import os from "node:os";
import path from "node:path";
import { CAPCUT_DRAFTS, DATA_DIR, SKILL_DIR, VIDEO_ROOT } from "./config.ts";
import { readModel, type Project } from "./projects.ts";
import { buildProxy, proxyState } from "./proxy.ts";
import { exportState, startExport } from "./exporter.ts";
import { enqueue, stop } from "./agent.ts";
import { KEYS, applyOption, hasOption } from "./options.ts";
import { OWNER, can, type Person } from "./people.ts";
import { loadComments, newId, restore, saveComments, updateComment, type Author, type Comment, type Target } from "./store.ts";

/**
 * What people (in the app) and agents (over MCP) can do in a project's room. Both go through these functions, so the
 * rules are the same whoever asks: roles, approvals, and what each person gets to see.
 */

export class RoomError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type Emitters = {
  emitComment: (c: Comment) => void;
  projectChanged: (p: Project) => void;
  overlayChanged: (p: Project) => void;
  exportChanged: (p: Project) => void;
};

/**
 * The agent runs shell commands on this Mac, and the only thing keeping it to one project is its prompt. So only an
 * editor with every project (someone the owner trusts with the whole Mac) starts it directly or approves a comment;
 * everyone else's comments wait for such an editor to read them first.
 */
export const runsDirectly = (p: Person) => can(p, "editor") && p.projects === "all";

export const authorOf = (p: Person): Author => ({ id: p.id, name: p.name, color: p.color, role: p.role, ...(p.kind ? { kind: p.kind } : {}) });

// this Mac's folders, longest first, so "/Users/me/…/Video Editor/1116s edit/x.json" reads "…/1116s edit/x.json"
const PRIVATE_ROOTS = [...new Set([VIDEO_ROOT, CAPCUT_DRAFTS, DATA_DIR, SKILL_DIR, os.homedir()])].sort((a, b) => b.length - a.length);
const redact = (s: string | undefined) => (s == null ? s : PRIVATE_ROOTS.reduce((acc, r) => acc.split(r).join("…"), s));

/**
 * What a person sees of a comment. Editors see everything; commenters and viewers (often clients) see what was asked and
 * Claude's answer, not the agent's command log, costs, option file lists or this Mac's folders.
 */
export const viewOf = (c: Comment, who: Person | undefined): Comment =>
  can(who, "editor")
    ? c
    : {
        ...c,
        reply: redact(c.reply),
        activity: c.activity.filter((a) => a.kind === "info" || a.kind === "text").map((a) => ({ ...a, text: redact(a.text)! })),
        changed: c.changed?.map((f) => path.basename(f)),
        options: c.options?.map(({ key, note, pictureChanged, picture }) => ({ key, note: redact(note)!, files: [], pictureChanged, picture })),
        costUsd: undefined,
      };

const KINDS = new Set(["caption", "frame", "sfx", "cut", "broll", "general"]);
const short = (v: unknown, n: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
const num = (v: unknown, lo: number, hi: number) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : null);

/**
 * The click target from the app, rebuilt from known kinds and short strings. It goes into the agent's prompt next to
 * the comment, so it must not be a place to hide a longer request than the approver sees (the app shows all of it).
 */
export function cleanTarget(t: any): Target {
  const kind = KINDS.has(t?.kind) ? t.kind : "general";
  const label = short(t?.label, 120) || "the video";
  const out: Target = { kind, label };
  if (t?.id != null && /^[\w.:-]{1,40}$/.test(String(t.id))) out.id = String(t.id);
  const detail = short(t?.detail, 160);
  if (detail) out.detail = detail;
  return out;
}

/** A target described by the server from the edit itself (what an agent points at by id), labelled like the app does. */
export function targetFromModel(p: Project, kind: string, id: string): { target: Target; t: number } {
  const m = readModel(p);
  const span = (s: { start: number; dur: number }) => `${s.start.toFixed(2)}–${(s.start + s.dur).toFixed(2)} s`;
  if (kind === "caption") {
    const g = m.captions.find((x) => x.id === id);
    if (g) return { t: g.start, target: { kind, id, label: `caption ${g.id} "${g.text}"`.slice(0, 120), ...(g.big ? { detail: `keyword "${g.big}"` } : {}) } };
  }
  if (kind === "cut") {
    const s = m.cuts.find((x) => x.id === id);
    if (s) return { t: s.start, target: { kind, id, label: `A-roll ${s.id}`, detail: `${span(s)}${s.scale !== 1 ? ` · punch-in ${+s.scale.toFixed(2)}×` : ""}` } };
  }
  if (kind === "broll") {
    const s = m.broll.find((x) => x.id === id);
    if (s) return { t: s.start, target: { kind, id, label: `card "${s.label}"`.slice(0, 120), detail: span(s) } };
  }
  if (kind === "sfx") {
    const s = m.sfx.find((x) => x.id === id);
    if (s) return { t: s.start, target: { kind, id, label: `sound "${s.name}"`.slice(0, 120), detail: `${s.start.toFixed(2)} s on ${s.track}, volume ${s.volume}` } };
  }
  throw new RoomError(400, `no ${kind} with id "${id}" in this edit (get_edit lists the ids)`);
}

