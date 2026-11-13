import type { Sfx } from "./types";

/**
 * Plays the draft's sound effects live over the proxy (which carries only the voice), so a sound change shows up
 * without any render, and any one sound can be heard alone. Scheduled against the video's clock on play/seek.
 */
export class SoundEngine {
  ctx = new AudioContext();
  private buffers = new Map<string, AudioBuffer>();
  private live: AudioBufferSourceNode[] = [];
  private bus = this.ctx.createGain();
  sfx: Sfx[] = [];
  urlFor: (s: Sfx) => string = (s) => s.file;
  muted = false;

  constructor() {
    this.bus.connect(this.ctx.destination);
  }

  async load(sfx: Sfx[], urlFor: (s: Sfx) => string) {
    this.sfx = sfx;
    this.urlFor = urlFor;
    await Promise.all(
      [...new Set(sfx.map((s) => s.file))].map(async (file) => {
        if (this.buffers.has(file)) return;
        try {
          const s = sfx.find((x) => x.file === file)!;
          const data = await fetch(urlFor(s)).then((r) => r.arrayBuffer());
          this.buffers.set(file, await this.ctx.decodeAudioData(data));
        } catch {
          /* a missing file just stays silent */
        }
      }),
    );
  }

  setMuted(m: boolean) {
    this.muted = m;
    this.bus.gain.value = m ? 0 : 1;
  }

  stop() {
    for (const n of this.live) {
      try {
        n.stop();
      } catch {}
    }
    this.live = [];
  }

  private play(s: Sfx, when: number, offset: number, gainBoost = 1) {
    const buf = this.buffers.get(s.file);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = s.volume * gainBoost;
    src.connect(g).connect(this.bus);
    const dur = Math.max(0, s.dur - offset);
    if (dur <= 0.005) return;
    src.start(when, s.src + offset, dur);
    this.live.push(src);
    src.onended = () => (this.live = this.live.filter((x) => x !== src));
  }

  /** Called when the video starts playing (or seeks while playing) at timeline time t. */
  schedule(t: number) {
    this.stop();
    if (this.ctx.state === "suspended") this.ctx.resume();
    const now = this.ctx.currentTime + 0.03;
    for (const s of this.sfx) {
      if (s.start + s.dur <= t) continue;
      const delay = s.start - t;
      this.play(s, now + Math.max(0, delay), Math.max(0, -delay));
    }
  }

  /** Audition one sound by itself. */
  solo(s: Sfx) {
    this.stop();
    if (this.ctx.state === "suspended") this.ctx.resume();
    const was = this.muted;
    this.bus.gain.value = 1;
    this.play(s, this.ctx.currentTime + 0.02, 0, 1 / Math.max(s.volume, 0.05)); // at full level, so it can be judged
    if (was) setTimeout(() => this.setMuted(was), s.dur * 1000 + 100);
  }
}
