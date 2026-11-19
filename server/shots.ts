/**
 * Shots: montage edits (wild card templates such as "Usage limit reached") are a list of shots on the music's beat
 * grid (edit-data/montage.json). Like a CapCut template, any shot can be swapped for another clip, keeping its length:
 * pick a clip from the footage folders (or the phone), pick which part of it, save. Only that shot is re-rendered
 * (the skill's montage_render.py), so the beat timing never moves. Swaps are logged next to the template so later
 * builds learn what the user takes out and puts in.
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, SKILL_DIR, VIDEO_ROOT, inside } from "./config.ts";
import type { Project } from "./projects.ts";
import { libraryFolders } from "./uploads.ts";
import { TEMPLATES_DIR, templateStory } from "./wildcards.ts";

const FPS = 30;
const VIDEO = /\.(mp4|mov|m4v|mts|m2ts|mxf|avi|mkv)$/i;
const INDEX = path.join(VIDEO_ROOT, ".broll-index.json");
const PY = "python3";
const RENDER = path.join(SKILL_DIR, "scripts/montage_render.py");
const PICK = path.join(SKILL_DIR, "scripts/broll_index.py");
const CACHE = path.join(DATA_DIR, "library");

export class ShotError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

type Clip = { part: string; file: string | null; src?: number; frames: number; fit?: string; cx?: number; cy?: number; zoom?: number; h?: number; ay?: number; shows?: string; why?: string };
export type Shot = {
  i: number;
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
export const hasShots = (p: Project) => fs.existsSync(montageFile(p));
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

export function listShots(p: Project): { shots: Shot[]; story: ReturnType<typeof templateStory>; style: string | null; total: number } {
  const m = plan(p);
  const man = manifest(p);
  let start = 0;
  const shots = m.clips.map((c, i): Shot => {
    const frames = Math.max(1, Math.round(Number(c.frames) || 1));
    const s: Shot = {
      i,
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
  return { shots, story: templateStory(style), style, total: start / FPS };
}

/** A shot's thumbnail, from the rendered montage (exactly as it looks in the edit), cached by its render signature. */
export function shotThumb(p: Project, i: number): string | null {
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

/** A clip a swap may use: in one of the footage folders, or this edit's own raw/, resources/ or shots/ (phone uploads). */
export function allowedClip(p: Project, rel: unknown): string {
  if (typeof rel !== "string" || !rel || rel.length > 400 || !VIDEO.test(rel)) throw new ShotError(400, "Pick a video clip.");
  const abs = path.resolve(VIDEO_ROOT, rel);
  const roots = [...libraryFolders().map((f) => path.join(VIDEO_ROOT, f.name)), ...["raw", "resources", "shots"].map((d) => path.join(p.editDir, d))];
  if (!inside(abs, roots) || !fs.existsSync(abs)) throw new ShotError(400, "That clip isn't in your footage folders.");
  return abs;
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
export function clipsFor(p: Project, needs: "portrait" | "landscape") {
  const idx = readJson<{ files: Record<string, any> }>(INDEX)?.files ?? {};
  const folders = new Set(libraryFolders().map((f) => f.name));
  const out: { file: string; name: string; w: number; h: number; duration: number; screens: number; outdoors: number; people: number; best: number; mine: boolean; at: number }[] = [];
  for (const [rel, e] of Object.entries(idx)) {
    if (!folders.has(rel.split("/")[0]) || !e?.orientation || e.error) continue;
    // a full 9:16 shot can also be cropped from a 4K landscape clip
    const fits = e.orientation === needs || (needs === "portrait" && e.orientation === "landscape" && e.h >= 2000);
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
        if (pr.orientation !== needs && !(needs === "portrait" && pr.orientation === "landscape" && pr.h >= 2000)) continue;
        out.push({ file: path.relative(VIDEO_ROOT, path.join(dir, n)), name: n, w: pr.w, h: pr.h, duration: pr.duration, screens: 0, outdoors: 0, people: 0, best: 0, mine: true, at: Math.min(1, pr.duration / 2) });
      } catch {}
    }
  }
  // the edit's own uploads first, then clips with no screens and good-looking moments
  return out.sort((a, b) => Number(b.mine) - Number(a.mine) || a.screens - b.screens || b.best - a.best);
}

/** The picker's best moments for a shot (story rules from the template), minus moments the edit already uses. */
export function suggestions(p: Project, i: number): Promise<{ file: string; t: number; labels: string[]; score: number }[]> {
  const { shots, story } = listShots(p);
  const s = shots[i];
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
          .filter((r) => s.needs !== "portrait" || r.shape === "portrait" || (clipW(r.file)?.h ?? 0) >= 2000)
          .slice(0, 9)
          .map((r) => ({ file: r.file, t: r.t, labels: (r.labels ?? []).slice(0, 4), score: r.score })),
      );
    });
    ch.on("error", () => resolve([]));
  });
}

/** One frame of a clip (for picker thumbnails), cached. */
export function clipFrame(p: Project, rel: unknown, t: unknown): string | null {
  const abs = allowedClip(p, rel);
  const at = Math.max(0, Math.min(86_400, Number(t) || 0));
  const out = path.join(CACHE, "frames", `${hashOf(abs)}-${at.toFixed(2)}.jpg`);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-ss", at.toFixed(2), "-i", abs, "-frames:v", "1", "-vf", "scale=320:-2", out], { timeout: 60_000 });
  return r.status === 0 && fs.existsSync(out) ? out : null;
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
export function applySwap(p: Project, i: number, b: SwapReq) {
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
  c.shows = `${path.basename(rel)} at ${src.toFixed(1)} s`;
  c.why = "swapped in by hand in Edit Room";
  const tmp = montageFile(p) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(m, null, 1));
  fs.renameSync(tmp, montageFile(p));
  return { before, after: { file: rel, src: c.src }, dur, part: c.part };
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
