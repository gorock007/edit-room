import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { SKILL_DIR } from "./config.ts";
import { draftMediaFiles, mediaStamp, type Project } from "./projects.ts";

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

export function exportState(p: Project): ExportState {
  const r = running.get(p.id);
  if (r) return { status: "running", stage: r.stage };
  if (errors.has(p.id)) return { status: "failed", error: errors.get(p.id) };
  if (!fs.existsSync(metaFile(p)) || !fs.existsSync(exportFile(p))) return { status: "none" };
  const m = JSON.parse(fs.readFileSync(metaFile(p), "utf8"));
  // exports written before media was tracked have no m.media; they go stale only on a draft change
  const fresh = m.hash === draftHash(p) && (m.media === undefined || m.media === mediaHash(p));
  return { status: fresh ? "ready" : "stale", report: m.report, savedTo: m.savedTo, at: m.at };
}

export function startExport(p: Project, onChange: () => void): ExportState {
  if (!p.draftDir) throw new Error("this edit has no CapCut draft yet");
  if (running.has(p.id)) return exportState(p);
  errors.delete(p.id);
  const hash = draftHash(p), media = mediaHash(p);
  const work = path.join(os.homedir(), "Movies", "claude_render", "edit-room-export", p.id);
  const tmp = path.join(p.dataDir, "export.tmp.mp4");
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const state = { stage: "starting" };
  running.set(p.id, state);
  let parts = 0, frames = 0, total = 0, out = "", err = "";
  const ch = spawn("python3", ["-I", path.join(SKILL_DIR, "scripts/export_social.py"), p.draftDir, work, tmp], { stdio: ["ignore", "pipe", "pipe"] });
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
      fs.writeFileSync(metaFile(p), JSON.stringify({ hash, media, report, savedTo, at: Date.now() }));
      fs.rmSync(work, { recursive: true, force: true });
    } catch (e) {
      errors.set(p.id, String((e as Error).message ?? e));
      fs.rmSync(tmp, { force: true });
    }
    onChange();
  });
  onChange();
  return exportState(p);
}
