import fs from "node:fs";
import path from "node:path";
import { query, tool, createSdkMcpServer, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { CAPCUT_DRAFTS, DATA_DIR, READ_ROOTS, SKILL_DIR, VIDEO_ROOT, WRITE_ROOTS, inside } from "./config.ts";
import { getProject, onScreen, readModel, type Project } from "./projects.ts";
import { buildProxy, grabFrame, proxyFile, proxyState } from "./proxy.ts";
import { changedSince, loadComments, restore, snapshot, updateComment, type Activity, type Comment } from "./store.ts";
import { KEYS, optionProject, saveOption } from "./options.ts";
import { ALL, coveredBy } from "../src/safezones.ts";
import { rawDir, rawInfo } from "./uploads.ts";

type Emit = (c: Comment) => void;
type Hooks = { emit: Emit; projectChanged: (p: Project) => void; overlayChanged: (p: Project) => void };

/** Projects where the agent is trying options in the real files: their file watchers stay quiet meanwhile. */
export const quiet = new Set<string>();

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
    const portrait = m.height > m.width;
    const under = portrait && c.x != null && c.y != null ? coveredBy(c.x, c.y) : [];
    ctx = [
      `Frame: ${m.width}x${m.height} (${portrait ? "vertical 9:16 for TikTok/Reels/Shorts" : "16:9"}).` +
        (portrait ? ` App UI covers roughly the top ${ALL.top}px, bottom ${ALL.bottom}px and right ${ALL.right}px (of 1080x1920); keep captions and key content inside.` : ""),
      under.length ? `The clicked point is under app UI: ${under.join("; ")}.` : "",
      s.broll ? `On screen: b-roll/card "${s.broll.label}" (${s.broll.start.toFixed(2)}-${(s.broll.start + s.broll.dur).toFixed(2)} s)` : "",
      s.cut ? `A-roll cut ${s.cut.id} (${s.cut.start.toFixed(2)}-${(s.cut.start + s.cut.dur).toFixed(2)} s, source ${s.cut.src.toFixed(2)} s, scale ${s.cut.scale})` : "",
      s.caption ? `Caption group ${s.caption.id} showing: "${s.caption.text}" (keyword "${s.caption.big}")` : "No caption on screen.",
      s.sfx.length ? `Sounds within 0.5 s: ${s.sfx.map((x) => `${x.name} @ ${x.start.toFixed(2)} s on ${x.track}`).join("; ")}` : "",
    ].filter(Boolean).join("\n");
  } catch {}
  return ctx;
}

/** The first edit of a new project: raw footage only, no CapCut draft yet. */
function firstEditPrompt(c: Comment, p: Project) {
  const raw = rawInfo(p);
  const gb = (n: number) => (n / 1024 ** 3).toFixed(2) + " GB";
  return `The user uploaded raw footage for a NEW edit from Edit Room and asked you to build the first edit.

Footage (in ${rawDir(p)}):
${raw.files.map((f) => `- ${f.name} (${gb(f.size)})`).join("\n")}

The user's note: ${raw.note.trim() ? `"${raw.note.trim()}"` : "(none: find the first script line and the end yourself, and drop off-script chatter)"}

Build it end to end with the talking-head-reel-edit skill, in the house style, exactly as you would in a chat with
the user, with these differences:
- Nobody is at a prompt. Do not stop to ask; make the call the skill and the user's memory point to, and say in your
  final reply what you decided (takes chosen, anything you were unsure of).
- The edit folder is ${p.editDir} (already made, with the footage in raw/). Keep deliverables there as the skill says.
- There is no CapCut draft yet. Create one named "${p.id}" in the CapCut drafts folder (\`capcut init "${p.id}"\`,
  --ratio 9:16 if the footage is vertical), then continue from step 0. Write edit-data/build_cfg.json as the skill
  says: the app finds the draft through its main_src.
- If the footage is not one talking-head recording (several clips, b-roll only, audio only), build the most sensible
  edit you can and explain it.
- Post a short progress note with room_note at the start of each big step (takes found, cut verified, grade, cards,
  draft built, preview), so the user can follow along on their phone.
- Do not run the 9:16 version or the 4K master; the user asks for those separately.
- When the draft is built, call room_refresh_picture so the app's preview is ready.
Final reply: 2-4 short sentences: what you built, the length, and anything the user should look at first.`;
}

