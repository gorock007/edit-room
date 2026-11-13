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
export const WRITE_ROOTS = [VIDEO_ROOT, CAPCUT_DRAFTS, DATA_DIR, os.tmpdir(), "/private/tmp", "/tmp"];
export const READ_ROOTS = [...WRITE_ROOTS, SKILL_DIR, path.join(home, ".claude")];

export const inside = (p: string, roots: string[]) => {
  const r = path.resolve(p);
  return roots.some((root) => r === root || r.startsWith(root.endsWith("/") ? root : root + "/"));
};
