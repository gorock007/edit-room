import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Project } from "./projects.ts";
import { editFiles } from "./store.ts";

/**
 * A sealed working copy of a project, so Claude can try something (one option of several, all at once) without
 * touching the real edit. The project's edit folder and CapCut draft are mirrored under the project's data folder:
 * every directory is a real directory, small text files (the draft, captions, plans) are copies, and media files are
 * links to the real ones. The skill's files hold full paths to the real draft and edit folder (build_cfg.json's
 * main_src and others), so each copied text file has those paths rewritten to the copy's, and back again when a
 * change is brought home. The draft copy sits in a folder named com.lveditor.draft, like the real one, so the
 * capcut CLI and findDraft treat it as a draft (CAPCUT_DRAFT_DIR points the CLI at it).
 *
 * Writing into a linked media file would change the real file, so runs in a workspace are sandboxed with the real
 * folders write-protected (agent.ts): new media gets a new name in the copy, and comes home with the option.
 */
export type Workspace = {
  root: string;
  project: Project;
  /** real path prefix → copy path prefix, longest first */
  map: [string, string][];
  draftsRoot: string | null;
  /** hash of each copied text file as it was copied, to see what the run changed */
  copied: Map<string, string>;
};

const TEXT = /\.(json|html|txt|py|md|js|mjs|cjs|css|csv|srt|vtt|xml|tsv)$/i;
const MAX_TEXT = 8 * 1024 * 1024;
const SKIP = new Set([".DS_Store", "node_modules", ".git", "__pycache__"]);
const sha = (b: Buffer | string) => crypto.createHash("sha1").update(b).digest("hex");

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Swap whole path prefixes only: "…/1116 signal" must not match inside "…/1116 signal 9x16". */
const swap = (s: string, pairs: [string, string][]) =>
  pairs.reduce((acc, [a, b]) => acc.replace(new RegExp(esc(a) + "(?=[/\\\\\"'\\s)\\],]|$)", "g"), () => b), s);
const toCopy = (w: Workspace, s: string) => swap(s, w.map);
const toReal = (w: Workspace, s: string) => swap(s, w.map.map(([a, b]) => [b, a] as [string, string]).sort((x, y) => y[0].length - x[0].length));

type Entry = { rel: string; kind: "dir" | "text" | "link"; src: string; text?: string };

/** Read a folder once: its directories, small text files (with their content) and everything else (linked). */
function scan(src: string, rel: string, out: Entry[], depth = 0) {
  for (const name of fs.readdirSync(src)) {
    if (SKIP.has(name)) continue;
    const s = path.join(src, name);
    const r = path.join(rel, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(s);
    } catch {
      continue; // a broken link
    }
    if (st.isDirectory() && depth < 8) {
      out.push({ rel: r, kind: "dir", src: s });
      scan(s, r, out, depth + 1);
    } else if (!st.isDirectory() && TEXT.test(name) && st.size <= MAX_TEXT) out.push({ rel: r, kind: "text", src: s, text: fs.readFileSync(s, "utf8") });
    else out.push({ rel: r, kind: "link", src: s });
  }
}

function materialize(entries: Entry[], dst: string, w: Workspace) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of entries) {
    const d = path.join(dst, e.rel);
    if (e.kind === "dir") fs.mkdirSync(d, { recursive: true });
    else if (e.kind === "link") fs.symlinkSync(e.src, d);
    else {
      const text = toCopy(w, e.text!);
      fs.writeFileSync(d, text);
      w.copied.set(d, sha(text));
    }
  }
}

/**
 * Build copies at <project data>/work/<name>, one per name (replacing old ones), reading the project only once:
 * an edit folder in iCloud can take a while to read.
 */
export function makeWorkspaces(p: Project, names: string[]): Workspace[] {
  const draftInside = !!p.draftDir && p.draftDir.startsWith(p.editDir + path.sep);
  const editEntries: Entry[] = [];
  scan(p.editDir, "", editEntries);
  const draftEntries: Entry[] = [];
  if (p.draftDir && !draftInside) scan(p.draftDir, "", draftEntries);
  return names.map((name) => {
    const root = path.join(p.dataDir, "work", name);
    fs.rmSync(root, { recursive: true, force: true });
    const edit = path.join(root, path.basename(p.editDir));
    const draftsRoot = p.draftDir ? path.join(root, "com.lveditor.draft") : null;
    const draft = p.draftDir ? (draftInside ? path.join(edit, path.relative(p.editDir, p.draftDir)) : path.join(draftsRoot!, path.basename(p.draftDir))) : null;
    const map: [string, string][] = [[p.editDir, edit]];
    if (p.draftDir && draft) map.push([p.draftDir, draft]);
    // longest first, so a draft inside the edit folder is swapped by its own prefix
    map.sort((a, b) => b[0].length - a[0].length);
    const w: Workspace = { root, map, draftsRoot, copied: new Map(), project: p };
    materialize(editEntries, edit, w);
    if (draft && !draftInside) materialize(draftEntries, draft, w);
    w.project = {
      ...p,
      id: `${p.id}~${name}`,
      editDir: edit,
      draftDir: draft,
      overlaysDir: p.overlaysDir ? toCopy(w, p.overlaysDir) : null,
      dataDir: path.join(root, ".data"),
    };
    fs.mkdirSync(w.project.dataDir, { recursive: true });
    return w;
  });
}

export const makeWorkspace = (p: Project, name: string) => makeWorkspaces(p, [name])[0];

export type Brought = {
  /** the edit's own files (what undo and versions track), with their content as it would be at the real path */
  files: { real: string; content: Buffer }[];
  /** media the run made (new files, never a replacement): copied into the real folders */
  media: string[];
};

/**
 * What the run changed in the copy, ready for the real project: changed edit files with their paths rewritten back,
 * and new media files, which are copied into the real folders (only where nothing exists yet).
 */
export function bringHome(w: Workspace): Brought {
  const files: Brought["files"] = [];
  for (const f of editFiles(w.project)) {
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, "utf8");
    if (w.copied.get(f) === sha(text)) continue;
    files.push({ real: toReal(w, f), content: Buffer.from(toReal(w, text)) });
  }
  const media: string[] = [];
  const walk = (dir: string, depth = 0) => {
    for (const name of fs.readdirSync(dir)) {
      const f = path.join(dir, name);
      const st = fs.lstatSync(f);
      if (st.isSymbolicLink()) continue; // the real file
      if (st.isDirectory()) {
        if (depth < 8 && name !== ".data") walk(f, depth + 1);
        continue;
      }
      if (w.copied.has(f) || TEXT.test(name)) continue; // text changes come home as edit files only
      const real = toReal(w, f);
      if (real === f || fs.existsSync(real)) continue;
      fs.mkdirSync(path.dirname(real), { recursive: true });
      fs.copyFileSync(f, real, fs.constants.COPYFILE_EXCL);
      media.push(real);
    }
  };
  walk(w.root);
  return { files, media };
}

export function dropWorkspace(w: Workspace) {
  fs.rmSync(w.root, { recursive: true, force: true });
}
