export const CUE_TONES = Object.freeze({
  ready: Object.freeze({ freq: 1320, duration: 0.5 }),
  preview: Object.freeze({ freq: 1320, duration: 0.5 }),
  countdown: Object.freeze({ freq: 1320, duration: 0.32 }),
  work: Object.freeze({ freq: 1320, duration: 0.5 }),
  rest: Object.freeze({ freq: 1047, duration: 0.4 }),
  complete: Object.freeze({ freq: 1568, duration: 0.68 })
});

const SAMPLE_RATE = 44100;
const WAV_HEADER_SIZE = 44;

function boundedVolume(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : 100;
}

function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function defaultBase64Encode(value) {
  if (typeof globalThis.btoa !== 'function') return null;
  return globalThis.btoa(value);
}

export function createToneWavDataUri(tone, base64Encode = defaultBase64Encode) {
  if (!tone || typeof base64Encode !== 'function') return null;

  const frequency = Number(tone.freq);
  const duration = Number(tone.duration);
  if (!Number.isFinite(frequency) || frequency <= 0 || !Number.isFinite(duration) || duration <= 0) {
    return null;
  }

  const sampleCount = Math.max(1, Math.ceil(duration * SAMPLE_RATE));
  const sampleBytes = sampleCount * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_SIZE + sampleBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + sampleBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, sampleBytes, true);

  const attackSamples = Math.max(1, Math.floor(SAMPLE_RATE * 0.01));
  const releaseSamples = Math.max(1, Math.floor(SAMPLE_RATE * 0.055));
  for (let index = 0; index < sampleCount; index += 1) {
    const attack = Math.min(1, index / attackSamples);
    const release = Math.min(1, (sampleCount - index - 1) / releaseSamples);
    const envelope = Math.max(0, Math.min(attack, release));
    const wave = Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE);
    view.setInt16(WAV_HEADER_SIZE + index * 2, Math.round(wave * envelope * 0.92 * 32767), true);
  }

  const bytes = new Uint8Array(buffer);
  const chunks = [];
  const chunkSize = 8192;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }

  const encoded = base64Encode(chunks.join(''));
  return encoded ? `data:audio/wav;base64,${encoded}` : null;
}

