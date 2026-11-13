export const fmt = (t: number, frames = false, fps = 30) => {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const base = `${m}:${String(s).padStart(2, "0")}`;
  return frames ? `${base}.${String(Math.floor((t % 1) * fps)).padStart(2, "0")}` : base;
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
