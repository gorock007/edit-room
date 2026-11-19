/**
 * Shots: house-style edits' footage b-roll (the draft's B-roll track) and montage edits' shot lists can be swapped
 * like a CapCut template's slots. Montage edits: (wild card templates such as "Usage limit reached") are a list of shots on the music's beat
 * grid (edit-data/montage.json). Like a CapCut template, any shot can be swapped for another clip, keeping its length:
 * pick a clip from the footage folders (or the phone), pick which part of it, save. Only that shot is re-rendered
 * (the skill's montage_render.py), so the beat timing never moves. Swaps are logged next to the template so later
 * builds learn what the user takes out and puts in.
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR, SKILL_DIR, VIDEO_ROOT, inside } from "./config.ts";
import { readModel, type Project } from "./projects.ts";
import { libraryFolders } from "./uploads.ts";
import { TEMPLATES_DIR, templateStory } from "./wildcards.ts";

const FPS = 30;
const VIDEO = /\.(mp4|mov|m4v|mts|m2ts|mxf|avi|mkv)$/i;
const INDEX = path.join(VIDEO_ROOT, ".broll-index.json");
const PY = "python3";
const RENDER = path.join(SKILL_DIR, "scripts/montage_render.py");
const PICK = path.join(SKILL_DIR, "scripts/broll_index.py");
const CACHE = path.join(DATA_DIR, "library");
const GRADE = path.join(SKILL_DIR, "scripts/prep_broll.py");
const US = 1_000_000;

export class ShotError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

type Clip = { part: string; file: string | null; src?: number; frames: number; fit?: string; cx?: number; cy?: number; zoom?: number; h?: number; ay?: number; shows?: string; why?: string };
export type Shot = {
  /** montage: index in montage.json; b-roll: index on the draft's B-roll track */
  i: number;
  /** 1-based number shown to the user */
  n: number;
  /** tall = a full 9:16 frame, strip = the wide band of a montage, wide = a full 16:9 frame */
  frame: "tall" | "strip" | "wide" | null;
  part: string;
  file: string | null;
  name: string | null;
  src: number | null;
  frames: number;
  dur: number;
  start: number;
  needs: "portrait" | "landscape" | null;
  shows: string | null;
  why: string | null;
  cx: number;
  sig: string;
};

const montageFile = (p: Project) => path.join(p.editDir, "edit-data", "montage.json");
const readJson = <T,>(f: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as T;
  } catch {
    return null;
  }
};
export type ShotMode = "montage" | "broll";
export function shotMode(p: Project): ShotMode | null {
  if (fs.existsSync(montageFile(p))) return "montage";
  try {
    return brollSegs(p).segs.length ? "broll" : null;
  } catch {
    return null;
  }
}
export const hasShots = (p: Project) => shotMode(p) !== null;
const plan = (p: Project) => {
  const m = readJson<{ clips: Clip[]; music?: string }>(montageFile(p));
  if (!m || !Array.isArray(m.clips)) throw new ShotError(404, "This edit has no shot list.");
  return m;
};
const mainSrc = (p: Project) => readJson<{ main_src?: string }>(path.join(p.editDir, "edit-data", "build_cfg.json"))?.main_src ?? null;
const manifest = (p: Project) => {
  const m = mainSrc(p);
  return (m && readJson<Record<string, string>>(path.join(path.dirname(m), "montage_pieces", "manifest.json"))) || {};
};
const styleOf = (p: Project) => readJson<{ style?: string }>(path.join(p.editDir, "edit-data", "build_cfg.json"))?.style ?? null;

/** Where a montage file lives, relative to the video folder (montage.json may hold a bare name from older builds). */
function relOf(f: string | null): string | null {
  if (!f) return null;
  const abs = path.isAbsolute(f) ? f : path.join(VIDEO_ROOT, f);
  if (fs.existsSync(abs)) return path.relative(VIDEO_ROOT, abs);
  const idx = readJson<{ files: Record<string, unknown> }>(INDEX)?.files ?? {};
  const hits = Object.keys(idx).filter((r) => path.basename(r) === path.basename(f));
  return hits.length === 1 ? hits[0] : f;
}

