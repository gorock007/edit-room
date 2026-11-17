import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { SKILL_DIR } from "./config.ts";
import { draftMediaFiles, mediaStamp, type Project } from "./projects.ts";

const HYPERFRAMES = "hyperframes@0.8.201";

/**
 * Upload-ready export for Instagram Reels and TikTok, straight from the CapCut draft (the skill's export_social.py:
 * 1080x1920 H.264 High 30 fps, AAC 320k 48 kHz, -14 LUFS, true peak under -1 dBTP). The file is kept in the app's
 * data folder (local, so iCloud can't offload it while the phone downloads it) and copied next to the edit.
 */

export type ExportReport = {
  width: number; height: number; fps: string; frames: number; expected_frames: number; video: string; video_mbps: number;
  audio: string; size_mb: number; duration: number; lufs: number; true_peak: number;
};
export type ExportState = {
  status: "none" | "running" | "ready" | "stale" | "failed";
  stage?: string; // "picture 12/30", "encoding 61%"
  error?: string;
  report?: ExportReport;
  savedTo?: string; // the copy next to the edit
  at?: number;
};

const running = new Map<string, { stage: string }>();
const errors = new Map<string, string>();

export const exportFile = (p: Project) => path.join(p.dataDir, "export.mp4");
const metaFile = (p: Project) => path.join(p.dataDir, "export.json");
const draftHash = (p: Project) => {
  try {
    return crypto.createHash("sha1").update(fs.readFileSync(path.join(p.draftDir!, "draft_info.json"))).digest("hex").slice(0, 16);
  } catch {
    return "";
  }
};
const mediaHash = (p: Project) => {
  try {
    return mediaStamp(draftMediaFiles(p.draftDir!));
  } catch {
    return "";
  }
};
/** "1114b 9x16 - Reels & TikTok.mp4": the CapCut project's name, so the user knows which edit it is. */
export const exportName = (p: Project) => `${path.basename(p.draftDir ?? p.name)} - Reels & TikTok.mp4`;

/**
 * The draft's Captions track plays captions.mov, a render of <edit>/overlays/index.html. Edit Room shows that
 * composition live and the agent changes it without re-rendering (cuts ripple captions.json, size tweaks, ...), so
 * the render goes stale while the preview looks right. The export re-renders it first whenever the composition
 * changed since the render, else the delivered captions drift from the speech after every cut.
 */