function buildPrompt(c: Comment, p: Project, framePath: string | null) {
  if (c.target.kind === "build") return firstEditPrompt(c, p);
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
- skill: ${SKILL_DIR}${(c.want ?? 1) > 1 ? `

The user asked for ${c.want} OPTIONS, to compare side by side before choosing. Make ${c.want} clearly different takes
on the request (not ${c.want} near-identical ones). For each option, in turn:
1. make the change in the real files, exactly as you would for a single change;
2. call room_save_option with a short label (under 8 words, e.g. "Smaller, moved up") describing that take.
   The tool saves the option and puts the files back the way they were, so start the next option from the original.
Do not call room_refresh_picture in this mode; each option's preview is prepared by room_save_option.
Your final reply: one line per option (A, B, C…) saying what it is, and which you would pick and why.` : ""}`;
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
          if ((c.want ?? 1) > 1) return { content: [{ type: "text", text: "Not needed in options mode: room_save_option prepares each option's preview." }] };
          const cur = getProject(p.id) ?? p; // a first edit has no draft when the run starts
          if (!cur.draftDir) return { content: [{ type: "text", text: "No CapCut draft found for this project yet: write edit-data/build_cfg.json (main_src inside the draft's folder) or name the draft after the project id." }], isError: true };
          await buildProxy(cur, () => hooks.projectChanged(cur));
          return { content: [{ type: "text", text: "Picture proxy rebuilt; the user's preview reloaded." }] };
        },
      ),
      tool(
        "room_save_option",
        "Options mode only: save the change you just made as the next option (A, B, C…) with a short label, then put the files back to how they were before this comment, ready for the next option.",
        { label: z.string() },
        async ({ label }) => {
          const done = loadComments(p).find((x) => x.id === c.id)?.options?.length ?? 0;
          if (done >= (c.want ?? 1)) return { content: [{ type: "text", text: `All ${c.want} options are saved already.` }], isError: true };
          const changed = changedSince(p, c.id);
          if (!changed.length) return { content: [{ type: "text", text: "Nothing has changed since the start, so there is no option to save." }], isError: true };
          const key = KEYS[done];
          saveOption(p, c.id, key, label, changed);
          restore(p, c.id, changed);
          const op = optionProject(p, c.id, key);
          const pictureChanged = readModel(op).pictureHash !== readModel(p).pictureHash;
          const u = updateComment(p, c.id, (x) => {
            x.options = [...(x.options ?? []), { key, note: label, files: changed, pictureChanged, picture: pictureChanged ? "building" : "ready" }];
            x.activity.push({ at: Date.now(), kind: "info", text: `Option ${key} saved: ${label}` });
          });
          if (u) hooks.emit(u);
          if (pictureChanged)
            buildProxy(op, () => {}).then(() => {
              const st = proxyState(op).status === "ready" ? "ready" : "failed";
              const v = updateComment(p, c.id, (x) => {
                const o = x.options?.find((o) => o.key === key);
                if (o) o.picture = st;
              });
              if (v) hooks.emit(v);
            });
          return { content: [{ type: "text", text: `Saved as option ${key}; files restored to the original${pictureChanged ? "; its picture preview is building" : ""}.` }] };
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
  const optionsMode = (c.want ?? 1) > 1;
  if (optionsMode) quiet.add(p.id);

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
        allowedTools: ["Read", "Glob", "Grep", "Bash", "Skill", "mcp__room__room_refresh_picture", "mcp__room__room_note", "mcp__room__room_save_option"],
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
    let changed = c.target.kind === "build" ? [] : changedSince(p, c.id); // a first edit has nothing to undo to
    if (optionsMode && changed.length) {
      restore(p, c.id, changed); // anything not saved as an option is not wanted
      set((x) => x.activity.push({ at: Date.now(), kind: "info", text: "Put back changes that were not saved as an option" }));
      changed = [];
    }
    set((x) => {
      const opts = x.options?.length ?? 0;
      x.status = failed ? "failed" : optionsMode ? (opts ? "review" : "failed") : "done";
      x.reply = finalText || (failed ? "The agent stopped with an error." : optionsMode && !opts ? "No options were saved." : "Done.");
      x.changed = changed;
      x.finishedAt = Date.now();
    });
  } catch (e: any) {
    let changed = c.target.kind === "build" ? [] : changedSince(p, c.id); // a first edit has nothing to undo to
    if (optionsMode && changed.length) {
      restore(p, c.id, changed);
      changed = [];
    }
    set((x) => {
      x.status = abort.signal.aborted ? "stopped" : "failed";
      x.activity.push({ at: Date.now(), kind: "error", text: String(e?.message ?? e).slice(0, 500) });
      x.reply = abort.signal.aborted ? "Stopped." : "Something went wrong; see the activity log.";
      x.changed = changed;
      x.finishedAt = Date.now();
    });
  } finally {
    aborts.delete(c.id);
    if (optionsMode) {
      quiet.delete(p.id);
      hooks.overlayChanged(p); // the main preview is back to the original; make sure it shows it
    }
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
