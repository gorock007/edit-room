import fs from "node:fs";
import path from "node:path";
import type { Project } from "./projects.ts";

/**
 * Options ("show me 3 versions"): the agent makes each version in the real files, then it is saved here and the
 * files are put back, so the user's edit stays untouched until they pick one. To preview an option without touching
 * anything, it gets a shadow copy of the caption folder and the draft folder: the option's files copied in, every
 * other entry a symlink to the real one. Everything that reads a project (the model, the caption server, preview.py)
 * then works on the shadow as if it were the project.
 */
export const KEYS = ["A", "B", "C", "D", "E"]; // five: the title hook options (hookOptions.ts)
export const optDir = (p: Project, cid: string, key: string) => path.join(p.dataDir, "options", cid, key);

type Saved = { key: string; note: string; index: Record<string, string> };

export function saveOption(p: Project, cid: string, key: string, note: string, changed: string[]) {
  const dir = optDir(p, cid, key);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "files"), { recursive: true });
  const index: Record<string, string> = {};
  changed.forEach((f, i) => {
    if (!fs.existsSync(f)) return;
    const copy = path.join(dir, "files", `${i}_${path.basename(f)}`);
    fs.copyFileSync(f, copy);
    index[f] = copy;
  });
  fs.writeFileSync(path.join(dir, "option.json"), JSON.stringify({ key, note, index } satisfies Saved));
}

/** Save an option made in a working copy: each file's content as it would be at its real path. */
export function saveOptionFrom(p: Project, cid: string, key: string, note: string, files: { real: string; content: Buffer }[]) {
  const dir = optDir(p, cid, key);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "files"), { recursive: true });
  const index: Record<string, string> = {};
  files.forEach(({ real, content }, i) => {
    const copy = path.join(dir, "files", `${i}_${path.basename(real)}`);
    fs.writeFileSync(copy, content);
    index[real] = copy;
  });
  fs.writeFileSync(path.join(dir, "option.json"), JSON.stringify({ key, note, index } satisfies Saved));
}

const saved = (p: Project, cid: string, key: string): Saved => JSON.parse(fs.readFileSync(path.join(optDir(p, cid, key), "option.json"), "utf8"));

export function hasOption(p: Project, cid: string, key: string) {
  return fs.existsSync(path.join(optDir(p, cid, key), "option.json"));
}

function shadow(srcDir: string | null, outDir: string, index: Record<string, string>): string | null {
  if (!srcDir) return null;
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, name);
    const out = path.join(outDir, name);
    if (fs.existsSync(out) || fs.lstatSync(out, { throwIfNoEntry: false })) continue;
    if (index[src]) fs.copyFileSync(index[src], out);
    else fs.symlinkSync(src, out);
  }
  return outDir;
}

/** The option as a Project of its own (separate id and data folder, so its preview builds and caches apart). */
export function optionProject(p: Project, cid: string, key: string): Project {
  const dir = optDir(p, cid, key);
  const { index } = saved(p, cid, key);
  return {
    ...p,
    id: `${p.id}~${cid}~${key}`,
    overlaysDir: shadow(p.overlaysDir, path.join(dir, "overlays"), index),
    draftDir: shadow(p.draftDir, path.join(dir, "draft"), index),
    dataDir: dir,
  };
}

/** Copy the option's files over the real ones; returns the files it changed. */
export function applyOption(p: Project, cid: string, key: string): string[] {
  const { index } = saved(p, cid, key);
  for (const [f, copy] of Object.entries(index)) fs.copyFileSync(copy, f);
  return Object.keys(index);
}
