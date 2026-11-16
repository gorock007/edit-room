import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getProject, readModel, type Project } from "./projects.ts";
import { editFiles, type Author } from "./store.ts";

/**
 * Version history, like Google Docs: after every change to an edit (a finished comment, a picked option, an undo, a
 * restore, or a change made outside Edit Room), the edit's files are saved as a version, with who asked for it, what
 * changed and a few stats. Any version can be named, previewed side by side with the current edit, and restored.
 *
 * The edit's files are the ones undo already tracks (store.ts editFiles: the CapCut draft, the caption composition and
 * its data, the edit-data plans). Each file's content is stored once by its hash, so a version that touches one file
 * costs one file. The media (graded A-roll, rendered cards) is not versioned: a version plays with today's media.
 */

export type VersionKind = "start" | "build" | "comment" | "pick" | "undo" | "restore" | "outside";
export type Stats = { duration: number; cuts: number; cards: number; captions: number; sounds: number };
export type Version = {
  n: number;
  at: number;
  kind: VersionKind;
  /** what happened, in words ("Make the hook caption bigger", "Picked option B: Smaller, moved up") */
  what: string;
  by?: Author;
  comment?: string;
  /** the owner's name for it ("Sent to client v1") */
  label?: string;
  labelledBy?: string;
  /** basenames of the files that differ from the version before */
  changed: string[];
  stats?: Stats;
  /** every edit file's content hash ("missing" if it didn't exist) */
  files: Record<string, string>;
};
export type VersionInfo = Omit<Version, "files">;

const dir = (p: Project) => path.join(p.dataDir, "versions");
const blobs = (p: Project) => path.join(dir(p), "blobs");
const indexFile = (p: Project) => path.join(dir(p), "index.json");
const hashOf = (f: string) => (fs.existsSync(f) ? crypto.createHash("sha1").update(fs.readFileSync(f)).digest("hex") : "missing");

export function versions(p: Project): Version[] {
  try {
    return JSON.parse(fs.readFileSync(indexFile(p), "utf8"));
  } catch {
    return [];
  }
}
const save = (p: Project, list: Version[]) => {
  fs.mkdirSync(dir(p), { recursive: true });
  const tmp = indexFile(p) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(list));
  fs.renameSync(tmp, indexFile(p));
};
export const info = ({ files: _f, ...v }: Version): VersionInfo => v;

function currentFiles(p: Project): Record<string, string> {
  return Object.fromEntries(editFiles(p).map((f) => [f, hashOf(f)]));
}
export const same = (a: Record<string, string>, b: Record<string, string>) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? "missing") !== (b[k] ?? "missing")) return false;
  return true;
};
function stats(p: Project): Stats | undefined {
  try {
    const m = readModel(p);
    return { duration: Math.round(m.duration * 100) / 100, cuts: m.cuts.length, cards: m.broll.length, captions: m.captions.length, sounds: m.sfx.length };
  } catch {
    return undefined;
  }
}

/** One edit at a time per project writes versions (the agent and a person picking an option could otherwise race). */
const busy = new Set<string>();

/**
 * Save the edit as it is now as the next version, if it differs from the last one (returns the version either way).
 * The first call for a project also saves where history starts.
 */
export function record(p0: Project, v: { kind: VersionKind; what: string; by?: Author; comment?: string }): Version | null {
  const p = getProject(p0.id) ?? p0; // a first edit has its draft only after the run
  if (!p.draftDir || busy.has(p.id)) return null;
  busy.add(p.id);
  try {
    const list = versions(p);
    const files = currentFiles(p);
    const last = list[list.length - 1];
    if (last && same(last.files, files)) return last;
    fs.mkdirSync(blobs(p), { recursive: true });
    for (const [f, h] of Object.entries(files)) {
      const b = path.join(blobs(p), h);
      if (h !== "missing" && !fs.existsSync(b)) fs.copyFileSync(f, b);
    }
    const changed = last
      ? [...new Set([...Object.keys(files), ...Object.keys(last.files)])].filter((f) => (files[f] ?? "missing") !== (last.files[f] ?? "missing")).map((f) => path.basename(f))
      : [];
    const next: Version = {
      n: (last?.n ?? 0) + 1,
      at: Date.now(),
      kind: last ? v.kind : v.kind === "build" ? "build" : "start",
      what: last ? v.what : v.kind === "build" ? v.what : "Where the history starts",
      ...(v.by ? { by: v.by } : {}),
      ...(v.comment ? { comment: v.comment } : {}),
      changed,
      stats: stats(p),
      files,
    };
    list.push(next);
    save(p, list);
    return next;
  } finally {
    busy.delete(p.id);
  }
}

/**
 * Anything changed since the last version that Edit Room didn't do (CapCut, a chat with Claude, a script) becomes a
 * version of its own before the next change, so history never mixes the two. Also starts history on first look.
 */
export function syncOutside(p: Project) {
  return record(p, { kind: "outside", what: "Changed outside Edit Room" });
}

export function nameVersion(p: Project, n: number, label: string, by: string): Version {
  const list = versions(p);
  const v = list.find((x) => x.n === n);
  if (!v) throw new Error("no such version");
  if (label) {
    v.label = label;
    v.labelledBy = by;
  } else {
    delete v.label;
    delete v.labelledBy;
  }
  save(p, list);
  return v;
}

const viewDir = (p: Project, n: number) => path.join(dir(p), "view", String(n));

/** Write the version's files into a folder that mirrors `srcDir`: its own files copied in, everything else linked. */
function shadow(p: Project, v: Version, srcDir: string | null, outDir: string): string | null {
  if (!srcDir) return null;
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, name);
    const out = path.join(outDir, name);
    if (fs.lstatSync(out, { throwIfNoEntry: false })) continue;
    const h = v.files[src];
    if (h && h !== "missing") fs.copyFileSync(path.join(blobs(p), h), out);
    else if (!h) fs.symlinkSync(src, out);
    // a file the version didn't have yet stays out
  }
  return outDir;
}

/** The version as a Project of its own (separate id and data folder, so its preview builds and caches apart). */
export function versionProject(p: Project, n: number): Project | null {
  const v = versions(p).find((x) => x.n === n);
  if (!v || !p.draftDir) return null;
  const d = viewDir(p, n);
  return {
    ...p,
    id: `${p.id}~v${n}`,
    overlaysDir: p.overlaysDir && fs.existsSync(path.join(p.overlaysDir, "index.html")) ? shadow(p, v, p.overlaysDir, path.join(d, "overlays")) : null,
    draftDir: shadow(p, v, p.draftDir, path.join(d, "draft")),
    dataDir: d,
  };
}

/** Put a version's files back in place. Returns the files it wrote. */
export function restoreFiles(p: Project, n: number): string[] {
  const v = versions(p).find((x) => x.n === n);
  if (!v) throw new Error("no such version");
  const wrote: string[] = [];
  for (const [f, h] of Object.entries(v.files)) {
    if (h === "missing") continue; // a file made later stays; nothing reads files a version didn't have
    if (hashOf(f) === h) continue;
    fs.copyFileSync(path.join(blobs(p), h), f);
    wrote.push(f);
  }
  return wrote;
}
