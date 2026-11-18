import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { SKILL_DIR } from "./config.ts";
import type { Project } from "./projects.ts";

/**
 * Cutting a stretch of time out of an edit without Claude: the words, a pause, or a range the person marked.
 * It is plain arithmetic on the edit's own files, so it takes a moment instead of minutes:
 *  - the CapCut draft: every track is closed up over the removed stretch (clips split or trimmed on the frame grid,
 *    everything later moves earlier);
 *  - the caption data (captions.json and the layout's times), then index.html is laid out again by the skill's
 *    build_captions.py;
 *  - the cut lists the skill keeps next to them (timeline.json, final_words.json).
 * The caller snapshots the files first (undo) and patches the preview afterwards (proxy.ts patchProxy).
 */

export type Word = { i: number; g: number; t: string; s: number; e: number };
export type Transcript = { words: Word[]; duration: number; fps: number; canCut: boolean; why?: string };
export type CutResult = { a: number; b: number; af: number; bf: number; fps: number; frames: number; duration: number; words: string[]; soundsDropped: number; soundsMoved: number };

export class CutError extends Error {}

const TRUSTED_BUILDER = path.join(SKILL_DIR, "assets/overlay-template/build_captions.py");
const sha = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
const writeJson = (f: string, v: unknown, indent?: number) => {
  fs.writeFileSync(f + ".tmp", JSON.stringify(v, null, indent));
  fs.renameSync(f + ".tmp", f);
};
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** Why this edit can't be cut directly, or null if it can. */
function blocker(p: Project): string | null {
  if (!p.draftDir) return "This edit isn't built yet.";
  if (!p.overlaysDir || !fs.existsSync(path.join(p.overlaysDir, "captions.json"))) return "This edit has no captions to read the words from.";
  const own = path.join(p.overlaysDir, "build_captions.py");
  // only the skill's own caption builder is ever run by the server (see exporter.ts relayCaptions)
  if (!fs.existsSync(TRUSTED_BUILDER) || !fs.existsSync(own) || sha(own) !== sha(TRUSTED_BUILDER))
    return "This edit's captions were built by an older or changed caption builder, so they can't be laid out again here. Ask Claude for the cut in a comment.";
  const words = captionWords(readJson(path.join(p.overlaysDir, "captions.json")));
  if (!words) return "This edit's caption data has no word end times (an older format). Ask Claude for the cut in a comment.";
  return null;
}

function captionWords(data: any): Word[] | null {
  const groups: any[] = Array.isArray(data?.groups) ? data.groups : [];
  const out: Word[] = [];
  for (const [g, grp] of groups.entries())
    for (const w of grp.words ?? []) {
      if (typeof w?.s !== "number" || typeof w?.e !== "number" || typeof w?.t !== "string") return null;
      out.push({ i: out.length, g, t: w.t, s: w.s, e: w.e });
    }
  return out;
}

/** The words of the edit as spoken on the current cut (what the captions are built from). */
export function transcript(p: Project): Transcript {
  let duration = 0, fps = 30;
  try {
    const d = readJson(path.join(p.draftDir!, "draft_info.json"));
    fps = d.fps ?? 30;
    duration = d.duration / 1e6;
  } catch {}
  let words: Word[] = [];
  try {
    words = captionWords(readJson(path.join(p.overlaysDir!, "captions.json"))) ?? [];
  } catch {}
  const why = blocker(p);
  return { words, duration, fps, canCut: !why, ...(why ? { why } : {}) };
}

/** Sounds are placed a moment before the word they go with (a caption's click lands ~30 ms early). */
const SOUND_LEAD = 0.05;

/**
 * Remove [a, b) seconds from the edit. Throws CutError (nothing useful written) when it can't; the caller restores
 * the snapshot on any error, so a failure part way never leaves the edit half cut.
 */
