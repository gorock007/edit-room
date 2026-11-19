import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { getProject, type Project } from "./projects.ts";
import { PORT } from "./config.ts";

/** The caption composition gets this tiny time driver injected, so the app (and a still) can seek it frame-exactly. */
export const DRIVER = `<script>
window.__timelines = window.__timelines || {};
window.__room = {
  seek(t) {
    for (const el of document.querySelectorAll('.clip')) {
      const s = +el.dataset.start, d = +el.dataset.duration;
      el.style.visibility = t >= s && t < s + d ? 'visible' : 'hidden';
    }
    const tl = window.__timelines.main || Object.values(window.__timelines)[0];
    if (tl) tl.seek(t, false);
  }
};
</script>`;

const CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
].find((f) => fs.existsSync(f));

/** The one outside script older caption compositions load (build_captions.py's template), pinned to its version. */
const GSAP_CDN = "https://cdn.jsdelivr.net/npm/gsap@3.14.2/";
/**
 * Sent with every caption composition. The page is written by the skill's builders and by Claude, and runs on this
 * server's own origin (in the player's iframe and in a still), so it may load only its own files and the pinned gsap,
 * and may not call anything: no fetch/XHR/WebSocket to the API, no forms, no frames, no plugins.
 */
export const OVERLAY_CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' ${GSAP_CDN}`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

/** Appended to the composition for a still: seek to t once the page and its fonts are loaded. */
export const stillSeek = (t: number) =>
  `<script>addEventListener("load",()=>{const go=()=>{try{window.__room.seek(${t.toFixed(3)})}catch(e){}};go();document.fonts.ready.then(go)});</script>`;

/**
 * The captions and titles exactly as the app draws them at t, as a transparent PNG, so a still for Claude shows what
 * the person saw when they commented. Headless Chrome loads the composition from this server's own overlay route (as
 * the player does), with no file access, under OVERLAY_CSP, and with every other host unreachable. False when it can't be made (no overlay,
 * no Chrome): the caller falls back to the bare picture.
 */
export async function overlayStill(p: Project, t: number, w: number, h: number, out: string): Promise<boolean> {
  // only a real project's own composition (an option or version copy is served under another path)
  if (!p.overlaysDir || !CHROME || getProject(p.id)?.overlaysDir !== p.overlaysDir || !fs.existsSync(path.join(p.overlaysDir, "index.html"))) return false;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "room-still-"));
  try {
    const url = `http://127.0.0.1:${PORT}/overlay/${encodeURIComponent(p.id)}/index.html?still=${t.toFixed(3)}`;
    await new Promise<void>((resolve, reject) => {
      const ch = spawn(CHROME, [
        "--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1", `--user-data-dir=${profile}`, "--no-first-run",
        // nothing leaves this Mac except the pinned gsap: every request goes to a dead proxy but these two
        "--disable-gpu", "--disable-extensions", "--proxy-server=http://127.0.0.1:9", `--proxy-bypass-list=127.0.0.1:${PORT};cdn.jsdelivr.net`,
        `--window-size=${w},${h}`, "--virtual-time-budget=4000", "--default-background-color=00000000", `--screenshot=${out}`, url,
      ], { stdio: "ignore" });
      const timer = setTimeout(() => ch.kill("SIGKILL"), 30_000);
      ch.on("close", (code) => (clearTimeout(timer), code === 0 ? resolve() : reject(new Error(`chrome exited ${code}`))));
      ch.on("error", (e) => (clearTimeout(timer), reject(e)));
    });
    return fs.existsSync(out) && fs.statSync(out).size > 0;
  } catch {
    return false;
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