export type ShotList = { mode: ShotMode; shots: Shot[]; story: ReturnType<typeof templateStory>; style: string | null; total: number };
export function listShots(p: Project): ShotList {
  if (shotMode(p) === "broll") return brollList(p);
  const m = plan(p);
  const man = manifest(p);
  let start = 0;
  const shots = m.clips.map((c, i): Shot => {
    const frames = Math.max(1, Math.round(Number(c.frames) || 1));
    const s: Shot = {
      i,
      n: i + 1,
      frame: c.file === null ? null : c.fit === "fill" ? "tall" : "strip",
      part: String(c.part ?? "shot"),
      file: relOf(c.file),
      name: c.file ? path.basename(c.file) : null,
      src: typeof c.src === "number" ? c.src : null,
      frames,
      dur: frames / FPS,
      start: start / FPS,
      needs: c.file === null ? null : c.fit === "fill" ? "portrait" : "landscape",
      shows: c.shows ? String(c.shows).slice(0, 200) : null,
      why: c.why ? String(c.why).slice(0, 300) : null,
      cx: typeof c.cx === "number" ? c.cx : 0.5,
      sig: man[String(i)] ?? "x",
    };
    start += frames;
    return s;
  });
  const style = styleOf(p);
  return { mode: "montage", shots, story: templateStory(style), style, total: start / FPS };
}

/** A shot's thumbnail, from the rendered montage (exactly as it looks in the edit), cached by its render signature. */
export function shotThumb(p: Project, i: number): string | null {
  if (shotMode(p) === "broll") return brollThumb(p, i);
  const m = mainSrc(p);
  const tl = readJson<{ src: number; dur: number }[]>(path.join(p.editDir, "edit-data", "timeline.json"));
  if (!m || !tl?.[i] || !fs.existsSync(m)) return null;
  const sig = manifest(p)[String(i)] ?? "x";
  const dir = path.join(p.dataDir, "shots");
  const out = path.join(dir, `${i}-${sig}.jpg`);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f.startsWith(`${i}-`)) fs.rmSync(path.join(dir, f), { force: true });
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-ss", String(tl[i].src + tl[i].dur / 2), "-i", m, "-frames:v", "1", "-vf", "scale=216:-2", out], { timeout: 20_000 });
  return r.status === 0 && fs.existsSync(out) ? out : null;
}

// ---- the footage a shot can come from ----

const hashOf = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

/**
 * A clip a swap may use: in one of the footage folders, this edit's own raw/, resources/ or shots/ (phone uploads), or
 * anywhere Browse can reach on this Mac (home folders, a camera card). `rel` is relative to the video folder, or a
 * full path for a browsed clip.
 */
export function allowedClip(p: Project, rel: unknown): string {
  if (typeof rel !== "string" || !rel || rel.length > 1000 || !VIDEO.test(rel)) throw new ShotError(400, "Pick a video clip.");
  const abs = path.resolve(VIDEO_ROOT, rel);
  const roots = [...libraryFolders().map((f) => path.join(VIDEO_ROOT, f.name)), ...["raw", "resources", "shots"].map((d) => path.join(p.editDir, d))];
  if (!fs.existsSync(abs) || !(inside(abs, roots) || browsable(abs))) throw new ShotError(400, "That clip can't be used (it isn't in your folders, or it's gone: is the card still in?).");
  return abs;
}

// ---- Browse: any folder on this Mac (home folders, a camera card), from the Mac or the phone ----

const HOME = os.homedir();
const hiddenIn = (abs: string) => abs.split(path.sep).some((seg) => seg.startsWith("."));
/** Home (not ~/Library, except the video folder in iCloud Drive) and mounted cards/drives; never hidden folders. */
function browsable(abs: string): boolean {
  let r: string;
  try {
    r = fs.realpathSync(abs);
  } catch {
    return false;
  }
  if (hiddenIn(r)) return false;
  if (inside(r, [VIDEO_ROOT])) return true;
  if (inside(r, [path.join(HOME, "Library")])) return false;
  if (inside(r, [HOME])) return true;
  return r.startsWith("/Volumes/") && r.split(path.sep).length > 2;
}

export function browseRoots(): { name: string; path: string }[] {
  const out = [{ name: "Video Editor", path: VIDEO_ROOT }];
  for (const n of ["Desktop", "Downloads", "Movies", "Documents"]) if (fs.existsSync(path.join(HOME, n))) out.push({ name: n, path: path.join(HOME, n) });
  let vols: string[] = [];
  try {
    vols = fs.readdirSync("/Volumes");
  } catch {}
  for (const v of vols) {
    const base = path.join("/Volumes", v);
    // the Mac's own disk resolves to / and is left out, and so are macOS's helper volumes
    if (v.startsWith(".") || /^(Recovery|Preboot|VM|Update|Data)$/i.test(v) || !browsable(base)) continue;
    // camera cards: straight to the clips (Sony PRIVATE/M4ROOT/CLIP, others DCIM)
    const deep = ["PRIVATE/M4ROOT/CLIP", "DCIM"].map((d) => path.join(base, d)).find((d) => fs.existsSync(d));
    out.push({ name: v, path: deep ?? base });
  }
  return out;
}

