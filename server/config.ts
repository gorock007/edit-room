import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = os.homedir();
export const VIDEO_ROOT = process.env.ROOM_VIDEO_ROOT ?? path.join(home, "Library/Mobile Documents/com~apple~CloudDocs/Video Editor");
export const CAPCUT_DRAFTS = process.env.ROOM_CAPCUT_DRAFTS ?? path.join(home, "Movies/CapCut/User Data/Projects/com.lveditor.draft");
export const SKILL_DIR = process.env.ROOM_SKILL_DIR ?? path.join(home, ".claude/skills/talking-head-reel-edit");
export const DATA_DIR = process.env.ROOM_DATA_DIR ?? path.resolve(import.meta.dirname, "../data");
export const PORT = Number(process.env.ROOM_PORT ?? 4310);
// localhost only: anyone who can reach this server can make the agent run commands on this Mac.
export const HOST = process.env.ROOM_HOST ?? "127.0.0.1";
export const PROXY_WIDTH = 960;

/** Roots the app may read media from and the agent may write to. */
// the agent may write only the user's video folders and scratch space; the skill and the app's undo history stay read-only
export const WRITE_ROOTS = [VIDEO_ROOT, CAPCUT_DRAFTS, os.tmpdir(), "/private/tmp", "/tmp"];
export const READ_ROOTS = [...WRITE_ROOTS, DATA_DIR, SKILL_DIR, path.join(home, ".claude")];

/** Resolve symlinks (for a path that does not exist yet, its nearest existing parent) so a link can't escape a root. */
const real = (p: string): string => {
  const r = path.resolve(p);
  try {
    return fs.realpathSync(r);
  } catch {
    const parent = path.dirname(r);
    return parent === r ? r : path.join(real(parent), path.basename(r));
  }
};

export const inside = (p: string, roots: string[]) => {
  const r = real(p);
  return roots.some((root0) => {
    const root = real(root0);
    return r === root || r.startsWith(root + "/");
  });
};

/** Only the app itself may call the server: blocks DNS rebinding (Host) and other websites (Origin). */
export const APP_PORTS = [PORT, Number(process.env.ROOM_WEB_PORT ?? 5310)];
export const ALLOWED_HOSTS = new Set(APP_PORTS.flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`]));
export const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));