export function makeRoom(e: Emitters) {
  const hooks = { emit: e.emitComment, projectChanged: e.projectChanged, overlayChanged: e.overlayChanged };
  const find = (p: Project, cid: string) => {
    const c = loadComments(p).find((x) => x.id === cid);
    if (!c) throw new RoomError(404, "no such comment");
    return c;
  };
  const needRole = (who: Person, role: "commenter" | "editor") => {
    if (!can(who, role)) throw new RoomError(403, role === "editor" ? "Only editors can do that." : "Only commenters and editors can do that.");
  };

  return {
    /** An approver's comment goes to the agent at once (like Claude Design); anyone else's waits for approval. */
    postComment(p: Project, who: Person, b: { text?: unknown; t?: unknown; x?: unknown; y?: unknown; target?: Target; want?: unknown }) {
      needRole(who, "commenter");
      const text = String(b.text ?? "").trim();
      if (!text) throw new RoomError(400, "empty comment");
      if (!p.draftDir) throw new RoomError(400, "this edit isn't built yet: start the edit first");
      const direct = runsDirectly(who);
      const c: Comment = {
        id: newId(),
        project: p.id,
        createdAt: Date.now(),
        text: text.slice(0, 4000),
        t: num(b.t, 0, 86_400) ?? 0,
        x: b.x == null ? null : num(b.x, 0, 1),
        y: b.y == null ? null : num(b.y, 0, 1),
        target: cleanTarget(b.target),
        status: direct ? "queued" : "pending",
        activity: direct ? [] : [{ at: Date.now(), kind: "info", text: "Waiting for an editor to approve it" }],
        want: Math.max(1, Math.min(KEYS.length, Number(b.want) || 1)),
        author: authorOf(who),
      };
      saveComments(p, [...loadComments(p), c]);
      e.emitComment(c);
      if (direct) enqueue(p, c.id, hooks);
      return viewOf(c, who);
    },

    approve(p: Project, who: Person, cid: string) {
      if (!runsDirectly(who)) throw new RoomError(403, "Only an editor with access to every project can approve a comment for Claude.");
      let ok = false;
      const c = updateComment(p, cid, (x) => {
        if (x.status !== "pending") return;
        ok = true;
        x.status = "queued";
        x.approvedBy = who.name;
        x.activity.push({ at: Date.now(), kind: "info", text: `Approved by ${who.name}` });
      });
      if (!c || !ok) throw new RoomError(400, "this comment isn't waiting for approval");
      e.emitComment(c);
      enqueue(p, c.id, hooks);
      return c;
    },

    decline(p: Project, who: Person, cid: string, reasonIn: unknown) {
      needRole(who, "editor");
      const reason = short(reasonIn, 500);
      let ok = false;
      const c = updateComment(p, cid, (x) => {
        if (x.status !== "pending") return;
        ok = true;
        x.status = "declined";
        x.approvedBy = who.name;
        x.reply = reason ? `${who.name}: ${reason}` : undefined;
        x.activity.push({ at: Date.now(), kind: "info", text: `Declined by ${who.name}` });
        x.finishedAt = Date.now();
      });
      if (!c || !ok) throw new RoomError(400, "this comment isn't waiting for approval");
      e.emitComment(c);
      return c;
    },

    /** Editors stop anything; anyone can take back their own comment before the agent starts on it. */
    stopComment(p: Project, who: Person, cid: string) {
      needRole(who, "commenter");
      const cur = find(p, cid);
      const own = (cur.author?.id ?? OWNER) === who.id;
      if (!can(who, "editor") && !(own && ["pending", "queued"].includes(cur.status)))
        throw new RoomError(403, "Only editors can stop a comment Claude is working on.");
      const c = updateComment(p, cid, (x) => {
        if (x.status === "queued" || x.status === "pending") x.status = "stopped";
      })!;
      stop(cid);
      e.emitComment(c);
      return viewOf(c, who);
    },

    undo(p: Project, who: Person, cid: string) {
      needRole(who, "editor");
      const c = find(p, cid);
      if (!c.changed?.length || c.status === "undone") throw new RoomError(400, "nothing to undo");
      restore(p, cid, c.changed);
      const u = updateComment(p, cid, (x) => {
        x.status = "undone";
        x.activity.push({ at: Date.now(), kind: "info", text: `Undone by ${who.name}: restored ${x.changed!.map((f) => path.basename(f)).join(", ")}` });
      })!;
      e.emitComment(u);
      if (c.changed.some((f) => f.endsWith("index.html"))) e.overlayChanged(p);
      if (proxyState(p).status === "stale") buildProxy(p, () => e.projectChanged(p));
      e.projectChanged(p);
      return u;
    },

    /** Use one of a comment's options (A, B, C…), or "current" to keep the edit as it is. */
    pick(p: Project, who: Person, cid: string, key: string) {
      needRole(who, "editor");
      const c = find(p, cid);
      if (c.status !== "review") throw new RoomError(400, "this comment has no options waiting");
      if (key === "current") {
        const u = updateComment(p, cid, (x) => {
          x.status = "done";
          x.chosen = "current";
          x.activity.push({ at: Date.now(), kind: "info", text: `${who.name} kept the current version` });
        })!;
        e.emitComment(u);
        return u;
      }
      if (!KEYS.includes(key) || !hasOption(p, cid, key)) throw new RoomError(400, "no such option");
      const files = applyOption(p, cid, key); // undo restores the snapshot taken before the options were made
      const opt = c.options?.find((o) => o.key === key);
      const u = updateComment(p, cid, (x) => {
        x.status = "done";
        x.chosen = key;
        x.changed = files;
        x.activity.push({ at: Date.now(), kind: "info", text: `${who.name} picked option ${key}${opt ? `: ${opt.note}` : ""}` });
      })!;
      e.emitComment(u);
      e.overlayChanged(p);
      if (proxyState(p).status === "stale") buildProxy(p, () => e.projectChanged(p));
      e.projectChanged(p);
      return u;
    },

    startExport(p: Project, who: Person) {
      needRole(who, "editor");
      if (!p.draftDir) throw new RoomError(409, "this edit isn't built yet");
      return startExport(p, () => e.exportChanged(p));
    },

    exportState,
  };
}

export type Room = ReturnType<typeof makeRoom>;
