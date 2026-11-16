export const fmt = (t: number, frames = false, fps = 30) => {
  // count whole frames first (with a hair of slack) so 10 frames shows .10, not .09 from float error
  fps = Math.round(fps) || 30; // 29.97 counts as 30 frames per second on the readout
  const total = Math.floor(t * fps + 1e-3);
  const sec = Math.floor(total / fps);
  const base = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  return frames ? `${base}.${String(total % fps).padStart(2, "0")}` : base;
};
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
export const basename = (p: string) => p.split("/").pop() ?? p;
export const ago = (ms: number) => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
};
