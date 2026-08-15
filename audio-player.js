export const CUE_TONES = Object.freeze({
  ready: Object.freeze({ freq: 988, duration: 0.36 }),
  preview: Object.freeze({ freq: 988, duration: 0.36 }),
  countdown: Object.freeze({ freq: 988, duration: 0.24 }),
  work: Object.freeze({ freq: 988, duration: 0.36 }),
  rest: Object.freeze({ freq: 784, duration: 0.28 }),
  complete: Object.freeze({ freq: 988, duration: 0.52 })
});

function boundedVolume(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : 100;
}

export function createCuePlayer({ AudioContextClass, initialVolume = 100 } = {}) {
  let engine = null;
  let volume = boundedVolume(initialVolume);

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

  async function unlock() {
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

  function scheduleTone(current, tone) {
    const { ctx, master } = current;
    const startAt = ctx.currentTime + 0.01;
    const endAt = startAt + tone.duration;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.value = tone.freq;
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(0.85, startAt + 0.008);
    gain.gain.setValueAtTime(0.85, Math.max(startAt + 0.009, endAt - 0.05));
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

  async function play(kind) {
    if (volume === 0) return false;

    const current = await unlock();
    if (!current) return false;

    try {
      scheduleTone(current, CUE_TONES[kind] || CUE_TONES.countdown);
      return true;
    } catch {
      return false;
    }
  }

  function setVolume(value) {
    volume = boundedVolume(value);
    discardClosedEngine();
    if (!engine) return;

    try {
      engine.master.gain.setTargetAtTime(volume / 100, engine.ctx.currentTime, 0.01);
    } catch {
      engine = null;
    }
  }

  return Object.freeze({ play, setVolume, unlock });
}
