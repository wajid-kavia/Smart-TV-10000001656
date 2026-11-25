import {getJellyfinDeviceProfile} from '../../../platform-webos/src/deviceProfile';
import {getSupportedAudioCodecs, isAudioStreamPlayable, getPlayMethod} from '../../../platform-webos/src/video';

jest.mock('@enact/webos/deviceinfo', () => ({__esModule: true, default: (cb) => cb({})}));
jest.mock('@enact/webos/LS2Request', () => ({
	__esModule: true,
	default: class {
		send({onFailure}) { onFailure({}); }
	}
}));

describe('webOS subtitle profile', () => {
	test.each([true, false])('never advertises TrueHD with legacy force=%s', async (forceTruehdPassthrough) => {
		const profile = await getJellyfinDeviceProfile({passthroughSettings: {forceTruehdPassthrough, truehdPassthrough: true}});
		for (const entry of profile.DirectPlayProfiles) {
			expect((entry.AudioCodec || '').split(',')).not.toEqual(expect.arrayContaining(['truehd']));
			expect((entry.AudioCodec || '').split(',')).not.toContain('mlp');
		}
		expect(profile.DirectPlayProfiles.find((entry) => entry.Container === 'mp4,m4v').AudioCodec).toContain('eac3');
	});

	test.each(['truehd', 'mlp'])('rejects %s despite injected capabilities and legacy options', (Codec) => {
		const caps = {truehd: true, ac3: true, eac3: true, dts: {mkv: true}, dtshd: true, mkv: true};
		const prefs = {forceTruehdPassthrough: true, truehdPassthrough: true};
		expect(getSupportedAudioCodecs(caps, 'mkv', prefs)).toEqual(expect.arrayContaining(['ac3', 'eac3', 'dts', 'dtshd']));
		expect(isAudioStreamPlayable({Codec}, caps, prefs)).toBe(false);
		const source = {Container: 'mkv', SupportsDirectPlay: true, SupportsDirectStream: true,
			MediaStreams: [{Type: 'Video', Codec: 'h264'}, {Type: 'Audio', Index: 1, Codec}]};
		expect(getPlayMethod(source, caps, {}, prefs)).toBe('Transcode');
		source.MediaStreams.push({Type: 'Audio', Index: 2, Codec: 'ac3'});
		expect(getPlayMethod(source, caps, {}, prefs)).toBe('DirectPlay');
		expect(isAudioStreamPlayable({Codec: 'dts'}, caps, {passthroughEnabled: false})).toBe(false);
		expect(isAudioStreamPlayable({Codec: 'eac3'}, caps, {eac3Passthrough: false})).toBe(false);
	});

	test('is unchanged when embedded text subtitles are off', async () => {
		const [off, unset] = await Promise.all([getJellyfinDeviceProfile({embedTextSubtitles: false}), getJellyfinDeviceProfile({})]);
		expect(off.SubtitleProfiles).toEqual(unset.SubtitleProfiles);
		expect(off.SubtitleProfiles.some((profile) => profile.Method === 'Embed')).toBe(false);
	});

	test('puts Embed ahead of External for SRT only when asked', async () => {
		const {SubtitleProfiles} = await getJellyfinDeviceProfile({embedTextSubtitles: true});
		const methodsOf = (format) => SubtitleProfiles.filter((profile) => profile.Format === format).map((profile) => profile.Method);
		expect(methodsOf('srt')).toEqual(['Embed', 'External']);
		expect(methodsOf('subrip')).toEqual(['Embed']);
		expect(methodsOf('ass')).toEqual(['External']);
		expect(methodsOf('pgssub')).toEqual(['External']);
	});
});
