import assert from 'node:assert/strict';
import test from 'node:test';

import { createCuePlayer } from '../audio-player.js';

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
  const player = createCuePlayer({ AudioContextClass: fake.AudioContextClass });

  const playback = player.play('preview');
  assert.equal(fake.instances.length, 1);
  assert.equal(fake.instances[0].oscillators.length, 0);

  finishResume();
  assert.equal(await playback, true);
  assert.equal(fake.instances[0].resumeCalls, 1);
  assert.equal(fake.instances[0].oscillators.length, 1);
  assert.equal(fake.instances[0].oscillators[0].frequency.value, 988);
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