export type BrowseList = {
  dir: string | null;
  parent: string | null;
  roots: { name: string; path: string }[];
  dirs: { name: string; path: string }[];
  clips: { name: string; path: string; size: number; mtime: number }[];
};
export function browse(dir: unknown): BrowseList {
  const roots = browseRoots();
  if (typeof dir !== "string" || !dir) return { dir: null, parent: null, roots, dirs: [], clips: [] };
  const abs = path.resolve(dir);
  if (!browsable(abs) || !fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) throw new ShotError(400, "That folder can't be opened.");
  const dirs: BrowseList["dirs"] = [];
  const clips: BrowseList["clips"] = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const f = path.join(abs, e.name);
    if (e.isDirectory()) {
      if (dirs.length < 400 && browsable(f)) dirs.push({ name: e.name, path: f });
    } else if (VIDEO.test(e.name) && clips.length < 600) {
      const st = fs.statSync(f, { throwIfNoEntry: false });
      if (st?.isFile()) clips.push({ name: e.name, path: f, size: st.size, mtime: st.mtimeMs });
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  clips.sort((a, b) => b.mtime - a.mtime); // newest first: what you just shot
  const up = path.dirname(abs);
  return { dir: abs, parent: up !== abs && browsable(up) ? up : null, roots, dirs, clips };
}

/**
 * A montage renders from its source files whenever a shot changes, so a clip from outside the video folder (a card
 * that will be ejected, Downloads) is copied in first: only the chosen part plus a second either side, 10-bit HEVC,
 * into the edit's shots/ folder. Returns where montage.json should point.
 */
export async function keepLocal(p: Project, abs: string, src: number, dur: number): Promise<{ file: string; src: number }> {
  if (inside(abs, [VIDEO_ROOT])) return { file: path.relative(VIDEO_ROOT, abs), src };
  const pre = Math.min(1, src);
  const from = src - pre;
  const dir = shotsDirOf(p);
  fs.mkdirSync(dir, { recursive: true });
  const stem = path.basename(abs).replace(/\.[^.]+$/, "").replace(/[^\w .-]+/g, "_").slice(0, 60);
  const out = path.join(dir, `${stem} from ${from.toFixed(2)}s.mp4`);
  const st = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_primaries,color_transfer,color_space", "-of", "json", abs], { encoding: "utf8", timeout: 60_000 });
  const c = JSON.parse(st.stdout || "{}").streams?.[0] ?? {};
  const tag = (flag: string, v: unknown) => (typeof v === "string" && /^[\w-]+$/.test(v) && v !== "unknown" ? [flag, v] : []);
  const tmp = out + ".part.mp4";
  await run("ffmpeg", ["-nostdin", "-v", "error", "-y", "-ss", from.toFixed(3), "-t", (pre + dur + 1).toFixed(3), "-i", abs, "-map", "0:v:0", "-c:v", "hevc_videotoolbox", "-profile:v", "main10", "-pix_fmt", "p010le", "-b:v", "80M", "-tag:v", "hvc1",
    ...tag("-color_primaries", c.color_primaries), ...tag("-color_trc", c.color_transfer), ...tag("-colorspace", c.color_space), "-an", tmp]).catch((e) => {
    fs.rmSync(tmp, { force: true });
    throw e;
  });
  fs.renameSync(tmp, out);
  return { file: path.relative(VIDEO_ROOT, out), src: Math.round(pre * 1000) / 1000 };
}

type Probe = { w: number; h: number; orientation: "landscape" | "portrait" | "square"; duration: number };
function probe(abs: string): Probe {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:stream_side_data=rotation:format=duration", "-of", "json", abs], { encoding: "utf8", timeout: 60_000 });
  const j = JSON.parse(r.stdout || "{}");
  const st = j.streams?.[0] ?? {};
  const rot = Number((st.side_data_list ?? []).find((x: any) => "rotation" in x)?.rotation ?? 0);
  let [w, h] = [Number(st.width) || 0, Number(st.height) || 0];
  if (Math.abs(rot) % 180 === 90) [w, h] = [h, w];
  if (!w || !h) throw new ShotError(400, "That file has no picture.");
  return { w, h, orientation: w > h * 1.05 ? "landscape" : h > w * 1.05 ? "portrait" : "square", duration: Number(j.format?.duration) || 0 };
}

/** Clips of the shape a shot needs: the footage folders' index plus anything uploaded to this edit. */
export function clipsFor(p: Project, needs: "portrait" | "landscape", cropH = 2000) {
  const idx = readJson<{ files: Record<string, any> }>(INDEX)?.files ?? {};
  const folders = new Set(libraryFolders().map((f) => f.name));
  const out: { file: string; name: string; w: number; h: number; duration: number; screens: number; outdoors: number; people: number; best: number; mine: boolean; at: number }[] = [];
  for (const [rel, e] of Object.entries(idx)) {
    if (!folders.has(rel.split("/")[0]) || !e?.orientation || e.error) continue;
    // a full 9:16 shot can also be cropped from a 4K landscape clip
    const fits = e.orientation === needs || (needs === "portrait" && e.orientation === "landscape" && e.h >= cropH);
    if (!fits) continue;
    // thumbnail at its best-looking moment
    const ms: any[] = Array.isArray(e.moments) ? e.moments : [];
    const top = ms.reduce((a: any, b: any) => ((b.a ?? 0) > (a?.a ?? -1) ? b : a), null);
    out.push({ file: rel, name: path.basename(rel), w: e.w, h: e.h, duration: e.duration_s ?? 0, screens: e.share?.screens ?? 0, outdoors: e.share?.outdoors ?? 0, people: e.share?.people ?? 0, best: e.best_a ?? 0, mine: false, at: top?.t ?? Math.min(1, (e.duration_s ?? 0) / 2) });
  }
  for (const d of ["shots", "resources", "raw"]) {
    const dir = path.join(p.editDir, d);
    for (const n of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!VIDEO.test(n) || n.startsWith(".")) continue;
      try {
        const pr = probe(path.join(dir, n));
        if (pr.orientation !== needs && !(needs === "portrait" && pr.orientation === "landscape" && pr.h >= cropH)) continue;
        out.push({ file: path.relative(VIDEO_ROOT, path.join(dir, n)), name: n, w: pr.w, h: pr.h, duration: pr.duration, screens: 0, outdoors: 0, people: 0, best: 0, mine: true, at: Math.min(1, pr.duration / 2) });
      } catch {}
    }
  }
  // the edit's own uploads first, then clips with no screens and good-looking moments
  return out.sort((a, b) => Number(b.mine) - Number(a.mine) || a.screens - b.screens || b.best - a.best);
}

