import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { SKILL_DIR, proxyWidth } from "./config.ts";
import { readModel, type Project } from "./projects.ts";
import { overlayStill } from "./overlay.ts";

export type ProxyState = { status: "missing" | "ready" | "stale" | "building" | "failed"; builtHash?: string; error?: string; version: number };

const building = new Map<string, Promise<void>>();
const errors = new Map<string, string>();

const meta = (p: Project) => path.join(p.dataDir, "proxy.json");
export const proxyFile = (p: Project) => path.join(p.dataDir, "proxy.mp4");

export function proxyState(p: Project): ProxyState {
  const m = fs.existsSync(meta(p)) ? JSON.parse(fs.readFileSync(meta(p), "utf8")) : null;
  if (building.has(p.id)) return { status: "building", builtHash: m?.hash, version: m?.version ?? 0 };
  if (errors.has(p.id)) return { status: "failed", error: errors.get(p.id), version: m?.version ?? 0 };
  if (!m || !fs.existsSync(proxyFile(p))) return { status: "missing", version: 0 };
  let fresh = true;
  try {
    const model = readModel(p);
    // proxies built before media was tracked have no m.media; they go stale only on a picture change
    fresh = model.pictureHash === m.hash && (m.media === undefined || m.media === model.pictureMedia);
  } catch {}
  return { status: fresh ? "ready" : "stale", builtHash: m.hash, version: m.version };
}

