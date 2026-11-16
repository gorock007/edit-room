import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import chokidar, { type FSWatcher } from "chokidar";
import os from "node:os";
import { ALLOWED_HOSTS, ALLOWED_ORIGINS, CAPCUT_DRAFTS, DATA_DIR, HOST, PORT, PUBLIC_HOSTS, READ_ROOTS, REMOTE_PORT, SKILL_DIR, VIDEO_ROOT, inside } from "./config.ts";
import { getProject, listProjects, readModel, type Project } from "./projects.ts";
import { buildProxy, proxyFile, proxyState } from "./proxy.ts";
import { exportFile, exportName, exportState, startExport } from "./exporter.ts";
import { enqueue, quiet, stop } from "./agent.ts";
import { KEYS, applyOption, hasOption, optionProject } from "./options.ts";
import { dropSessions, hasPassword, isRemote, login, logout, needsLogin, personOf, startSession } from "./auth.ts";
import {
  OWNER, can, canSee, cancelInvites, cleanName, createInvite, getPerson, invites, peekInvite, people, publicPerson, redeemInvite,
  removePerson, updatePerson, type Person, type Role,
} from "./people.ts";
import { loadComments, newId, restore, saveComments, updateComment, type Author, type Comment } from "./store.ts";
import { MAX_CHUNK, newEditFolder, putChunk, rawDir, rawInfo, saveNote, startUpload } from "./uploads.ts";

const app = express();
app.set("case sensitive routing", true); // "/API/..." must not reach a route the login gate didn't recognise
app.set("strict routing", true);
// Every request must come from the app itself. A comment makes the agent run commands, so a web page in another tab
// must not be able to post one: the Host check stops DNS rebinding, the Origin check stops cross-site requests.
const allowed = (req: http.IncomingMessage) => {
  const host = String(req.headers.host ?? "");
  const origin = req.headers.origin;
  return ALLOWED_HOSTS.has(host) && (origin == null || ALLOWED_ORIGINS.has(origin));
};
app.use((req, res, next) => (allowed(req) ? next() : res.status(403).send("forbidden")));
app.use(express.json({ limit: "1mb" }));

// ---- login: needed by anything that is not this Mac (the phone, invited people; all over Tailscale) ----
// Deny by default: without a session a remote device gets the login/join endpoints and the app's own built files, nothing else.
const dist = path.resolve(import.meta.dirname, "../dist");
const OPEN_API = new Set(["GET /api/me", "POST /api/login", "POST /api/logout", "POST /api/invite", "POST /api/join"]);
const isAppFile = (p: string) => {
  if (p === "/" || p === "/index.html" || p === "/join") return true; // /join is the invite page (the app itself)
  try {
    const f = path.resolve(dist, "." + decodeURIComponent(p));
    return f.startsWith(dist + path.sep) && fs.statSync(f).isFile();
  } catch {
    return false;
  }
};
app.use((req, res, next) => {
  if (!needsLogin(req) || OPEN_API.has(`${req.method} ${req.path}`)) return next();
  if ((req.method === "GET" || req.method === "HEAD") && isAppFile(req.path)) return next();
  res.status(401).json({ error: "login required" });
});

/** Who is asking. Past the gate this is always someone. */
const me = (req: express.Request) => personOf(req)!;
const ROLE_WORD: Record<Role, string> = { viewer: "people in the room", commenter: "commenters and editors", editor: "editors", owner: "the owner" };
const need = (role: Role): express.RequestHandler => (req, res, next) =>
  can(personOf(req) ?? undefined, role) ? next() : res.status(403).json({ error: `Only ${ROLE_WORD[role]} can do that.` });

const publicUrl = () => (PUBLIC_HOSTS[0] ? `https://${PUBLIC_HOSTS[0]}` : null);
const authorOf = (p: Person): Author => ({ id: p.id, name: p.name, color: p.color, role: p.role });