/** The picker's best moments for a shot (story rules from the template), minus moments the edit already uses. */
export function suggestions(p: Project, i: number): Promise<{ file: string; t: number; labels: string[]; score: number }[]> {
  const { shots, story, mode } = listShots(p);
  const s = shots.find((x) => x.i === i);
  const cropH = mode === "broll" ? BROLL_CROP_H : 2000;
  if (!s || !s.needs) return Promise.resolve([]);
  const args = ["-I", PICK, "--pick", "--json", "--shape", s.needs === "portrait" ? "any" : "landscape", "--len", s.dur.toFixed(2), "--top", "40", "--per-clip", "3", "--gap", "2"];
  if (story?.never.length) args.push("--avoid", story.never.join(","));
  if (story?.show.length) args.push("--want", story.show.join(","));
  // a person alone isn't the story: a moment must also show one of its places or things (outdoors, food...)
  const need = story?.show.filter((g) => g !== "people") ?? [];
  if (need.length) args.push("--need", need.join(","));
  return new Promise((resolve) => {
    const ch = spawn(PY, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    ch.stdout.on("data", (d) => (out += d));
    ch.on("close", () => {
      let rows: any[] = [];
      try {
        rows = JSON.parse(out);
      } catch {}
      const used = shots.filter((x) => x.file && x.src != null).map((x) => ({ f: x.file!, a: x.src!, b: x.src! + x.dur }));
      const clipW = (rel: string) => readJson<{ files: Record<string, any> }>(INDEX)?.files?.[rel];
      resolve(
        rows
          .filter((r) => !used.some((u) => u.f === r.file && r.t < u.b + 1 && r.t + s.dur > u.a - 1))
          .filter((r) => s.needs !== "portrait" || r.shape === "portrait" || (clipW(r.file)?.h ?? 0) >= cropH)
          .slice(0, 9)
          .map((r) => ({ file: r.file, t: r.t, labels: (r.labels ?? []).slice(0, 4), score: r.score })),
      );
    });
    ch.on("error", () => resolve([]));
  });
}

/** One frame of a clip (for picker thumbnails), cached. A few at a time: a card full of 4K clips must not stall the room. */
let framing = 0;
const frameQueue: (() => void)[] = [];
export async function clipFrame(p: Project, rel: unknown, t: unknown): Promise<string | null> {
  const abs = allowedClip(p, rel);
  const at = Math.max(0, Math.min(86_400, Number(t) || 0));
  const out = path.join(CACHE, "frames", `${hashOf(abs)}-${at.toFixed(2)}.jpg`);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (framing >= 3) await new Promise<void>((r) => frameQueue.push(r));
  framing++;
  try {
    await run("ffmpeg", ["-nostdin", "-v", "error", "-y", "-ss", at.toFixed(2), "-i", abs, "-frames:v", "1", "-vf", "scale=320:-2", out]).catch(() => {});
  } finally {
    framing--;
    frameQueue.shift()?.();
  }
  return fs.existsSync(out) ? out : null;
}

// A small H.264 copy of a clip for scrubbing on the phone (4K HEVC / 10-bit camera files don't play everywhere).
const previewJobs = new Map<string, Promise<void>>();
export function clipPreview(p: Project, rel: unknown): { state: "ready" | "working" | "failed"; file?: string } {
  const abs = allowedClip(p, rel);
  const st = fs.statSync(abs);
  const out = path.join(CACHE, "previews", `${hashOf(`${abs}:${st.size}:${st.mtimeMs}`)}.mp4`);
  if (fs.existsSync(out)) return { state: "ready", file: out };
  if (!previewJobs.has(out)) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const tmp = out + ".tmp.mp4";
    previewJobs.set(
      out,
      new Promise<void>((resolve) => {
        const ch = spawn("ffmpeg", ["-nostdin", "-v", "error", "-y", "-i", abs, "-vf", "scale=-2:540:flags=bicubic,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-g", "15", "-an", "-movflags", "+faststart", tmp], { stdio: "ignore" });
        ch.on("close", (code) => {
          if (code === 0) fs.renameSync(tmp, out);
          else fs.rmSync(tmp, { force: true });
          setTimeout(() => previewJobs.delete(out), code === 0 ? 0 : 60_000);
          resolve();
        });
        ch.on("error", () => resolve());
      }),
    );
  }
  return { state: "working" };
}
export const previewFile = (f: string) => (inside(f, [path.join(CACHE, "previews")]) && fs.existsSync(f) ? f : null);

