import * as playback from './playback';
import * as jellyfinApi from './jellyfinApi';
import {getDeviceCapabilities, getDeviceProfile} from './deviceProfile';
import {linkBitrate} from './linkBitrate';
import {getPlayMethod, isAudioStreamPlayable} from './video';
import {getFromStorage} from './storage';

jest.mock('./jellyfinApi', () => {
	const server = {getPlaybackInfo: jest.fn(), closeLiveStream: jest.fn(), reportPlaybackStopped: jest.fn()};
	return {
		api: server,
		createApiForServer: () => server,
		getServerType: () => 'jellyfin',
		getServerUrl: () => 'http://server',
		getAuthHeader: () => 'MediaBrowser Token="key"',
		getAuthHeaderFor: (type, token) => `${type} ${token}`,
		getApiKey: () => 'key',
		getDeviceId: () => 'device',
		getTokenParam: () => 'ApiKey'
	};
});
jest.mock('./deviceProfile', () => ({
	getDeviceProfile: jest.fn(),
	getDeviceCapabilities: jest.fn()
}));
jest.mock('./linkBitrate', () => ({linkBitrate: jest.fn()}));
jest.mock('./video', () => ({
	getPlayMethod: jest.fn(() => 'DirectPlay'),
	getMimeType: () => 'video/mp4',
	isAudioStreamPlayable: jest.fn(() => true),
	canRenderEmbeddedPgsInBand: () => false,
	rendersSubtitleInHost: () => false
}));
jest.mock('./storage', () => ({getFromStorage: jest.fn(async () => ({}))}));
jest.mock('./serverLogger', () => ({serverLogger: {playback: jest.fn()}}));
jest.mock('./systemVolume', () => ({getVolumeState: jest.fn(), lastVolumeState: () => null}));
jest.mock('../platform', () => ({isVega: () => false, isXbox: () => false, isTizen: () => false}));

const {api} = jellyfinApi;
const movie = {Id: 'movie-1', Type: 'Movie'};

beforeEach(async () => {
	await playback.reportStop(0);
	jest.clearAllMocks();
	getFromStorage.mockResolvedValue({});
	getPlayMethod.mockImplementation(() => 'DirectPlay');
	isAudioStreamPlayable.mockImplementation(() => true);
	jest.spyOn(console, 'log').mockImplementation(() => {});
	api.reportPlaybackStopped.mockResolvedValue(null);
	getDeviceProfile.mockResolvedValue({});
	api.getPlaybackInfo.mockResolvedValue({
		PlaySessionId: 'session',
		MediaSources: [{Id: 'source', SupportsDirectPlay: true, Container: 'mkv', MediaStreams: []}]
	});
});

