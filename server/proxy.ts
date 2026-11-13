import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { PROXY_WIDTH, SKILL_DIR } from "./config.ts";
import { readModel, type Project } from "./projects.ts";

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
  let current = m.hash;
  try {
    current = readModel(p).pictureHash;
  } catch {}
  return { status: current === m.hash ? "ready" : "stale", builtHash: m.hash, version: m.version };
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
 * The proxy is the cut picture (A-roll + cards, no captions) with the cut voice, at 960 px.
 * Captions and SFX are drawn live by the app, so only picture changes need a rebuild.
 * preview.py does the cutting (it already reproduces the draft frame-exactly).
 */
export function buildProxy(p: Project, onChange: () => void): Promise<void> {
  const running = building.get(p.id);
  if (running) return running;
  errors.delete(p.id);
  const job = (async () => {
    const hash = readModel(p).pictureHash;
    const work = path.join(p.dataDir, "proxy-work");
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    await run("python3", ["-I", path.join(SKILL_DIR, "scripts/preview.py"), p.draftDir!, work, path.join(work, "with_captions.mp4"), String(PROXY_WIDTH)]);
    const tmp = path.join(p.dataDir, "proxy.tmp.mp4");
    await run("ffmpeg", ["-nostdin", "-v", "error", "-y", "-i", path.join(work, "pic.mp4"), "-i", path.join(work, "aud.wav"),
      "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", tmp]);
    fs.renameSync(tmp, proxyFile(p));
    const prev = fs.existsSync(meta(p)) ? JSON.parse(fs.readFileSync(meta(p), "utf8")) : { version: 0 };
    fs.writeFileSync(meta(p), JSON.stringify({ hash, builtAt: Date.now(), version: (prev.version ?? 0) + 1 }));
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

/** A still of the picture at t with the commented point marked, for the agent to look at. */
export async function grabFrame(p: Project, t: number, x: number | null, y: number | null, out: string) {
  const vf = [`scale=${PROXY_WIDTH}:-2`];
  if (x != null && y != null) {
    const s = 44;
    vf.push(`drawbox=x=${Math.round(x * PROXY_WIDTH - s / 2)}:y=ih*${y.toFixed(4)}-${s / 2}:w=${s}:h=${s}:color=red@0.9:t=4`);
  }
  await run("ffmpeg", ["-nostdin", "-v", "error", "-y", "-ss", t.toFixed(3), "-i", proxyFile(p), "-frames:v", "1", "-vf", vf.join(","), out]);
}