export function createCuePlayer({
  AudioClass,
  AudioContextClass,
  mediaParent = null,
  base64Encode = defaultBase64Encode,
  initialVolume = 100,
  preferWebAudio = false
} = {}) {
  let engine = null;
  let media = null;
  let volume = boundedVolume(initialVolume);
  const mediaSources = new Map();

  function createMediaElement() {
    if (typeof AudioClass !== 'function' || typeof base64Encode !== 'function') return null;

    try {
      const element = new AudioClass();
      element.preload = 'auto';
      element.controls = false;
      element.playsInline = true;
      element.defaultMuted = false;
      element.muted = false;
      element.volume = volume / 100;
      element.setAttribute?.('aria-hidden', 'true');
      element.setAttribute?.('playsinline', '');
      element.setAttribute?.('webkit-playsinline', '');
      if (element.style) {
        element.style.position = 'fixed';
        element.style.left = '-9999px';
        element.style.width = '1px';
        element.style.height = '1px';
      }
      mediaParent?.append?.(element);
      return element;
    } catch {
      return null;
    }
  }

  function sourceForTone(tone) {
    const key = `${tone.freq}:${tone.duration}`;
    if (!mediaSources.has(key)) {
      mediaSources.set(key, createToneWavDataUri(tone, base64Encode));
    }
    return mediaSources.get(key);
  }

  async function playMediaTone(tone) {
    if (!media) media = createMediaElement();
    if (!media) return false;

    const source = sourceForTone(tone);
    if (!source) return false;

    try {
      media.pause?.();
      if (media.src !== source) {
        media.src = source;
        media.load?.();
      }
      try {
        media.currentTime = 0;
      } catch {
        // Some mobile browsers do not allow seeking until metadata is available.
      }
      media.defaultMuted = false;
      media.muted = false;
      media.volume = volume / 100;
      const started = media.play();
      if (started?.then) await started;
      return true;
    } catch {
      return false;
    }
  }

  function discardClosedEngine() {
    if (engine?.ctx?.state === 'closed') engine = null;
  }

  function createEngine() {
    if (typeof AudioContextClass !== 'function') return null;

    let ctx;
    try {
      try {
        ctx = new AudioContextClass({ latencyHint: 'interactive' });
      } catch {
        ctx = new AudioContextClass();
      }

      const master = ctx.createGain();
      master.gain.value = volume / 100;
      master.connect(ctx.destination);
      return { ctx, master };
    } catch {
      try {
        const closing = ctx?.close?.();
        closing?.catch?.(() => {});
      } catch {
        // Audio is optional; cleanup failure must not affect the timer.
      }
      return null;
    }
  }

  function getEngine() {
    discardClosedEngine();
    if (!engine) engine = createEngine();
    return engine;
  }

  async function unlockWebAudio() {
    const current = getEngine();
    if (!current) return null;

    if (current.ctx.state !== 'running') {
      try {
        const resumed = current.ctx.resume();
        if (resumed?.then) await resumed;
      } catch {
        return null;
      }
    }

    return current.ctx.state === 'running' ? current : null;
  }

  function scheduleWebAudioTone(current, tone) {
    const { ctx, master } = current;
    const startAt = ctx.currentTime + 0.01;
    const endAt = startAt + tone.duration;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.value = tone.freq;
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(0.92, startAt + 0.01);
    gain.gain.setValueAtTime(0.92, Math.max(startAt + 0.011, endAt - 0.055));
    gain.gain.exponentialRampToValueAtTime(0.0001, endAt);
    oscillator.connect(gain);
    gain.connect(master);
    oscillator.onended = () => {
      try {
        oscillator.disconnect();
        gain.disconnect();
      } catch {
        // Nodes may already be disconnected by the browser.
      }
    };
    oscillator.start(startAt);
    oscillator.stop(endAt + 0.03);
  }

  async function playWebAudioTone(tone, pendingEngine = unlockWebAudio()) {
    const current = await pendingEngine;
    if (!current) return false;

    try {
      scheduleWebAudioTone(current, tone);
      return true;
    } catch {
      return false;
    }
  }

  async function play(kind) {
    if (volume === 0) return false;
    const tone = CUE_TONES[kind] || CUE_TONES.countdown;

    const pendingEngine = unlockWebAudio();
    if (preferWebAudio) {
      if (await playWebAudioTone(tone, pendingEngine)) return true;
      return playMediaTone(tone);
    }

    const mediaPlayback = playMediaTone(tone);
    if (await mediaPlayback) return true;
    return playWebAudioTone(tone, pendingEngine);
  }

  async function unlock() {
    if (volume === 0) return false;
    const mediaPlayback = playMediaTone(CUE_TONES.ready);
    const pendingEngine = unlockWebAudio();
    if (await mediaPlayback) return true;
    return Boolean(await pendingEngine);
  }

  function prepare(kind = 'ready') {
    if (!media) media = createMediaElement();
    if (!media) return false;

    const tone = CUE_TONES[kind] || CUE_TONES.ready;
    const source = sourceForTone(tone);
    if (!source) return false;

    try {
      if (media.src !== source) {
        media.src = source;
        media.load?.();
      }
      return true;
    } catch {
      return false;
    }
  }

  function setVolume(value) {
    volume = boundedVolume(value);
    if (media) media.volume = volume / 100;

    discardClosedEngine();
    if (!engine) return;
    try {
      engine.master.gain.setTargetAtTime(volume / 100, engine.ctx.currentTime, 0.01);
    } catch {
      engine = null;
    }
  }

  return Object.freeze({ play, setVolume, unlock, prepare });
}