function run(cmd: string, args: string[], cwd?: string) {
  return new Promise<void>((resolve, reject) => {
    const ch = spawn(cmd, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    ch.stderr.on("data", (b) => (err += b));
    ch.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} ${args[0] ?? ""} failed: ${err.slice(-600)}`))));
  });
}

/**
 * The proxy is the cut picture (A-roll + cards, no captions) with the cut voice, 960 px on its long side.
 * Captions and SFX are drawn live by the app, so only picture changes need a rebuild.
 * preview.py does the cutting (it already reproduces the draft frame-exactly).
 */
export function buildProxy(p: Project, onChange: () => void): Promise<void> {
  const running = building.get(p.id);
  if (running) return running;
  errors.delete(p.id);
  const job = (async () => {
    const model = readModel(p);
    const hash = model.pictureHash, media = model.pictureMedia;
    const work = path.join(p.dataDir, "proxy-work");
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    await run("python3", ["-I", path.join(SKILL_DIR, "scripts/preview.py"), p.draftDir!, work, path.join(work, "with_captions.mp4"), String(proxyWidth(model.width, model.height))]);
    const tmp = path.join(p.dataDir, "proxy.tmp.mp4");
    await run("ffmpeg", ["-nostdin", "-v", "error", "-y", "-i", path.join(work, "pic.mp4"), "-i", path.join(work, "aud.wav"),
      "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-frames:v", String(Math.round(model.duration * 30)),
      "-movflags", "+faststart", tmp]); // no -shortest: it trimmed the picture to the encoded audio's end, a few frames early
    fs.renameSync(tmp, proxyFile(p));
    const prev = fs.existsSync(meta(p)) ? JSON.parse(fs.readFileSync(meta(p), "utf8")) : { version: 0 };
    fs.writeFileSync(meta(p), JSON.stringify({ hash, media, builtAt: Date.now(), version: (prev.version ?? 0) + 1 }));
    fs.rmSync(work, { recursive: true, force: true });
  })()
    .catch((e) => {
      errors.set(p.id, String(e.message ?? e));
    })
    .finally(() => {
      building.delete(p.id);
      onChange();
    });
  building.set(p.id, job);
  onChange();
  return job;
}

/**
 * A still of the picture at t with the commented point marked, for the agent to look at. With `overlay` (the default)
 * the captions and titles are drawn on top as the app shows them; returns whether they were.
 */
export async function grabFrame(p: Project, t: number, x: number | null, y: number | null, out: string, overlay = true): Promise<boolean> {
  const m = readModel(p);
  const pw = proxyWidth(m.width, m.height);
  const ov = out.replace(/\.png$/, "") + ".overlay.png";
  const drawn = overlay && (await overlayStill(p, t, m.width, m.height, ov));
  const box = x != null && y != null ? (() => {
    const s = 44;
    return `drawbox=x=${Math.round(x * pw - s / 2)}:y=ih*${y.toFixed(4)}-${s / 2}:w=${s}:h=${s}:color=red@0.9:t=4`;
  })() : null;
  try {
    if (drawn)
      await run("ffmpeg", ["-nostdin", "-v", "error", "-y", "-ss", t.toFixed(3), "-i", proxyFile(p), "-i", ov, "-frames:v", "1",
        "-filter_complex", `[0:v]scale=${pw}:-2[b];[1:v]scale=${pw}:-2[o];[b][o]overlay=0:0${box ? "," + box : ""}`, out]);
    else
      await run("ffmpeg", ["-nostdin", "-v", "error", "-y", "-ss", t.toFixed(3), "-i", proxyFile(p), "-frames:v", "1", "-vf", [`scale=${pw}:-2`, ...(box ? [box] : [])].join(","), out]);
  } finally {
    fs.rmSync(ov, { force: true });
  }
  return drawn;
}

// ---- a direct cut (cut.ts): the preview is patched in a couple of seconds instead of rebuilt in a minute ----

const keepDir = (p: Project, cid: string) => path.join(p.dataDir, "history", cid);
/** After this many patches in a row the proxy is rebuilt from the footage, so re-encoding never piles up. */
const MAX_PATCHES = 8;

/**
 * Take frames [af, bf) out of the proxy itself (picture and voice), which is exactly what the cut did to the edit.
 * Only when the proxy matched the edit before the cut (`wasReady`); otherwise it is rebuilt as usual. The proxy as it
 * was is kept with the cut's undo snapshot, so undoing brings the old picture back at once too.
 */
export async function patchProxy(p: Project, cid: string, cut: { af: number; bf: number; fps: number; frames: number }, wasReady: boolean, onChange: () => void): Promise<void> {
  const prev = fs.existsSync(meta(p)) ? JSON.parse(fs.readFileSync(meta(p), "utf8")) : null;
  if (!wasReady || !prev || building.has(p.id) || (prev.patches ?? 0) >= MAX_PATCHES || cut.fps !== 30) {
    buildProxy(p, onChange);
    return;
  }
  const job = (async () => {
    const { af, bf, fps } = cut;
    fs.mkdirSync(keepDir(p, cid), { recursive: true });
    fs.rmSync(path.join(keepDir(p, cid), "proxy.mp4"), { force: true });
    fs.linkSync(proxyFile(p), path.join(keepDir(p, cid), "proxy.mp4")); // a link: the patch below writes a new file
    fs.writeFileSync(path.join(keepDir(p, cid), "proxy.json"), JSON.stringify(prev));
    const a = (af / fps).toFixed(5), b = (bf / fps).toFixed(5);
    // picture: by frame number (timestamps are rewritten first, so a proxy with uneven ones still cuts on the frame);
    // voice: by time. -reinit_filter 0: a proxy whose cards and A-roll carry different colour tags must not restart
    // the filters part way, which would restart the frame count.
    const parts = [`[0:v]setpts=N/(${fps}*TB),select='not(between(n,${af},${bf - 1}))',setpts=N/(${fps}*TB)[v]`];
    const au: string[] = [];
    if (af > 0) parts.push(`[0:a]atrim=end=${a},asetpts=PTS-STARTPTS[a0]`), au.push("[a0]");
    parts.push(`[0:a]atrim=start=${b},asetpts=PTS-STARTPTS[a1]`), au.push("[a1]");
    parts.push(`${au.join("")}concat=n=${au.length}:v=0:a=1[a]`);
    const tmp = path.join(p.dataDir, "proxy.tmp.mp4");
    await run("ffmpeg", ["-nostdin", "-v", "error", "-y", "-reinit_filter", "0", "-i", proxyFile(p), "-filter_complex", parts.join(";"), "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(fps), "-fps_mode", "cfr", "-c:a", "aac", "-b:a", "160k",
      "-frames:v", String(cut.frames), "-movflags", "+faststart", tmp]);
    const got = await frameCount(tmp);
    if (got !== cut.frames) throw new Error(`patched proxy has ${got} frames, the cut has ${cut.frames}`);
    const model = readModel(p);
    fs.renameSync(tmp, proxyFile(p));
    fs.writeFileSync(meta(p), JSON.stringify({ hash: model.pictureHash, media: model.pictureMedia, builtAt: Date.now(), version: (prev.version ?? 0) + 1, patches: (prev.patches ?? 0) + 1 }));
  })()
    .catch(() => {
      building.delete(p.id);
      return buildProxy(p, onChange); // the patch failed: build it the long way
    })
    .finally(() => {
      building.delete(p.id);
      onChange();
    });
  building.set(p.id, job);
  await job;
}

function frameCount(file: string): Promise<number> {
  return new Promise((resolve) => {
    const ch = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=nb_frames", "-of", "csv=p=0", file]);
    let out = "";
    ch.stdout.on("data", (b) => (out += b));
    ch.on("close", () => resolve(Number(out.trim()) || -1));
    ch.on("error", () => resolve(-1));
  });
}

/** Undoing a direct cut: if the proxy kept with it is the picture of the edit as restored, put it back. */
export function restoreKeptProxy(p: Project, cid: string): boolean {
  try {
    const file = path.join(keepDir(p, cid), "proxy.mp4");
    const kept = JSON.parse(fs.readFileSync(path.join(keepDir(p, cid), "proxy.json"), "utf8"));
    const model = readModel(p);
    if (building.has(p.id) || !fs.existsSync(file) || kept.hash !== model.pictureHash || (kept.media !== undefined && kept.media !== model.pictureMedia)) return false;
    const now = fs.existsSync(meta(p)) ? JSON.parse(fs.readFileSync(meta(p), "utf8")) : { version: 0 };
    const tmp = path.join(p.dataDir, "proxy.tmp.mp4");
    fs.copyFileSync(file, tmp);
    fs.renameSync(tmp, proxyFile(p));
    fs.writeFileSync(meta(p), JSON.stringify({ ...kept, version: (now.version ?? 0) + 1 }));
    return true;
  } catch {
    return false;
  }
}

/** Kept proxies are only for undoing the latest cuts: drop the rest (each is a full copy of the preview). */
export function pruneKeptProxies(p: Project, keep: string[]) {
  const dir = path.join(p.dataDir, "history");
  try {
    for (const cid of fs.readdirSync(dir)) if (!keep.includes(cid)) fs.rmSync(path.join(dir, cid, "proxy.mp4"), { force: true });
  } catch {}
}
