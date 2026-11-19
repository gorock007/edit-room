import os from "node:os";
import path from "node:path";
import { CAPCUT_DRAFTS, DATA_DIR, SKILL_DIR, VIDEO_ROOT } from "./config.ts";
import { readModel, type Project } from "./projects.ts";
import { buildProxy, patchProxy, proxyState, pruneKeptProxies, restoreKeptProxy } from "./proxy.ts";
import { exportState, startExport } from "./exporter.ts";
import { INTERRUPTED, enqueue, isRunning, quiet, stop } from "./agent.ts";
import { CutError, STAGE_CONFIG, applyCut, isStage, rebuildStageCaptions, transcript } from "./cut.ts";
import fs from "node:fs";
import { KEYS, applyOption, hasOption } from "./options.ts";
import { OWNER, can, type Person } from "./people.ts";
import { changedSince, loadComments, newId, restore, saveComments, snapshot, updateComment, type Author, type Comment, type Target, type Tier } from "./store.ts";
import { TIER_NAMES } from "./router.ts";
import { ShotError, allowedClip, applySwap, keepLocal, listShots, logSwap, renderMontage, shotMode, swapBroll, type SwapReq } from "./shots.ts";
import { info, nameVersion, record, restoreFiles, same, syncOutside, versions, type Version } from "./versions.ts";

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
  versionsChanged: (p: Project) => void;
  checksChanged: (p: Project) => void;
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
        route: undefined,
        // the reason names the owner's plan usage; clients only need to know it waits
        held: c.held ? "Waiting for an editor to start it." : undefined,
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

/** Projects with a direct cut in progress (one at a time). */
const cutting = new Set<string>();
const swapping = new Set<string>();
/** A restore (undo, version) brought back an older shot list: render those shots before the preview is rebuilt. */
const montageRestored = (files: string[]) => files.some((f) => f.endsWith(`${path.sep}montage.json`));

