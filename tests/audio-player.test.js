import assert from 'node:assert/strict';
import test from 'node:test';

import { createCuePlayer, createToneWavDataUri } from '../audio-player.js';

function audioParam(initialValue = 0) {
  return {
    value: initialValue,
    calls: [],
    setValueAtTime(value, time) {
      this.calls.push(['set', value, time]);
      this.value = value;
    },
    exponentialRampToValueAtTime(value, time) {
      this.calls.push(['ramp', value, time]);
      this.value = value;
    },
    setTargetAtTime(value, time, constant) {
      this.calls.push(['target', value, time, constant]);
      this.value = value;
    }
  };
}

function createFakeAudioContext({ initialState = 'running', resume } = {}) {
  const instances = [];

  class FakeAudioContext {
    constructor() {
      this.state = initialState;
      this.currentTime = 4;
      this.destination = { kind: 'destination' };
      this.resumeCalls = 0;
      this.gains = [];
      this.oscillators = [];
      instances.push(this);
    }

    createGain() {
      const node = {
        gain: audioParam(1),
        connections: [],
        connect(target) {
          this.connections.push(target);
        },
        disconnect() {}
      };
      this.gains.push(node);
      return node;
    }

    createOscillator() {
      const node = {
        type: '',
        frequency: audioParam(),
        connections: [],
        startedAt: null,
        stoppedAt: null,
        connect(target) {
          this.connections.push(target);
        },
        disconnect() {},
        start(time) {
          this.startedAt = time;
        },
        stop(time) {
          this.stoppedAt = time;
        }
      };
      this.oscillators.push(node);
      return node;
    }

    resume() {
      this.resumeCalls += 1;
      if (resume) return resume(this);
      this.state = 'running';
      return Promise.resolve();
    }
  }

  return { AudioContextClass: FakeAudioContext, instances };
}

function createFakeAudio({ play } = {}) {
  const instances = [];

  class FakeAudio {
    constructor() {
      this.src = '';
      this.volume = 1;
      this.muted = false;
      this.currentTime = 0;
      this.style = {};
      this.attributes = new Map();
      this.pauseCalls = 0;
      this.playCalls = 0;
      this.loadCalls = 0;
      instances.push(this);
    }

    setAttribute(name, value) {
      this.attributes.set(name, value);
    }

    pause() {
      this.pauseCalls += 1;
    }

    load() {
      this.loadCalls += 1;
    }

    play() {
      this.playCalls += 1;
      return play ? play(this) : Promise.resolve();
    }
  }

  return { AudioClass: FakeAudio, instances };
}

const encodeBase64 = (value) => Buffer.from(value, 'binary').toString('base64');

test('generated media tones are valid mono PCM WAV data', () => {
  const uri = createToneWavDataUri({ freq: 988, duration: 0.4 }, encodeBase64);
  assert.match(uri, /^data:audio\/wav;base64,/);

  const bytes = Buffer.from(uri.split(',')[1], 'base64');
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(bytes.readUInt16LE(22), 1);
  assert.equal(bytes.readUInt32LE(24), 44100);
  assert.equal(bytes.readUInt16LE(34), 16);
  assert.ok(bytes.length > 44);
});

test('prepare mounts and preloads mobile media without starting playback', () => {
  const media = createFakeAudio();
  const mounted = [];
  const player = createCuePlayer({
    AudioClass: media.AudioClass,
    mediaParent: { append: (element) => mounted.push(element) },
    base64Encode: encodeBase64
  });

  assert.equal(player.prepare('ready'), true);
  assert.equal(media.instances.length, 1);
  assert.deepEqual(mounted, [media.instances[0]]);
  assert.equal(media.instances[0].loadCalls, 1);
  assert.equal(media.instances[0].playCalls, 0);
  assert.equal(media.instances[0].muted, false);
  assert.equal(media.instances[0].attributes.has('playsinline'), true);
  assert.equal(media.instances[0].attributes.has('webkit-playsinline'), true);
});

test('HTML media playback is started synchronously and preferred for audible output', async () => {
  let finishPlayback;
  const media = createFakeAudio({
    play() {
      return new Promise((resolve) => {
        finishPlayback = resolve;
      });
    }
  });
  const webAudio = createFakeAudioContext();
  const mounted = [];
  const player = createCuePlayer({
    AudioClass: media.AudioClass,
    AudioContextClass: webAudio.AudioContextClass,
    mediaParent: { append: (element) => mounted.push(element) },
    base64Encode: encodeBase64
  });

  const playback = player.play('preview');
  assert.equal(media.instances.length, 1);
  assert.equal(media.instances[0].playCalls, 1);
  assert.match(media.instances[0].src, /^data:audio\/wav;base64,/);
  assert.deepEqual(mounted, [media.instances[0]]);
  assert.equal(webAudio.instances.length, 1);
  assert.equal(webAudio.instances[0].oscillators.length, 0);

  finishPlayback();
  assert.equal(await playback, true);
  assert.equal(webAudio.instances[0].oscillators.length, 0);
});

