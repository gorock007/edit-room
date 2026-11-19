import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type http from "node:http";
import { CAPCUT_DRAFTS, VIDEO_ROOT } from "./config.ts";
import type { Project } from "./projects.ts";

/**
 * Raw footage for a new edit, sent from any device (the phone over Tailscale) in chunks, so a dropped connection or a
 * locked screen resumes where it stopped instead of starting a 5 GB file again. The file lands in "<NNNN> edit/raw/".
 * Extra material for the same video (b-roll, screen recordings, screenshots) goes the same way into
 * "<NNNN> edit/resources/": the edit skill catalogues that folder and must use each file or say why not.
 */

export const VIDEO_EXT = /\.(mp4|mov|m4v|mts|m2ts|mxf|avi|mkv|wav|m4a|mp3|aif|aiff)$/i;
export const IMAGE_EXT = /\.(png|jpe?g|heic|heif|webp|gif|tiff?)$/i;
export type Dest = "raw" | "resources";
export const FORMATS = ["9:16", "16:9"] as const;
export type Format = (typeof FORMATS)[number];
export const MAX_FILE = 200 * 1024 ** 3;
export const MAX_CHUNK = 64 * 1024 ** 2;
const SPARE = 5 * 1024 ** 3; // never fill the disk: keep this much free after the upload

export const rawDir = (p: Project) => path.join(p.editDir, "raw");
export const resourcesDir = (p: Project) => path.join(p.editDir, "resources");
const destDir = (p: Project, dest: Dest) => (dest === "resources" ? resourcesDir(p) : rawDir(p));
const partsDir = (p: Project) => path.join(rawDir(p), ".uploads");
const okFor = (name: string, dest: Dest) => VIDEO_EXT.test(name) || (dest === "resources" && IMAGE_EXT.test(name));

/**
 * The next free "<MMDD> edit" folder (today's date, like the user's earlier edits); a second one today is "<MMDD>b".
 * A name CapCut already has is taken too: the app links an edit folder to the CapCut project of the same name, and the
 * user may have made one in CapCut themselves.
 */
export function newEditFolder(now = new Date()): { id: string; dir: string } {
  const base = String(now.getMonth() + 1).padStart(2, "0") + String(now.getDate()).padStart(2, "0");
  // "v" is skipped: "<id>v" already names a project's 9:16 version
  for (const suffix of ["", ..."bcdefghijklmnopqrstuwxyz"]) {
    const id = base + suffix;
    const dir = path.join(VIDEO_ROOT, `${id} edit`);
    const inCapcut = [id, `${id} (1)`].some((n) => fs.existsSync(path.join(CAPCUT_DRAFTS, n)));
    if (!fs.existsSync(dir) && !inCapcut) {
      fs.mkdirSync(path.join(dir, "raw"), { recursive: true });
      return { id, dir };
    }
  }
  throw new Error("too many edits today");
}

export function cleanName(name: string, dest: Dest = "raw"): string | null {
  const n = path.basename(String(name)).replace(/[\u0000-\u001f/\\:]/g, "").trim();
  if (!n || n.startsWith(".") || n.length > 180 || !okFor(n, dest)) return null;
  return n;
}

type Meta = { name: string; size: number; dest?: Dest };
// the raw key stays as it was, so an upload begun before this change still resumes
const keyOf = (name: string, size: number, dest: Dest) =>
  crypto.createHash("sha1").update(dest === "raw" ? `${name}\0${size}` : `${dest}\0${name}\0${size}`).digest("hex").slice(0, 16);
const partFile = (p: Project, key: string) => path.join(partsDir(p), `${key}.part`);
const metaFile = (p: Project, key: string) => path.join(partsDir(p), `${key}.json`);
const size = (f: string) => (fs.existsSync(f) ? fs.statSync(f).size : 0);

export type UploadState = { key: string; name: string; size: number; received: number; done: boolean };

/** Start (or resume) an upload. Picking the same file again resumes from what the server already has. */
export function startUpload(p: Project, rawName: string, total: number, dest: Dest = "raw"): UploadState {
  const name = cleanName(rawName, dest);
  if (!name) throw new Error(dest === "resources" ? "only video, audio or image files can be added" : "only video or audio files can be uploaded");
  if (!Number.isFinite(total) || total <= 0 || total > MAX_FILE) throw new Error("file size is missing or too big");
  const key = keyOf(name, total, dest);
  const done = path.join(destDir(p, dest), name);
  if (size(done) === total) return { key, name, size: total, received: total, done: true };
  fs.mkdirSync(partsDir(p), { recursive: true });
  const received = size(partFile(p, key));
  const { bavail, bsize } = fs.statfsSync(partsDir(p));
  if (bavail * bsize - (total - received) < SPARE) throw new Error("not enough free space on the Mac for this file");
  fs.writeFileSync(metaFile(p, key), JSON.stringify({ name, size: total, dest } satisfies Meta));
  return { key, name, size: total, received, done: false };
}

const busy = new Set<string>();

