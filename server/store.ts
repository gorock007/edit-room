import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Project } from "./projects.ts";

export type Target = {
  kind: "caption" | "frame" | "sfx" | "cut" | "broll" | "general";
  id?: string;
  label: string;
  detail?: string;
};
export type Activity = { at: number; kind: "tool" | "text" | "info" | "error"; text: string };
export type CommentStatus = "queued" | "working" | "review" | "done" | "failed" | "stopped" | "undone";
export type Option = { key: string; note: string; files: string[]; pictureChanged: boolean; picture?: "building" | "ready" | "failed" };
export type Comment = {
  id: string;
  project: string;
  createdAt: number;
  text: string;
  t: number;
  x: number | null; // 0..1 across the frame, null when not pinned to a point
  y: number | null;
  target: Target;
  status: CommentStatus;
  activity: Activity[];
  reply?: string;
  frame?: string;
  changed?: string[];
  costUsd?: number;
  finishedAt?: number;
  want?: number; // how many options the user asked for (1 = just do it)
  options?: Option[];
  chosen?: string; // the option key used, or "current"
};

const file = (p: Project) => path.join(p.dataDir, "comments.json");

export function loadComments(p: Project): Comment[] {
  try {
    return JSON.parse(fs.readFileSync(file(p), "utf8"));
  } catch {
    return [];
  }
}

export function saveComments(p: Project, list: Comment[]) {
  const tmp = file(p) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1));
  fs.renameSync(tmp, file(p));
}

export function updateComment(p: Project, id: string, fn: (c: Comment) => void): Comment | undefined {
  const list = loadComments(p);
  const c = list.find((x) => x.id === id);
  if (!c) return;
  fn(c);
  saveComments(p, list);
  return c;
}

export const newId = () => crypto.randomBytes(5).toString("hex");

// ---- per-comment snapshots, so every agent change can be undone in one click ----

/** The files an edit lives in: the draft, the caption composition and its data, the edit-data plans. */
export function editFiles(p: Project): string[] {
  const out: string[] = [];
  if (p.draftDir) out.push(path.join(p.draftDir, "draft_info.json"));
  if (p.overlaysDir)
    for (const n of fs.readdirSync(p.overlaysDir))
      if (/\.(json|html|txt|py)$/.test(n)) out.push(path.join(p.overlaysDir, n));
  const ed = path.join(p.editDir, "edit-data");
  if (fs.existsSync(ed)) for (const n of fs.readdirSync(ed)) if (n.endsWith(".json")) out.push(path.join(ed, n));
  return out;
}

const hash = (f: string) => (fs.existsSync(f) ? crypto.createHash("sha1").update(fs.readFileSync(f)).digest("hex") : "missing");

export function snapshot(p: Project, commentId: string) {
  const dir = path.join(p.dataDir, "history", commentId);
  fs.mkdirSync(dir, { recursive: true });
  const index: Record<string, string> = {};
  editFiles(p).forEach((f, i) => {
    const copy = path.join(dir, `${i}_${path.basename(f)}`);
    fs.copyFileSync(f, copy);
    index[f] = copy;
  });
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({ index, hashes: Object.fromEntries(Object.keys(index).map((f) => [f, hash(f)])) }));
}

/** Files that differ from the snapshot taken before the agent ran. */
export function changedSince(p: Project, commentId: string): string[] {
  const idx = path.join(p.dataDir, "history", commentId, "index.json");
  if (!fs.existsSync(idx)) return [];
  const { hashes } = JSON.parse(fs.readFileSync(idx, "utf8"));
  const now = new Set(editFiles(p));
  const changed = Object.keys(hashes).filter((f) => hash(f) !== hashes[f]);
  for (const f of now) if (!(f in hashes)) changed.push(f); // created by the agent
  return changed;
}

export function restore(p: Project, commentId: string, files: string[]) {
  const idx = path.join(p.dataDir, "history", commentId, "index.json");
  const { index } = JSON.parse(fs.readFileSync(idx, "utf8"));
  for (const f of files) {
    if (index[f]) fs.copyFileSync(index[f], f);
  }
}