describe('LG TrueHD negotiation', () => {
	const source = (codec, alternate = null) => ({
		Id: 'source', Container: 'mkv', SupportsDirectPlay: true, SupportsDirectStream: true,
		DefaultAudioStreamIndex: 1,
		MediaStreams: [
			{Type: 'Video', Index: 0, Codec: 'h264'},
			{Type: 'Audio', Index: 1, Codec: codec, Language: 'eng'},
			...(alternate ? [{Type: 'Audio', Index: 2, Codec: alternate, Language: 'eng'}] : [])
		]
	});
	beforeEach(() => {
		const webos = jest.requireActual('../../../platform-webos/src/video');
		getPlayMethod.mockImplementation(webos.getPlayMethod);
		isAudioStreamPlayable.mockImplementation(webos.isAudioStreamPlayable);
		getDeviceCapabilities.mockResolvedValue({mkv: true, h264: true, ac3: true, eac3: true, truehd: true});
	});

	test.each(['ac3', 'eac3'])('selects same-language %s instead of the TrueHD default', async (alternate) => {
		api.getPlaybackInfo
			.mockResolvedValueOnce({MediaSources: [source('truehd', alternate)]})
			.mockResolvedValueOnce({MediaSources: [{...source('truehd', alternate), DefaultAudioStreamIndex: 2}]});
		const result = await playback.getPlaybackInfo(movie.Id, {item: movie, passthroughSettings: {forceTruehdPassthrough: true}});
		expect(api.getPlaybackInfo.mock.calls[1][1].AudioStreamIndex).toBe(2);
		expect(result.selectedAudioStreamIndex).toBe(2);
		expect(result.playMethod).toBe('DirectPlay');
		expect(getDeviceProfile.mock.calls[0][1].passthroughSettings).not.toHaveProperty('forceTruehdPassthrough');
	});

	test.each(['truehd', 'mlp'])('requests conversion for %s-only media', async (codec) => {
		api.getPlaybackInfo
			.mockResolvedValueOnce({MediaSources: [source(codec)]})
			.mockResolvedValue({MediaSources: [{...source(codec), SupportsDirectPlay: false, SupportsDirectStream: false,
				TranscodingUrl: '/videos/movie-1/master.m3u8?MediaSourceId=source'}]});
		const result = await playback.getPlaybackInfo(movie.Id, {item: movie, forceTruehdPassthrough: true});
		expect(api.getPlaybackInfo.mock.calls[1][1]).toMatchObject({EnableDirectPlay: false, EnableDirectStream: false, EnableTranscoding: true});
		expect(result.playMethod).toBe('Transcode');
	});

	test('does not silently substitute an explicitly selected TrueHD track', async () => {
		api.getPlaybackInfo
			.mockResolvedValueOnce({MediaSources: [{...source('truehd', 'ac3'), SupportsDirectPlay: false, SupportsDirectStream: false}]})
			.mockResolvedValue({MediaSources: [{...source('truehd', 'ac3'), SupportsDirectPlay: false, SupportsDirectStream: false,
				TranscodingUrl: '/videos/movie-1/master.m3u8?MediaSourceId=source'}]});
		const result = await playback.getPlaybackInfo(movie.Id, {item: movie, audioStreamIndex: 1});
		expect(api.getPlaybackInfo.mock.calls[1][1].AudioStreamIndex).toBe(1);
		expect(result.selectedAudioStreamIndex).toBe(1);
		expect(result.playMethod).toBe('Transcode');
	});

	test.each([true, false])('ignores saved legacy force=%s and fails cleanly without a conversion URL', async (forceTruehdPassthrough) => {
		getFromStorage.mockResolvedValue({forceTruehdPassthrough, truehdPassthrough: true});
		api.getPlaybackInfo.mockImplementation(async () => ({MediaSources: [source('truehd')]}));
		await expect(playback.getPlaybackInfo(movie.Id, {item: movie})).rejects.toThrow('No playback URL available');
		expect(getDeviceProfile.mock.calls[0][1].passthroughSettings).not.toHaveProperty('forceTruehdPassthrough');
		expect(api.getPlaybackInfo.mock.calls[1][1]).toMatchObject({EnableDirectPlay: false, EnableDirectStream: false});
	});
});

