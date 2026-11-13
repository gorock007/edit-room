import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import chokidar, { type FSWatcher } from "chokidar";
import { ALLOWED_HOSTS, ALLOWED_ORIGINS, HOST, PORT, READ_ROOTS, inside } from "./config.ts";
import { getProject, listProjects, readModel, type Project } from "./projects.ts";
import { buildProxy, proxyFile, proxyState } from "./proxy.ts";
import { enqueue, quiet, stop } from "./agent.ts";
import { KEYS, applyOption, hasOption, optionProject } from "./options.ts";
import { hasPassword, isRemote, login, logout, needsLogin, sessionOk } from "./auth.ts";
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

// ---- login: needed by anything that is not this Mac (the phone over Tailscale) ----
app.get("/api/me", (req, res) => res.json({ remote: isRemote(req), authed: !needsLogin(req), hasPassword: hasPassword() }));
app.post("/api/login", async (req, res) => {
  if (!isRemote(req)) return res.json({ ok: true });
  const r = await login(String(req.body?.password ?? ""), String(req.headers["user-agent"] ?? ""));
  if ("error" in r) return res.status(r.status).json({ error: r.error });
  res.setHeader("Set-Cookie", r.cookie).json({ ok: true });
});
app.post("/api/logout", (req, res) => res.setHeader("Set-Cookie", logout(req)).json({ ok: true }));
// The app's own files (the login screen is part of it) load without a session; everything with data needs one.
const PRIVATE = /^\/(api|media|overlay|ws)(\/|$)/;
app.use((req, res, next) => (PRIVATE.test(req.path) && needsLogin(req) ? res.status(401).json({ error: "login required" }) : next()));

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient: ({ req }: { req: http.IncomingMessage }) => allowed(req) && req.headers.origin != null && (!isRemote(req) || sessionOk(req)),
});

const send = (msg: unknown) => {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(s);
};
const emitComment = (c: Comment) => send({ type: "comment", comment: c });
const projectChanged = (p: Project) => send({ type: "project", id: p.id, proxy: proxyState(p) });
const overlayChanged = (p: Project) => send({ type: "overlay", id: p.id, at: Date.now() });
const hooks = { emit: emitComment, projectChanged, overlayChanged };

// ---- live reload: the draft (sounds, cuts) and the caption composition ----
const watchers = new Map<string, FSWatcher>();
function watch(p: Project) {
  if (watchers.has(p.id)) return;
  const files = [p.draftDir && path.join(p.draftDir, "draft_info.json"), p.overlaysDir && path.join(p.overlaysDir, "index.html")].filter(Boolean) as string[];
  const w = chokidar.watch(files, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 } });
  w.on("change", (f) => {
    if (quiet.has(p.id)) return; // the agent is trying options in these files; the user's preview stays put
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
    want: Math.max(1, Math.min(KEYS.length, Number(b.want) || 1)),
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

app.post("/api/projects/:id/comments/:cid/pick", withProject((p, req, res) => {
  const cid = String(req.params.cid);
  const key = String(req.body?.key ?? "");
  const c = loadComments(p).find((x) => x.id === cid);
  if (!c || c.status !== "review") return res.status(400).json({ error: "this comment has no options waiting" });
  if (key === "current") {
    const u = updateComment(p, cid, (x) => {
      x.status = "done";
      x.chosen = "current";
      x.activity.push({ at: Date.now(), kind: "info", text: "Kept the current version" });
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
    x.activity.push({ at: Date.now(), kind: "info", text: `Using option ${key}${opt ? `: ${opt.note}` : ""}` });
  })!;
  emitComment(u);
  overlayChanged(p);
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
const dist = path.resolve(import.meta.dirname, "../dist");
app.use(express.static(dist, { index: false }));
app.get("/{*any}", (_req, res) => {
  const index = path.join(dist, "index.html");
  fs.existsSync(index) ? res.set("Cache-Control", "no-cache").sendFile(index) : res.status(404).send("Not built yet: run npm run build");
});

server.listen(PORT, HOST, () => console.log(`edit room server on http://${HOST}:${PORT}`));
