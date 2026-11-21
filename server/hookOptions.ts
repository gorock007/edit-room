import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { SKILL_DIR } from "./config.ts";
import type { Project } from "./projects.ts";
import { isStage } from "./cut.ts";
import { KEYS, saveOptionFrom } from "./options.ts";
import { loadComments, newId, saveComments, snapshot, updateComment, type Author, type Comment, type Option } from "./store.ts";

/**
 * Title hook options (the user, 2026-11-21): every video opens on a title hook held at least 5 s, and after each first
 * edit the user gets five different hooks to compare side by side in Edit Room and pick from. The hook's first frame
 * is the video's cover.
 *
 * For house-caption edits (overlays/caption_layout.json) no agent is needed: one short Sonnet call writes the five
 * hooks from the transcript, and the skill's own build_captions.py lays each one out in a scratch copy of the caption
 * files. Each becomes an option (caption_layout.json + index.html), so nothing in the edit changes until one is picked.
 * Stage-format edits keep their titles in stage_captions.json; they go to the agent as a normal 5-option comment.
 */
export const HOOK_OPTIONS = 5;
export const MIN_HOOK_S = 5;
export const HOOK_REQUEST =
  "Make 5 title hook options for the start of the video (the cover). Each a different angle, on screen from the very first frame with no animation, for at least 5 s. Captions move clear of it while it shows.";

type Hook = { small: string; big: string; angle: string };
const BUILDER = () => path.join(SKILL_DIR, "assets/overlay-template/build_captions.py");

export const canMakeHookOptions = (p: Project) =>
  !!p.overlaysDir && !isStage(p) && fs.existsSync(path.join(p.overlaysDir, "captions.json")) && fs.existsSync(BUILDER());

type Group = { start: number; end: number; words: { t: string }[] };
const groupsOf = (p: Project): Group[] => JSON.parse(fs.readFileSync(path.join(p.overlaysDir!, "captions.json"), "utf8")).groups;
const layoutOf = (p: Project): any => {
  try {
    return JSON.parse(fs.readFileSync(path.join(p.overlaysDir!, "caption_layout.json"), "utf8"));
  } catch {
    return {};
  }
};

/** Keep the hook the edit already has; otherwise end it on the first caption group boundary at 5 s or later. */
function hookUntil(p: Project, layout: any): number {
  if (layout.hook?.until >= MIN_HOOK_S) return layout.hook.until;
  const g = groupsOf(p).find((x) => x.start >= MIN_HOOK_S - 0.05);
  return g ? Math.round(g.start * 1000) / 1000 : 6;
}

async function writeHooks(p: Project, n: number): Promise<Hook[]> {
  const words = groupsOf(p)
    .map((g) => g.words.map((w) => w.t).join(" "))
    .join(" ")
    .slice(0, 6000);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 60_000);
  let out = "";
  try {
    for await (const m of query({
      prompt: `What the creator says in the video, in order:\n${words}`,
      options: {
        model: "claude-sonnet-5-5",
        effort: "low",
        abortController: abort,
        settingSources: [],
        tools: [],
        persistSession: false,
        maxTurns: 1,
        cwd: os.tmpdir(),
        systemPrompt: `You write the on-screen title hook for a short vertical talking-head video. It shows from the first frame for 5+ seconds and is the video's cover, so it must make a scroller stop and stay.
Write ${n} hooks, each a clearly different angle (for example: the problem, the payoff, curiosity, a bold claim, a "how I" story). Each has two parts:
- "small": a 2-4 word lead-in line
- "big": a 2-4 word punch line, the words that matter
Rules: only claims the video backs up; no numbers that aren't said; use the creator's own words for things (if they say "workers", say "workers"); plain words; no emojis, no hashtags, no quotes; don't just repeat the first spoken sentence.
Reply with only a JSON array: [{"angle": "<2-3 word name>", "small": "...", "big": "..."}].`,
      },
    })) {
      if (m.type === "result" && m.subtype === "success") out = m.result;
    }
  } finally {
    clearTimeout(timer);
  }
  const json = out.slice(out.indexOf("["), out.lastIndexOf("]") + 1);
  const list = (JSON.parse(json) as any[])
    .map((h) => ({ angle: String(h.angle ?? "").trim().slice(0, 40), small: String(h.small ?? "").trim().slice(0, 40), big: String(h.big ?? "").trim().slice(0, 40) }))
    .filter((h) => h.small && h.big);
  if (list.length < n) throw new Error(`only ${list.length} usable hooks came back`);
  return list.slice(0, n);
}