app.get("/api/me", (req, res) => {
  const p = personOf(req);
  res.json({
    remote: isRemote(req),
    authed: !needsLogin(req),
    hasPassword: hasPassword(),
    person: p ? { ...publicPerson(p), projects: p.projects } : null,
    publicUrl: publicUrl(),
  });
});
app.post("/api/login", async (req, res) => {
  if (!isRemote(req)) return res.json({ ok: true });
  const r = await login(String(req.body?.password ?? ""), String(req.headers["user-agent"] ?? ""));
  if ("error" in r) return res.status(r.status).json({ error: r.error });
  res.setHeader("Set-Cookie", r.cookie).json({ ok: true });
});
app.post("/api/logout", (req, res) => res.setHeader("Set-Cookie", logout(req)).json({ ok: true }));

app.patch("/api/me", (req, res) => {
  try {
    const p = updatePerson(me(req).id, { name: req.body?.name });
    peopleChanged();
    res.json(publicPerson(p));
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

// ---- invites: a one-time link the owner makes; the person opens it, types their name, and is in ----
const EXPIRED = "This invite link has expired or was already used. Ask for a new one.";
app.post("/api/invite", (req, res) => {
  const i = peekInvite(String(req.body?.token ?? ""));
  if (!i) return res.status(404).json({ error: EXPIRED });
  const names = i.projects === "all" ? null : i.projects.map((id) => getProject(id)?.name ?? id);
  res.json({ role: i.role, from: i.from, projects: names });
});
app.post("/api/join", (req, res) => {
  if (!isRemote(req)) return res.status(400).json({ error: "This Mac is already the owner. Open the invite link on the other person's device." });
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: "Type your name so others know who's commenting." });
  const p = redeemInvite(String(req.body?.token ?? ""), name);
  if (!p) return res.status(404).json({ error: EXPIRED });
  res.setHeader("Set-Cookie", startSession(p.id, String(req.headers["user-agent"] ?? ""))).json({ ok: true });
  peopleChanged();
});

// ---- people: the owner decides who is in the room and what they may do ----
app.get("/api/people", need("owner"), (_req, res) => res.json({ people: people(), invites: invites(), publicUrl: publicUrl() }));
app.post("/api/people/invites", need("owner"), (req, res) => {
  try {
    const { token, expires } = createInvite(me(req), req.body?.role, req.body?.projects);
    const base = publicUrl();
    res.json({ token, expires, url: base ? `${base}/join#${token}` : null });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});
app.delete("/api/people/invites", need("owner"), (_req, res) => {
  cancelInvites();
  res.json({ ok: true });
});
app.patch("/api/people/:pid", need("owner"), (req, res) => {
  try {
    const p = updatePerson(String(req.params.pid), { name: req.body?.name, role: req.body?.role, projects: req.body?.projects });
    sendTo(p.id, { type: "me" }); // their app re-reads what they may do now
    peopleChanged();
    res.json(p);
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});
app.delete("/api/people/:pid", need("owner"), (req, res) => {
  const id = String(req.params.pid);
  try {
    removePerson(id);
  } catch (e: any) {
    return res.status(400).json({ error: String(e?.message ?? e) });
  }
  dropSessions(id);
  for (const [ws, peer] of peers) if (peer.person === id) ws.close(4401, "removed");
  peopleChanged();
  res.json({ ok: true });
});

// Two listeners on one app: the local port (this Mac; no login) and the remote port (tailscale serve; always login).
const localServer = http.createServer(app);
const remoteServer = http.createServer(app);
const sockets = [localServer, remoteServer].map(
  (server) =>
    new WebSocketServer({
      server,
      path: "/ws",
      maxPayload: 4096,
      verifyClient: ({ req }: { req: http.IncomingMessage }) => allowed(req) && req.headers.origin != null && !needsLogin(req),
    }),
);

// ---- the live room: who is connected, which project they have open, where their playhead is ----
type Peer = { sid: string; person: string; project: string | null; t: number; playing: boolean; at: number };
const peers = new Map<WebSocket, Peer>();

/** Send to everyone who may see `project` (everyone when no project). */
const send = (msg: unknown, project?: string) => {
  const s = JSON.stringify(msg);
  for (const [ws, peer] of peers) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (project && !canSee(getPerson(peer.person), project)) continue;
    ws.send(s);
  }
};
const sendTo = (personId: string, msg: unknown) => {
  const s = JSON.stringify(msg);
  for (const [ws, peer] of peers) if (peer.person === personId && ws.readyState === WebSocket.OPEN) ws.send(s);
};

/**
 * What a person sees of a comment. Editors see everything; commenters and viewers (often clients) see what was asked and
 * Claude's answer, not the agent's command log, costs or this Mac's file paths.
 */
// this Mac's folders, longest first, so "/Users/me/…/Video Editor/1116s edit/x.json" reads "…/1116s edit/x.json"
const PRIVATE_ROOTS = [...new Set([VIDEO_ROOT, CAPCUT_DRAFTS, DATA_DIR, SKILL_DIR, os.homedir()])].sort((a, b) => b.length - a.length);
const redact = (s: string | undefined) => (s == null ? s : PRIVATE_ROOTS.reduce((acc, r) => acc.split(r).join("…"), s));
const viewOf = (c: Comment, who: Person | undefined): Comment =>
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

const emitComment = (c: Comment) => {
  for (const [ws, peer] of peers) {
    const who = getPerson(peer.person);
    if (ws.readyState !== WebSocket.OPEN || !canSee(who, c.project)) continue;
    ws.send(JSON.stringify({ type: "comment", comment: viewOf(c, who) }));
  }
};
const projectChanged = (p: Project) => send({ type: "project", id: p.id, proxy: proxyState(p) }, p.id);
const exportChanged = (p: Project) => send({ type: "export", id: p.id, export: exportState(p) }, p.id);
const overlayChanged = (p: Project) => send({ type: "overlay", id: p.id, at: Date.now() }, p.id);
const hooks = { emit: emitComment, projectChanged, overlayChanged };

let presenceTimer: ReturnType<typeof setTimeout> | null = null;
function broadcastPresence() {
  presenceTimer = null;
  const list = [...peers.values()].flatMap((pe) => {
    const who = getPerson(pe.person);
    return who && pe.project ? [{ sid: pe.sid, ...publicPerson(who), project: pe.project, t: pe.t, playing: pe.playing, at: pe.at }] : [];
  });
  for (const [ws, peer] of peers) {
    const who = getPerson(peer.person);
    if (!who || ws.readyState !== WebSocket.OPEN) continue;
    ws.send(JSON.stringify({ type: "presence", people: list.filter((x) => canSee(who, x.project)) }));
  }
}
const presenceSoon = () => {
  if (!presenceTimer) presenceTimer = setTimeout(broadcastPresence, 120);
};
/** A name, role or colour changed: everyone's presence list and the owner's people list refresh. */
const peopleChanged = () => {
  presenceSoon();
  sendTo(OWNER, { type: "people" });
};

for (const wss of sockets)
  wss.on("connection", (ws, req) => {
    const who = personOf(req);
    if (!who) return ws.close(4401, "login required");
    const peer: Peer = { sid: newId(), person: who.id, project: null, t: 0, playing: false, at: Date.now() };
    peers.set(ws, peer);
    ws.send(JSON.stringify({ type: "hello", sid: peer.sid }));
    ws.on("message", (raw) => {
      let m: any;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (m?.type !== "presence") return;
      const proj = typeof m.project === "string" && m.project.length < 100 ? m.project : null;
      peer.project = proj && canSee(getPerson(peer.person), proj) ? proj : null;
      const t = Number(m.t);
      peer.t = Number.isFinite(t) ? Math.max(0, Math.min(t, 86_400)) : 0;
      peer.playing = !!m.playing;
      peer.at = Date.now();
      presenceSoon();
    });
    ws.on("close", () => {
      peers.delete(ws);
      presenceSoon();
    });
  });

// ---- live reload: the draft (sounds, cuts) and the caption composition ----
const watchers = new Map<string, FSWatcher>();
function watch(p: Project) {
  if (watchers.has(p.id)) return;
  const files = [p.draftDir && path.join(p.draftDir, "draft_info.json"), p.overlaysDir && path.join(p.overlaysDir, "index.html")].filter(Boolean) as string[];
  const w = chokidar.watch(files, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 } });
  w.on("change", (f) => {
    if (quiet.has(p.id)) return; // the agent is trying options in these files; the user's preview stays put
    if (f.endsWith("index.html")) overlayChanged(p);
    else projectChanged(p);
  });
  watchers.set(p.id, w);
}

