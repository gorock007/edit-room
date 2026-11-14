import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CAPCUT_DRAFTS, DATA_DIR, VIDEO_ROOT } from "./config.ts";

export type Project = {
  id: string; // "1110"
  name: string; // "1110 edit"
  editDir: string;
  draftDir: string | null;
  overlaysDir: string | null;
  dataDir: string;
};

export type Seg = { id: string; start: number; dur: number; label: string; file: string; scale: number; src: number };
export type CapGroup = { id: string; start: number; dur: number; text: string; big: string };
export type Sfx = { id: string; track: string; start: number; dur: number; src: number; volume: number; file: string; name: string };
export type EditModel = {
  project: Pick<Project, "id" | "name">;
  duration: number;
  fps: number;
  width: number;
  height: number;
  cuts: Seg[];
  broll: Seg[];
  captions: CapGroup[];
  sfx: Sfx[];
  hasOverlay: boolean;
  pictureHash: string;
  draftMtime: number;
};

const US = 1_000_000;

/** Every "<NNNN> edit" folder in the video root, linked to its CapCut draft. */
export function listProjects(): Project[] {
  if (!fs.existsSync(VIDEO_ROOT)) return [];
  return fs
    .readdirSync(VIDEO_ROOT)
    .filter((n) => /^\d{3,4} edit$/.test(n))
    .sort()
    .reverse()
    .flatMap((name) => {
      const id = name.split(" ")[0];
      const editDir = path.join(VIDEO_ROOT, name);
      const one = (id: string, name: string, dir: string): Project => {
        const overlays = path.join(dir, "overlays");
        return {
          id,
          name,
          editDir: dir,
          draftDir: findDraft(id, dir),
          overlaysDir: fs.existsSync(path.join(overlays, "index.html")) ? overlays : null,
          dataDir: path.join(DATA_DIR, id),
        };
      };
      // the 9:16 version (make_vertical.py) lives in "<NNNN> edit/vertical" with its own draft, overlays and edit-data
      const vertical = path.join(editDir, "vertical");
      const hasVertical = fs.existsSync(path.join(vertical, "edit-data", "build_cfg.json"));
      return [one(id, name, editDir), ...(hasVertical ? [one(`${id}v`, `${name} · 9:16`, vertical)] : [])];
    });
}

export function getProject(id: string) {
  const p = listProjects().find((x) => x.id === id);
  if (p) fs.mkdirSync(p.dataDir, { recursive: true });
  return p;
}

