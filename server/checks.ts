import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { draftMediaFiles, readModel, type EditModel, type Project } from "./projects.ts";
import { proxyFile, proxyState } from "./proxy.ts";
import { STAGE_CONFIG, isStage, stageWords } from "./cut.ts";
import { isCaptionRender } from "./exporter.ts";

/**
 * Checks: Edit Room watches and listens to the preview so the person doesn't have to find the same faults by hand
 * every time (a leftover pause, captions off the speech, a word the cut clipped, a colour jump between two cuts).
 * No Claude: ffmpeg measures the preview, and one Whisper pass listens to the voice. Two passes:
 *  - quick (a few seconds, after every change): missing media, timeline faults, pauses, colour jumps, black frames;
 *  - listening (Whisper, when the edit has been still for a moment): words said but not captioned, captioned but not
 *    said, and captions that run early or late.
 * Every finding is a place to look, with the time; the app offers "Cut" for a pause and "Ask Claude" for the rest.
 */

export type Issue = {
  /** stable while the thing stays where it is: kind + time */
  id: string;
  kind: "media" | "timeline" | "pause" | "colour" | "black" | "sync" | "extra" | "missing";
  /** fix = the export would be wrong; look = worth a look */
  level: "fix" | "look";
  t: number;
  end?: number;
  title: string;
  detail?: string;
  /** a pause: the stretch a direct cut would remove */
  cut?: { a: number; b: number };
  /** what to ask Claude, when a person can't fix it with a cut */
  ask?: string;
};
export type Checks = {
  status: "none" | "running" | "ready" | "failed";
  /** the listening pass: done, still going, or why not */
  listened: "yes" | "running" | "waiting" | "unavailable" | "failed";
  listenNote?: string;
  at?: number;
  issues: Issue[];
  /** issues the person marked as fine (still listed, greyed) */
  ok: string[];
  error?: string;
};

// ---- limits, set from the user's finished edits (1110, 1114b, 1116b, 1116n: none has a silence over 0.42 s) ----
const PAUSE_SEC = 0.45;
// dead air before the first word or after the last. 1119: the user flagged 0.07 s at the start ("always start with
// video straightaway") and a 0.37 s tail ("cut it out right after I say learn")
const PAUSE_HEAD_SEC = 0.06;
const PAUSE_TAIL_SEC = 0.2;
const SILENT_DB = 30; // this far under the voice's loud level counts as silence
const COLOUR_Y = 7, COLOUR_C = 3.5; // jump in brightness / colour (8-bit) across a join in the same shot
const SYNC_SEC = 0.3, SYNC_RUN = 3; // captions this far off the speech, for this many words in a row
const HOLE_SEC = 1.5; // a gap this long in the captions is a card's hidden lines, not a pause
const LISTEN_QUIET_MS = 6000; // listen once the edit has been still this long (cuts come in bursts)

const file = (p: Project) => path.join(p.dataDir, "checks.json");
const okFile = (p: Project) => path.join(p.dataDir, "checks-ok.json");
const sha = (s: string | Buffer) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
const read = (f: string) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};

type Saved = { key: string; listenKey?: string; at: number; quick: Issue[]; heard: Issue[] | null; listenNote?: string; listenFailed?: boolean; unavailable?: boolean; error?: string };
const running = new Set<string>();
const listening = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listens = new Map<string, Promise<void>>();
const waiters = new Map<string, (() => void)[]>();

/** What the checks were made from: the preview, the draft and the captions. */
function keyOf(p: Project): string | null {
  try {
    const st = fs.statSync(proxyFile(p));
    const draft = fs.readFileSync(path.join(p.draftDir!, "draft_info.json"));
    const capFile = p.overlaysDir && [STAGE_CONFIG, "captions.json"].map((n) => path.join(p.overlaysDir!, n)).find((f) => fs.existsSync(f));
    // a stage edit's words live in their own file: a cut changes it, so the checks are made again
    const cap = capFile ? fs.readFileSync(capFile) + (isStage(p) ? (() => { try { return fs.readFileSync(stageWords(p).file, "utf8"); } catch { return ""; } })() : "") : "";
    return sha(`${st.size}|${st.mtimeMs}|${sha(draft)}|${sha(cap)}`);
  } catch {
    return null;
  }
}