export function applyCut(p: Project, a0: number, b0: number): CutResult {
  const why = blocker(p);
  if (why) throw new CutError(why);
  if (spawnSync("pgrep", ["-x", "CapCut"]).status === 0) throw new CutError("CapCut is open on this Mac and would overwrite the cut. Quit CapCut, then cut again.");

  const draftFile = path.join(p.draftDir!, "draft_info.json");
  const d = readJson(draftFile);
  const fps: number = d.fps ?? 30;
  const us = (f: number) => Math.round((f * 1e6) / fps);
  const fr = (u: number) => Math.round((u * fps) / 1e6);
  const total = fr(d.duration);
  const af = Math.max(0, Math.round(a0 * fps)), bf = Math.min(total, Math.round(b0 * fps));
  const n = bf - af;
  if (!(n >= 1)) throw new CutError("That is shorter than one frame: nothing to cut.");
  if (total - n < fps) throw new CutError("That would leave less than a second of video.");
  const a = af / fps, b = bf / fps, len = n / fps;
  const usA = us(af), usB = us(bf), delta = usB - usA;
  /** a time on the old timeline -> the same moment after the cut */
  const tm = (t: number) => (t <= a ? t : t < b ? a : t - len);

  // ---- captions.json: which words go, and where the rest land ----
  const capFile = path.join(p.overlaysDir!, "captions.json");
  const cap = readJson(capFile);
  const gone: string[] = [];
  const groupMap = new Map<number, number>(); // old group index -> new
  const groups: any[] = [];
  for (const [gi, g] of (cap.groups as any[]).entries()) {
    const words = (g.words as any[]).filter((w) => {
      const mid = (w.s + w.e) / 2;
      if (mid >= a && mid < b) return gone.push(w.t), false;
      return true;
    });
    if (!words.length) continue;
    for (const w of words) {
      w.s = r3(tm(w.s));
      w.e = r3(Math.max(tm(w.e), w.s + 0.02));
    }
    const start = r3(tm(g.start)), end = r3(Math.max(tm(g.end), start + 0.1));
    groupMap.set(gi, groups.length);
    groups.push({ ...g, words, ...(g.first != null ? { first: words[0].s } : {}), ...(g.last_end != null ? { last_end: words[words.length - 1].e } : {}), start, end });
  }
  cap.groups = groups;
  if (typeof cap.duration === "number") cap.duration = r3((total - n) / fps);

  // ---- the draft: close every track up over the removed stretch ----
  const materialLists: any[][] = Object.values(d.materials ?? {}).filter(Array.isArray) as any[][];
  const newId = () => crypto.randomUUID().toUpperCase();
  /** The second half of a split clip: its own id, and its own copies of the per-clip materials (speed, canvas…). */
  const twin = (s: any) => {
    const t = structuredClone(s);
    t.id = newId();
    t.extra_material_refs = (s.extra_material_refs ?? []).map((ref: string) => {
      for (const list of materialLists) {
        const m = list.find((x) => x?.id === ref);
        if (m) {
          const copy = { ...structuredClone(m), id: newId() };
          list.push(copy);
          return copy.id;
        }
      }
      return ref;
    });
    return t;
  };
  let soundsDropped = 0, soundsMoved = 0;
  for (const t of d.tracks as any[]) {
    const out: any[] = [];
    // the captions clip is one render of the whole composition: it just gets shorter (Export re-renders it)
    const wholeCaptions = t.type === "video" && t.name === "Captions" && t.segments.length === 1;
    for (const s of t.segments as any[]) {
      const tr = s.target_timerange, src = s.source_timerange;
      const speed = s.speed || 1;
      if (wholeCaptions) {
        tr.duration = us(total - n) - tr.start;
        if (src) src.duration = tr.duration;
        out.push(s);
        continue;
      }
      if (t.type === "audio") {
        // a sound belongs to the moment it starts on
        const at = tr.start / 1e6 + SOUND_LEAD;
        if (at >= b) tr.start = Math.max(0, tr.start - delta);
        else if (at >= a) {
          if (gone.length) {
            soundsDropped++; // it went with the words that were cut
            continue;
          }
          if (tr.start > usA) soundsMoved++;
          tr.start = Math.min(tr.start, usA);
        }
        out.push(s);
        continue;
      }
      const s0 = tr.start, sf = fr(s0), ef = fr(s0 + tr.duration);
      if (ef <= af) {
        out.push(s);
      } else if (sf >= bf) {
        tr.start = us(sf - n);
        tr.duration = us(ef - n) - tr.start;
        if (src) src.duration = Math.round(tr.duration * speed); // the frame grid can move a length by a microsecond
        out.push(s);
      } else {
        const head = sf < af, tail = ef > bf;
        if ((head || tail) && (s.common_keyframes?.length || s.keyframe_refs?.length))
          throw new CutError("This cut goes through a clip with a moving zoom, which can't be split here. Ask Claude for the cut in a comment.");
        if (head && tail) {
          const second = twin(s);
          tr.duration = usA - s0;
          if (src) src.duration = Math.round(tr.duration * speed);
          const tr2 = second.target_timerange, src2 = second.source_timerange;
          tr2.start = usA;
          tr2.duration = us(ef - n) - usA;
          if (src2) {
            src2.start = src.start + Math.round((usB - s0) * speed);
            src2.duration = Math.round(tr2.duration * speed);
          }
          out.push(s, second);
        } else if (head) {
          tr.duration = usA - s0;
          if (src) src.duration = Math.round(tr.duration * speed);
          out.push(s);
        } else if (tail) {
          if (src) src.start += Math.round((usB - s0) * speed);
          tr.start = usA;
          tr.duration = us(ef - n) - usA;
          if (src) src.duration = Math.round(tr.duration * speed);
          out.push(s);
        } // else: the whole clip sat inside the removed stretch
      }
    }
    t.segments = out;
  }
  d.duration = us(total - n);

  // ---- the caption layout's own times, and the group numbers it names ----
  const spans = (list: any) =>
    (Array.isArray(list) ? list : [])
      .map((x: any) => [r4(tm(x[0])), r4(tm(x[1]))])
      .filter((x: number[]) => x[1] - x[0] > 0.02);
  const layoutFile = path.join(p.overlaysDir!, "caption_layout.json");
  let layout: any = null;
  if (fs.existsSync(layoutFile)) {
    layout = readJson(layoutFile);
    if (layout.hook?.until != null) layout.hook.until = r4(tm(layout.hook.until));
    for (const k of ["split_spans", "title_spans"]) if (Array.isArray(layout[k])) layout[k] = spans(layout[k]);
    if (Array.isArray(layout.below_mouth?.groups))
      layout.below_mouth.groups = layout.below_mouth.groups.map((g: number) => groupMap.get(g)).filter((g: number | undefined) => g != null);
  }
  const brollFile = path.join(p.overlaysDir!, "broll_spans.json");
  const broll = fs.existsSync(brollFile) ? spans(readJson(brollFile)) : null;

  // ---- the lists the skill keeps of the cut and its words: kept in step, so a later rebuild starts from the truth ----
  const side: [string, unknown][] = [];
  for (const f of [path.join(p.overlaysDir!, "timeline.json"), path.join(p.editDir, "edit-data", "timeline.json")]) {
    const v = safeJson(f);
    if (Array.isArray(v) && v.length && v.every((x) => typeof x?.start === "number" && typeof x?.dur === "number")) side.push([f, cutList(v, a, b)]);
  }
  for (const f of [path.join(p.overlaysDir!, "final_words.json"), path.join(p.editDir, "edit-data", "final_words.json")]) {
    const v = safeJson(f);
    if (Array.isArray(v) && v.length && v.every((x) => typeof x?.s === "number" && typeof x?.e === "number"))
      side.push([f, v.filter((w) => !((w.s + w.e) / 2 >= a && (w.s + w.e) / 2 < b)).map((w) => ({ ...w, s: r3(tm(w.s)), e: r3(Math.max(tm(w.e), tm(w.s) + 0.02)) }))]);
  }

  // ---- write, then lay the captions out again from the new draft ----
  writeJson(draftFile, d);
  writeJson(capFile, cap);
  if (layout) writeJson(layoutFile, layout);
  if (broll) writeJson(brollFile, broll);
  for (const [f, v] of side) writeJson(f, v);
  const r = spawnSync("python3", ["-I", TRUSTED_BUILDER, p.overlaysDir!], { cwd: os.tmpdir(), encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) {
    const msg = `${r.stderr ?? ""}${r.stdout ?? ""}`.trim().split("\n").slice(-2).join(" ") || String(r.error ?? "unknown error");
    throw new CutError(`The captions could not be laid out after this cut (${msg.slice(0, 300)}). Nothing was changed.`);
  }
  return { a, b, af, bf, fps, frames: total - n, duration: (total - n) / fps, words: gone, soundsDropped, soundsMoved };
}

const safeJson = (f: string) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};

/** A list of cuts ({start, dur, src} in seconds) with [a, b) removed. */
function cutList(list: any[], a: number, b: number): any[] {
  const len = b - a;
  const out: any[] = [];
  for (const x of list) {
    const s = x.start, e = x.start + x.dur;
    const hasSrc = typeof x.src === "number";
    if (e <= a + 1e-4) out.push(x);
    else if (s >= b - 1e-4) out.push({ ...x, start: r4(s - len) });
    else {
      if (s < a - 1e-4) out.push({ ...x, dur: r4(a - s) });
      if (e > b + 1e-4) out.push({ ...x, start: r4(a), dur: r4(e - b), ...(hasSrc ? { src: r4(x.src + (b - s)) } : {}) });
    }
  }
  return out;
}