const captionsRecord = (p: Project) => path.join(p.dataDir, "captions-render.json");
const overlayHash = (p: Project) => {
  try {
    return crypto.createHash("sha1").update(fs.readFileSync(path.join(p.overlaysDir!, "index.html"))).digest("hex").slice(0, 16);
  } catch {
    return "";
  }
};
function captionsFile(p: Project): string | null {
  if (!p.draftDir || !p.overlaysDir) return null;
  try {
    const d = JSON.parse(fs.readFileSync(path.join(p.draftDir, "draft_info.json"), "utf8"));
    const seg = d.tracks?.find((t: any) => t.type === "video" && t.name === "Captions")?.segments?.[0];
    const m = seg && d.materials.videos.find((v: any) => v.id === seg.material_id);
    const file = m?.path?.replace(/##_draftpath_placeholder_[^#]*_##/, p.draftDir);
    return file && path.basename(file) === "captions.mov" ? file : null;
  } catch {
    return null;
  }
}
function captionsStale(p: Project): boolean {
  const file = captionsFile(p);
  if (!file) return false;
  if (!fs.existsSync(file)) return true;
  try {
    const r = JSON.parse(fs.readFileSync(captionsRecord(p), "utf8"));
    if (r.stamp === mediaStamp([file])) return r.overlay !== overlayHash(p);
  } catch {}
  // rendered outside the app (the skill, an agent): trust it only if it is newer than the composition
  return fs.statSync(file).mtimeMs < fs.statSync(path.join(p.overlaysDir!, "index.html")).mtimeMs;
}

function renderCaptions(p: Project, work: string, onStage: (s: string) => void): Promise<void> {
  const file = captionsFile(p)!;
  const out = path.join(work, "captions.mov");
  const want = JSON.parse(fs.readFileSync(path.join(p.draftDir!, "draft_info.json"), "utf8")).duration / 1e6;
  const hash = overlayHash(p);
  return new Promise((resolve, reject) => {
    const ch = spawn("npx", ["--yes", HYPERFRAMES, "render", ".", "--format", "mov", "--no-browser-gpu", "-w", "2", "-o", out],
      { cwd: p.overlaysDir!, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    const take = (b: Buffer) => {
      const s = b.toString();
      log = (log + s).slice(-4000);
      const pct = [...s.matchAll(/(\d{1,3})%/g)].pop();
      if (pct) onStage(`captions ${Math.min(99, +pct[1])}%`);
    };
    ch.stdout.on("data", take);
    ch.stderr.on("data", take);
    ch.on("close", (code) => {
      if (code !== 0) return reject(new Error(`caption render failed: ${log.trim().split("\n").slice(-4).join("\n")}`));
      const pr = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]);
      let dur = "";
      pr.stdout.on("data", (b) => (dur += b));
      pr.on("close", () => {
        if (Math.abs(+dur - want) > 1.5 / 30)
          return reject(new Error(`caption render is ${(+dur).toFixed(2)} s but the cut is ${want.toFixed(2)} s; rebuild captions (build_captions.py) first`));
        // swap in place (same name the draft points at), atomically
        fs.copyFileSync(out, file + ".tmp");
        fs.renameSync(file + ".tmp", file);
        fs.writeFileSync(captionsRecord(p), JSON.stringify({ overlay: hash, stamp: mediaStamp([file]), at: Date.now() }));
        resolve();
      });
    });
  });
}

/** Rebuild index.html with the overlay's own build_captions.py. Returns an error message, or null when fine. */
function relayCaptions(p: Project): string | null {
  const dir = p.overlaysDir;
  if (!dir || !fs.existsSync(path.join(dir, "build_captions.py")) || !fs.existsSync(path.join(dir, "captions.json"))) return null;
  const r = spawnSync("python3", ["-I", "build_captions.py"], { cwd: dir, encoding: "utf8", timeout: 60_000 });
  if (r.status === 0) return null;
  const why = `${r.stderr ?? ""}${r.stdout ?? ""}`.trim().split("\n").slice(-3).join("\n") || String(r.error ?? "unknown error");
  return `captions could not be laid out (build_captions.py): ${why}`;
}

export function exportState(p: Project): ExportState {
  const r = running.get(p.id);
  if (r) return { status: "running", stage: r.stage };
  if (errors.has(p.id)) return { status: "failed", error: errors.get(p.id) };
  if (!fs.existsSync(metaFile(p)) || !fs.existsSync(exportFile(p))) return { status: "none" };
  const m = JSON.parse(fs.readFileSync(metaFile(p), "utf8"));
  // exports written before media was tracked have no m.media; they go stale only on a draft change
  const fresh = m.hash === draftHash(p) && (m.media === undefined || m.media === mediaHash(p))
    && (m.overlay === undefined || m.overlay === overlayHash(p)) && !captionsStale(p);
  return { status: fresh ? "ready" : "stale", report: m.report, savedTo: m.savedTo, at: m.at };
}

export function startExport(p: Project, onChange: () => void): ExportState {
  if (!p.draftDir) throw new Error("this edit has no CapCut draft yet");
  if (running.has(p.id)) return exportState(p);
  errors.delete(p.id);
  // lay the captions out again from the draft as it is now (build_captions.py reads where the cards and wall
  // titles are), so a change made after the captions were built can't put a caption on top of a graphic
  const relaid = relayCaptions(p);
  if (relaid) {
    errors.set(p.id, relaid);
    onChange();
    return exportState(p);
  }
  const overlay = p.overlaysDir ? overlayHash(p) : undefined;
  const work = path.join(os.homedir(), "Movies", "claude_render", "edit-room-export", p.id);
  const tmp = path.join(p.dataDir, "export.tmp.mp4");
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const state = { stage: "starting" };
  running.set(p.id, state);
  const fail = (e: unknown) => {
    running.delete(p.id);
    errors.set(p.id, String((e as Error).message ?? e));
    onChange();
  };
  const captions = captionsStale(p)
    ? (state.stage = "captions", renderCaptions(p, work, (s) => { if (s !== state.stage) { state.stage = s; onChange(); } }))
    : Promise.resolve();
  captions.then(() => encode(p, work, tmp, state, overlay, onChange)).catch(fail);
  onChange();
  return exportState(p);
}

function encode(p: Project, work: string, tmp: string, state: { stage: string }, overlay: string | undefined, onChange: () => void) {
  // hashed after the caption render, so the swapped captions.mov counts as what this export was made from
  const hash = draftHash(p), media = mediaHash(p);
  let parts = 0, frames = 0, total = 0, out = "", err = "";
  const ch = spawn("python3", ["-I", path.join(SKILL_DIR, "scripts/export_social.py"), p.draftDir!, work, tmp], { stdio: ["ignore", "pipe", "pipe"] });
  const tick = () => onChange();
  ch.stdout.on("data", (b) => {
    out += b.toString();
    const m = [...out.matchAll(/picture (\d+) parts/g)].pop();
    if (m && +m[1] !== parts) {
      parts = +m[1];
      state.stage = `picture: ${parts} cuts`;
      tick();
    }
  });
  ch.stderr.on("data", (b) => {
    const s = b.toString();
    err = (err + s).slice(-4000);
    const f = [...s.matchAll(/frame=\s*(\d+)/g)].pop();
    if (f) {
      frames = +f[1];
      total ||= Math.round(JSON.parse(fs.readFileSync(path.join(p.draftDir!, "draft_info.json"), "utf8")).duration / 1e6 * 30);
      const pct = Math.min(99, Math.round((frames / total) * 100));
      const next = `encoding ${pct}%`;
      if (next !== state.stage) {
        state.stage = next;
        tick();
      }
    }
  });
  ch.on("close", (code) => {
    running.delete(p.id);
    try {
      const line = out.trim().split("\n").pop() ?? "";
      if (code !== 0) throw new Error((err.trim().split("\n").slice(-4).join("\n") || line || `export failed (${code})`).slice(-900));
      const report: ExportReport = JSON.parse(line);
      fs.renameSync(tmp, exportFile(p));
      // a copy next to the edit, for Finder / Files on the phone
      let savedTo: string | undefined = path.join(p.editDir, exportName(p));
      try {
        fs.copyFileSync(exportFile(p), savedTo);
      } catch {
        savedTo = undefined;
      }
      fs.writeFileSync(metaFile(p), JSON.stringify({ hash, media, overlay, report, savedTo, at: Date.now() }));
      fs.rmSync(work, { recursive: true, force: true });
    } catch (e) {
      errors.set(p.id, String((e as Error).message ?? e));
      fs.rmSync(tmp, { force: true });
    }
    onChange();
  });
}