describe('the automatic bitrate', () => {
	const askedFor = () => api.getPlaybackInfo.mock.calls[api.getPlaybackInfo.mock.calls.length - 1][1].MaxStreamingBitrate;

	test('is the device ceiling where the platform doesnt ask for the link to be measured', async () => {
		getDeviceCapabilities.mockResolvedValue({});

		await playback.getPlaybackInfo(movie.Id, {item: movie});

		expect(linkBitrate).not.toHaveBeenCalled();
		expect(askedFor()).toBe(40000000);
	});

	test('stays under what the link carries where the platform asks for that, without a test before direct play', async () => {
		getDeviceCapabilities.mockResolvedValue({fitsBitrateToLink: true});
		linkBitrate.mockResolvedValue(5000000);

		await playback.getPlaybackInfo(movie.Id, {item: movie});

		expect(linkBitrate).toHaveBeenCalledTimes(1);
		expect(linkBitrate).toHaveBeenCalledWith({serverUrl: 'http://server', serverType: 'jellyfin', authHeader: 'MediaBrowser Token="key"'}, false);
		expect(askedFor()).toBe(5000000);
	});

	describe('once the server answers with a transcode', () => {
		const transcode = {
			PlaySessionId: 'session',
			MediaSources: [{
				Id: 'source', SupportsDirectPlay: false, SupportsDirectStream: false, Container: 'mkv', MediaStreams: [],
				TranscodingUrl: '/videos/movie-1/master.m3u8?MediaSourceId=source'
			}]
		};
		const asked = () => api.getPlaybackInfo.mock.calls.map((call) => call[1].MaxStreamingBitrate);

		beforeEach(() => {
			getDeviceCapabilities.mockResolvedValue({fitsBitrateToLink: true});
			api.getPlaybackInfo.mockResolvedValue(transcode);
		});

		test('measures the link and asks again under what it carries', async () => {
			linkBitrate.mockResolvedValueOnce(null).mockResolvedValueOnce(5000000);

			await playback.getPlaybackInfo(movie.Id, {item: movie});

			expect(linkBitrate.mock.calls.map((call) => call[1])).toEqual([false, true]);
			expect(asked()).toEqual([40000000, 5000000]);
		});

		test('asks only once when the measurement leaves the ceiling where it was', async () => {
			linkBitrate.mockResolvedValue(5000000);

			await playback.getPlaybackInfo(movie.Id, {item: movie});

			expect(asked()).toEqual([5000000]);
		});

		test('a start with direct play turned off measures before it asks', async () => {
			linkBitrate.mockResolvedValue(5000000);

			await playback.getPlaybackInfo(movie.Id, {item: movie, enableDirectPlay: false});

			expect(linkBitrate.mock.calls[0][1]).toBe(true);
			expect(asked()).toEqual([5000000]);
		});
	});

	test('is never raised over the device ceiling by a fast link, nor lost to a failed measurement', async () => {
		getDeviceCapabilities.mockResolvedValue({fitsBitrateToLink: true});
		linkBitrate.mockResolvedValueOnce(300000000).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('offline'));

		for (let i = 0; i < 3; i++) {
			await playback.getPlaybackInfo(movie.Id, {item: movie});
			expect(askedFor()).toBe(40000000);
			await playback.reportStop(0);
		}
	});

	test("is the platform's own where it names one", async () => {
		getDeviceCapabilities.mockResolvedValue({uhd: true, autoMaxBitrate: 120000000});

		await playback.getPlaybackInfo(movie.Id, {item: movie});

		expect(askedFor()).toBe(120000000);
	});

	test('gives way to a limit the user set', async () => {
		getDeviceCapabilities.mockResolvedValue({fitsBitrateToLink: true});

		await playback.getPlaybackInfo(movie.Id, {item: movie, maxBitrate: 8000000});

		expect(linkBitrate).not.toHaveBeenCalled();
		expect(askedFor()).toBe(8000000);
	});

	test('is measured on the server an item from another server lives on', async () => {
		getDeviceCapabilities.mockResolvedValue({fitsBitrateToLink: true});
		linkBitrate.mockResolvedValue(5000000);
		const other = {...movie, _serverUrl: 'http://other', _serverAccessToken: 'token', _serverUserId: 'user', _serverType: 'emby'};

		await playback.getPlaybackInfo(other.Id, {item: other});

		expect(linkBitrate).toHaveBeenCalledWith({serverUrl: 'http://other', serverType: 'emby', authHeader: 'emby token'}, false);
	});
});

