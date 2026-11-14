/**
 * Where each app's own UI sits on a vertical video, in pixels of a 1080x1920 frame (scaled to any 9:16 size).
 * There is no official organic spec: these are estimates from the apps' current layouts (Nov 2026), so they move when
 * the apps change. Tune them here; the app's overlay and the agent's prompt both read this table.
 */
export type Margins = { top: number; bottom: number; left: number; right: number };
export type Platform = "tiktok" | "reels" | "shorts";
export type SafeMode = "off" | "all" | Platform | "title";

const REF_W = 1080, REF_H = 1920;

export const PLATFORMS: Record<Platform, { label: string; m: Margins; ui: { top: string; right: string; bottom: string } }> = {
  tiktok: { label: "TikTok", m: { top: 130, bottom: 480, left: 60, right: 150 }, ui: { top: "Following / For You", right: "like, comment, share", bottom: "handle, caption, sound" } },
  reels: { label: "Reels", m: { top: 220, bottom: 420, left: 60, right: 120 }, ui: { top: "Reels header", right: "like, comment, share", bottom: "handle, caption, audio" } },
  shorts: { label: "Shorts", m: { top: 200, bottom: 480, left: 48, right: 192 }, ui: { top: "Shorts header", right: "like, dislike, comment, share", bottom: "title, channel, subscribe" } },
};

/** The box that is clear on all three apps. */
export const ALL: Margins = (["top", "bottom", "left", "right"] as const).reduce(
  (acc, k) => ({ ...acc, [k]: Math.max(...Object.values(PLATFORMS).map((p) => p.m[k])) }),
  {} as Margins,
);

/** Margins as fractions of the frame. */
export function fractions(m: Margins) {
  return { top: m.top / REF_H, bottom: m.bottom / REF_H, left: m.left / REF_W, right: m.right / REF_W };
}

export const marginsFor = (mode: SafeMode): Margins | null =>
  mode === "all" ? ALL : mode === "off" || mode === "title" ? null : PLATFORMS[mode].m;

/** Which app UI covers a point (x, y as 0-1 of a vertical frame), e.g. ["TikTok: like, comment, share"]. */
export function coveredBy(x: number, y: number): string[] {
  const out: string[] = [];
  for (const p of Object.values(PLATFORMS)) {
    const f = fractions(p.m);
    if (y < f.top) out.push(`${p.label}: ${p.ui.top}`);
    else if (y > 1 - f.bottom) out.push(`${p.label}: ${p.ui.bottom}`);
    else if (x > 1 - f.right) out.push(`${p.label}: ${p.ui.right}`);
    else if (x < f.left) out.push(`${p.label}: left edge`);
  }
  return out;
}

export const SAFE_LABEL: Record<SafeMode, string> = {
  off: "Off", all: "All apps", tiktok: "TikTok", reels: "Reels", shorts: "Shorts", title: "Title safe",
};
export const modesFor = (portrait: boolean): SafeMode[] => (portrait ? ["off", "all", "tiktok", "reels", "shorts"] : ["off", "title"]);