export function makeRoom(e: Emitters) {
  /** Save a version (fn) and tell the room if one was added. */
  const rec = (p: Project, fn: () => Version | null) => {
    const before = versions(p).at(-1)?.n;
    const v = fn();
    if (v && v.n !== before) e.versionsChanged(p);
    return v;
  };
  /** Claude is changing this edit's files right now: no outside-change check, no restore. */
  const agentBusy = (p: Project) => loadComments(p).some((c) => c.status === "working");
  const outside = (p: Project) => {
    if (!agentBusy(p)) rec(p, () => syncOutside(p));
  };
  const hooks = {
    emit: e.emitComment,
    projectChanged: e.projectChanged,
    overlayChanged: e.overlayChanged,
    checksChanged: e.checksChanged,
    starting: (p: Project) => rec(p, () => syncOutside(p)),
    finished: (p: Project, c: Comment) =>
      rec(p, () =>
        record(p, {
          kind: c.target.kind === "build" ? "build" : "comment",
          what: c.target.kind === "build" ? "First edit" : c.text.slice(0, 200),
          by: c.author,
          comment: c.id,
        }),
      ),
  };
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
    postComment(p: Project, who: Person, b: { text?: unknown; t?: unknown; x?: unknown; y?: unknown; target?: Target; want?: unknown; pick?: unknown }) {
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
        // only someone who starts Claude directly picks its model; everyone else's comment is routed
        pick: direct && TIER_NAMES.includes(b.pick as Tier) ? (b.pick as Tier) : "auto",
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

    /** A held comment (the plan is nearly used up) runs now, on the model the person picks. */
    release(p: Project, who: Person, cid: string, tierIn: unknown) {
      if (!runsDirectly(who)) throw new RoomError(403, "Only an editor with access to every project can start Claude.");
      const tier = TIER_NAMES.includes(tierIn as Tier) ? (tierIn as Tier) : null;
      if (!tier) throw new RoomError(400, `pick one of: ${TIER_NAMES.join(", ")}`);
      let ok = false;
      const c = updateComment(p, cid, (x) => {
        if (x.status !== "held") return;
        ok = true;
        x.status = "queued";
        x.pick = tier;
        x.held = undefined;
        x.activity.push({ at: Date.now(), kind: "info", text: `${who.name} started it` });
      });
      if (!c || !ok) throw new RoomError(400, "this comment isn't waiting");
      e.emitComment(c);
      enqueue(p, c.id, hooks);
      return viewOf(c, who);
    },

    /** Editors stop anything; anyone can take back their own comment before the agent starts on it. */
    stopComment(p: Project, who: Person, cid: string) {
      needRole(who, "commenter");
      const cur = find(p, cid);
      const own = (cur.author?.id ?? OWNER) === who.id;
      if (!can(who, "editor") && !(own && ["pending", "queued", "held"].includes(cur.status)))
        throw new RoomError(403, "Only editors can stop a comment Claude is working on.");
      const c = updateComment(p, cid, (x) => {
        if (x.status === "queued" || x.status === "pending" || x.status === "held") x.status = "stopped";
        // working, but no agent behind it (cut off by a server restart): nothing to abort, so stop it here
        else if (x.status === "working" && !isRunning(cid)) {
          x.status = "stopped";
          x.reply = INTERRUPTED;
          x.activity = [...(x.activity ?? []), { at: Date.now(), kind: "error", text: INTERRUPTED }];
        }
      })!;
      stop(cid);
      e.emitComment(c);
      return viewOf(c, who);
    },

    undo(p: Project, who: Person, cid: string) {
      needRole(who, "editor");
      const c = find(p, cid);
      if (!c.changed?.length || c.status === "undone") throw new RoomError(400, "nothing to undo");
      outside(p);
      restore(p, cid, c.changed);
      rec(p, () => record(p, { kind: "undo", what: `Undid “${c.text.slice(0, 120)}”`, by: authorOf(who), comment: cid }));
      const u = updateComment(p, cid, (x) => {
        x.status = "undone";
        x.activity.push({ at: Date.now(), kind: "info", text: `Undone by ${who.name}: restored ${x.changed!.map((f) => path.basename(f)).join(", ")}` });
      })!;
      e.emitComment(u);
      if (c.changed.some((f) => f.endsWith("index.html"))) e.overlayChanged(p);
      if (montageRestored(c.changed)) {
        renderMontage(p)
          .catch((err) => console.error(`undo ${cid}: ${err.message}`))
          .then(() => buildProxy(p, () => e.projectChanged(p)));
      } else if (proxyState(p).status === "stale" && !(c.direct && restoreKeptProxy(p, cid))) buildProxy(p, () => e.projectChanged(p));
      e.projectChanged(p);
      return u;
    },

    transcript(p: Project) {
      return transcript(p);
    },

    /**
     * Cut [a, b) seconds out of the edit directly: no Claude, no waiting. It is listed with the comments (so it has
     * Undo and shows who did it) and saved as a version like any other change.
     */
    async cut(p: Project, who: Person, b: { a?: unknown; b?: unknown; label?: unknown }) {
      needRole(who, "editor");
      const from = num(b.a, 0, 86_400), to = num(b.b, 0, 86_400);
      if (from == null || to == null || to <= from) throw new RoomError(400, "pick what to cut first");
      if (agentBusy(p) || loadComments(p).some((c) => c.status === "queued")) throw new RoomError(409, "Claude is working on this edit. Wait for it to finish, then cut.");
      if (cutting.has(p.id)) throw new RoomError(409, "The last cut is still being made.");
      cutting.add(p.id);
      quiet.add(p.id); // one refresh at the end, not one per file written
      const cid = newId();
      try {
        outside(p);
        const wasReady = proxyState(p).status === "ready";
        snapshot(p, cid);
        let r;
        try {
          r = applyCut(p, from, to);
        } catch (err: any) {
          restore(p, cid, changedSince(p, cid));
          throw err instanceof CutError ? new RoomError(400, err.message) : err;
        }
        const changed = changedSince(p, cid);
        const said = short(b.label, 80);
        const what = r.words.length ? `“${r.words.join(" ").slice(0, 80)}”` : said || "a pause";
        const len = r.b - r.a;
        const secs = (n: number) => `${n.toFixed(2)} s`;
        const sounds = [r.soundsDropped ? `${r.soundsDropped} sound${r.soundsDropped > 1 ? "s" : ""} that went with ${r.words.length > 1 ? "those words" : "it"} removed` : "", r.soundsMoved ? `${r.soundsMoved} sound${r.soundsMoved > 1 ? "s" : ""} moved to the join` : ""].filter(Boolean).join(", ");
        const c: Comment = {
          id: cid,
          project: p.id,
          createdAt: Date.now(),
          text: `Cut ${what}`,
          t: Math.max(0, r.a - 1),
          x: null,
          y: null,
          target: { kind: "cut", label: "the transcript", detail: `${secs(r.a)} to ${secs(r.b)}` },
          status: "done",
          activity: [{ at: Date.now(), kind: "info", text: `${who.name} cut ${secs(len)} directly` }],
          reply: `Removed ${secs(len)} at ${secs(r.a)}. The video is now ${secs(r.duration)}.${sounds ? ` ${sounds[0].toUpperCase()}${sounds.slice(1)}.` : ""}`,
          changed,
          finishedAt: Date.now(),
          want: 1,
          author: authorOf(who),
          direct: true,
        };
        saveComments(p, [...loadComments(p), c]);
        rec(p, () => record(p, { kind: "comment", what: c.text, by: c.author, comment: cid }));
        await patchProxy(p, cid, r, wasReady, () => e.projectChanged(p));
        pruneKeptProxies(p, loadComments(p).filter((x) => x.direct && x.status === "done").slice(-5).map((x) => x.id));
        e.emitComment(c);
        e.overlayChanged(p);
        e.projectChanged(p);
        return { comment: c, at: r.a, duration: r.duration };
      } finally {
        quiet.delete(p.id);
        cutting.delete(p.id);
        e.projectChanged(p); // now that the room is listening again: the checks look at the edit as cut
      }
    },

    /**
     * Swap one shot of a montage edit for another clip (same length, so the beat timing never moves), like a CapCut
     * template slot. Only that shot is re-rendered. Listed with the comments (Undo, who did it), saved as a version,
     * and logged next to the template so later builds learn from it.
     */
    async swapShot(p: Project, who: Person, i: number, b: SwapReq) {
      needRole(who, "editor");
      if (agentBusy(p) || loadComments(p).some((c) => c.status === "queued")) throw new RoomError(409, "Claude is working on this edit. Wait for it to finish, then swap.");
      if (swapping.has(p.id) || cutting.has(p.id)) throw new RoomError(409, "The last change is still being made.");
      swapping.add(p.id);
      quiet.add(p.id);
      const cid = newId();
      try {
        outside(p);
        snapshot(p, cid);
        const broll = shotMode(p) === "broll";
        let r;
        try {
          if (broll) r = await swapBroll(p, i, b);
          else {
            // a clip from outside the video folder (a camera card, Downloads): copy just the chosen part in first
            const shot = listShots(p).shots.find((x) => x.i === i);
            const orig = allowedClip(p, b.file);
            let from: { name: string; src: number } | undefined;
            if (shot) {
              const kept = await keepLocal(p, orig, Number(b.src), shot.dur);
              if (kept.file !== b.file && !orig.startsWith(VIDEO_ROOT + path.sep)) from = { name: path.basename(orig), src: Number(b.src) };
              b = { ...b, file: kept.file, src: kept.src };
            }
            r = applySwap(p, i, b, from);
            await renderMontage(p);
          }
        } catch (err: any) {
          restore(p, cid, changedSince(p, cid));
          if (!broll) await renderMontage(p).catch(() => {});
          throw err instanceof ShotError ? new RoomError(err.status, err.message) : err;
        }
        const changed = changedSince(p, cid);
        const shot = listShots(p).shots.find((s) => s.i === i);
        const n = shot?.n ?? i + 1;
        const name = path.basename(r.after.file);
        const what = "label" in r && r.label ? r.label : `${name} at ${r.after.src.toFixed(1)} s`;
        const c: Comment = {
          id: cid,
          project: p.id,
          createdAt: Date.now(),
          text: broll ? `Swapped b-roll ${n} for ${what}` : `Swapped shot ${n} for ${what}`,
          t: shot?.start ?? 0,
          x: null,
          y: null,
          target: { kind: "broll", label: broll ? `b-roll ${n}` : `shot ${n} (${r.part})`, detail: `${r.dur.toFixed(2)} s` },
          status: "done",
          activity: [{ at: Date.now(), kind: "info", text: `${who.name} swapped it directly (was ${r.before.file ? path.basename(r.before.file) : "?"} at ${r.before.src ?? "?"} s)` }],
          reply: broll
            ? `B-roll ${n} is now ${name} from ${r.after.src.toFixed(2)} s, graded like the rest of the edit. It keeps its place and length, so nothing else moved.`
            : `Shot ${n} is now ${what}.${"label" in r && r.label && !r.label.startsWith(name) ? " That part was copied into the edit's shots folder, so it still works after the card is ejected." : ""} Only that shot was re-rendered; the beat timing is unchanged.`,
          changed,
          finishedAt: Date.now(),
          want: 1,
          author: authorOf(who),
          direct: true,
        };
        saveComments(p, [...loadComments(p), c]);
        rec(p, () => record(p, { kind: "comment", what: c.text, by: c.author, comment: cid }));
        try {
          logSwap(p, { shot: n, part: r.part, before: r.before, after: r.after, by: who.name });
        } catch {}
        buildProxy(p, () => e.projectChanged(p));
        e.emitComment(c);
        return { comment: c };
      } finally {
        quiet.delete(p.id);
        swapping.delete(p.id);
        e.projectChanged(p);
      }
    },

    /**
     * Change a title directly (stage-format edits): move it, change its words, colours or sizes, or remove it. The
     * change goes into overlays/stage_captions.json and the captions are laid out again, so no rebuild ever loses it.
     * Listed with the comments (Undo, who did it) and saved as a version, like a direct cut.
     */
    titles(p: Project, who: Person, b: { id?: unknown; x?: unknown; y?: unknown; rows?: unknown; remove?: unknown; what?: unknown }) {
      needRole(who, "editor");
      if (!isStage(p)) throw new RoomError(400, "Only stage-format edits have titles you can change here.");
      if (agentBusy(p) || loadComments(p).some((c) => c.status === "queued")) throw new RoomError(409, "Claude is working on this edit. Wait for it to finish, then change the title.");
      const id = short(b.id, 40);
      const cfgFile = path.join(p.overlaysDir!, STAGE_CONFIG);
      const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
      const list: any[] = Array.isArray(cfg.titles) ? cfg.titles : [];
      const T = list.find((x) => String(x.id) === id);
      if (!T) throw new RoomError(404, "no such title");
      const colour = (v: unknown) => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : undefined);
      const n = (v: unknown, lo: number, hi: number) => num(v, lo, hi) ?? undefined;
      let what = short(b.what, 80);
      if (b.remove === true) {
        cfg.titles = list.filter((x) => x !== T);
        what ||= "Removed the title";
      } else {
        const x = n(b.x, 0, 4000), y = n(b.y, 0, 4000);
        if (x != null) T.x = Math.round(x);
        if (y != null) T.y = Math.round(y);
        if (Array.isArray(b.rows)) {
          if (b.rows.length !== (T.rows ?? []).length) throw new RoomError(400, "rows don't match the title");
          T.rows = (T.rows as any[]).map((r, i) => {
            const nr: any = (b.rows as any[])[i] ?? {};
            const out = { ...r };
            if (!r.rule && nr.text != null) {
              if (/[<>&]/.test(String(nr.text))) throw new RoomError(400, "A title can't contain < > or &.");
              out.text = short(nr.text, 80);
            }
            const c = colour(nr.color);
            if (c) out.color = c;
            const sz = n(nr.size, 12, 400);
            if (!r.rule && sz != null) out.size = Math.round(sz);
            return out;
          });
        }
        what ||= "Changed the title";
      }
      const cid = newId();
      quiet.add(p.id);
      try {
        outside(p);
        snapshot(p, cid);
        const tmp = `${cfgFile}.${newId()}.tmp`;
        const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o644);
        try {
          fs.writeSync(fd, JSON.stringify(cfg, null, 1));
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(tmp, cfgFile);
        const why = rebuildStageCaptions(p);
        if (why) {
          restore(p, cid, changedSince(p, cid));
          throw new RoomError(400, `The captions could not be laid out again (${why}). Nothing was changed.`);
        }
        const c: Comment = {
          id: cid,
          project: p.id,
          createdAt: Date.now(),
          text: what,
          t: Math.max(0, (T.start ?? 0) + 0.8),
          x: null,
          y: null,
          target: { kind: "frame", label: `title “${id}”` },
          status: "done",
          activity: [{ at: Date.now(), kind: "info", text: `${who.name} changed the title directly` }],
          reply: `${what}. Saved in stage_captions.json, so later cuts and caption changes keep it.`,
          changed: changedSince(p, cid),
          finishedAt: Date.now(),
          want: 1,
          author: authorOf(who),
          direct: true,
        };
        saveComments(p, [...loadComments(p), c]);
        rec(p, () => record(p, { kind: "comment", what: c.text, by: c.author, comment: cid }));
        e.emitComment(c);
        e.overlayChanged(p);
        return { comment: c };
      } finally {
        quiet.delete(p.id);
        e.projectChanged(p);
      }
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
      outside(p);
      const files = applyOption(p, cid, key); // undo restores the snapshot taken before the options were made
      const opt = c.options?.find((o) => o.key === key);
      rec(p, () => record(p, { kind: "pick", what: `Picked option ${key}${opt ? `: ${opt.note}` : ""} for “${c.text.slice(0, 100)}”`, by: authorOf(who), comment: cid }));
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
    /** For starting the agent elsewhere (the first-edit build): versions get saved the same way. */
    hooks,

    // ---- version history ----

    /** Newest first. `current` is the version the edit is at now (null if it changed since, e.g. mid-edit). */
    listVersions(p: Project, who: Person | undefined) {
      if (!p.draftDir) return { versions: [], current: null };
      outside(p); // also starts the history on first look
      const list = versions(p);
      const last = list.at(-1);
      const current = last && !agentBusy(p) ? last.n : null;
      // an older version with the very same files as now (e.g. the one just restored) has nothing to compare or restore
      const asNow = (v: Version) => current != null && v.n !== current && same(v.files, last!.files);
      // a picked option's note in `what` is the agent's own words, so it can name this Mac's folders: hide them as viewOf does
      const seen = (v: ReturnType<typeof info>) => (can(who, "editor") ? v : { ...v, what: redact(v.what)!, label: redact(v.label) });
      return { versions: list.map((v) => ({ ...seen(info(v)), ...(asNow(v) ? { sameAsNow: true } : {}) })).reverse(), current };
    },

    nameVersion(p: Project, who: Person, n: number, label: unknown) {
      needRole(who, "editor");
      try {
        const v = nameVersion(p, n, short(label, 60), who.name);
        e.versionsChanged(p);
        return info(v);
      } catch (err: any) {
        throw new RoomError(404, String(err?.message ?? err));
      }
    },

    /** Put the edit back to version n. The edit as it was becomes a version first, so a restore can be undone too. */
    restoreVersion(p: Project, who: Person, n: number) {
      needRole(who, "editor");
      if (agentBusy(p) || loadComments(p).some((c) => c.status === "queued")) throw new RoomError(409, "Wait for Claude to finish the comments in progress, then restore.");
      const v = versions(p).find((x) => x.n === n);
      if (!v) throw new RoomError(404, "no such version");
      outside(p);
      const wrote = restoreFiles(p, n);
      if (!wrote.length) throw new RoomError(400, `The edit is already the same as version ${n}.`);
      const saved = rec(p, () => record(p, { kind: "restore", what: `Restored version ${n}${v.label ? ` “${v.label}”` : ""}`, by: authorOf(who) }));
      if (wrote.some((f) => f.endsWith("index.html"))) e.overlayChanged(p);
      if (montageRestored(wrote)) {
        renderMontage(p)
          .catch((err) => console.error(`restore version ${n}: ${err.message}`))
          .then(() => buildProxy(p, () => e.projectChanged(p)));
      } else if (proxyState(p).status === "stale") buildProxy(p, () => e.projectChanged(p));
      e.projectChanged(p);
      return saved ? info(saved) : null;
    },
  };
}

export type Room = ReturnType<typeof makeRoom>;