describe('frames that never reach the screen', () => {
	let now;
	let monitor;

	// A second of a 24 frame a second file, with so many of its frames dropped
	const second = (video, dropped) => {
		now += 1000;
		video.total += 24;
		video.dropped += dropped;
		monitor.recordProgress();
		monitor.recordFrames(video.element);
	};
	const playing = () => {
		const video = {total: 0, dropped: 0};
		video.element = {getVideoPlaybackQuality: () => ({totalVideoFrames: video.total, droppedVideoFrames: video.dropped})};
		return video;
	};
	const start = async (capabilities) => {
		getDeviceCapabilities.mockResolvedValue(capabilities);
		await playback.getPlaybackInfo(movie.Id, {item: movie});
		monitor = playback.getHealthMonitor();
		monitor.reset();
	};

	beforeEach(() => {
		now = 1000000;
		jest.spyOn(Date, 'now').mockImplementation(() => now);
	});

	test('send a file to a transcode once a quarter of them have gone missing for a while', async () => {
		await start({watchesDroppedFrames: true});
		const video = playing();

		for (let i = 0; i < 14; i++) second(video, 6);
		expect(monitor.checkHealth()).toBe(true);

		for (let i = 0; i < 3; i++) second(video, 6);
		expect(monitor.checkHealth()).toBe(false);
		expect(monitor.shouldFallbackToTranscode()).toBe(true);
	});

	test('are let be when only the odd one goes missing, or a burst of them passes', async () => {
		await start({watchesDroppedFrames: true});
		const video = playing();

		for (let i = 0; i < 30; i++) second(video, i % 10 === 0 ? 1 : 0);
		for (let i = 0; i < 3; i++) second(video, 20);
		for (let i = 0; i < 30; i++) second(video, 0);

		expect(monitor.checkHealth()).toBe(true);
	});

	test('arent counted where the platform doesnt ask for it', async () => {
		await start({});
		const video = playing();

		for (let i = 0; i < 30; i++) second(video, 12);

		expect(monitor.checkHealth()).toBe(true);
	});
});

describe('a long pause', () => {
	test('isnt read as a stall the moment playback resumes, and a real stall after it still is', () => {
		let now = 1000000;
		jest.spyOn(Date, 'now').mockImplementation(() => now);
		const monitor = playback.getHealthMonitor();
		monitor.reset();
		monitor.setPaused(true);
		now += 3 * 60 * 1000;
		monitor.setPaused(false);
		expect(monitor.checkHealth()).toBe(true);

		now += 31000;
		expect(monitor.checkHealth()).toBe(false);
	});
});

describe('the transcoding profile that only offers AV1', () => {
	const profile = {TranscodingProfiles: [
		{Container: 'ts', Type: 'Video', VideoCodec: 'hevc,h264'},
		{Container: 'mp4', Type: 'Video', VideoCodec: 'av1'}
	]};
	const episode = {Id: 'episode-1', Type: 'Episode', MediaStreams: [
		{Type: 'Subtitle', Index: 2, Codec: 'dvdsub'},
		{Type: 'Subtitle', Index: 3, Codec: 'subrip'}
	]};
	const sentCodecs = () => api.getPlaybackInfo.mock.calls[0][1].DeviceProfile.TranscodingProfiles.map((p) => p.VideoCodec);

	beforeEach(() => {
		getDeviceCapabilities.mockResolvedValue({});
		getDeviceProfile.mockResolvedValue(profile);
	});

	test('is left out when a subtitle gets burned in, since the video has to be encoded', async () => {
		await playback.getPlaybackInfo(episode.Id, {item: episode, subtitleStreamIndex: 2});
		expect(sentCodecs()).toEqual(['hevc,h264']);
	});

	test('stays for a subtitle the TV draws itself', async () => {
		await playback.getPlaybackInfo(episode.Id, {item: episode, subtitleStreamIndex: 3});
		expect(sentCodecs()).toEqual(['hevc,h264', 'av1']);
	});
});

describe('a Plex subtitle', () => {
	const streams = [{Type: 'Subtitle', Index: 2, Codec: 'pgs'}, {Type: 'Subtitle', Index: 3, Codec: 'none'}];
	const plexMovie = {...movie, _serverType: 'plex', MediaStreams: streams, MediaSources: [{Id: 'source', Container: 'mkv', MediaStreams: streams}]};
	const directPlayAsked = () => api.getPlaybackInfo.mock.calls[api.getPlaybackInfo.mock.calls.length - 1][1].EnableDirectPlay;

	beforeEach(() => getDeviceCapabilities.mockResolvedValue({}));

	test('the TV cant read from the file turns direct play off, so Plex burns it in', async () => {
		await playback.getPlaybackInfo(plexMovie.Id, {item: plexMovie, subtitleStreamIndex: 2});

		expect(directPlayAsked()).toBe(false);
	});

	test('Plex lists as codec none keeps direct play, since Plex never burns one', async () => {
		await playback.getPlaybackInfo(plexMovie.Id, {item: plexMovie, subtitleStreamIndex: 3});

		expect(directPlayAsked()).toBe(true);
	});
});
