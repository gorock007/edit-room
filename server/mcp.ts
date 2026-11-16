import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getProject, listProjects, readModel, type Project } from "./projects.ts";
import { grabFrame, proxyFile, proxyState } from "./proxy.ts";
import { agentByKey, canSee, type Person } from "./people.ts";
import { loadComments, type Comment } from "./store.ts";
import { RoomError, runsDirectly, targetFromModel, viewOf, type Room } from "./room.ts";

/**
 * Edit Room as an MCP server, so other agents (Claude Code, Codex, scripts…) can join the room like people do.
 *
 * POST /mcp, Streamable HTTP with plain JSON answers and no sessions: every request carries the agent's key
 * (`Authorization: Bearer er_…`) and is checked on its own, so removing an agent in Share stops it at once. An agent is
 * a person of kind "agent": the same role, project limits and approvals as a person with that role, through the same
 * room actions the app uses.
 */

export type McpDeps = {
  room: Room;
  /** An agent touched a project: it shows in the room (avatar, playhead at `t`) for a while. */
  seen: (who: Person, projectId: string, t?: number) => void;
  /** Who has this project open right now. */
  here: (who: Person, projectId: string) => { name: string; role: string; kind?: string; t: number; playing: boolean }[];
  /** First look at a project: watch its files, build its preview if missing. */
  open: (p: Project) => void;
};

const INSTRUCTIONS = `Edit Room is the user's review app for their video edits (talking-head reels). You are in the room as an
agent the owner connected, with a role: viewer (look only), commenter (your comments wait for an editor's approval) or
editor. You never edit files yourself: you leave comments, and Edit Room's own editor (Claude, working on the Mac) makes
each change, which the people in the room see live.

A good loop: list_projects → get_edit (the timeline: cuts, cards, captions, sounds, with ids) → look_at_frame where it
matters → add_comment pointing at an id ("caption c12", "sfx s3"…) with one clear request → get_comment with
wait_seconds to follow it until it is done, then read the reply. Ask for 2-3 options when taste matters; an editor picks
one with pick_option. Keep requests specific and small: one change per comment.`;