export function checksState(p: Project): Checks {
  const s: Saved | null = read(file(p));
  const ok: string[] = read(okFile(p)) ?? [];
  const key = p.draftDir ? keyOf(p) : null;
  const fresh = !!s && s.key === key;
  if (running.has(p.id) || (!fresh && key && proxyState(p).status === "ready")) return { status: "running", listened: "waiting", issues: fresh ? s!.quick : [], ok };
  if (!s || !fresh) return { status: "none", listened: "waiting", issues: [], ok };
  if (s.error) return { status: "failed", listened: "failed", issues: [], ok, error: s.error };
  const heardFresh = s.listenKey === key && s.heard != null;
  const listened = heardFresh ? "yes" : s.unavailable ? "unavailable" : s.listenFailed && s.listenKey === key ? "failed" : listening.has(p.id) ? "running" : "waiting";
  const issues = [...s.quick, ...(heardFresh ? s.heard! : [])].sort((a, b) => (a.level === b.level ? a.t - b.t : a.level === "fix" ? -1 : 1));
  return { status: "ready", listened, listenNote: s.listenNote, at: s.at, issues, ok: ok.filter((id) => issues.some((i) => i.id === id)) };
}

export function setOk(p: Project, id: string, on: boolean) {
  const cur: string[] = read(okFile(p)) ?? [];
  const next = on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id);
  fs.writeFileSync(okFile(p), JSON.stringify(next.slice(-400)));
}

/**
 * Check the edit if anything changed since the last check (cheap to call often). `now` listens right away instead
 * of waiting for the edit to be still. Resolves when both passes are done (or can't run).
 */
export function scheduleChecks(p: Project, onChange: () => void, now = false): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      resolve();
    };
    if (!p.draftDir || proxyState(p).status !== "ready") return done();
    const key = keyOf(p);
    const s: Saved | null = read(file(p));
    if (!key) return done();
    const quickFresh = s?.key === key; // a failed check is not tried again until the edit changes
    const heardDone = quickFresh && (!!s!.error || s!.listenKey === key || s!.unavailable);
    if (heardDone) return done();
    (waiters.get(p.id) ?? waiters.set(p.id, []).get(p.id)!).push(done);
    const finish = () => {
      for (const w of waiters.get(p.id) ?? []) w();
      waiters.delete(p.id);
    };
    // `restart`: the edit just changed, so the wait starts over; a mere look at the checks must not postpone it
    const listenSoon = (restart = false) => {
      const going = listens.get(p.id);
      if (going) return void going.finally(finish); // already listening: wait for that pass
      if (timers.has(p.id) && !restart && !now) return;
      clearTimeout(timers.get(p.id));
      timers.set(p.id, setTimeout(() => {
        timers.delete(p.id);
        const pass = listen(p, onChange).finally(() => listens.delete(p.id));
        listens.set(p.id, pass);
        pass.finally(finish);
      }, now ? 0 : LISTEN_QUIET_MS));
    };
    if (quickFresh) return listenSoon();
    if (running.has(p.id)) return;
    running.add(p.id);
    onChange();
    quick(p, key)
      .then((issues) => fs.writeFileSync(file(p), JSON.stringify({ key, at: Date.now(), quick: issues, heard: null, unavailable: s?.unavailable } satisfies Saved)))
      .catch((e) => fs.writeFileSync(file(p), JSON.stringify({ key, at: Date.now(), quick: [], heard: null, error: String(e?.message ?? e).slice(0, 300) } satisfies Saved)))
      .finally(() => {
        running.delete(p.id);
        onChange();
        // the edit may have changed while this ran: check that one too, else listen
        if (keyOf(p) !== key) scheduleChecks(p, onChange, now).finally(finish);
        else listenSoon(true);
      });
  });
}

function run(cmd: string, args: string[], opts: { timeout?: number } = {}): Promise<{ code: number | null; out: Buffer; err: string }> {
  return new Promise((resolve) => {
    const ch = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    const timer = opts.timeout ? setTimeout(() => ch.kill("SIGKILL"), opts.timeout) : null;
    ch.stdout.on("data", (b) => out.push(b));
    ch.stderr.on("data", (b) => (err = (err + b).slice(-2000)));
    ch.on("error", (e) => resolve({ code: -1, out: Buffer.concat(out), err: String(e) }));
    ch.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, out: Buffer.concat(out), err });
    });
  });
}