/** Append one chunk at `offset`, which must be exactly what the server has so far. */
export async function putChunk(p: Project, key: string, offset: number, req: http.IncomingMessage): Promise<UploadState> {
  if (!/^[a-f0-9]{16}$/.test(key) || !fs.existsSync(metaFile(p, key))) throw Object.assign(new Error("no such upload"), { status: 404 });
  const meta: Meta = JSON.parse(fs.readFileSync(metaFile(p, key), "utf8"));
  const part = partFile(p, key);
  const lock = `${p.id}/${key}`;
  if (busy.has(lock)) throw Object.assign(new Error("this file is already uploading"), { status: 409 });
  busy.add(lock);
  try {
    const have = size(part);
    if (offset !== have) throw Object.assign(new Error(`expected offset ${have}`), { status: 409, received: have });
    let n = 0;
    const limit = new Transform({
      transform(chunk, _enc, cb) {
        n += chunk.length;
        if (n > MAX_CHUNK || have + n > meta.size) return cb(new Error("chunk too big"));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, limit, fs.createWriteStream(part, { flags: "a" }));
    } catch (e) {
      // keep whatever arrived whole up to the failure; the client asks for the offset and continues from there
      throw Object.assign(e as Error, { status: 400, received: size(part) });
    }
    const received = size(part);
    if (received < meta.size) return { key, name: meta.name, size: meta.size, received, done: false };
    const dir = destDir(p, meta.dest === "resources" ? "resources" : "raw");
    fs.mkdirSync(dir, { recursive: true });
    let dest = path.join(dir, meta.name);
    for (let i = 2; fs.existsSync(dest); i++) dest = path.join(dir, meta.name.replace(/(\.[^.]+)$/, ` (${i})$1`));
    fs.renameSync(part, dest);
    fs.rmSync(metaFile(p, key), { force: true });
    try {
      fs.rmdirSync(partsDir(p)); // only when no other upload is in progress (it fails if not empty)
    } catch {}
    return { key, name: path.basename(dest), size: meta.size, received, done: true };
  } finally {
    busy.delete(lock);
  }
}

type FileRow = { name: string; size: number };
type PendingRow = FileRow & { received: number; dest?: Dest };
/** What the build was asked for besides the footage: the format the user picked and library folders to draw from. */
/** style: a wild card template's folder name in Video Editor/templates, or null for the house style. */
/** music: null for none (the house default, voice only), "auto" for Claude to pick, or a track's path in the bank. */
export type BuildOptions = { format: Format | null; folders: string[]; style: string | null; music: string | null };
export type RawInfo = { files: FileRow[]; pending: PendingRow[]; note: string; resources: FileRow[] } & BuildOptions;

const list = (dir: string, dest: Dest): FileRow[] =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((n) => okFor(n, dest) && !n.startsWith(".")).map((name) => ({ name, size: size(path.join(dir, name)) }))
    : [];

const optionsFile = (p: Project) => path.join(rawDir(p), "build.json");
export function buildOptions(p: Project): BuildOptions {
  try {
    const o = JSON.parse(fs.readFileSync(optionsFile(p), "utf8"));
    return {
      format: FORMATS.includes(o.format) ? o.format : null,
      folders: Array.isArray(o.folders) ? o.folders.filter((x: unknown) => typeof x === "string") : [],
      style: typeof o.style === "string" && /^[a-z0-9-]{1,60}$/.test(o.style) ? o.style : null,
      music: typeof o.music === "string" && o.music.length <= 400 ? o.music : null,
    };
  } catch {
    return { format: null, folders: [], style: null, music: null };
  }
}
export function saveBuildOptions(p: Project, o: BuildOptions) {
  fs.mkdirSync(rawDir(p), { recursive: true });
  fs.writeFileSync(optionsFile(p), JSON.stringify(o, null, 1) + "\n");
}

const SKIP_DIRS = /^(\d{4}\w? edit|SFX Sounds|background music|editing-toolkit|graphic-type|references|reports|research_notes|capcut assets|wild cards|templates)$/i;
/**
 * Folders of the user's own footage inside the video folder that an edit may draw b-roll from ("Brolls shots", a
 * shoot's folder): any top-level folder that is not an edit or a tools folder and holds video or pictures.
 */
export function libraryFolders(): { name: string; files: number }[] {
  const out: { name: string; files: number }[] = [];
  let top: fs.Dirent[] = [];
  try {
    top = fs.readdirSync(VIDEO_ROOT, { withFileTypes: true });
  } catch {}
  const count = (dir: string, depth: number): number => {
    let n = 0;
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue;
        if (e.isDirectory()) n += depth > 0 ? count(path.join(dir, e.name), depth - 1) : 0;
        else if (/\.(mp4|mov|m4v|mts|m2ts|mxf|avi|mkv)$/i.test(e.name) || IMAGE_EXT.test(e.name)) n++;
      }
    } catch {}
    return n;
  };
  for (const e of top) {
    if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.test(e.name)) continue;
    const files = count(path.join(VIDEO_ROOT, e.name), 1);
    if (files) out.push({ name: e.name, files });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function rawInfo(p: Project): RawInfo {
  const dir = rawDir(p);
  const resources = list(resourcesDir(p), "resources");
  if (!fs.existsSync(dir)) return { files: [], pending: [], note: "", resources, ...buildOptions(p) };
  const files = list(dir, "raw");
  const pending = fs.existsSync(partsDir(p))
    ? fs
        .readdirSync(partsDir(p))
        .filter((n) => n.endsWith(".json"))
        .flatMap((n) => {
          try {
            const m: Meta = JSON.parse(fs.readFileSync(path.join(partsDir(p), n), "utf8"));
            return [{ name: m.name, size: m.size, dest: m.dest ?? "raw", received: size(partFile(p, n.replace(/\.json$/, ""))) }];
          } catch {
            return [];
          }
        })
    : [];
  let note = "";
  try {
    note = fs.readFileSync(path.join(dir, "brief.md"), "utf8");
  } catch {}
  return { files, pending, note, resources, ...buildOptions(p) };
}

export function saveNote(p: Project, note: string) {
  fs.mkdirSync(rawDir(p), { recursive: true });
  fs.writeFileSync(path.join(rawDir(p), "brief.md"), note.trim().slice(0, 4000) + "\n");
}