// ---- swapping ----

/** Run the montage renderer (only changed shots are re-rendered). */
export function renderMontage(p: Project): Promise<void> {
  return new Promise((resolve, reject) => {
    const ch = spawn(PY, ["-I", RENDER, p.editDir], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    ch.stdout.on("data", (d) => (out += d));
    ch.stderr.on("data", (d) => (err = (err + d).slice(-3000)));
    ch.on("close", (code) => {
      if (code === 0) return resolve();
      let msg = err.trim().split("\n").pop() ?? `exit ${code}`;
      try {
        msg = (JSON.parse(out.trim().split("\n").pop() || "{}").errors ?? [msg]).join("; ");
      } catch {}
      reject(new ShotError(500, `Rendering failed: ${msg}`));
    });
    ch.on("error", (e) => reject(new ShotError(500, String(e.message))));
  });
}

export type SwapReq = { file?: unknown; src?: unknown; cx?: unknown; cy?: unknown; zoom?: unknown };
/** Change shot i in montage.json (same length); returns what changed, for the comment and the swap log. */
export function applySwap(p: Project, i: number, b: SwapReq, from?: { name: string; src: number }) {
  const m = plan(p);
  const c = m.clips[i];
  if (!c || c.file === null) throw new ShotError(400, "That shot can't be swapped.");
  const abs = allowedClip(p, b.file);
  const pr = probe(abs);
  const fill = c.fit === "fill";
  if (!fill && pr.orientation !== "landscape") throw new ShotError(400, "This shot is a wide strip: pick a horizontal (landscape) clip.");
  if (fill && pr.orientation === "landscape" && pr.h < 2000) throw new ShotError(400, "This shot fills the whole 9:16 frame: pick a vertical clip, or a 4K horizontal one to crop from.");
  const dur = c.frames / FPS;
  const src = Number(b.src);
  if (!Number.isFinite(src) || src < 0 || src + dur > pr.duration + 0.01) throw new ShotError(400, `Pick a ${dur.toFixed(2)} s part inside the clip.`);
  const clamp01 = (v: unknown, d: number) => (v != null && Number.isFinite(Number(v)) ? Math.max(0, Math.min(1, Number(v))) : d);
  const before = { file: relOf(c.file), src: c.src ?? null, shows: c.shows ?? null };
  const rel = path.relative(VIDEO_ROOT, abs);
  c.file = rel;
  c.src = Math.round(src * 1000) / 1000;
  c.cx = clamp01(b.cx, 0.5);
  if (fill) {
    c.cy = clamp01(b.cy, 0.5);
    c.zoom = b.zoom != null && Number.isFinite(Number(b.zoom)) ? Math.max(1, Math.min(2, Number(b.zoom))) : 1;
  } else {
    delete c.cy;
    delete c.zoom;
  }
  // a part copied in from a card: name the original clip and time, not the copy
  c.shows = from ? `${from.name} at ${from.src.toFixed(1)} s` : `${path.basename(rel)} at ${src.toFixed(1)} s`;
  c.why = "swapped in by hand in Edit Room";
  const tmp = montageFile(p) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(m, null, 1));
  fs.renameSync(tmp, montageFile(p));
  return { before, after: { file: rel, src: c.src }, dur, part: c.part, label: c.shows };
}