const secs = (n: number) => `${n.toFixed(2)} s`;
const clock = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const idOf = (kind: string, t: number) => `${kind}@${t.toFixed(1)}`;

// ---- the quick pass ----

/** The voice's loudness every 20 ms, in dB. */
async function envelope(proxy: string): Promise<number[]> {
  const r = await run("ffmpeg", ["-nostdin", "-v", "error", "-i", proxy, "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-"]);
  if (r.code !== 0) throw new Error(`could not read the preview's sound: ${r.err.slice(-200)}`);
  const n = Math.floor(r.out.length / 2), W = 320;
  const env: number[] = [];
  for (let i = 0; i + W <= n; i += W) {
    let sum = 0;
    for (let k = i; k < i + W; k++) {
      const v = r.out.readInt16LE(k * 2) / 32768;
      sum += v * v;
    }
    env.push(10 * Math.log10(sum / W + 1e-10));
  }
  return env;
}

/** Average brightness and colour of every frame (Y, U, V in 8-bit), from a small copy of the picture. */
async function frameStats(proxy: string): Promise<[number, number, number][]> {
  const r = await run("ffmpeg", ["-nostdin", "-v", "error", "-reinit_filter", "0", "-i", proxy, "-an", "-vf", "scale=96:-2,signalstats,metadata=print:file=-", "-f", "null", "-"]);
  const out: [number, number, number][] = [];
  let cur: [number, number, number] = [0, 0, 0];
  for (const line of r.out.toString().split("\n")) {
    const m = /lavfi\.signalstats\.([YUV])AVG=([\d.]+)/.exec(line);
    if (!m) continue;
    cur["YUV".indexOf(m[1])] = +m[2];
    if (m[1] === "V") out.push(cur), (cur = [0, 0, 0]);
  }
  return out;
}

function structure(p: Project, m: EditModel): Issue[] {
  const out: Issue[] = [];
  // media the export reads: a missing file fails the export (captions.mov is re-rendered, so it doesn't count)
  const missing = [...new Set(draftMediaFiles(p.draftDir!).filter((f) => f && !isCaptionRender(f) && !fs.existsSync(f)))];
  const used = new Set([...m.cuts, ...m.broll].map((s) => s.file).concat(m.sfx.map((s) => s.file)));
  const needed = missing.filter((f) => used.has(f));
  if (needed.length)
    out.push({
      id: idOf("media", needed.length), kind: "media", level: "fix", t: 0,
      title: `${needed.length} media file${needed.length > 1 ? "s are" : " is"} missing`,
      detail: `Export and a picture rebuild need ${needed.length > 1 ? "them" : "it"}: ${needed.slice(0, 3).map((f) => path.basename(f)).join(", ")}${needed.length > 3 ? ` and ${needed.length - 3} more` : ""}.`,
      ask: `These media files the draft uses are missing: ${needed.map((f) => path.basename(f)).join(", ")}. Make them again (grade the A-roll, re-render the cards) so the edit can export.`,
    });
  // the main track must run from 0 to the end with no hole
  let at = 0;
  for (const c of m.cuts) {
    if (Math.abs(c.start - at) > 0.5 / m.fps) {
      out.push({ id: idOf("timeline", at), kind: "timeline", level: "fix", t: at, title: `A hole in the picture at ${clock(at)}`, detail: `Nothing is on the main track for ${secs(Math.abs(c.start - at))}.`, ask: `The main track has a gap at ${at.toFixed(2)} s. Close it so every cut sits on the frame grid and the track reaches the end.` });
      break;
    }
    at = c.start + c.dur;
  }
  if (m.cuts.length && Math.abs(at - m.duration) > 0.5 / m.fps && !out.some((i) => i.kind === "timeline"))
    out.push({ id: idOf("timeline", at), kind: "timeline", level: "fix", t: at, title: "The picture ends before the video does", detail: `The last cut ends at ${clock(at)}, the video at ${clock(m.duration)}.`, ask: `The main track ends at ${at.toFixed(2)} s but the draft is ${m.duration.toFixed(2)} s long. Make them match.` });
  return out;
}

