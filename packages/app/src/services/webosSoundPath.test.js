import {clearCapabilitiesCache, getDeviceCapabilities, getJellyfinDeviceProfile} from '../../../platform-webos/src/deviceProfile';

let mockSoundOutput;
let mockDigitalOutput;
const mockSoundReads = jest.fn();

jest.mock('@enact/webos/deviceinfo', () => ({
	__esModule: true,
	default: (callback) => callback({sdkVersion: '6.0.0'})
}));

jest.mock('@enact/webos/LS2Request', () => ({
	__esModule: true,
	default: class {
		send ({method, onSuccess}) {
			if (method === 'getSystemSettings') {
				mockSoundReads();
				onSuccess({settings: {soundOutput: mockSoundOutput, digitalSoundOutput: mockDigitalOutput}});
			} else {
				onSuccess({});
			}
		}
	}
}));

describe('the webOS sound path', () => {
	beforeEach(() => {
		mockSoundOutput = 'tv_speaker';
		mockDigitalOutput = 'passthrough';
		clearCapabilitiesCache();
	});

	test.each([
		['tv_speaker', 'passthrough', false],
		['external_arc', 'passthrough', true],
		['external_earc', 'auto', true],
		['external_arc', 'pcm', false]
	])('%s with %s never enables TrueHD', async (output, digital, receiver) => {
		mockSoundOutput = output;
		mockDigitalOutput = digital;
		for (let read = 0; read < 2; read++) {
			const caps = await getDeviceCapabilities({});
			expect(caps.truehd).toBe(false);
			expect(caps.externalAudioPathActive).toBe(receiver);
			expect(caps.dtshd).toBe(receiver);
			expect(caps.eac3).toBe(true);
			const profile = await getJellyfinDeviceProfile({passthroughSettings: {forceTruehdPassthrough: true}});
			const mkv = profile.DirectPlayProfiles.find((entry) => entry.Container === 'mkv');
			expect(mkv.AudioCodec.split(',')).not.toContain('truehd');
			expect(mkv.AudioCodec.includes('dtshd')).toBe(receiver);
		}
	});

	test('one playback start asks the TV once', async () => {
		const start = {};
		await getDeviceCapabilities(start);
		await getJellyfinDeviceProfile(start);
		expect(mockSoundReads).toHaveBeenCalledTimes(1);
	});

	test('the next start sees a receiver switched on right after the last one', async () => {
		expect((await getDeviceCapabilities({})).externalAudioPathActive).toBe(false);
		mockSoundOutput = 'external_arc';
		expect((await getDeviceCapabilities({})).externalAudioPathActive).toBe(true);
		expect(mockSoundReads).toHaveBeenCalledTimes(2);
	});

	test('a read outside a playback start always asks', async () => {
		await getDeviceCapabilities();
		await getDeviceCapabilities();
		expect(mockSoundReads).toHaveBeenCalledTimes(2);
	});
});
