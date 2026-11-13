import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import chokidar, { type FSWatcher } from "chokidar";
import { ALLOWED_HOSTS, ALLOWED_ORIGINS, HOST, PORT, READ_ROOTS, inside } from "./config.ts";
import { getProject, listProjects, readModel, type Project } from "./projects.ts";
import { buildProxy, proxyFile, proxyState } from "./proxy.ts";
import { enqueue, stop } from "./agent.ts";
import { loadComments, newId, restore, saveComments, updateComment, type Comment } from "./store.ts";

const app = express();
// Every request must come from the app itself. A comment makes the agent run commands, so a web page in another tab
// must not be able to post one: the Host check stops DNS rebinding, the Origin check stops cross-site requests.
const allowed = (req: http.IncomingMessage) => {
  const host = String(req.headers.host ?? "");
  const origin = req.headers.origin;
  return ALLOWED_HOSTS.has(host) && (origin == null || ALLOWED_ORIGINS.has(origin));
};
app.use((req, res, next) => (allowed(req) ? next() : res.status(403).send("forbidden")));
app.use(express.json({ limit: "1mb" }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws", verifyClient: ({ req }: { req: http.IncomingMessage }) => allowed(req) && req.headers.origin != null });

const send = (msg: unknown) => {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(s);
};
const emitComment = (c: Comment) => send({ type: "comment", comment: c });
const projectChanged = (p: Project) => send({ type: "project", id: p.id, proxy: proxyState(p) });
const hooks = { emit: emitComment, projectChanged };

// ---- live reload: the draft (sounds, cuts) and the caption composition ----
const watchers = new Map<string, FSWatcher>();
function watch(p: Project) {
  if (watchers.has(p.id)) return;
  const files = [p.draftDir && path.join(p.draftDir, "draft_info.json"), p.overlaysDir && path.join(p.overlaysDir, "index.html")].filter(Boolean) as string[];
  const w = chokidar.watch(files, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 } });
  w.on("change", (f) => {
    if (f.endsWith("index.html")) send({ type: "overlay", id: p.id, at: Date.now() });
    else projectChanged(p);
  });
  watchers.set(p.id, w);
}

const withProject = (fn: (p: Project, req: express.Request, res: express.Response) => unknown) => async (req: express.Request, res: express.Response) => {
  const p = getProject(String(req.params.id));
  if (!p) return res.status(404).json({ error: "no such project" });
  try {
    await fn(p, req, res);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
};

app.get("/api/projects", (_req, res) => {
  res.json(listProjects().map((p) => ({ id: p.id, name: p.name, hasDraft: !!p.draftDir, hasOverlay: !!p.overlaysDir })));
});

app.get("/api/projects/:id/model", withProject((p, _req, res) => {
  watch(p);
  const st = proxyState(p);
  if (st.status === "missing") buildProxy(p, () => projectChanged(p)); // first open: make the preview
  res.json({ model: readModel(p), proxy: proxyState(p) });
}));

app.post("/api/projects/:id/proxy", withProject((p, _req, res) => {
  buildProxy(p, () => projectChanged(p));
  res.json(proxyState(p));
}));

app.get("/api/projects/:id/comments", withProject((p, _req, res) => res.json(loadComments(p))));

app.post("/api/projects/:id/comments", withProject((p, req, res) => {
  const b = req.body ?? {};
  if (!String(b.text ?? "").trim()) return res.status(400).json({ error: "empty comment" });
  const c: Comment = {
    id: newId(),
    project: p.id,
    createdAt: Date.now(),
    text: String(b.text).trim().slice(0, 4000),
    t: Number(b.t) || 0,
    x: b.x == null ? null : Number(b.x),
    y: b.y == null ? null : Number(b.y),
    target: b.target ?? { kind: "general", label: "the video" },
    status: "queued",
    activity: [],
  };
  saveComments(p, [...loadComments(p), c]);
  emitComment(c);
  enqueue(p, c.id, hooks); // like Claude Design: the agent starts on it right away
  res.json(c);
}));

app.post("/api/projects/:id/comments/:cid/stop", withProject((p, req, res) => {
  const cid = String(req.params.cid);
  const c = updateComment(p, cid, (x) => {
    if (x.status === "queued") x.status = "stopped";
  });
  stop(cid);
  if (c) emitComment(c);
  res.json(c ?? null);
}));

app.post("/api/projects/:id/comments/:cid/undo", withProject((p, req, res) => {
  const cid = String(req.params.cid);
  const c = loadComments(p).find((x) => x.id === cid);
  if (!c?.changed?.length) return res.status(400).json({ error: "nothing to undo" });
  restore(p, cid, c.changed);
  const u = updateComment(p, cid, (x) => {
    x.status = "undone";
    x.activity.push({ at: Date.now(), kind: "info", text: `Undone: restored ${x.changed!.map((f) => path.basename(f)).join(", ")}` });
  })!;
  emitComment(u);
  if (c.changed.some((f) => f.endsWith("index.html"))) send({ type: "overlay", id: p.id, at: Date.now() });
  if (proxyState(p).status === "stale") buildProxy(p, () => projectChanged(p));
  projectChanged(p);
  res.json(u);
}));

// ---- media ----
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
  const known = readModel(p).sfx.some((s) => s.file === f);
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
  if (!p.overlaysDir) return res.status(404).end();
  const rest = ([] as string[]).concat((req.params as any).rest ?? []).join("/") || "index.html";
  const f = path.resolve(p.overlaysDir, rest);
  if (!inside(f, [p.overlaysDir]) || !fs.existsSync(f)) return res.status(404).end();
  if (rest === "index.html") {
    const html = fs.readFileSync(f, "utf8").replace("<head>", "<head>" + DRIVER);
    return res.type("html").set("Cache-Control", "no-store").send(html);
  }
  res.sendFile(f);
}));

// production build
const dist = path.resolve(import.meta.dirname, "../dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get("/{*any}", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

server.listen(PORT, HOST, () => console.log(`edit room server on http://${HOST}:${PORT}`));