const ROUND = (n: number) => Math.round(n * 100) / 100;
const WAITING = new Set(["pending", "queued", "working"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A comment as an agent reads it: what was asked, by whom, where, and what happened. */
function brief(c: Comment) {
  return {
    id: c.id,
    status: c.status,
    text: c.text,
    by: c.author ? `${c.author.name}${c.author.kind === "agent" ? " (agent)" : ""}` : "owner",
    at_seconds: ROUND(c.t),
    target: c.target.label + (c.target.detail ? ` (${c.target.detail})` : ""),
    ...(c.reply ? { reply: c.reply } : {}),
    ...(c.options?.length ? { options: c.options.map((o) => ({ key: o.key, note: o.note })) } : {}),
    ...(c.chosen ? { chosen: c.chosen } : {}),
    ...(c.approvedBy ? { approved_or_declined_by: c.approvedBy } : {}),
    created: new Date(c.createdAt).toISOString(),
    ...(c.finishedAt ? { finished: new Date(c.finishedAt).toISOString() } : {}),
  };
}

function buildServer(who: Person, d: McpDeps) {
  const server = new McpServer({ name: "edit-room", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  const text = (data: unknown) => ({ content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 1) }] });
  const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });
  // every tool: errors come back as a readable message, not a protocol error
  const guard =
    <A,>(fn: (a: A) => Promise<any> | any) =>
    async (a: A) => {
      try {
        return await fn(a);
      } catch (e: any) {
        return fail(e instanceof RoomError ? e.message : String(e?.message ?? e));
      }
    };
  const project = (id: string, t?: number) => {
    const p = getProject(id);
    if (!p || !canSee(who, p.id)) throw new RoomError(404, `No project "${id}". list_projects shows the ones you can see.`);
    d.seen(who, p.id, t);
    return p;
  };
  const comment = (p: Project, cid: string) => {
    const c = loadComments(p).find((x) => x.id === cid);
    if (!c) throw new RoomError(404, `No comment "${cid}" in ${p.id}.`);
    return viewOf(c, who);
  };
  const id = z.string().max(100);

  server.registerTool(
    "whoami",
    { title: "Who am I here", description: "Your name, role and which projects you can see, and what your role lets you do.", annotations: { readOnlyHint: true } },
    guard(() =>
      text({
        name: who.name,
        role: who.role,
        projects: who.projects,
        your_comments: runsDirectly(who) ? "go to Claude right away" : who.role === "viewer" ? "not allowed (viewer)" : "wait for an editor's approval, then Claude makes the change",
        can_pick_options_and_undo: who.role === "editor",
      }),
    ),
  );

  server.registerTool(
    "list_projects",
    { title: "List projects", description: "The edits you can see: id, name, and whether the edit is built yet.", annotations: { readOnlyHint: true } },
    guard(() => text(listProjects().filter((p) => canSee(who, p.id)).map((p) => ({ id: p.id, name: p.name, built: !!p.draftDir })))),
  );

  server.registerTool(
    "get_edit",
    {
      title: "Read an edit's timeline",
      description:
        "The edit as a timeline, in seconds: size and length, A-roll cuts (with punch-ins), cards/b-roll, caption groups (text and keyword) and sound effects, each with the id you can point a comment at. Also who else is in the room and the preview/export state.",
      inputSchema: { project: id },
      annotations: { readOnlyHint: true },
    },
    guard(({ project: pid }: { project: string }) => {
      const p = project(pid);
      if (!p.draftDir) throw new RoomError(409, `${p.id} isn't built yet (the first edit is still to come).`);
      d.open(p);
      const m = readModel(p);
      return text({
        project: { id: p.id, name: p.name },
        size: `${m.width}x${m.height}`,
        fps: m.fps,
        duration_seconds: ROUND(m.duration),
        cuts: m.cuts.map((s) => ({ id: s.id, start: ROUND(s.start), dur: ROUND(s.dur), ...(s.scale !== 1 ? { punch_in: ROUND(s.scale) } : {}) })),
        cards: m.broll.map((s) => ({ id: s.id, start: ROUND(s.start), dur: ROUND(s.dur), label: s.label })),
        captions: m.captions.map((g) => ({ id: g.id, start: ROUND(g.start), dur: ROUND(g.dur), text: g.text, ...(g.big ? { keyword: g.big } : {}) })),
        sounds: m.sfx.map((s) => ({ id: s.id, start: ROUND(s.start), dur: ROUND(s.dur), name: s.name, track: s.track, volume: s.volume })),
        preview: proxyState(p).status,
        export: d.room.exportState(p).status,
        in_the_room: d.here(who, p.id).map((x) => ({ name: x.name, role: x.role, ...(x.kind ? { kind: x.kind } : {}), at_seconds: ROUND(x.t), playing: x.playing })),
      });
    }),
  );

  server.registerTool(
    "look_at_frame",
    {
      title: "Look at a frame",
      description: "A still of the picture at a time (seconds), from the preview: cuts, punch-ins and cards, without the live captions. Use it to see what a comment is about before writing it.",
      inputSchema: { project: id, at_seconds: z.number().min(0).max(86_400) },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ project: pid, at_seconds }: { project: string; at_seconds: number }) => {
      const p = project(pid, at_seconds);
      if (!p.draftDir) throw new RoomError(409, `${p.id} isn't built yet.`);
      d.open(p);
      if (!fs.existsSync(proxyFile(p))) throw new RoomError(409, "The preview is still being built (about a minute). Try again shortly.");
      const m = readModel(p);
      const t = Math.min(at_seconds, Math.max(0, m.duration - 0.05));
      const out = path.join(p.dataDir, "frames", `agent-${crypto.randomBytes(4).toString("hex")}.png`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      try {
        await grabFrame(p, t, null, null, out);
        const data = fs.readFileSync(out).toString("base64");
        return { content: [{ type: "image" as const, data, mimeType: "image/png" }, { type: "text" as const, text: `${p.id} at ${t.toFixed(2)} s (preview picture, captions not drawn)` }] };
      } finally {
        fs.rmSync(out, { force: true });
      }
    }),
  );

  server.registerTool(
    "list_comments",
    {
      title: "List comments",
      description: "The comments on an edit, newest first: what was asked, by whom, at what time and target, and what happened (status, Claude's reply, options).",
      inputSchema: { project: id, status: z.enum(["pending", "queued", "working", "review", "done", "failed", "stopped", "undone", "declined"]).optional(), limit: z.number().int().min(1).max(100).optional() },
      annotations: { readOnlyHint: true },
    },
    guard(({ project: pid, status, limit }: { project: string; status?: string; limit?: number }) => {
      const p = project(pid);
      const list = loadComments(p)
        .filter((c) => !status || c.status === status)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit ?? 30)
        .map((c) => brief(viewOf(c, who)));
      return text(list);
    }),
  );

  server.registerTool(
    "get_comment",
    {
      title: "Follow a comment",
      description:
        "One comment and what happened to it. With wait_seconds (up to 50), waits while it is pending, queued or being worked on, and returns as soon as it changes state, so you can follow a request to the end by calling this again.",
      inputSchema: { project: id, comment_id: id, wait_seconds: z.number().min(0).max(50).optional() },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ project: pid, comment_id, wait_seconds }: { project: string; comment_id: string; wait_seconds?: number }) => {
      const p = project(pid);
      let c = comment(p, comment_id);
      const until = Date.now() + (wait_seconds ?? 0) * 1000;
      const start = c.status;
      while (WAITING.has(c.status) && c.status === start && Date.now() < until) {
        await sleep(1000);
        c = comment(p, comment_id);
      }
      return text({ ...brief(c), ...(WAITING.has(c.status) ? { note: "Not finished yet: call get_comment again to keep following it." } : {}) });
    }),
  );

  server.registerTool(
    "add_comment",
    {
      title: "Ask for a change",
      description:
        "Leave a comment asking for one change. Point it at something from get_edit (target kind + id) or a moment (at_seconds), or leave both out for the whole video. options: 2 or 3 makes Claude prepare that many takes to compare instead of changing the edit. Returns the comment id; follow it with get_comment. If your role is commenter, it waits for an editor's approval first.",
      inputSchema: {
        project: id,
        text: z.string().min(1).max(4000),
        target: z.object({ kind: z.enum(["caption", "cut", "card", "sound"]), id }).optional(),
        at_seconds: z.number().min(0).max(86_400).optional(),
        options: z.number().int().min(1).max(3).optional(),
      },
    },
    guard(({ project: pid, text: body, target, at_seconds, options }: { project: string; text: string; target?: { kind: string; id: string }; at_seconds?: number; options?: number }) => {
      const p = project(pid, at_seconds);
      if (!p.draftDir) throw new RoomError(409, `${p.id} isn't built yet.`);
      const kind = target ? ({ card: "broll", sound: "sfx" } as Record<string, string>)[target.kind] ?? target.kind : null;
      // the target's label comes from the edit itself, never from the agent's words
      const fromModel = kind && target ? targetFromModel(p, kind, target.id) : null;
      const t = at_seconds ?? fromModel?.t ?? 0;
      const c = d.room.postComment(p, who, {
        text: body,
        t,
        x: null,
        y: null,
        target: fromModel?.target ?? { kind: "general", label: at_seconds != null ? "this moment" : "the whole video" },
        want: options ?? 1,
      });
      d.seen(who, p.id, t);
      return text({
        ...brief(c),
        next: c.status === "pending" ? "Waiting for an editor to approve it. Follow it with get_comment." : "Claude is on it. Follow it with get_comment (wait_seconds: 50).",
      });
    }),
  );

  server.registerTool(
    "approve_comment",
    { title: "Approve a comment", description: "Editors with every project: let a waiting comment go to Claude.", inputSchema: { project: id, comment_id: id } },
    guard(({ project: pid, comment_id }: { project: string; comment_id: string }) => text(brief(d.room.approve(project(pid), who, comment_id)))),
  );

  server.registerTool(
    "decline_comment",
    { title: "Decline a comment", description: "Editors: say no to a waiting comment, with a short reason its author sees.", inputSchema: { project: id, comment_id: id, reason: z.string().max(500).optional() } },
    guard(({ project: pid, comment_id, reason }: { project: string; comment_id: string; reason?: string }) => text(brief(d.room.decline(project(pid), who, comment_id, reason)))),
  );

  server.registerTool(
    "pick_option",
    {
      title: "Pick an option",
      description: "Editors: when a comment's options are ready (status review), use one (A, B, C) or keep the edit as it is (current).",
      inputSchema: { project: id, comment_id: id, key: z.enum(["A", "B", "C", "current"]) },
    },
    guard(({ project: pid, comment_id, key }: { project: string; comment_id: string; key: string }) => text(brief(d.room.pick(project(pid), who, comment_id, key)))),
  );

  server.registerTool(
    "undo_comment",
    { title: "Undo a change", description: "Editors: put back the files a finished comment changed.", inputSchema: { project: id, comment_id: id }, annotations: { destructiveHint: true } },
    guard(({ project: pid, comment_id }: { project: string; comment_id: string }) => text(brief(d.room.undo(project(pid), who, comment_id)))),
  );

  server.registerTool(
    "stop_comment",
    { title: "Stop or withdraw", description: "Withdraw your own comment before Claude starts on it; editors can also stop one Claude is working on.", inputSchema: { project: id, comment_id: id } },
    guard(({ project: pid, comment_id }: { project: string; comment_id: string }) => text(brief(d.room.stopComment(project(pid), who, comment_id)))),
  );

  server.registerTool(
    "export_video",
    {
      title: "Export the video",
      description: "Editors: make the upload-ready MP4 (Reels/TikTok spec). Takes 1-2 minutes; call again with check_only to see the state and file report.",
      inputSchema: { project: id, check_only: z.boolean().optional() },
    },
    guard(({ project: pid, check_only }: { project: string; check_only?: boolean }) => {
      const p = project(pid);
      const st = check_only ? d.room.exportState(p) : d.room.startExport(p, who);
      const { savedTo: _s, ...rest } = st as any; // the Mac's path stays on the Mac
      return text(rest);
    }),
  );

  return server;
}

/** The /mcp endpoint. */
export function mcpHandler(d: McpDeps): express.RequestHandler {
  return async (req, res) => {
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""));
    const who = m ? agentByKey(m[1]) : undefined;
    if (!who) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Edit Room needs this agent's key: send Authorization: Bearer er_… (the owner makes one in Share → Connect an agent)." },
        id: null,
      });
      return;
    }
    if (req.method !== "POST") {
      res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server answers POST only." }, id: null });
      return;
    }
    const server = buildServer(who, d);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e: any) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: String(e?.message ?? e) }, id: null });
    }
  };
}
