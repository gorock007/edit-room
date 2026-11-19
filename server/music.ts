/**
 * The music bank: the user's `background music/` folder, measured by the edit skill's music_catalog.py into
 * catalog.json (length, loudness, BPM, beats, hits). New edit offers its tracks; a shared reel's music lands in
 * `background music/from reels/`. Tracks dropped into the folder by hand are measured the next time it's listed.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SKILL_DIR, VIDEO_ROOT } from "./config.ts";

export const MUSIC_DIR = path.join(VIDEO_ROOT, "background music");
const CATALOG = path.join(MUSIC_DIR, "catalog.json");
const SCRIPT = path.join(SKILL_DIR, "scripts/music_catalog.py");
const AUDIO = /\.(mp3|m4a|aac|wav|aif|aiff|flac|ogg|opus|mp4|mov|m4v)$/i;

export type Track = {
  path: string; // relative to the bank, e.g. "from reels/patsunrick - DfupE6yRZBl.m4a"
  name: string;
  folder: string; // "" or "from reels"
  lengthS: number | null;
  bpm: number | null;
  lufs: number | null;
  firstBeatS: number | null;
  from: { handle: string | null; link: string | null; kind: string | null } | null;
  note: string | null;
};
export type MusicList = { tracks: Track[]; measuring: number };

function walk(dir: string, rel = ""): string[] {
  let out: string[] = [];
  for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    if (e.name.startsWith(".")) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out = out.concat(walk(path.join(dir, e.name), r));
    else if (AUDIO.test(e.name)) out.push(r);
  }
  return out;
}

function readCatalog(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(CATALOG, "utf8")).tracks ?? {};
  } catch {
    return {};
  }
}

let measuring: Promise<void> | null = null;
/** Measure whatever isn't in the catalog yet (one run at a time); onDone tells the app to refresh its list. */
function measureNew(onDone: () => void) {
  if (measuring) return;
  measuring = new Promise<void>((resolve) => {
    const ch = spawn("python3", ["-I", SCRIPT, MUSIC_DIR], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    ch.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    ch.on("close", (code) => {
      if (code) console.error(`music_catalog failed (${code}): ${err.trim().split("\n").pop()}`);
      measuring = null;
      resolve();
      onDone();
    });
    ch.on("error", () => ((measuring = null), resolve()));
  });
}

export function listMusic(onMeasured: () => void): MusicList {
  const cat = readCatalog();
  const files = walk(MUSIC_DIR);
  const missing = files.filter((f) => {
    const c = cat[f];
    if (!c) return true;
    try {
      const st = fs.statSync(path.join(MUSIC_DIR, f));
      return c.size !== st.size || c.mtime !== Math.floor(st.mtimeMs / 1000);
    } catch {
      return false;
    }
  });
  if (missing.length) measureNew(onMeasured);
  const tracks: Track[] = files
    .filter((f) => cat[f] && cat[f].kind === "music")
    .map((f) => {
      const c = cat[f];
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      const src = c.source && typeof c.source === "object" ? c.source : null;
      return {
        path: f,
        name: path.basename(f).replace(AUDIO, ""),
        folder: path.dirname(f) === "." ? "" : path.dirname(f),
        lengthS: num(c.length_s),
        bpm: num(c.bpm),
        lufs: num(c.lufs),
        firstBeatS: num(c.first_beat_s),
        from: src ? { handle: src.handle ?? null, link: src.link ?? null, kind: src.kind ?? null } : null,
        note: typeof c.note === "string" ? c.note : null,
      };
    })
    // the user's own picks first, then reel music; newest names don't matter, keep it alphabetical
    .sort((a, b) => (a.folder === b.folder ? a.name.localeCompare(b.name) : a.folder ? 1 : -1));
  return { tracks, measuring: missing.length };
}

/** A track in the bank by its relative path, or null (never anything outside the bank). */
export function musicFile(rel: string): string | null {
  if (typeof rel !== "string" || !rel || rel.length > 400 || !AUDIO.test(rel)) return null;
  const full = path.resolve(MUSIC_DIR, rel);
  if (!full.startsWith(MUSIC_DIR + path.sep)) return null;
  try {
    return fs.statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

/** The catalog entry for a track (for the build prompt), or null. */
export function musicInfo(rel: string): Record<string, any> | null {
  return musicFile(rel) ? readCatalog()[rel] ?? null : null;
}
