const MUTE_KEY = "machiai-muted";

let audio: AudioContext | undefined;
let muted = readMuted();

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

function context(): AudioContext | undefined {
  if (muted) return undefined;
  try {
    audio = audio ?? new AudioContext();
    if (audio.state === "suspended") void audio.resume();
    return audio;
  } catch {
    return undefined;
  }
}

/** One synthesized note: fast attack, exponential decay. All sounds are generated — no audio assets. */
function tone(frequency: number, startOffset: number, duration: number, peak: number, type: OscillatorType = "sine"): void {
  const ctx = context();
  if (!ctx) return;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  const at = ctx.currentTime + startOffset;
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, at);
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(peak, at + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(at);
  oscillator.stop(at + duration + 0.02);
}

export const sounds = {
  isMuted(): boolean {
    return muted;
  },
  toggleMute(): boolean {
    muted = !muted;
    try {
      localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
    } catch {
      // persistence is best-effort
    }
    return muted;
  },
  /** Wooden "tock" for a quiet move. */
  move(): void {
    tone(220, 0, 0.07, 0.22, "triangle");
  },
  /** Deeper double-knock for a capture. */
  capture(): void {
    tone(150, 0, 0.1, 0.3, "triangle");
    tone(95, 0.015, 0.12, 0.22, "sine");
  },
  /** Rising two-note chime when an opponent is found. */
  gameFound(): void {
    tone(523.25, 0, 0.15, 0.18);
    tone(783.99, 0.12, 0.24, 0.18);
  },
  /** Short arpeggio keyed to the result. */
  gameEnd(result: "win" | "loss" | "draw"): void {
    if (result === "win") {
      tone(523.25, 0, 0.14, 0.16);
      tone(659.25, 0.11, 0.14, 0.16);
      tone(783.99, 0.22, 0.28, 0.16);
    } else if (result === "loss") {
      tone(392, 0, 0.16, 0.15);
      tone(311.13, 0.13, 0.16, 0.15);
      tone(261.63, 0.26, 0.3, 0.13);
    } else {
      tone(440, 0, 0.16, 0.13);
      tone(440, 0.18, 0.22, 0.09);
    }
  },
};