/** What the user took out and put in, next to the template (or the edit), so later builds learn from it. */
export function logSwap(p: Project, entry: Record<string, unknown>) {
  const style = styleOf(p);
  const dir = style && /^[a-z0-9-]{1,80}$/.test(style) && fs.existsSync(path.join(TEMPLATES_DIR, style)) ? path.join(TEMPLATES_DIR, style) : path.join(p.editDir, "edit-data");
  const idx = readJson<{ files: Record<string, any> }>(INDEX)?.files ?? {};
  const labelsAt = (f: unknown, t: unknown) => {
    const ms: any[] = (typeof f === "string" && idx[f]?.moments) || [];
    const n = Number(t);
    return ms.length && Number.isFinite(n) ? ms.reduce((a, b) => (Math.abs(b.t - n) < Math.abs(a.t - n) ? b : a)).l?.slice(0, 6) ?? [] : [];
  };
  const e = entry as any;
  const line = { at: new Date().toISOString(), edit: p.id, ...entry, out_labels: labelsAt(e.before?.file, e.before?.src), in_labels: labelsAt(e.after?.file, e.after?.src) };
  fs.appendFileSync(path.join(dir, "swaps.jsonl"), JSON.stringify(line) + "\n");
}

export const shotsDirOf = (p: Project) => path.join(p.editDir, "shots");
export { probe as probeClip };

// ---- house-style edits: footage on the draft's B-roll track ----
// Cards, boards and stage shots on the same track are graphics, not footage: Claude changes those from a comment.

