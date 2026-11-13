import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const home = os.homedir();
export const VIDEO_ROOT = process.env.ROOM_VIDEO_ROOT ?? path.join(home, "Library/Mobile Documents/com~apple~CloudDocs/Video Editor");
export const CAPCUT_DRAFTS = process.env.ROOM_CAPCUT_DRAFTS ?? path.join(home, "Movies/CapCut/User Data/Projects/com.lveditor.draft");
export const SKILL_DIR = process.env.ROOM_SKILL_DIR ?? path.join(home, ".claude/skills/talking-head-reel-edit");
export const DATA_DIR = process.env.ROOM_DATA_DIR ?? path.resolve(import.meta.dirname, "../data");
export const PORT = Number(process.env.ROOM_PORT ?? 4310);
// localhost only: anyone who can reach this server can make the agent run commands on this Mac.
// Other devices (the phone) come in through `tailscale serve`, which forwards to this loopback port, and must log in.
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

/** Where the login password hash and sessions live (never in the repo). */
export const AUTH_DIR = process.env.ROOM_AUTH_DIR ?? DATA_DIR;
/** Ask for the password even on this Mac (for testing the login screen). */
export const REQUIRE_LOGIN = process.env.ROOM_REQUIRE_LOGIN === "1";

/** This Mac's Tailscale name (e.g. my-mac.tailnet.ts.net), so the phone's requests pass the Host/Origin checks. */
function tailscaleName(): string[] {
  if (process.env.ROOM_PUBLIC_HOST != null) return process.env.ROOM_PUBLIC_HOST.split(",").map((s) => s.trim()).filter(Boolean);
  for (const bin of ["tailscale", "/usr/local/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    try {
      const out = execFileSync(bin, ["status", "--json"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
      const name = String(JSON.parse(out)?.Self?.DNSName ?? "").replace(/\.$/, "");
      return name ? [name] : [];
    } catch {}
  }
  return [];
}
export const PUBLIC_HOSTS = tailscaleName();

/** Only the app itself may call the server: blocks DNS rebinding (Host) and other websites (Origin). */
export const APP_PORTS = [PORT, Number(process.env.ROOM_WEB_PORT ?? 5310)];
export const LOCAL_HOSTS = new Set(APP_PORTS.flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`]));
export const ALLOWED_HOSTS = new Set([...LOCAL_HOSTS, ...PUBLIC_HOSTS, ...PUBLIC_HOSTS.map((h) => `${h}:443`)]);
export const ALLOWED_ORIGINS = new Set([...[...LOCAL_HOSTS].map((h) => `http://${h}`), ...PUBLIC_HOSTS.map((h) => `https://${h}`)]);