function pauses(env: number[], words: { s: number; e: number }[], duration: number): Issue[] {
  const sorted = [...env].sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.95)] ?? -20;
  const out: Issue[] = [];
  const firstWord = words[0]?.s ?? null, lastWord = words.at(-1)?.e ?? null;
  let runStart = -1;
  for (let i = 0; i <= env.length; i++) {
    const quiet = i < env.length && env[i] < loud - SILENT_DB;
    if (quiet && runStart < 0) runStart = i;
    if (!quiet && runStart >= 0) {
      const s = runStart * 0.02, e = Math.min(i * 0.02, duration);
      runStart = -1;
      const head = s < 0.05, tail = e > duration - 0.05;
      const len = e - s;
      if (len < (head ? PAUSE_HEAD_SEC : tail ? PAUSE_TAIL_SEC : PAUSE_SEC)) continue;
      // keep a breath on each side inside the video; at the very start keep one frame, at the end 0.1 s after the word
      const a = head ? 0 : tail ? s + 0.1 : s + 0.08, b = tail ? duration : head ? e - 0.03 : e - 0.08;
      if (b - a < (head || tail ? 0.03 : 0.1)) continue;
      out.push({
        id: idOf("pause", s), kind: "pause", level: "look", t: s, end: e,
        title: head ? `${secs(len)} of silence before the first word` : tail ? `${secs(len)} of silence at the end` : `A ${secs(len)} pause at ${clock(s)}`,
        detail: head || tail ? undefined : "Your finished edits have no pause over 0.42 s.",
        cut: { a, b },
      });
    }
  }
  void firstWord, void lastWord;
  return out;
}

/** Where anything other than the A-roll starts or stops (cards, wall titles, boards behind the speaker). */
function overlayEdges(p: Project): number[] {
  const d = read(path.join(p.draftDir!, "draft_info.json"));
  const out: number[] = [];
  for (const t of d?.tracks ?? []) {
    if (t.type !== "video" || !t.name || t.name === "Captions") continue; // the main track has no name
    for (const s of t.segments ?? []) out.push(s.target_timerange.start / 1e6, (s.target_timerange.start + s.target_timerange.duration) / 1e6);
  }
  return out;
}

function colour(stats: [number, number, number][], m: EditModel, edges: number[]): Issue[] {
  const out: Issue[] = [];
  const fps = m.fps;
  // a graphic that comes or goes at the join changes the picture on purpose
  const covered = (t: number) => m.broll.some((b) => t >= b.start - 0.001 && t < b.start + b.dur) || edges.some((e) => Math.abs(e - t) < 0.25);
  const mean = (from: number, to: number) => {
    const rows = stats.slice(Math.max(0, from), Math.max(0, to));
    if (rows.length < 2) return null;
    return [0, 1, 2].map((k) => rows.reduce((s, r) => s + r[k], 0) / rows.length);
  };
  for (let i = 1; i < m.cuts.length; i++) {
    const a = m.cuts[i - 1], b = m.cuts[i];
    const t = b.start;
    // only where the speaker is on screen on both sides, in the same shot (same file, same punch-in)
    if (covered(t - 0.1) || covered(t + 0.1) || a.file !== b.file) continue;
    const f = Math.round(t * fps);
    const before = mean(f - 4, f - 1), after = mean(f + 1, f + 4);
    if (!before || !after) continue;
    const dy = after[0] - before[0], dc = Math.max(Math.abs(after[1] - before[1]), Math.abs(after[2] - before[2]));
    // a punch-in reframes the shot, which moves the averages a little on its own
    const zoomed = Math.abs(a.scale - b.scale) > 0.01;
    const k = zoomed ? 1.6 : 1;
    if (Math.abs(dy) < COLOUR_Y * k && dc < COLOUR_C * k) continue;
    out.push({
      id: idOf("colour", t), kind: "colour", level: "look", t: Math.max(0, t - 0.5), end: t + 0.5,
      title: `The picture ${Math.abs(dy) >= COLOUR_Y * k ? (dy > 0 ? "gets brighter" : "gets darker") : "changes colour"} at the cut at ${clock(t)}`,
      detail: `Brightness ${dy > 0 ? "+" : ""}${dy.toFixed(0)}, colour ${dc.toFixed(1)} (of 255) between ${a.id} and ${b.id}.`,
      ask: `The colour jumps at the cut at ${t.toFixed(2)} s (between ${a.id} and ${b.id}): brightness ${dy.toFixed(0)}, colour ${dc.toFixed(1)} of 255. Match the grade of the two cuts so the join is invisible.`,
    });
  }
  // black frames
  let start = -1;
  for (let i = 0; i <= stats.length; i++) {
    const dark = i < stats.length && stats[i][0] < 18;
    if (dark && start < 0) start = i;
    if (!dark && start >= 0) {
      if (i - start >= 2) {
        const t = start / fps;
        out.push({ id: idOf("black", t), kind: "black", level: "fix", t, end: i / fps, title: `${i - start} black frames at ${clock(t)}`, ask: `The picture is black for ${i - start} frames at ${t.toFixed(2)} s. Find what is missing there and fix it.` });
      }
      start = -1;
    }
  }
  return out;
}

