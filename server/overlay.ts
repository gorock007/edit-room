import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Project } from "./projects.ts";

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

/**
 * The captions and titles exactly as the app draws them at t, as a transparent PNG (headless Chrome), so a still for
 * Claude shows what the person saw when they commented. False when it can't be made (no overlay, no Chrome): the
 * caller falls back to the bare picture.
 */
export async function overlayStill(p: Project, t: number, w: number, h: number, out: string): Promise<boolean> {
  if (!p.overlaysDir || !CHROME || !fs.existsSync(path.join(p.overlaysDir, "index.html"))) return false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-still-"));
  try {
    // the composition's own folder, linked, so its fonts and scripts load as they do in the app
    for (const n of fs.readdirSync(p.overlaysDir)) if (n !== "index.html") fs.symlinkSync(path.join(p.overlaysDir, n), path.join(dir, n));
    const seek = `<script>addEventListener("load",()=>{const go=()=>{try{window.__room.seek(${t.toFixed(3)})}catch(e){}};go();document.fonts.ready.then(go)});</script>`;
    const html = fs.readFileSync(path.join(p.overlaysDir, "index.html"), "utf8").replace("<head>", "<head>" + DRIVER).replace(/<\/body>/i, seek + "</body>");
    fs.writeFileSync(path.join(dir, "still.html"), html);
    await new Promise<void>((resolve, reject) => {
      const ch = spawn(CHROME, [
        "--headless=new", "--hide-scrollbars", "--allow-file-access-from-files", "--force-device-scale-factor=1",
        `--user-data-dir=${path.join(dir, ".chrome")}`, "--no-first-run", "--disable-gpu",
        `--window-size=${w},${h}`, "--virtual-time-budget=4000", "--default-background-color=00000000",
        `--screenshot=${out}`, `file://${path.join(dir, "still.html")}`,
      ], { stdio: "ignore" });
      const timer = setTimeout(() => ch.kill("SIGKILL"), 30_000);
      ch.on("close", (code) => (clearTimeout(timer), code === 0 ? resolve() : reject(new Error(`chrome exited ${code}`))));
      ch.on("error", (e) => (clearTimeout(timer), reject(e)));
    });
    return fs.existsSync(out) && fs.statSync(out).size > 0;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
