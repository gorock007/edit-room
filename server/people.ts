import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AUTH_DIR } from "./config.ts";

/**
 * Everyone who can open the room. The Mac itself, and the owner's password login, are the owner; everyone else joins
 * with a one-time invite link the owner makes. A role says what a person may do; `projects` can keep a person (a
 * client, say) to one edit.
 *
 * - viewer: watches, sees the comments and who is here
 * - commenter: also comments; the comment waits until an editor approves it, then the agent runs it
 * - editor: comments run right away; approves others, picks options, undoes, exports, starts new edits
 * - owner: everything, plus who is in the room
 */
export type Role = "owner" | "editor" | "commenter" | "viewer";
export const ROLES: Role[] = ["viewer", "commenter", "editor", "owner"];
/**
 * An agent (Claude Code, Codex, a script…) is a person too, with the same roles and project limits. It has no
 * browser login: it calls the MCP endpoint with a secret key (stored only as a hash) that the owner made for it.
 */
export type Person = { id: string; name: string; role: Role; color: string; projects: "all" | string[]; createdAt: number; kind?: "agent"; keyHash?: string };
type Invite = { hash: string; role: Exclude<Role, "owner">; projects: "all" | string[]; by: string; createdAt: number; expires: number };
type File = { people: Person[]; invites: Invite[] };

export const OWNER = "owner";
const FILE = path.join(AUTH_DIR, "people.json");
const INVITE_DAYS = 7;
const COLORS = ["#f2b84b", "#7cc4ff", "#ff8a7a", "#9be08f", "#c8a2ff", "#ffd36e", "#5fe0d2", "#ff9fd0"];

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

let data: File = (() => {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { people: [], invites: [] };
  }
})();
if (!data.people.some((p) => p.id === OWNER))
  data.people.unshift({ id: OWNER, name: process.env.ROOM_OWNER_NAME ?? "Owner", role: "owner", color: COLORS[0], projects: "all", createdAt: Date.now() });

const save = () => {
  const now = Date.now();
  data.invites = data.invites.filter((i) => i.expires > now);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
};

export const people = () => data.people;
export const getPerson = (id: string | undefined | null) => (id ? data.people.find((p) => p.id === id) : undefined);
export const owner = () => getPerson(OWNER)!;

export const can = (p: Person | undefined, role: Role) => !!p && ROLES.indexOf(p.role) >= ROLES.indexOf(role);

/** A person kept to some projects also sees their 9:16 versions ("1114b" → "1114bv"). */
export const canSee = (p: Person | undefined, projectId: string) =>
  !!p && (p.projects === "all" || p.projects.includes(projectId) || p.projects.includes(projectId.replace(/v$/, "")));

/** What other people see of a person (no join time, no project list, never the key hash). */
export const publicPerson = (p: Person) => ({ id: p.id, name: p.name, role: p.role, color: p.color, ...(p.kind ? { kind: p.kind } : {}) });
/** What the owner's Share panel gets: everything but the key hash. */
export const ownerView = ({ keyHash: _k, ...p }: Person) => p;

const pickColor = () => {
  const used = new Set(data.people.map((p) => p.color));
  return COLORS.find((c) => !used.has(c)) ?? COLORS[data.people.length % COLORS.length];
};

/** Connect an agent: a new person of kind "agent" and its key, shown to the owner once (only its hash is kept). */
export function createAgent(name: unknown, role: unknown, projects: unknown): { person: Person; key: string } {
  if (!["viewer", "commenter", "editor"].includes(String(role))) throw new Error("pick viewer, commenter or editor");
  const key = "er_" + crypto.randomBytes(32).toString("base64url");
  const person: Person = {
    id: crypto.randomBytes(6).toString("hex"),
    name: cleanName(name) || "Agent",
    role: role as Role,
    color: pickColor(),
    projects: cleanProjects(projects),
    createdAt: Date.now(),
    kind: "agent",
    keyHash: sha(key),
  };
  data.people.push(person);
  save();
  return { person, key };
}

/** The agent a key belongs to (a removed agent's key stops working at once). */
export function agentByKey(key: string): Person | undefined {
  if (!key.startsWith("er_") || key.length > 100) return;
  const h = sha(key);
  return data.people.find((p) => p.kind === "agent" && p.keyHash === h);
}

export const cleanName = (s: unknown) => String(s ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);

const cleanProjects = (v: unknown): "all" | string[] =>
  v === "all" ? "all" : Array.isArray(v) ? [...new Set(v.map(String).filter((s) => /^[\w .-]{1,80}$/.test(s)))].slice(0, 50) : "all";

export function createInvite(by: Person, role: unknown, projects: unknown): { token: string; expires: number } {
  if (!["viewer", "commenter", "editor"].includes(String(role))) throw new Error("pick viewer, commenter or editor");
  const token = crypto.randomBytes(24).toString("base64url");
  const now = Date.now();
  const inv: Invite = { hash: sha(token), role: role as Invite["role"], projects: cleanProjects(projects), by: by.id, createdAt: now, expires: now + INVITE_DAYS * 86_400_000 };
  data.invites.push(inv);
  save();
  return { token, expires: inv.expires };
}

/** What an invite link is for, before the person joins (shown on the join screen). */
export function peekInvite(token: string) {
  const inv = data.invites.find((i) => i.hash === sha(token) && i.expires > Date.now());
  return inv ? { role: inv.role, projects: inv.projects, from: getPerson(inv.by)?.name ?? "the owner" } : null;
}

/** Use an invite (once): the new person, who then gets a session. */
export function redeemInvite(token: string, name: string): Person | null {
  const i = data.invites.findIndex((x) => x.hash === sha(String(token)) && x.expires > Date.now());
  if (i < 0) return null;
  const inv = data.invites[i];
  data.invites.splice(i, 1);
  const person: Person = {
    id: crypto.randomBytes(6).toString("hex"),
    name: cleanName(name) || "Guest",
    role: inv.role,
    color: pickColor(),
    projects: inv.projects,
    createdAt: Date.now(),
  };
  data.people.push(person);
  save();
  return person;
}

export function updatePerson(id: string, patch: { name?: unknown; role?: unknown; projects?: unknown }): Person {
  const p = getPerson(id);
  if (!p) throw new Error("no such person");
  if (patch.name !== undefined) {
    const n = cleanName(patch.name);
    if (!n) throw new Error("a name can't be empty");
    p.name = n;
  }
  if (patch.role !== undefined) {
    if (p.id === OWNER) throw new Error("the owner stays the owner");
    if (!["viewer", "commenter", "editor"].includes(String(patch.role))) throw new Error("pick viewer, commenter or editor");
    p.role = patch.role as Role;
  }
  if (patch.projects !== undefined) {
    if (p.id === OWNER) throw new Error("the owner sees every project");
    p.projects = cleanProjects(patch.projects);
  }
  save();
  return p;
}

export function removePerson(id: string) {
  if (id === OWNER) throw new Error("the owner can't be removed");
  const before = data.people.length;
  data.people = data.people.filter((p) => p.id !== id);
  if (data.people.length === before) throw new Error("no such person");
  save();
}

export function invites() {
  return data.invites.filter((i) => i.expires > Date.now()).map((i) => ({ role: i.role, projects: i.projects, createdAt: i.createdAt, expires: i.expires }));
}

export function cancelInvites() {
  data.invites = [];
  save();
}