/** A 9:16 house edit centre-crops horizontal footage (any HD clip), so landscape clips from 1080 p up fit. */
export const BROLL_CROP_H = 1080;
const fixPath = (f: string, draftDir: string) => f.replace(/##_draftpath_placeholder_[^#]*_##/, draftDir);
const sourcesFile = (p: Project) => path.join(p.editDir, "edit-data", "broll_sources.json");
/** media: the graded copy the slot showed after the swap (undo puts the old media back but leaves this record) */
type Source = { file: string | null; src: number | null; cx?: number; media?: string };

function footageRoots(p: Project) {
  return [...libraryFolders().map((f) => path.join(VIDEO_ROOT, f.name)), ...["raw", "resources", "shots"].map((d) => path.join(p.editDir, d))];
}
/** Graded copies (prep_broll), Signal's br_ shots, earlier swaps, or a clip straight from the footage folders. */
function isFootage(abs: string, roots: string[]) {
  const n = path.basename(abs);
  if (/^(card_|chip_|captions|terminal|stage_|sg_)/i.test(n)) return false;
  return /_graded\.mp4$/i.test(n) || /^(br|sw)_/i.test(n) || inside(abs, roots);
}

function brollSegs(p: Project) {
  if (!p.draftDir) return { d: null as any, tall: false, segs: [] as { i: number; seg: any; abs: string }[] };
  const d = readJson<any>(path.join(p.draftDir, "draft_info.json"));
  const track = d?.tracks?.find((t: any) => t.type === "video" && t.name === "B-roll");
  const vids = new Map<string, any>((d?.materials?.videos ?? []).map((v: any) => [v.id, v]));
  const tall = (d?.canvas_config?.height ?? 1080) > (d?.canvas_config?.width ?? 1920);
  const roots = footageRoots(p);
  const segs = ((track?.segments ?? []) as any[])
    .map((seg, i) => ({ i, seg, abs: fixPath(vids.get(seg.material_id)?.path ?? "", p.draftDir!) }))
    .filter((x) => x.abs && isFootage(x.abs, roots));
  return { d, tall, segs };
}

/** Where a b-roll shot came from: the last swap, the build's broll_plan.json (NN_<name>_graded.mp4 = row NN), or itself. */
function originOf(p: Project, seg: any, abs: string): Source {
  const src = seg.source_timerange.start / US;
  const swapped = readJson<Record<string, Source>>(sourcesFile(p))?.[seg.id];
  if (swapped && swapped.media === path.basename(abs)) return swapped;
  if (inside(abs, [VIDEO_ROOT])) return { file: path.relative(VIDEO_ROOT, abs), src };
  const m = path.basename(abs).match(/^(\d\d)_(.+)_graded\.mp4$/i);
  const row = m ? readJson<any[]>(path.join(p.editDir, "edit-data", "broll_plan.json"))?.[Number(m[1])] : null;
  if (m && row && typeof row.file === "string" && path.basename(row.file).replace(/\.[^.]+$/, "").replace(/\W+/g, "_") === m[2]) {
    const a = path.isAbsolute(row.file) ? row.file : path.join(VIDEO_ROOT, row.file);
    return { file: inside(a, [VIDEO_ROOT]) ? path.relative(VIDEO_ROOT, a) : path.basename(a), src: (Number(row.src) || 0) + src };
  }
  return { file: null, src: null };
}

/** Caption text comes from the composition's HTML. */
const unescape = (t: string) =>
  t.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k[0] === "#") return String.fromCodePoint(k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[k] ?? m;
  });

function brollList(p: Project): ShotList {
  const { d, tall, segs } = brollSegs(p);
  let caps: { start: number; dur: number; text: string }[] = [];
  try {
    caps = readModel(p).captions;
  } catch {}
  const shots = segs.map(({ i, seg, abs }, k): Shot => {
    const start = seg.target_timerange.start / US;
    const dur = seg.target_timerange.duration / US;
    const o = originOf(p, seg, abs);
    const said = unescape(caps.filter((c) => c.start < start + dur - 0.05 && c.start + c.dur > start + 0.05).map((c) => c.text).join(" ")).replace(/\s+/g, " ").trim();
    // a graded copy whose original isn't recorded: show the clip's own name (C0506, not 01_C0506_graded.mp4)
    const name = o.file ? path.basename(o.file) : path.basename(abs).replace(/^\d\d_/, "").replace(/_graded\.mp4$/i, "");
    return {
      i,
      n: k + 1,
      frame: tall ? "tall" : "wide",
      part: "b-roll",
      file: o.file,
      name,
      src: o.src,
      frames: Math.round(dur * FPS),
      dur,
      start,
      needs: tall ? "portrait" : "landscape",
      shows: `${name}${o.src != null ? ` at ${o.src.toFixed(1)} s` : ""}`,
      why: said ? `Said here: “${said.slice(0, 160)}”` : null,
      cx: o.cx ?? 0.5,
      sig: hashOf(`${abs}|${seg.source_timerange.start}|${seg.source_timerange.duration}`),
    };
  });
  return { mode: "broll", shots, story: null, style: styleOf(p), total: (d?.duration ?? 0) / US };
}

function brollThumb(p: Project, i: number): string | null {
  const x = brollSegs(p).segs.find((s) => s.i === i);
  if (!x || !fs.existsSync(x.abs)) return null;
  const sig = hashOf(`${x.abs}|${x.seg.source_timerange.start}|${x.seg.source_timerange.duration}`);
  const dir = path.join(p.dataDir, "shots");
  const out = path.join(dir, `b${i}-${sig}.jpg`);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f.startsWith(`b${i}-`)) fs.rmSync(path.join(dir, f), { force: true });
  const t = (x.seg.source_timerange.start + x.seg.source_timerange.duration / 2) / US;
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-ss", t.toFixed(3), "-i", x.abs, "-frames:v", "1", "-vf", "scale=216:-2", out], { timeout: 20_000 });
  return r.status === 0 && fs.existsSync(out) ? out : null;
}

const run = (cmd: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const ch = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    ch.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    ch.on("close", (code) => (code === 0 ? resolve() : reject(new ShotError(500, `Grading failed: ${err.trim().split("\n").pop() || `exit ${code}`}`))));
    ch.on("error", (e) => reject(new ShotError(500, e.message)));
  });

