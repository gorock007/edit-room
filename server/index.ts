import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import chokidar, { type FSWatcher } from "chokidar";
import { ALLOWED_HOSTS, ALLOWED_ORIGINS, HOST, PORT, PUBLIC_HOSTS, READ_ROOTS, REMOTE_PORT, VIDEO_ROOT, inside } from "./config.ts";
import { getProject, listProjects, readModel, type Project } from "./projects.ts";
import { buildProxy, proxyFile, proxyState } from "./proxy.ts";
import { exportFile, exportName, exportState } from "./exporter.ts";
import { enqueue, quiet, recoverInterrupted } from "./agent.ts";
import { KEYS, hasOption, optionProject } from "./options.ts";
import { dropSessions, hasPassword, isRemote, login, logout, needsLogin, personOf, startSession } from "./auth.ts";
import {
  OWNER, can, canSee, cancelInvites, cleanName, createAgent, createInvite, getPerson, invites, ownerView, peekInvite, people,
  publicPerson, redeemInvite, removePerson, updatePerson, type Person, type Role,
} from "./people.ts";
import { loadComments, newId, saveComments, type Comment } from "./store.ts";
import { FORMATS, MAX_CHUNK, libraryFolders, newEditFolder, putChunk, rawDir, rawInfo, saveBuildOptions, saveNote, startUpload, type Format } from "./uploads.ts";
import { RoomError, authorOf, makeRoom, runsDirectly, viewOf } from "./room.ts";
import { mcpHandler } from "./mcp.ts";
import { versionProject } from "./versions.ts";
import { readUsage } from "./usage.ts";
import { checksState, scheduleChecks, setOk } from "./checks.ts";
import { MUSIC_DIR, listMusic, musicFile } from "./music.ts";
import { autoTemplates, templateKit, WILD_ROOT, WildError, folderOf, listTemplates, templateOf, listWild, recoverWildJobs, setDecision, startPlan, startTemplate, stopWildJob, wildDetail, wildFile, type Decision } from "./wildcards.ts";
import { DRIVER, GSAP_CDN_SRC, LOCAL_GSAP, OVERLAY_CSP, localGsapUrl, stillSeek } from "./overlay.ts";

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
// /mcp checks the agent's own key on every request (never a browser cookie), on both ports.
const dist = path.resolve(import.meta.dirname, "../dist");
const OPEN_API = new Set(["GET /api/me", "POST /api/login", "POST /api/logout", "POST /api/invite", "POST /api/join", "POST /mcp", "GET /mcp", "DELETE /mcp"]);
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
/** Where agents connect: on this Mac, and over Tailscale. */
const mcpUrls = () => ({ local: `http://127.0.0.1:${PORT}/mcp`, remote: publicUrl() ? `${publicUrl()}/mcp` : null });

