import fs from "node:fs";
import path from "node:path";
import { query, tool, createSdkMcpServer, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { CAPCUT_DRAFTS, DATA_DIR, READ_ROOTS, SKILL_DIR, VIDEO_ROOT, WRITE_ROOTS, inside } from "./config.ts";
import { onScreen, readModel, type Project } from "./projects.ts";
import { buildProxy, grabFrame, proxyFile } from "./proxy.ts";
import { changedSince, loadComments, snapshot, updateComment, type Activity, type Comment } from "./store.ts";

type Emit = (c: Comment) => void;
type Hooks = { emit: Emit; projectChanged: (p: Project) => void };

const queues = new Map<string, Promise<void>>();
const aborts = new Map<string, AbortController>();

const ROOM_PROMPT = `
You are the editor working inside Edit Room, the user's own review app for their talking-head reels.
The user watches a live preview and clicks on things (a caption, a sound, a cut, a spot in the frame) to leave a
comment. Each comment reaches you the moment it is posted; act on it right away, like a designer who was asked to
change one thing.

How the preview is built, so your change shows up:
- Captions are the HyperFrames composition <edit>/overlays/index.html, generated from overlays/captions.json (+
  caption_layout.json, broll_spans.json) by \`python3 build_captions.py\` in that folder. The app plays it live and
  reloads it the moment index.html changes; do NOT re-render captions.mov for the preview.
- Sounds, cuts, b-roll and cards live in the CapCut draft (draft_info.json). Change them with the skill's scripts and
  the capcut CLI (load the capcut-edit skill for its contracts). CapCut must be closed for writes: if
  \`pgrep -x CapCut\` finds it running, do not write the draft; reply asking the user to quit CapCut.
- The app shows sound changes as soon as the draft changes. Cuts, punch-ins and b-roll need the picture proxy rebuilt:
  call the room_refresh_picture tool after such a change.
- Follow the talking-head-reel-edit skill (house style, references/style.md, sfx_catalog.md for any sound choice).

Rules:
- Do exactly what the comment asks, nothing else. If it is ambiguous, make the most likely call and say which.
- Keep the user's files safe: change only this project's edit folder, its CapCut draft and your scratch files.
- Finish with a reply of 1-3 short sentences in plain words: what you changed and where. No markdown headings.
  If you could not do it, say why and what the user can do.
`.trim();

function activityLine(m: SDKMessage): Activity[] {
  if (m.type !== "assistant") return [];
  const out: Activity[] = [];
  for (const b of m.message.content as any[]) {
    if (b.type === "text" && b.text?.trim()) out.push({ at: Date.now(), kind: "text", text: b.text.trim().slice(0, 400) });
    if (b.type === "tool_use") {
      const i = b.input ?? {};
      const short = (s: string) => (s.length > 140 ? s.slice(0, 137) + "…" : s);
      const what =
        b.name === "Bash" ? short(i.description || i.command || "") :
        ["Read", "Edit", "Write"].includes(b.name) ? path.basename(i.file_path ?? "") :
        b.name === "Skill" ? i.skill ?? "" :
        b.name.startsWith("mcp__room__") ? "" :
        short(JSON.stringify(i));
      const name = b.name.replace("mcp__room__room_", "").replace(/_/g, " ");
      out.push({ at: Date.now(), kind: "tool", text: `${name}${what ? ": " + what : ""}` });
    }
  }
  return out;
}

function describeTarget(c: Comment, p: Project) {
  let ctx = "";
  try {
    const m = readModel(p);
    const s = onScreen(m, c.t);
    ctx = [
      s.broll ? `On screen: b-roll/card "${s.broll.label}" (${s.broll.start.toFixed(2)}-${(s.broll.start + s.broll.dur).toFixed(2)} s)` : "",
      s.cut ? `A-roll cut ${s.cut.id} (${s.cut.start.toFixed(2)}-${(s.cut.start + s.cut.dur).toFixed(2)} s, source ${s.cut.src.toFixed(2)} s, scale ${s.cut.scale})` : "",
      s.caption ? `Caption group ${s.caption.id} showing: "${s.caption.text}" (keyword "${s.caption.big}")` : "No caption on screen.",
      s.sfx.length ? `Sounds within 0.5 s: ${s.sfx.map((x) => `${x.name} @ ${x.start.toFixed(2)} s on ${x.track}`).join("; ")}` : "",
    ].filter(Boolean).join("\n");
  } catch {}
  return ctx;
}

function buildPrompt(c: Comment, p: Project, framePath: string | null) {
  const where = c.x != null ? ` at point (${(c.x * 100).toFixed(0)}% across, ${(c.y! * 100).toFixed(0)}% down)` : "";
  return `New comment from the user on project ${p.name}.

"${c.text}"

They clicked ${c.target.label}${c.target.detail ? ` (${c.target.detail})` : ""} at ${c.t.toFixed(2)} s${where}.
${describeTarget(c, p)}
${framePath ? `A still of the picture there (without captions; the clicked point is boxed in red): ${framePath}` : ""}

Paths:
- edit folder: ${p.editDir}
- caption composition: ${p.overlaysDir ?? "(none)"}
- CapCut draft: ${p.draftDir ?? "(none)"}
- skill: ${SKILL_DIR}`;
}

function roomTools(p: Project, c: Comment, hooks: Hooks) {
  return createSdkMcpServer({
    name: "room",
    version: "1.0.0",
    tools: [
      tool(
        "room_refresh_picture",
        "Rebuild the preview's picture proxy after changing cuts, punch-ins, b-roll or cards in the CapCut draft. Takes about a minute. Captions and sounds refresh on their own.",
        {},
        async () => {
          await buildProxy(p, () => hooks.projectChanged(p));
          return { content: [{ type: "text", text: "Picture proxy rebuilt; the user's preview reloaded." }] };
        },
      ),
      tool(
        "room_note",
        "Post a short progress note under the user's comment while you work (e.g. a question you are deciding, or a long step starting).",
        { text: z.string() },
        async ({ text }) => {
          const u = updateComment(p, c.id, (x) => x.activity.push({ at: Date.now(), kind: "info", text }));
          if (u) hooks.emit(u);
          return { content: [{ type: "text", text: "posted" }] };
        },
      ),
    ],
  });
}

const sessionFile = (p: Project) => path.join(p.dataDir, "session.json");
const lastSession = (p: Project): string | undefined => {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(p), "utf8")).sessionId;
  } catch {}
};