function findDraft(id: string, editDir: string): string | null {
  // build_cfg.json names the graded A-roll inside the draft's claude_media: the most reliable link
  const cfg = path.join(editDir, "edit-data/build_cfg.json");
  if (fs.existsSync(cfg)) {
    try {
      const src: string = JSON.parse(fs.readFileSync(cfg, "utf8")).main_src ?? "";
      const m = src.match(/^(.*com\.lveditor\.draft\/[^/]+)\//);
      if (m && fs.existsSync(path.join(m[1], "draft_info.json"))) return m[1];
    } catch {}
  }
  for (const cand of [id, `${id} (1)`]) {
    const d = path.join(CAPCUT_DRAFTS, cand);
    if (fs.existsSync(path.join(d, "draft_info.json"))) return d;
  }
  return null;
}

const fixPath = (p: string, draftDir: string) => p.replace(/##_draftpath_placeholder_[^#]*_##/, draftDir);

export function readModel(p: Project): EditModel {
  if (!p.draftDir) throw new Error(`no CapCut draft found for ${p.name}`);
  const draftFile = path.join(p.draftDir, "draft_info.json");
  const d = JSON.parse(fs.readFileSync(draftFile, "utf8"));
  const vids = new Map<string, any>(d.materials.videos.map((v: any) => [v.id, v]));
  const auds = new Map<string, any>(d.materials.audios.map((a: any) => [a.id, a]));
  const vtracks = d.tracks.filter((t: any) => t.type === "video");
  const byName = (n: string) => vtracks.find((t: any) => (t.name || "main") === n);
  const seg = (s: any, i: number, kind: string): Seg => {
    const file = fixPath(vids.get(s.material_id)?.path ?? "", p.draftDir!);
    return {
      id: `${kind}${i}`,
      start: s.target_timerange.start / US,
      dur: s.target_timerange.duration / US,
      src: s.source_timerange.start / US,
      scale: s.clip?.scale?.x ?? 1,
      file,
      label: path.basename(file).replace(/\.[^.]+$/, ""),
    };
  };
  const main = byName("main")?.segments ?? [];
  const broll = byName("B-roll")?.segments ?? [];
  // "Behind": graphics cut around the speaker (9:16 versions); baked into the proxy picture by preview.py
  const behind = byName("Behind")?.segments ?? [];
  const sfx: Sfx[] = [];
  for (const t of d.tracks.filter((t: any) => t.type === "audio")) {
    t.segments.forEach((s: any, i: number) => {
      const file = fixPath(auds.get(s.material_id)?.path ?? "", p.draftDir!);
      sfx.push({
        id: `${t.name || "audio"}#${i}`,
        track: t.name || "audio",
        start: s.target_timerange.start / US,
        dur: s.target_timerange.duration / US,
        src: s.source_timerange.start / US,
        volume: s.volume ?? 1,
        file,
        name: path.basename(file).replace(/\.[^.]+$/, ""),
      });
    });
  }
  // what the proxy picture depends on: cuts, punch-ins and the media behind them
  const pictureHash = crypto
    .createHash("sha1")
    .update(JSON.stringify([main, broll].map((ts) => ts.map((s: any) => [s.material_id, s.target_timerange, s.source_timerange, s.clip?.scale, s.common_keyframes]))))
    .update(JSON.stringify([...vids.values()].map((v) => v.path)))
    .update(extraPicture(d, [main, broll]))
    .update(behind.map((s: any) => {
      const f = fixPath(vids.get(s.material_id)?.path ?? "", p.draftDir!);
      return `${f}|${JSON.stringify(s.target_timerange)}|${fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0}`;
    }).join(";"))
    .digest("hex")
    .slice(0, 16);
  return {
    project: { id: p.id, name: p.name },
    duration: d.duration / US,
    fps: d.fps ?? 30,
    width: d.canvas_config?.width ?? 1920,
    height: d.canvas_config?.height ?? 1080,
    cuts: main.map((s: any, i: number) => seg(s, i, "cut")),
    broll: broll.map((s: any, i: number) => seg(s, i, "broll")),
    captions: p.overlaysDir ? readCaptions(p.overlaysDir) : [],
    sfx,
    hasOverlay: !!p.overlaysDir,
    pictureHash,
    draftMtime: fs.statSync(draftFile).mtimeMs,
  };
}

/** Canvas size and clip positions, hashed only when they differ from a plain 16:9 edit. */
function extraPicture(d: any, tracks: any[][]) {
  const c = d.canvas_config ?? {};
  const canvas = (c.width ?? 1920) !== 1920 || (c.height ?? 1080) !== 1080 ? `canvas ${c.width}x${c.height}` : "";
  const moved = tracks.flat().map((s: any) => s.clip?.transform).filter((t: any) => t && (t.x || t.y));
  return canvas + (moved.length ? JSON.stringify(moved) : "");
}

/** Caption groups straight from the composition HTML (ids g0, g1… are what the agent edits). */
function readCaptions(overlaysDir: string): CapGroup[] {
  const html = fs.readFileSync(path.join(overlaysDir, "index.html"), "utf8");
  const body = html.slice(html.indexOf("<body"), html.indexOf("<script>", html.indexOf("<body")));
  const parts = body.split(/(?=<div class="grp)/).slice(1);
  const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return parts.flatMap((chunk) => {
    const m = chunk.match(/id="(g\d+)" data-start="([\d.]+)" data-duration="([\d.]+)"/);
    if (!m) return [];
    const big = chunk.match(/class="big[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/);
    return [{ id: m[1], start: +m[2], dur: +m[3], text: strip(chunk), big: big ? strip(big[1]) : "" }];
  });
}

export function onScreen(m: EditModel, t: number) {
  const inSeg = (s: Seg) => t >= s.start && t < s.start + s.dur;
  return {
    cut: m.cuts.find(inSeg),
    broll: m.broll.find(inSeg),
    caption: m.captions.find((g) => t >= g.start && t < g.start + g.dur),
    sfx: m.sfx.filter((s) => Math.abs(s.start - t) < 0.5),
  };
}