/** Lay one hook out with the skill's builder in a scratch copy of the caption files; the edit itself isn't touched. */
function buildVariant(p: Project, hook: Hook, until: number): { layout: string; html: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "hook-"));
  try {
    const ov = path.join(base, "overlays");
    fs.mkdirSync(ov);
    for (const f of ["captions.json", "broll_spans.json"]) {
      const src = path.join(p.overlaysDir!, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(ov, f));
    }
    // the builder reads ../edit-data/build_cfg.json to find the draft (where the cards and wall titles are)
    const ed = path.join(path.dirname(p.overlaysDir!), "edit-data");
    if (fs.existsSync(ed)) fs.symlinkSync(ed, path.join(base, "edit-data"));
    const layout = layoutOf(p);
    const prev = layout.hook ?? {};
    layout.hook = {
      until,
      small: hook.small,
      big: hook.big,
      ...(prev.chin_top != null ? { chin_top: prev.chin_top } : {}),
      ...(prev.chin_height != null ? { chin_height: prev.chin_height } : {}),
    };
    const layoutText = JSON.stringify(layout);
    fs.writeFileSync(path.join(ov, "caption_layout.json"), layoutText);
    execFileSync("python3", ["-I", BUILDER(), ov], { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    return { layout: layoutText, html: fs.readFileSync(path.join(ov, "index.html"), "utf8") };
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/** Post a "title hook" comment and fill it with five options to compare. Returns the comment (status review or failed). */
export async function makeHookOptions(p: Project, author: Author | undefined, emit: (c: Comment) => void): Promise<Comment> {
  if (!canMakeHookOptions(p)) throw new Error("this edit's captions aren't house captions");
  const id = newId();
  snapshot(p, id); // picking an option is undone like any other change
  const c: Comment = {
    id,
    project: p.id,
    createdAt: Date.now(),
    text: HOOK_REQUEST,
    t: 0,
    x: null,
    y: null,
    target: { kind: "general", label: "the title hook", detail: "the cover, from 0 s" },
    status: "working",
    activity: [{ at: Date.now(), kind: "info", text: `Writing ${HOOK_OPTIONS} title hooks` }],
    want: HOOK_OPTIONS,
    author,
  };
  saveComments(p, [...loadComments(p), c]);
  emit(c);
  const set = (fn: (x: Comment) => void) => {
    const u = updateComment(p, id, fn);
    if (u) emit(u);
    return u;
  };
  try {
    const layoutFile = path.join(p.overlaysDir!, "caption_layout.json");
    const indexFile = path.join(p.overlaysDir!, "index.html");
    const until = hookUntil(p, layoutOf(p));
    const hooks = await writeHooks(p, HOOK_OPTIONS);
    const options: Option[] = [];
    hooks.forEach((h, i) => {
      const key = KEYS[i];
      const v = buildVariant(p, h, until);
      const note = `${h.angle ? `${h.angle}: ` : ""}${h.small} / ${h.big}`;
      saveOptionFrom(p, id, key, note, [
        { real: layoutFile, content: Buffer.from(v.layout) },
        { real: indexFile, content: Buffer.from(v.html) },
      ]);
      options.push({ key, note, files: [layoutFile, indexFile], pictureChanged: false, picture: "ready" });
    });
    return set((x) => {
      x.options = options;
      x.status = "review";
      x.finishedAt = Date.now();
      x.reply = `${HOOK_OPTIONS} title hooks, each on screen from the first frame to ${until.toFixed(1)} s with the captions under the mouth meanwhile. Compare them and pick one: its first frame is the cover.`;
      x.activity.push({ at: Date.now(), kind: "info", text: `${HOOK_OPTIONS} options ready to compare` });
    })!;
  } catch (e: any) {
    return set((x) => {
      x.status = "failed";
      x.finishedAt = Date.now();
      x.reply = `Couldn't make the title hook options: ${String(e?.message ?? e).slice(0, 300)}`;
    })!;
  }
}