async function runOne(p: Project, commentId: string, hooks: Hooks) {
  const set = (fn: (c: Comment) => void) => {
    const u = updateComment(p, commentId, fn);
    if (u) hooks.emit(u);
    return u;
  };
  if (loadComments(p).find((x) => x.id === commentId)?.status !== "queued") return; // stopped while waiting
  const c = set((x) => {
    x.status = "working";
    x.activity.push({ at: Date.now(), kind: "info", text: "Claude picked this up" });
  })!;

  let framePath: string | null = null;
  if (fs.existsSync(proxyFile(p))) {
    framePath = path.join(p.dataDir, "frames", `${c.id}.png`);
    fs.mkdirSync(path.dirname(framePath), { recursive: true });
    await grabFrame(p, c.t, c.x, c.y, framePath).catch(() => (framePath = null));
  }
  snapshot(p, c.id);

  const abort = new AbortController();
  aborts.set(c.id, abort);
  const resume = lastSession(p);
  let finalText = "";
  let failed = false;
  const attempt = async (resumeId?: string) => {
    for await (const m of query({
      prompt: buildPrompt(c, p, framePath),
      options: {
        cwd: VIDEO_ROOT, // the user's memory and project instructions are keyed to this folder
        additionalDirectories: [CAPCUT_DRAFTS], // edits auto-accepted only here and in cwd; anything else goes through canUseTool
        resume: resumeId,
        abortController: abort,
        settingSources: ["user", "project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code", append: ROOM_PROMPT },
        permissionMode: "acceptEdits",
        allowedTools: ["Read", "Glob", "Grep", "Bash", "Skill", "mcp__room__room_refresh_picture", "mcp__room__room_note"],
        disallowedTools: ["Bash(rm -rf *)", "Bash(sudo *)", "Bash(git push*)", "WebSearch", "WebFetch"],
        mcpServers: { room: roomTools(p, c, hooks) },
        // nobody is at a prompt: anything not pre-approved is decided here, inside the project's folders only
        canUseTool: async (name, input, opts) => {
          const target = String((input as any).file_path ?? (input as any).path ?? opts.blockedPath ?? "");
          const writes = ["Edit", "Write", "NotebookEdit"].includes(name);
          if (target && inside(target, writes ? WRITE_ROOTS : READ_ROOTS)) return { behavior: "allow", updatedInput: input };
          if (!target && ["Read", "Glob", "Grep"].includes(name)) return { behavior: "allow", updatedInput: input };
          return { behavior: "deny", message: `${name} is not allowed from the edit room${target ? ` on ${target}` : ""}.` };
        },
      },
    })) {
      if (m.type === "system" && m.subtype === "init") {
        fs.writeFileSync(sessionFile(p), JSON.stringify({ sessionId: m.session_id }));
      }
      const lines = activityLine(m);
      if (lines.length) set((x) => x.activity.push(...lines));
      if (m.type === "result") {
        if (m.subtype === "success") finalText = m.result;
        else failed = true;
        set((x) => (x.costUsd = (x.costUsd ?? 0) + (m.total_cost_usd ?? 0)));
      }
    }
  };

  try {
    try {
      await attempt(resume);
    } catch (e) {
      if (!resume || abort.signal.aborted) throw e;
      set((x) => x.activity.push({ at: Date.now(), kind: "info", text: "Started a fresh agent session" }));
      await attempt(undefined); // the stored session may be gone
    }
    const changed = changedSince(p, c.id);
    set((x) => {
      x.status = failed ? "failed" : "done";
      x.reply = finalText || (failed ? "The agent stopped with an error." : "Done.");
      x.changed = changed;
      x.finishedAt = Date.now();
    });
  } catch (e: any) {
    const changed = changedSince(p, c.id);
    set((x) => {
      x.status = abort.signal.aborted ? "stopped" : "failed";
      x.activity.push({ at: Date.now(), kind: "error", text: String(e?.message ?? e).slice(0, 500) });
      x.reply = abort.signal.aborted ? "Stopped." : "Something went wrong; see the activity log.";
      x.changed = changed;
      x.finishedAt = Date.now();
    });
  } finally {
    aborts.delete(c.id);
    hooks.projectChanged(p);
  }
}

/** Comments on one project run one at a time, in the order posted (they edit the same files). */
export function enqueue(p: Project, commentId: string, hooks: Hooks) {
  const prev = queues.get(p.id) ?? Promise.resolve();
  const next = prev.then(() => runOne(p, commentId, hooks)).catch(() => {});
  queues.set(p.id, next);
}

export function stop(commentId: string) {
  aborts.get(commentId)?.abort();
}