type CapWord = { t: string; s: number; e: number };
function captionWords(p: Project): CapWord[] {
  if (isStage(p))
    try {
      return stageWords(p).words.map((w) => ({ t: w.t, s: w.s, e: w.e }));
    } catch {
      return [];
    }
  const cap = p.overlaysDir ? read(path.join(p.overlaysDir, "captions.json")) : null;
  const out: CapWord[] = [];
  for (const g of cap?.groups ?? []) for (const w of g.words ?? []) if (typeof w?.s === "number" && typeof w?.t === "string") out.push({ t: w.t, s: w.s, e: typeof w.e === "number" ? w.e : w.s + 0.2 });
  return out;
}

export async function quick(p: Project, _key = ""): Promise<Issue[]> {
  const m = readModel(p);
  const [env, stats] = await Promise.all([envelope(proxyFile(p)), frameStats(proxyFile(p))]);
  return [...structure(p, m), ...pauses(env, captionWords(p), m.duration), ...colour(stats, m, overlayEdges(p))];
}

/** For tuning: the raw numbers behind the colour check at every join. */
export async function colourNumbers(p: Project) {
  const m = readModel(p);
  const stats = await frameStats(proxyFile(p));
  return { issues: colour(stats, m, overlayEdges(p)), frames: stats.length, joins: m.cuts.length - 1 };
}

// ---- the listening pass ----

const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, "");
function near(a: string, b: string) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (Math.abs(a.length - b.length) > 2) return false;
  // small edit distance: "claude"/"cloud", "mods"/"mod", a dropped "s"
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length] <= (Math.max(a.length, b.length) >= 6 ? 2 : 1);
}