/** Runs `fn` for a project this person may see; anything else is "no such project" (it doesn't say it exists). */
const withProject = (fn: (p: Project, req: express.Request, res: express.Response) => unknown) => async (req: express.Request, res: express.Response) => {
  const p = getProject(String(req.params.id));
  if (!p || !canSee(personOf(req) ?? undefined, p.id)) return res.status(404).json({ error: "no such project" });
  try {
    await fn(p, req, res);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
};

app.get("/api/projects", (req, res) => {
  const who = me(req);
  res.json(
    listProjects()
      .filter((p) => canSee(who, p.id))
      .map((p) => ({ id: p.id, name: p.name, hasDraft: !!p.draftDir, hasOverlay: !!p.overlaysDir, hasRaw: fs.existsSync(rawDir(p)) })),
  );
});

// ---- new edit: raw footage in from any device, then Claude builds the first cut ----
app.post("/api/new-edit", need("editor"), (req, res) => {
  if (me(req).projects !== "all") return res.status(403).json({ error: "Only people with access to every project can start a new edit." });
  try {
    const { id } = newEditFolder();
    res.json({ id });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.get("/api/projects/:id/raw", withProject((p, _req, res) => res.json(rawInfo(p))));

app.post("/api/projects/:id/uploads", need("editor"), withProject((p, req, res) => {
  if (p.draftDir) return res.status(400).json({ error: "this edit is already built; start a new edit for new footage" });
  try {
    res.json(startUpload(p, String(req.body?.name ?? ""), Number(req.body?.size)));
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
}));

app.put("/api/projects/:id/uploads/:key", need("editor"), withProject(async (p, req, res) => {
  const len = Number(req.headers["content-length"]);
  if (!Number.isFinite(len) || len <= 0 || len > MAX_CHUNK) return res.status(413).json({ error: "chunk too big" });
  try {
    res.json(await putChunk(p, String(req.params.key), Number(req.query.offset), req));
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: String(e?.message ?? e), received: e.received });
  }
}));

const BUILD_LABEL = "first edit";
app.post("/api/projects/:id/build", need("editor"), withProject((p, req, res) => {
  if (!runsDirectly(me(req))) return res.status(403).json({ error: "Only people with access to every project can start a new edit." });
  if (p.draftDir) return res.status(400).json({ error: "this edit is already built" });
  const raw = rawInfo(p);
  if (!raw.files.length) return res.status(400).json({ error: "upload the footage first" });
  if (raw.pending.length) return res.status(400).json({ error: "wait for the uploads to finish" });
  if (loadComments(p).some((c) => c.target.kind === "build" && ["queued", "working"].includes(c.status)))
    return res.status(409).json({ error: "the first edit is already being built" });
  const note = String(req.body?.note ?? "").trim();
  saveNote(p, note);
  const c: Comment = {
    id: newId(),
    project: p.id,
    createdAt: Date.now(),
    text: note ? `Build the first edit. ${note}` : "Build the first edit.",
    t: 0,
    x: null,
    y: null,
    target: { kind: "build", label: BUILD_LABEL, detail: raw.files.map((f) => f.name).join(", ") },
    status: "queued",
    activity: [],
    want: 1,
    author: authorOf(me(req)),
  };
  saveComments(p, [...loadComments(p), c]);
  emitComment(c);
  enqueue(p, c.id, hooks);
  res.json(c);
}));

app.get("/api/projects/:id/model", withProject((p, _req, res) => {
  watch(p);
  const st = proxyState(p);
  if (st.status === "missing") buildProxy(p, () => projectChanged(p)); // first open: make the preview
  res.json({ model: readModel(p), proxy: proxyState(p) });
}));

// ---- export for Reels / TikTok ----
app.get("/api/projects/:id/export", withProject((p, _req, res) => res.json(exportState(p))));

app.post("/api/projects/:id/export", need("editor"), withProject((p, _req, res) => {
  if (!p.draftDir) return res.status(409).json({ error: "this edit isn't built yet" });
  res.json(startExport(p, () => exportChanged(p)));
}));

app.post("/api/projects/:id/proxy", need("editor"), withProject((p, _req, res) => {
  buildProxy(p, () => projectChanged(p));
  res.json(proxyState(p));
}));

app.get("/api/projects/:id/comments", withProject((p, req, res) => {
  const who = me(req);
  res.json(loadComments(p).map((c) => viewOf(c, who)));
}));

/**
 * The agent runs shell commands on this Mac, and the only thing keeping it to one project is its prompt. So only an
 * editor with every project (someone the owner trusts with the whole Mac) starts it directly or approves a comment;
 * everyone else's comments wait for such an editor to read them first.
 */
const runsDirectly = (p: Person) => can(p, "editor") && p.projects === "all";

const KINDS = new Set(["caption", "frame", "sfx", "cut", "broll", "general"]);
const short = (v: unknown, n: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
/**
 * The click target from the app, rebuilt from known kinds and short strings. It goes into the agent's prompt next to
 * the comment, so it must not be a place to hide a longer request than the approver sees (the app shows all of it).
 */
function cleanTarget(t: any): Comment["target"] {
  const kind = KINDS.has(t?.kind) ? t.kind : "general";
  const label = short(t?.label, 120) || "the video";
  const out: Comment["target"] = { kind, label };
  if (t?.id != null && /^[\w.:-]{1,40}$/.test(String(t.id))) out.id = String(t.id);
  const detail = short(t?.detail, 160);
  if (detail) out.detail = detail;
  return out;
}

// An editor's comment goes to the agent the moment it is posted (like Claude Design). A commenter's waits for an
// editor to approve it: the agent runs commands on this Mac, so someone trusted reads every request first.
app.post("/api/projects/:id/comments", need("commenter"), withProject((p, req, res) => {
  const b = req.body ?? {};
  if (!String(b.text ?? "").trim()) return res.status(400).json({ error: "empty comment" });
  if (b.target?.kind === "build") return res.status(400).json({ error: "use the build endpoint" });
  if (!p.draftDir) return res.status(400).json({ error: "this edit isn't built yet: start the edit first" });
  const who = me(req);
  const direct = runsDirectly(who);
  const num = (v: unknown, lo: number, hi: number) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : null);
  const c: Comment = {
    id: newId(),
    project: p.id,
    createdAt: Date.now(),
    text: String(b.text).trim().slice(0, 4000),
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
  emitComment(c);
  if (direct) enqueue(p, c.id, hooks);
  res.json(viewOf(c, who));
}));

app.post("/api/projects/:id/comments/:cid/approve", need("editor"), withProject((p, req, res) => {
  const cid = String(req.params.cid);
  const who = me(req);
  if (!runsDirectly(who)) return res.status(403).json({ error: "Only an editor with access to every project can approve a comment for Claude." });
  let ok = false;
  const c = updateComment(p, cid, (x) => {
    if (x.status !== "pending") return;
    ok = true;
    x.status = "queued";
    x.approvedBy = who.name;
    x.activity.push({ at: Date.now(), kind: "info", text: `Approved by ${who.name}` });
  });
  if (!c || !ok) return res.status(400).json({ error: "this comment isn't waiting for approval" });
  emitComment(c);
  enqueue(p, c.id, hooks);
  res.json(c);
}));

app.post("/api/projects/:id/comments/:cid/decline", need("editor"), withProject((p, req, res) => {
  const cid = String(req.params.cid);
  const who = me(req);
  const reason = String(req.body?.reason ?? "").trim().slice(0, 500);
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
  if (!c || !ok) return res.status(400).json({ error: "this comment isn't waiting for approval" });
  emitComment(c);
  res.json(c);
}));

// Editors stop anything; anyone can take back their own comment before the agent starts on it.
app.post("/api/projects/:id/comments/:cid/stop", need("commenter"), withProject((p, req, res) => {
  const cid = String(req.params.cid);
  const who = me(req);
  const cur = loadComments(p).find((x) => x.id === cid);
  if (!cur) return res.status(404).json({ error: "no such comment" });
  const own = (cur.author?.id ?? OWNER) === who.id;
  if (!can(who, "editor") && !(own && ["pending", "queued"].includes(cur.status)))
    return res.status(403).json({ error: "Only editors can stop a comment Claude is working on." });
  const c = updateComment(p, cid, (x) => {
    if (x.status === "queued" || x.status === "pending") x.status = "stopped";
  });
  stop(cid);
  if (c) emitComment(c);
  res.json(c ? viewOf(c, who) : null);
}));

app.post("/api/projects/:id/comments/:cid/undo", need("editor"), withProject((p, req, res) => {
  const cid = String(req.params.cid);
  const c = loadComments(p).find((x) => x.id === cid);
  if (!c?.changed?.length) return res.status(400).json({ error: "nothing to undo" });
  restore(p, cid, c.changed);
  const who = me(req);
  const u = updateComment(p, cid, (x) => {
    x.status = "undone";
    x.activity.push({ at: Date.now(), kind: "info", text: `Undone by ${who.name}: restored ${x.changed!.map((f) => path.basename(f)).join(", ")}` });
  })!;
  emitComment(u);
  if (c.changed.some((f) => f.endsWith("index.html"))) overlayChanged(p);
  if (proxyState(p).status === "stale") buildProxy(p, () => projectChanged(p));
  projectChanged(p);
  res.json(u);
}));


// ---- options: preview each one, then use one or keep the current version ----
const optionOf = (p: Project, req: express.Request) => {
  const cid = String(req.params.cid), key = String(req.params.key);
  if (!/^[a-f0-9]{10}$/.test(cid) || !KEYS.includes(key) || !hasOption(p, cid, key)) return null;
  return { cid, key, op: optionProject(p, cid, key) };
};

app.get("/api/projects/:id/options/:cid/:key/model", withProject((p, req, res) => {
  const o = optionOf(p, req);
  if (!o) return res.status(404).json({ error: "no such option" });
  res.json({ model: readModel(o.op), proxy: proxyState(o.op) });
}));

app.get("/media/:id/options/:cid/:key/proxy.mp4", withProject((p, req, res) => {
  const o = optionOf(p, req);
  if (!o || !fs.existsSync(proxyFile(o.op))) return res.status(404).end();
  res.sendFile(proxyFile(o.op), { headers: { "Cache-Control": "no-cache" } });
}));

app.post("/api/projects/:id/comments/:cid/pick", need("editor"), withProject((p, req, res) => {
  const cid = String(req.params.cid);
  const key = String(req.body?.key ?? "");
  const who = me(req);
  const c = loadComments(p).find((x) => x.id === cid);
  if (!c || c.status !== "review") return res.status(400).json({ error: "this comment has no options waiting" });
  if (key === "current") {
    const u = updateComment(p, cid, (x) => {
      x.status = "done";
      x.chosen = "current";
      x.activity.push({ at: Date.now(), kind: "info", text: `${who.name} kept the current version` });
    })!;
    emitComment(u);
    return res.json(u);
  }
  if (!KEYS.includes(key) || !hasOption(p, cid, key)) return res.status(400).json({ error: "no such option" });
  const files = applyOption(p, cid, key); // undo restores the snapshot taken before the options were made
  const opt = c.options?.find((o) => o.key === key);
  const u = updateComment(p, cid, (x) => {
    x.status = "done";
    x.chosen = key;
    x.changed = files;
    x.activity.push({ at: Date.now(), kind: "info", text: `${who.name} picked option ${key}${opt ? `: ${opt.note}` : ""}` });
  })!;
  emitComment(u);
  overlayChanged(p);
  if (proxyState(p).status === "stale") buildProxy(p, () => projectChanged(p));
  projectChanged(p);
  res.json(u);
}));

// ---- media ----
app.get("/media/:id/export.mp4", withProject((p, req, res) => {
  if (!fs.existsSync(exportFile(p))) return res.status(404).end();
  const name = exportName(p);
  const disp = req.query.download ? "attachment" : "inline";
  res.sendFile(exportFile(p), {
    headers: { "Cache-Control": "no-cache", "Content-Disposition": `${disp}; filename="${name.replace(/[^\x20-\x7e]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}` },
  });
}));

app.get("/media/:id/proxy.mp4", withProject((p, _req, res) => {
  if (!fs.existsSync(proxyFile(p))) return res.status(404).end();
  res.sendFile(proxyFile(p), { headers: { "Cache-Control": "no-cache" } });
}));

app.get("/media/:id/frame/:cid.png", withProject((p, req, res) => {
  const f = path.join(p.dataDir, "frames", `${String(req.params.cid).replace(/[^a-f0-9]/g, "")}.png`);
  fs.existsSync(f) ? res.sendFile(f) : res.status(404).end();
}));

/** Sound files: only the exact files this project's draft uses. */
app.get("/media/:id/file", withProject((p, req, res) => {
  const f = String(req.query.p ?? "");
  const uses = (q: Project) => {
    try {
      return readModel(q).sfx.some((s) => s.file === f);
    } catch {
      return false;
    }
  };
  // the current edit's sounds, or those of an option waiting to be compared
  const known = uses(p) || loadComments(p).some((c) => c.status === "review" && c.options?.some((o) => uses(optionProject(p, c.id, o.key))));
  if (!known || !inside(f, READ_ROOTS) || !fs.existsSync(f)) return res.status(404).end();
  res.sendFile(f);
}));

// The caption composition, with a tiny time driver injected so the app can seek it frame-exactly.
const DRIVER = `<script>
window.__timelines = window.__timelines || {};
window.__room = {
  seek(t) {
    for (const el of document.querySelectorAll('.clip')) {
      const s = +el.dataset.start, d = +el.dataset.duration;
      el.style.visibility = t >= s && t < s + d ? 'visible' : 'hidden';
    }
    const tl = window.__timelines.main || Object.values(window.__timelines)[0];
    if (tl) tl.seek(t, false);
  }
};
</script>`;
app.get("/overlay/:id/{*rest}", withProject((p, req, res) => {
  let rest = ([] as string[]).concat((req.params as any).rest ?? []).join("/") || "index.html";
  let dir = p.overlaysDir;
  const m = rest.match(/^o\/([a-f0-9]{10})\/([A-D])\/(.*)$/);
  if (m) {
    if (!hasOption(p, m[1], m[2])) return res.status(404).end();
    dir = optionProject(p, m[1], m[2]).overlaysDir;
    rest = m[3] || "index.html";
  }
  if (!dir) return res.status(404).end();
  const f = path.resolve(dir, rest);
  // an option's folder links to the real one for everything it did not change, so both are allowed roots
  if (!inside(f, [dir, p.overlaysDir ?? dir]) || !fs.existsSync(f)) return res.status(404).end();
  if (rest === "index.html") {
    const html = fs.readFileSync(f, "utf8").replace("<head>", "<head>" + DRIVER);
    return res.type("html").set("Cache-Control", "no-store").send(html);
  }
  res.sendFile(f);
}));

// the built app (what the phone loads; `npm run dev` keeps it rebuilt)
app.use(express.static(dist, { index: false }));
app.get("/{*any}", (_req, res) => {
  const index = path.join(dist, "index.html");
  fs.existsSync(index) ? res.set("Cache-Control", "no-cache").sendFile(index) : res.status(404).send("Not built yet: run npm run build");
});

localServer.listen(PORT, HOST, () => console.log(`edit room server on http://${HOST}:${PORT} (this Mac)`));
remoteServer.listen(REMOTE_PORT, "127.0.0.1", () => console.log(`login-only port for tailscale serve on http://127.0.0.1:${REMOTE_PORT}`));