/**
 * Swap b-roll shot i (its place on the B-roll track): grade the chosen part of the new clip like the rest of the edit
 * (prep_broll.py one), then point only that segment at it. Its place and length on the timeline never change.
 */
export async function swapBroll(p: Project, i: number, b: SwapReq) {
  const first = brollSegs(p);
  const x = first.segs.find((s) => s.i === i);
  if (!x) throw new ShotError(400, "That isn't footage b-roll: ask Claude in Comments to change a card or graphic.");
  const clip = allowedClip(p, b.file);
  const pr = probe(clip);
  if (!first.tall && pr.orientation !== "landscape") throw new ShotError(400, "This edit is 16:9: pick a horizontal (landscape) clip.");
  if (first.tall && pr.orientation === "landscape" && pr.h < BROLL_CROP_H) throw new ShotError(400, "That clip is too small to fill a 9:16 frame: pick a vertical clip or an HD horizontal one.");
  const used = x.seg.source_timerange.duration / US;
  const src = Number(b.src);
  if (!Number.isFinite(src) || src < 0 || src + used > pr.duration + 0.01) throw new ShotError(400, `Pick a ${used.toFixed(2)} s part inside the clip.`);
  const cxv = b.cx != null && Number.isFinite(Number(b.cx)) ? Math.max(0, Math.min(1, Number(b.cx))) : 0.5;
  const rel = path.relative(VIDEO_ROOT, clip);
  const before = originOf(p, x.seg, x.abs);
  const stem = path.basename(clip).replace(/\.[^.]+$/, "").replace(/\W+/g, "_").slice(0, 40);
  const name = `sw_${stem}_${hashOf(`${rel}|${src}|${cxv}|${Date.now()}`).slice(0, 8)}.mp4`;
  await run(PY, ["-I", GRADE, "one", p.draftDir!, clip, src.toFixed(3), used.toFixed(3), name, ...(first.tall ? ["--format", "9:16"] : []), "--cx", cxv.toFixed(3)]);
  const out = path.join(p.draftDir!, "claude_media", name);
  const got = probe(out);

  // the draft again (it was only read before grading); the room holds other changes off while a swap runs
  const draftFile = path.join(p.draftDir!, "draft_info.json");
  const d = JSON.parse(fs.readFileSync(draftFile, "utf8"));
  const track = d.tracks.find((t: any) => t.type === "video" && t.name === "B-roll");
  const seg = track?.segments?.[i];
  if (!seg || seg.id !== x.seg.id) throw new ShotError(409, "The edit changed while the clip was graded: try again.");
  const vids: any[] = d.materials.videos;
  const old = vids.find((v) => v.id === seg.material_id);
  const users = d.tracks.flatMap((t: any) => t.segments ?? []).filter((s: any) => s.material_id === seg.material_id).length;
  const placeholder = [old, ...vids].map((v) => String(v?.path ?? "").match(/^##_draftpath_placeholder_[^#]*_##/)?.[0]).find(Boolean);
  let mat = old;
  if (!mat || users > 1) {
    // another segment shows the same media: give this one its own
    mat = { ...(old ? structuredClone(old) : { type: "video" }), id: crypto.randomUUID().toUpperCase() };
    vids.push(mat);
    seg.material_id = mat.id;
  }
  Object.assign(mat, { path: placeholder ? `${placeholder}/claude_media/${name}` : out, material_name: name, width: got.w, height: got.h, duration: Math.round(got.duration * US) });
  seg.source_timerange.start = 0;
  if (seg.clip) {
    seg.clip.scale = { x: 1, y: 1 };
    seg.clip.transform = { x: 0, y: 0 };
  }
  const tmp = draftFile + ".claude-tmp";
  fs.writeFileSync(tmp, JSON.stringify(d));
  fs.renameSync(tmp, draftFile);

  const srcs = readJson<Record<string, Source>>(sourcesFile(p)) ?? {};
  srcs[seg.id] = { file: rel, src: Math.round(src * 1000) / 1000, cx: cxv, media: name };
  fs.mkdirSync(path.dirname(sourcesFile(p)), { recursive: true });
  fs.writeFileSync(sourcesFile(p), JSON.stringify(srcs, null, 1));
  return { before: { file: before.file, src: before.src }, after: { file: rel, src: Math.round(src * 1000) / 1000 }, dur: seg.target_timerange.duration / US, part: "b-roll", start: seg.target_timerange.start / US };
}