/** Line the heard words up with the caption words (longest common run of near-equal words). */
function align(cap: CapWord[], heard: { w: string; s: number; e: number }[]) {
  const A = cap.map((w) => norm(w.t)), B = heard.map((w) => norm(w.w));
  const n = A.length, mm = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(mm + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = mm - 1; j >= 0; j--) L[i][j] = near(A[i], B[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const pairs: [number, number][] = [], onlyCap: number[] = [], onlyHeard: number[] = [];
  let i = 0, j = 0;
  while (i < n && j < mm) {
    if (near(A[i], B[j])) pairs.push([i++, j++]);
    else if (L[i + 1][j] >= L[i][j + 1]) onlyCap.push(i++);
    else onlyHeard.push(j++);
  }
  while (i < n) onlyCap.push(i++);
  while (j < mm) onlyHeard.push(j++);
  return { pairs, onlyCap, onlyHeard };
}

/** Whisper splits a number ("41", ".3", "%"; "5", ".2"): join the pieces back into one word, as the captions write it. */
function joinNumbers(heard: { w: string; s: number; e: number }[]) {
  const out: { w: string; s: number; e: number }[] = [];
  for (const h of heard) {
    const w = h.w.trim(), prev = out.at(-1);
    if (prev && /\d[.%]?$/.test(prev.w.trim()) && /^(\.\d+%?[.,?!]?|%[.,?!]?)$/.test(w)) prev.w = prev.w.trim() + w, (prev.e = h.e);
    else out.push({ ...h });
  }
  return out;
}

export function compare(cap: CapWord[], heard0: { w: string; s: number; e: number }[]): Issue[] {
  const out: Issue[] = [];
  const heard = joinNumbers(heard0);
  if (!cap.length || !heard.length) return out;
  const { pairs, onlyCap, onlyHeard } = align(cap, heard);
  // a caption word and a heard word left over side by side are one word heard differently, not two faults
  const capLeft = new Set(onlyCap), heardLeft = new Set(onlyHeard);
  for (const ci of onlyCap) {
    const hj = onlyHeard.find((j) => heardLeft.has(j) && Math.abs(heard[j].s - cap[ci].s) < 0.5);
    if (hj != null) capLeft.delete(ci), heardLeft.delete(hj);
  }
  const groupRuns = (idx: number[]) => {
    const runs: number[][] = [];
    for (const k of idx.sort((a, b) => a - b)) (runs.at(-1)?.at(-1) === k - 1 ? runs.at(-1)! : runs[runs.push([]) - 1]).push(k);
    return runs;
  };
  // stretches the captions leave out on purpose (lines shown as a card): what is said there is not a fault
  const holes: [number, number][] = [];
  for (let i = 0; i <= cap.length; i++) {
    const a = i ? cap[i - 1].e : 0, b = i < cap.length ? cap[i].s : Infinity;
    if (b - a >= HOLE_SEC) holes.push([a - 0.6, b + 0.6]);
  }
  /** one small word alone ("a", "but", ".5") is how Whisper differs from itself between two passes, not a finding */
  const slight = (words: string[]) => words.length === 1 && (norm(words[0]).length <= 3 || /^\d+$/.test(norm(words[0])));
  for (const r of groupRuns([...heardLeft])) {
    const ws = r.map((j) => heard[j]);
    const mid = (ws[0].s + ws.at(-1)!.e) / 2;
    if (holes.some(([a, b]) => mid > a && mid < b) || slight(ws.map((w) => w.w))) continue;
    const said = ws.map((w) => w.w).join(" ");
    out.push({
      id: idOf("extra", ws[0].s), kind: "extra", level: "look", t: Math.max(0, ws[0].s - 0.6), end: ws.at(-1)!.e,
      title: `“${said.slice(0, 60)}” is said at ${clock(ws[0].s)} but isn't in the captions`,
      detail: "A repeat or a stray word left in the cut, or a caption that is missing. Listen first: Whisper can mishear.",
      cut: { a: ws[0].s, b: ws.at(-1)!.e },
      ask: `At ${ws[0].s.toFixed(2)} s the voice says "${said}" but the captions don't have it. Listen there: if it is a repeat or a stray word, cut it out cleanly; if it belongs, add it to the captions.`,
    });
  }
  for (const r of groupRuns([...capLeft])) {
    const ws = r.map((i) => cap[i]);
    if (slight(ws.map((w) => w.t))) continue;
    const text = ws.map((w) => w.t).join(" ");
    out.push({
      id: idOf("missing", ws[0].s), kind: "missing", level: "look", t: Math.max(0, ws[0].s - 0.6), end: ws.at(-1)!.e,
      title: `The captions say “${text.slice(0, 60)}” at ${clock(ws[0].s)} but it isn't heard`,
      detail: "A cut may have clipped the word, or the caption is left over. Listen first: Whisper can miss a word.",
      ask: `At ${ws[0].s.toFixed(2)} s the captions show "${text}" but the voice doesn't seem to say it. Listen there: if a cut clipped the word, give it back from the footage; if the words are gone on purpose, remove them from the captions.`,
    });
  }
  // captions early or late: a run of matched words all off the same way
  let run: [number, number][] = [];
  const flush = () => {
    if (run.length >= SYNC_RUN) {
      const offs = run.map(([i, j]) => cap[i].s - heard[j].s).sort((a, b) => a - b);
      const off = offs[Math.floor(offs.length / 2)];
      const t = cap[run[0][0]].s, end = cap[run.at(-1)![0]].e;
      out.push({
        id: idOf("sync", t), kind: "sync", level: "fix", t: Math.max(0, t - 0.5), end,
        title: `Captions run ${secs(Math.abs(off))} ${off > 0 ? "late" : "early"} from ${clock(t)} to ${clock(end)}`,
        detail: `${run.length} words in a row, from “${cap[run[0][0]].t}” to “${cap[run.at(-1)![0]].t}”.`,
        ask: `The captions run about ${Math.abs(off).toFixed(2)} s ${off > 0 ? "late" : "early"} against the voice from ${t.toFixed(2)} s to ${end.toFixed(2)} s (${run.length} words). Re-time the caption words there to the speech on the current cut.`,
      });
    }
    run = [];
  };
  let sign = 0;
  for (const [i, j] of pairs) {
    const off = cap[i].s - heard[j].s;
    const s = Math.abs(off) >= SYNC_SEC ? Math.sign(off) : 0;
    if (s === 0 || (sign !== 0 && s !== sign)) flush();
    if (s !== 0) run.push([i, j]);
    sign = s;
  }
  flush();
  return out;
}

async function listen(p: Project, onChange: () => void): Promise<void> {
  const key = keyOf(p);
  const s: Saved | null = read(file(p));
  if (!key || !s || s.key !== key || s.listenKey === key || listening.has(p.id)) return;
  const cap = captionWords(p);
  const save = (patch: Partial<Saved>) => {
    const cur: Saved | null = read(file(p));
    if (cur?.key === key) fs.writeFileSync(file(p), JSON.stringify({ ...cur, ...patch }));
  };
  if (!cap.length) return save({ listenKey: key, heard: [], listenNote: "No captions to compare the voice with." });
  listening.add(p.id);
  onChange();
  const wav = path.join(os.tmpdir(), `edit-room-listen-${p.id}-${process.pid}.wav`);
  try {
    const a = await run("ffmpeg", ["-nostdin", "-v", "error", "-y", "-i", proxyFile(p), "-vn", "-ac", "1", "-ar", "16000", wav]);
    if (a.code !== 0) throw new Error(a.err.slice(-200));
    // the edit's own names, so they are heard the way the captions spell them
    const names = [...new Set(cap.map((w) => w.t.replace(/[^\w']/g, "")).filter((t, i) => /^[A-Z]/.test(t) && t.length > 2 && i > 0))].slice(0, 30).join(", ");
    const r = await run("python3", ["-I", path.resolve(import.meta.dirname, "listen.py"), wav, names], { timeout: 5 * 60_000 });
    const res = read2(r.out.toString());
    if (r.code === 3) return save({ unavailable: true, listenNote: "The listening check needs Whisper (pip install openai-whisper)." });
    if (r.code !== 0 || !res?.words) throw new Error(res?.error ?? r.err.slice(-200));
    if (keyOf(p) !== key) return; // the edit moved on while it listened
    save({ listenKey: key, heard: compare(cap, res.words), listenFailed: false, unavailable: false, listenNote: undefined });
  } catch (e: any) {
    save({ listenKey: key, heard: null, listenFailed: true, listenNote: `The listening check failed: ${String(e?.message ?? e).slice(0, 160)}` });
  } finally {
    fs.rmSync(wav, { force: true });
    listening.delete(p.id);
    onChange();
  }
}
const read2 = (s: string) => {
  try {
    return JSON.parse(s.trim().split("\n").pop() ?? "");
  } catch {
    return null;
  }
};

/** The checks as a few plain lines, for Claude (the room_check tool). */
export function checksText(c: Checks): string {
  const open = c.issues.filter((i) => !c.ok.includes(i.id));
  const heard = c.listened === "yes" ? "" : `\n(The listening check did not run: ${c.listenNote ?? c.listened}.)`;
  if (c.status !== "ready") return `The checks could not run (${c.error ?? c.status}).`;
  if (!open.length) return `Nothing found: no long pauses, colour jumps, black frames or missing media${c.listened === "yes" ? ", and the captions match the voice" : ""}.${heard}`;
  return `${open.length} thing${open.length > 1 ? "s" : ""} to look at:\n${open.map((i) => `- [${i.level}] ${i.title}${i.detail ? ` (${i.detail})` : ""}`).join("\n")}${heard}`;
}