/** The Claude plan's usage, which steers the model each comment runs on (editors see it next to the comments). */
app.get("/api/usage", need("editor"), async (req, res) => {
  res.json(await readUsage(req.query.fresh === "1"));
});

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
app.get("/api/people", need("owner"), (_req, res) =>
  res.json({ people: people().map(ownerView), invites: invites(), publicUrl: publicUrl(), mcp: mcpUrls() }),
);
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
// connect an agent: its key is shown this once; only a hash is kept
app.post("/api/people/agents", need("owner"), (req, res) => {
  try {
    const { person, key } = createAgent(req.body?.name, req.body?.role, req.body?.projects);
    peopleChanged();
    res.json({ person: ownerView(person), key, mcp: mcpUrls() });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});
app.patch("/api/people/:pid", need("owner"), (req, res) => {
  try {
    const p = updatePerson(String(req.params.pid), { name: req.body?.name, role: req.body?.role, projects: req.body?.projects });
    sendTo(p.id, { type: "me" }); // their app re-reads what they may do now
    peopleChanged();
    res.json(ownerView(p));
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
  agentSeen.delete(id);
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
/** Agents have no socket: they are "here" for a while after each call that touches a project, at the time it was about. */
const AGENT_HERE_MS = 90_000;
const agentSeen = new Map<string, { project: string; t: number; at: number }>();

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

const emitComment = (c: Comment) => {
  for (const [ws, peer] of peers) {
    const who = getPerson(peer.person);
    if (ws.readyState !== WebSocket.OPEN || !canSee(who, c.project)) continue;
    ws.send(JSON.stringify({ type: "comment", comment: viewOf(c, who) }));
  }
};
const checksChanged = (p: Project) => send({ type: "checks", id: p.id, checks: checksState(p) }, p.id);
/** Look the edit over again if it changed (checks.ts): cheap to call, it only runs when something is new. */
const recheck = (p: Project) => void scheduleChecks(p, () => checksChanged(p)).catch(() => {});
const projectChanged = (p: Project) => {
  send({ type: "project", id: p.id, proxy: proxyState(p) }, p.id);
  if (!quiet.has(p.id)) recheck(p);
};
const exportChanged = (p: Project) => send({ type: "export", id: p.id, export: exportState(p) }, p.id);
const overlayChanged = (p: Project) => send({ type: "overlay", id: p.id, at: Date.now() }, p.id);
const versionsChanged = (p: Project) => send({ type: "versions", id: p.id }, p.id);
const room = makeRoom({ emitComment, projectChanged, overlayChanged, exportChanged, versionsChanged, checksChanged });
const hooks = room.hooks;

type Here = ReturnType<typeof publicPerson> & { sid: string; project: string; t: number; playing: boolean; at: number };
function hereNow(): Here[] {
  const now = Date.now();
  const list: Here[] = [...peers.values()].flatMap((pe) => {
    const who = getPerson(pe.person);
    return who && pe.project ? [{ sid: pe.sid, ...publicPerson(who), project: pe.project, t: pe.t, playing: pe.playing, at: pe.at }] : [];
  });
  for (const [id, a] of agentSeen) {
    const who = getPerson(id);
    if (!who || now - a.at > AGENT_HERE_MS) agentSeen.delete(id);
    else list.push({ sid: `agent-${id}`, ...publicPerson(who), project: a.project, t: a.t, playing: false, at: a.at });
  }
  return list;
}

let presenceTimer: ReturnType<typeof setTimeout> | null = null;
function broadcastPresence() {
  presenceTimer = null;
  const list = hereNow();
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
/** First look at a project: follow its files, and make its preview if there is none yet. */
const openProject = (p: Project) => {
  watch(p);
  if (proxyState(p).status === "missing") buildProxy(p, () => projectChanged(p));
};

// ---- agents: Edit Room as an MCP server (see mcp.ts) ----
app.all("/mcp", mcpHandler({
  room,
  open: openProject,
  seen: (who, project, t) => {
    const prev = agentSeen.get(who.id);
    agentSeen.set(who.id, { project, t: t ?? (prev?.project === project ? prev.t : 0), at: Date.now() });
    presenceSoon();
    setTimeout(presenceSoon, AGENT_HERE_MS + 500); // and again when it has been quiet long enough to leave
  },
  here: (who, project) => hereNow().filter((x) => x.project === project && x.id !== who.id),
}));

/** Runs `fn` for a project this person may see; anything else is "no such project" (it doesn't say it exists). */
const withProject = (fn: (p: Project, req: express.Request, res: express.Response) => unknown) => async (req: express.Request, res: express.Response) => {
  const p = getProject(String(req.params.id));
  if (!p || !canSee(personOf(req) ?? undefined, p.id)) return res.status(404).json({ error: "no such project" });
  try {
    await fn(p, req, res);
  } catch (e: any) {
    if (e instanceof RoomError) return res.status(e.status).json({ error: e.message });
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

// the user's own footage folders a new edit may draw b-roll from: folder names on this Mac, so only for full editors
app.get("/api/library-folders", need("editor"), (req, res) => {
  if (me(req).projects !== "all") return res.json([]);
  res.json(libraryFolders());
});

app.post("/api/projects/:id/uploads", need("editor"), withProject((p, req, res) => {
  if (p.draftDir) return res.status(400).json({ error: "this edit is already built; start a new edit for new footage" });
  try {
    res.json(startUpload(p, String(req.body?.name ?? ""), Number(req.body?.size), req.body?.dest === "resources" ? "resources" : "raw"));
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
  // the format is the user's call for every video, and nobody is there to ask once the build runs
  const format = req.body?.format as Format;
  if (!FORMATS.includes(format)) return res.status(400).json({ error: "choose 9:16 or 16:9 first" });
  const known = new Set(libraryFolders().map((f) => f.name));
  const folders = (Array.isArray(req.body?.folders) ? req.body.folders : []).filter((f: unknown): f is string => typeof f === "string" && known.has(f));
  // the look: the house style (null) or one of the user's wild card templates
  const style = req.body?.style == null || req.body.style === "" ? null : String(req.body.style);
  const tpl = style ? templateOf(style) : null;
  if (style && !tpl) return res.status(400).json({ error: "that template doesn't exist any more" });
  // music: none (voice only, the house default), "auto" (Claude picks from the bank) or one track in the bank
  const music = req.body?.music == null || req.body.music === "" ? null : String(req.body.music);
  if (music && music !== "auto" && !musicFile(music)) return res.status(400).json({ error: "that track isn't in the music folder any more" });
  saveNote(p, note);
  saveBuildOptions(p, { format, folders, style, music });
  const text = `Build the first edit in ${format}${tpl ? `, in the "${tpl.title}" template` : ""}${music === "auto" ? ", music picked by Claude" : music ? `, music "${trackName(music)}"` : ""}.${raw.resources.length ? ` ${raw.resources.length} extra file${raw.resources.length > 1 ? "s" : ""} to use.` : ""}${note ? ` ${note}` : ""}`;
  res.json(queueBuild(p, me(req), text, raw.files.map((f) => f.name).join(", ")));
}));

const trackName = (m: string) => path.basename(m).replace(/\.[^.]+$/, "");
/** The first-edit job: a "build" comment the agent queue picks up (its prompt is firstEditPrompt). */
function queueBuild(p: Project, who: Person, text: string, detail: string): Comment {
  const c: Comment = {
    id: newId(),
    project: p.id,
    createdAt: Date.now(),
    text,
    t: 0,
    x: null,
    y: null,
    target: { kind: "build", label: BUILD_LABEL, detail },
    status: "queued",
    activity: [],
    want: 1,
    author: authorOf(who),
  };
  saveComments(p, [...loadComments(p), c]);
  emitComment(c);
  enqueue(p, c.id, hooks);
  return c;
}

app.get("/api/projects/:id/model", withProject((p, _req, res) => {
  openProject(p);
  res.json({ model: readModel(p), proxy: proxyState(p) });
}));

// ---- export for Reels / TikTok ----
app.get("/api/projects/:id/export", withProject((p, _req, res) => res.json(exportState(p))));
app.post("/api/projects/:id/export", withProject((p, req, res) => res.json(room.startExport(p, me(req)))));

app.post("/api/projects/:id/proxy", need("editor"), withProject((p, _req, res) => {
  buildProxy(p, () => projectChanged(p));
  res.json(proxyState(p));
}));

// ---- comments: the same room actions agents use over MCP (room.ts) ----
app.get("/api/projects/:id/comments", withProject((p, req, res) => {
  const who = me(req);
  res.json(loadComments(p).map((c) => viewOf(c, who)));
}));

app.post("/api/projects/:id/comments", withProject((p, req, res) => {
  const b = req.body ?? {};
  if (b.target?.kind === "build") return res.status(400).json({ error: "use the build endpoint" });
  res.json(room.postComment(p, me(req), b));
}));
app.post("/api/projects/:id/comments/:cid/run", withProject((p, req, res) => res.json(room.release(p, me(req), String(req.params.cid), req.body?.tier))));
app.post("/api/projects/:id/comments/:cid/approve", withProject((p, req, res) => res.json(room.approve(p, me(req), String(req.params.cid)))));
app.post("/api/projects/:id/comments/:cid/decline", withProject((p, req, res) => res.json(room.decline(p, me(req), String(req.params.cid), req.body?.reason))));
app.post("/api/projects/:id/comments/:cid/stop", withProject((p, req, res) => res.json(room.stopComment(p, me(req), String(req.params.cid)))));
app.post("/api/projects/:id/comments/:cid/undo", withProject((p, req, res) => res.json(room.undo(p, me(req), String(req.params.cid)))));
app.post("/api/projects/:id/comments/:cid/pick", withProject((p, req, res) => res.json(room.pick(p, me(req), String(req.params.cid), String(req.body?.key ?? "")))));

// ---- the transcript, and cutting words or pauses straight from it (no Claude; see cut.ts) ----
app.get("/api/projects/:id/transcript", withProject((p, _req, res) => res.json(room.transcript(p))));
app.post("/api/projects/:id/cut", withProject(async (p, req, res) => res.json(await room.cut(p, me(req), req.body ?? {}))));
app.post("/api/projects/:id/titles", withProject((p, req, res) => res.json(room.titles(p, me(req), req.body ?? {}))));

// ---- checks: what Edit Room found watching and listening to the preview (checks.ts) ----
app.get("/api/projects/:id/checks", withProject((p, _req, res) => {
  recheck(p);
  res.json(checksState(p));
}));
app.post("/api/projects/:id/checks/ok", need("editor"), withProject((p, req, res) => {
  setOk(p, String(req.body?.id ?? "").slice(0, 60), req.body?.ok !== false);
  checksChanged(p);
  res.json(checksState(p));
}));
app.post("/api/projects/:id/checks/run", need("editor"), withProject((p, _req, res) => {
  fs.rmSync(path.join(p.dataDir, "checks.json"), { force: true });
  void scheduleChecks(p, () => checksChanged(p), true).catch(() => {});
  res.json(checksState(p));
}));

// ---- version history: list, name, restore, and preview any version next to the current edit ----
const versionN = (req: express.Request) => {
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 1) throw new RoomError(404, "no such version");
  return n;
};
const versionOf = (p: Project, req: express.Request) => {
  const vp = versionProject(p, versionN(req));
  if (!vp) throw new RoomError(404, "no such version");
  return vp;
};
app.get("/api/projects/:id/versions", withProject((p, req, res) => res.json(room.listVersions(p, me(req)))));
app.post("/api/projects/:id/versions/:n/name", withProject((p, req, res) => res.json(room.nameVersion(p, me(req), versionN(req), req.body?.label))));
app.post("/api/projects/:id/versions/:n/restore", withProject((p, req, res) => res.json(room.restoreVersion(p, me(req), versionN(req)))));
// a version's timeline and preview: it reuses the current picture when its cuts are the same, else builds its own
app.get("/api/projects/:id/versions/:n/model", withProject((p, req, res) => {
  const vp = versionOf(p, req);
  const model = readModel(vp);
  const samePicture = model.pictureHash === readModel(p).pictureHash;
  if (!samePicture && proxyState(vp).status === "missing") buildProxy(vp, () => versionsChanged(p));
  res.json({ model, proxy: proxyState(vp), samePicture });
}));
app.get("/media/:id/versions/:n/proxy.mp4", withProject((p, req, res) => {
  const vp = versionOf(p, req);
  if (!fs.existsSync(proxyFile(vp))) return res.status(404).end();
  res.sendFile(proxyFile(vp), { headers: { "Cache-Control": "no-cache" } });
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
  // the current edit's sounds, those of an option waiting to be compared, or of the version being previewed (?v=n)
  const vq = Number(req.query.v);
  const vp = Number.isInteger(vq) && vq > 0 ? versionProject(p, vq) : null;
  const known =
    uses(p) ||
    (vp != null && uses(vp)) ||
    loadComments(p).some((c) => c.status === "review" && c.options?.some((o) => uses(optionProject(p, c.id, o.key))));
  if (!known || !inside(f, READ_ROOTS) || !fs.existsSync(f)) return res.status(404).end();
  res.sendFile(f);
}));

// The caption composition, with the time driver injected (overlay.ts) so the app can seek it frame-exactly.
app.get("/overlay/:id/{*rest}", withProject((p, req, res) => {
  let rest = ([] as string[]).concat((req.params as any).rest ?? []).join("/") || "index.html";
  if (rest === "__room/gsap.min.js") return res.set("Content-Security-Policy", OVERLAY_CSP).type("js").sendFile(LOCAL_GSAP, { dotfiles: "allow" }); // instead of the CDN (overlay.ts)
  let dir = p.overlaysDir;
  const m = rest.match(/^o\/([a-f0-9]{10})\/([A-D])\/(.*)$/);
  if (m) {
    if (!hasOption(p, m[1], m[2])) return res.status(404).end();
    dir = optionProject(p, m[1], m[2]).overlaysDir;
    rest = m[3] || "index.html";
  }
  const v = rest.match(/^v\/(\d{1,6})\/(.*)$/); // a version's captions
  if (v) {
    const vp = versionProject(p, Number(v[1]));
    if (!vp) return res.status(404).end();
    dir = vp.overlaysDir;
    rest = v[2] || "index.html";
  }
  if (!dir) return res.status(404).end();
  const f = path.resolve(dir, rest);
  // an option's folder links to the real one for everything it did not change, so both are allowed roots
  if (!inside(f, [dir, p.overlaysDir ?? dir]) || !fs.existsSync(f)) return res.status(404).end();
  res.set("Content-Security-Policy", OVERLAY_CSP); // the composition's files may not call the API (overlay.ts)
  if (rest === "index.html") {
    let html = fs.readFileSync(f, "utf8").replace("<head>", "<head>" + DRIVER).split(GSAP_CDN_SRC).join(localGsapUrl(p.id));
    // ?still=<seconds>: seek once loaded, for a still of the captions (overlay.ts, headless Chrome)
    const still = Number(req.query.still);
    if (req.query.still != null && Number.isFinite(still) && still >= 0) html = html.replace(/<\/body>/i, stillSeek(still) + "</body>");
    return res.type("html").set("Cache-Control", "no-store").send(html);
  }
  res.sendFile(f);
}));

// ---- wild cards: reels shared from the phone, broken down by the reel-breakdown skill's inbox watcher ----
const wildOk: express.RequestHandler = (req, res, next) =>
  me(req).projects === "all" ? next() : res.status(403).json({ error: "Wild cards are for people with access to every project." });
const wild = (fn: (req: express.Request, res: express.Response) => unknown) => async (req: express.Request, res: express.Response) => {
  try {
    await fn(req, res);
  } catch (e: any) {
    res.status(e instanceof WildError ? e.status : 500).json({ error: String(e?.message ?? e) });
  }
};
const wildChanged = () => {
  send({ type: "wildcards", at: Date.now() });
  autoTemplates(wildChanged); // a shared reel whose breakdown just landed gets its template
};
let wildSoon: NodeJS.Timeout | null = null;
fs.mkdirSync(WILD_ROOT, { recursive: true });
chokidar
  .watch(WILD_ROOT, { ignoreInitial: true, depth: 1, ignored: (f) => /\/(frames|inbox)(\/|$)/.test(f) })
  .on("all", () => {
    if (wildSoon) clearTimeout(wildSoon);
    wildSoon = setTimeout(wildChanged, 800);
  });
recoverWildJobs();
autoTemplates(wildChanged);
const DECISIONS = new Set<Decision>(["new", "reference", "dismissed"]);
app.get("/api/wildcards", need("editor"), wildOk, wild((_req, res) => res.json(listWild())));
app.get("/api/wildcards/:id", need("editor"), wildOk, wild((req, res) => res.json(wildDetail(String(req.params.id)))));
app.post("/api/wildcards/:id/decision", need("editor"), wildOk, wild((req, res) => {
  const state = String(req.body?.state) as Decision;
  if (!DECISIONS.has(state)) throw new WildError(400, "unknown decision");
  res.json(setDecision(String(req.params.id), state, me(req).name));
  wildChanged();
}));
app.post("/api/wildcards/:id/plan", need("owner"), wild((req, res) => {
  startPlan(String(req.params.id), Number(req.body?.idea), req.body?.note, wildChanged);
  res.json({ ok: true });
}));
app.post("/api/wildcards/:id/template", need("owner"), wild((req, res) => {
  startTemplate(String(req.params.id), req.body?.name, req.body?.note, wildChanged, req.body?.exact === true);
  res.json({ ok: true });
}));
app.post("/api/wildcards/:id/stop", need("owner"), wild((req, res) => {
  stopWildJob(String(req.params.id));
  res.json({ ok: true });
}));
app.get("/api/templates", need("editor"), (_req, res) => res.json(listTemplates()));
// "Make one like this": a new edit in the card's template, made from the user's b-roll folders, nothing to fill in
app.post("/api/wildcards/:id/make", need("editor"), wildOk, wild((req, res) => {
  if (!runsDirectly(me(req))) throw new WildError(403, "Only people with access to every project can start a new edit.");
  const kit = templateKit(String(req.params.id));
  const folders = libraryFolders().map((f) => f.name);
  if (!folders.length) throw new WildError(400, "There are no footage folders in Video Editor to take clips from.");
  const { id } = newEditFolder();
  const p = getProject(id);
  if (!p) throw new WildError(500, "The new edit folder didn't show up.");
  const note = kit.line ? `On screen: "${kit.line}".` : "";
  saveNote(p, note);
  saveBuildOptions(p, { format: kit.format, folders, style: kit.slug, music: kit.track, fromLibrary: kit.footage });
  const shapes = Object.entries(kit.footage).filter(([k]) => k !== "clips").map(([k, v]) => `${v} ${k}`).join(", ");
  queueBuild(
    p,
    me(req),
    `Make one like the "${kit.title}" template in ${kit.format}, from your b-roll folders (${shapes})${kit.track ? `, music "${trackName(kit.track)}"` : ""}.${note ? ` ${note}` : ""}`,
    `b-roll: ${folders.join(", ")}`,
  );
  res.json({ id });
}));

// ---- the music bank (background music/, measured into catalog.json) ----
const musicChanged = () => send({ type: "music", at: Date.now() });
app.get("/api/music", need("editor"), (_req, res) => res.json(listMusic(musicChanged)));
app.get("/media/music/{*rest}", need("editor"), (req, res) => {
  const rest = ([] as string[]).concat((req.params as any).rest ?? []).join("/");
  const f = musicFile(rest);
  if (!f) return res.status(404).end();
  res.sendFile(f);
});
fs.mkdirSync(MUSIC_DIR, { recursive: true });
app.get("/media/wild/:id/{*rest}", need("editor"), wildOk, wild((req, res) => {
  const rest = ([] as string[]).concat((req.params as any).rest ?? []).join("/");
  folderOf(String(req.params.id));
  const f = wildFile(String(req.params.id), rest);
  if (!f) return res.status(404).end();
  res.sendFile(f);
}));

// the built app (what the phone loads; `npm run dev` keeps it rebuilt)
app.use(express.static(dist, { index: false }));
app.get("/{*any}", (_req, res) => {
  const index = path.join(dist, "index.html");
  fs.existsSync(index) ? res.set("Cache-Control", "no-cache").sendFile(index) : res.status(404).send("Not built yet: run npm run build");
});

// macOS refuses a terminal the iCloud Drive folder until it is allowed: say how, instead of a stack trace
try {
  fs.readdirSync(VIDEO_ROOT);
} catch (e) {
  if ((e as NodeJS.ErrnoException).code === "EPERM") {
    console.error(`\nEdit Room can't read ${VIDEO_ROOT}: macOS is blocking this terminal app.\nOpen System Settings > Privacy & Security > Files & Folders, find this terminal app and turn on iCloud Drive\n(or add it under Full Disk Access), quit and reopen the terminal, then run npm run dev again.\n`);
    process.exit(1);
  }
}

const cutOff = recoverInterrupted(listProjects());
if (cutOff) console.log(`marked ${cutOff} comment(s) stopped: they were cut off when the server last closed`);

localServer.listen(PORT, HOST, () => console.log(`edit room server on http://${HOST}:${PORT} (this Mac)`));
remoteServer.listen(REMOTE_PORT, "127.0.0.1", () => console.log(`login-only port for tailscale serve on http://127.0.0.1:${REMOTE_PORT}`));