test('the same permitted media element is reused for later timer cues', async () => {
  const media = createFakeAudio();
  const player = createCuePlayer({
    AudioClass: media.AudioClass,
    base64Encode: encodeBase64
  });

  assert.equal(await player.play('ready'), true);
  assert.equal(await player.play('countdown'), true);
  assert.equal(media.instances.length, 1);
  assert.equal(media.instances[0].playCalls, 2);
  assert.equal(media.instances[0].pauseCalls, 2);
  assert.equal(media.instances[0].loadCalls, 2);
});

test('a rejected media start falls back to resumed Web Audio', async () => {
  const media = createFakeAudio({ play: () => Promise.reject(new Error('blocked')) });
  const webAudio = createFakeAudioContext({ initialState: 'suspended' });
  const player = createCuePlayer({
    AudioClass: media.AudioClass,
    AudioContextClass: webAudio.AudioContextClass,
    base64Encode: encodeBase64
  });

  assert.equal(await player.play('work'), true);
  assert.equal(media.instances[0].playCalls, 1);
  assert.equal(webAudio.instances.length, 1);
  assert.equal(webAudio.instances[0].resumeCalls, 1);
  assert.equal(webAudio.instances[0].oscillators.length, 1);
});

test('volume changes update the reusable media element', async () => {
  const media = createFakeAudio();
  const player = createCuePlayer({
    AudioClass: media.AudioClass,
    base64Encode: encodeBase64
  });
  assert.equal(await player.play('preview'), true);

  player.setVolume(40);
  assert.equal(media.instances[0].volume, 0.4);
});

test('a suspended context is running before a cue is scheduled', async () => {
  let finishResume;
  const fake = createFakeAudioContext({
    initialState: 'suspended',
    resume(ctx) {
      return new Promise((resolve) => {
        finishResume = () => {
          ctx.state = 'running';
          resolve();
        };
      });
    }
  });
  const media = createFakeAudio();
  const player = createCuePlayer({
    AudioClass: media.AudioClass,
    AudioContextClass: fake.AudioContextClass,
    base64Encode: encodeBase64,
    preferWebAudio: true
  });

  const playback = player.play('preview');
  assert.equal(fake.instances.length, 1);
  assert.equal(fake.instances[0].oscillators.length, 0);

  finishResume();
  assert.equal(await playback, true);
  assert.equal(fake.instances[0].resumeCalls, 1);
  assert.equal(fake.instances[0].oscillators.length, 1);
  assert.equal(fake.instances[0].oscillators[0].frequency.value, 1320);
  assert.equal(media.instances.length, 0);
});

test('a rejected resume reports failure and never schedules silent audio', async () => {
  const fake = createFakeAudioContext({
    initialState: 'suspended',
    resume() {
      return Promise.reject(new Error('blocked'));
    }
  });
  const player = createCuePlayer({ AudioContextClass: fake.AudioContextClass });

  assert.equal(await player.play('ready'), false);
  assert.equal(fake.instances[0].oscillators.length, 0);
});

test('an interrupted context is resumed before playback', async () => {
  const fake = createFakeAudioContext({ initialState: 'interrupted' });
  const player = createCuePlayer({ AudioContextClass: fake.AudioContextClass });

  assert.equal(await player.play('work'), true);
  assert.equal(fake.instances[0].resumeCalls, 1);
  assert.equal(fake.instances[0].state, 'running');
});

test('a closed context is discarded and recreated', async () => {
  const fake = createFakeAudioContext();
  const player = createCuePlayer({ AudioContextClass: fake.AudioContextClass });

  assert.equal(await player.play('ready'), true);
  fake.instances[0].state = 'closed';
  assert.equal(await player.play('complete'), true);
  assert.equal(fake.instances.length, 2);
});

test('muted playback creates no audio context and can be enabled later', async () => {
  const fake = createFakeAudioContext();
  const player = createCuePlayer({
    AudioContextClass: fake.AudioContextClass,
    initialVolume: 0
  });

  assert.equal(await player.play('preview'), false);
  assert.equal(fake.instances.length, 0);

  player.setVolume(100);
  assert.equal(await player.play('preview'), true);
  assert.equal(fake.instances.length, 1);
});

test('volume changes update the active master gain', async () => {
  const fake = createFakeAudioContext();
  const player = createCuePlayer({ AudioContextClass: fake.AudioContextClass });
  assert.equal(await player.play('preview'), true);

  player.setVolume(40);
  const masterGain = fake.instances[0].gains[0].gain;
  assert.deepEqual(masterGain.calls.at(-1), ['target', 0.4, 4, 0.01]);
});

test('missing Web Audio support is reported without throwing', async () => {
  const player = createCuePlayer();
  assert.equal(await player.play('preview'), false);
});
