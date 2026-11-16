import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { AUTH_DIR, LOCAL_HOSTS, PORT, REQUIRE_LOGIN } from "./config.ts";
import { OWNER, getPerson, owner, type Person } from "./people.ts";

/**
 * Login for anything that does not come straight from this Mac (the phone over Tailscale, invited people).
 * A comment makes the agent run commands on this Mac, so a remote device needs a session cookie: the owner gets one
 * with the password (set on the Mac with `npm run password`, stored only as an scrypt hash), everyone else with a
 * one-time invite link (people.ts). Sessions are stored hashed, each one tied to the person it belongs to.
 */
const AUTH_FILE = path.join(AUTH_DIR, "auth.json");
const SESS_FILE = path.join(AUTH_DIR, "sessions.json");
export const COOKIE = "room_session";
const SESSION_DAYS = 30;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

type Hash = { salt: string; hash: string };
/** `person` is who logged in; sessions from before there were people are the owner's (the password is the owner's). */
type Session = { created: number; expires: number; agent: string; person?: string };

const writePrivate = (f: string, data: unknown) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data, null, 1), { mode: 0o600 });
};
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export const hasPassword = () => fs.existsSync(AUTH_FILE);

export function setPassword(pw: string) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, SCRYPT);
  writePrivate(AUTH_FILE, { salt: salt.toString("hex"), hash: hash.toString("hex") } satisfies Hash);
  // a new password signs the owner's devices out; invited people keep their sessions
  sessions = Object.fromEntries(Object.entries(sessions).filter(([, s]) => (s.person ?? OWNER) !== OWNER));
  saveSessions();
}

function passwordOk(pw: string): boolean {
  if (!hasPassword()) return false;
  const h: Hash = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
  const want = Buffer.from(h.hash, "hex");
  const got = crypto.scryptSync(pw, Buffer.from(h.salt, "hex"), want.length, SCRYPT);
  return crypto.timingSafeEqual(want, got);
}

let sessions: Record<string, Session> = (() => {
  try {
    return JSON.parse(fs.readFileSync(SESS_FILE, "utf8"));
  } catch {
    return {};
  }
})();
const saveSessions = () => {
  const now = Date.now();
  for (const [k, s] of Object.entries(sessions)) if (s.expires < now) delete sessions[k];
  writePrivate(SESS_FILE, sessions);
};

const cookieOf = (req: http.IncomingMessage) => {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return null;
};

function sessionOf(req: http.IncomingMessage) {
  const tok = cookieOf(req);
  if (!tok) return null;
  const s = sessions[sha(tok)];
  return s && s.expires > Date.now() ? s : null;
}

/** Who is making this request: the owner on this Mac, the session's person elsewhere, null if not logged in (or removed). */
export function personOf(req: http.IncomingMessage): Person | null {
  if (!isRemote(req)) return owner();
  const s = sessionOf(req);
  return s ? getPerson(s.person ?? OWNER) ?? null : null;
}

export const sessionOk = (req: http.IncomingMessage) => personOf(req) != null;

/** Sign a person out on every device (they were removed). */
export function dropSessions(personId: string) {
  let n = 0;
  for (const [k, s] of Object.entries(sessions))
    if ((s.person ?? OWNER) === personId) {
      delete sessions[k];
      n++;
    }
  if (n) saveSessions();
}

/** A fresh 30-day session for this person; returns the Set-Cookie value. */
export function startSession(personId: string, agent: string) {
  const tok = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  sessions[sha(tok)] = { created: now, expires: now + SESSION_DAYS * 86_400_000, agent: agent.slice(0, 200), person: personId };
  saveSessions();
  return `${COOKIE}=${tok}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86_400}`;
}

const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * "This Mac" only when the request reached the local port, from a loopback socket, addressed to a loopback name, with
 * no proxy headers. The Tailscale port, and anything else, must log in. Headers can only make a request MORE remote.
 */
export function isRemote(req: http.IncomingMessage) {
  if (REQUIRE_LOGIN) return true;
  if (req.socket.localPort !== PORT || !LOOPBACK_PEERS.has(String(req.socket.remoteAddress))) return true;
  const h = req.headers;
  return !LOCAL_HOSTS.has(String(h.host ?? "")) || h["tailscale-user-login"] != null || h["x-forwarded-for"] != null || h["forwarded"] != null;
}

export const needsLogin = (req: http.IncomingMessage) => isRemote(req) && !sessionOk(req);

// Too many wrong passwords locks login for a while (only the owner has a password, so one shared counter is enough).
const fails: number[] = [];
const WINDOW = 15 * 60_000, MAX_FAILS = 5;
export function lockedFor() {
  const now = Date.now();
  while (fails.length && fails[0] < now - WINDOW) fails.shift();
  return fails.length >= MAX_FAILS ? Math.ceil((fails[0] + WINDOW - now) / 1000) : 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type LoginResult = { cookie: string } | { error: string; status: number };

// One attempt at a time: parallel guesses would all pass the lock check before any of them failed.
let queue: Promise<unknown> = Promise.resolve();
export function login(pw: string, agent: string): Promise<LoginResult> {
  const run = queue.then(() => attempt(pw, agent));
  queue = run.catch(() => {});
  return run;
}

async function attempt(pw: string, agent: string): Promise<LoginResult> {
  if (!hasPassword()) return { status: 409, error: "No password yet. On the Mac, run: npm run password" };
  const wait = lockedFor();
  if (wait) return { status: 429, error: `Too many tries. Try again in ${Math.ceil(wait / 60)} min.` };
  await sleep(300); // slows guessing; scrypt adds more
  if (!passwordOk(pw)) {
    fails.push(Date.now());
    return { status: 401, error: "Wrong password" };
  }
  fails.length = 0;
  return { cookie: startSession(OWNER, agent) }; // the password is the owner's own way in from the phone
}

export function logout(req: http.IncomingMessage) {
  const tok = cookieOf(req);
  if (tok && sessions[sha(tok)]) {
    delete sessions[sha(tok)];
    saveSessions();
  }
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}
