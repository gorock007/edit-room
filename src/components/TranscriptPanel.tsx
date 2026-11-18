import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { EditModel, Transcript, Word } from "../types";
import { cx, fmt } from "../util";
import { Kbd } from "./CommentsPanel";

type Props = {
  pid: string;
  model: EditModel;
  time: number;
  playing: boolean;
  canEdit: boolean;
  /** Claude is changing the edit: cuts wait */
  busy: boolean;
  /** changes whenever the edit's words may have changed */
  stamp: string;
  full?: boolean;
  header?: React.ReactNode;
  onSeek: (t: number) => void;
  onPlay: () => void;
  onPause: () => void;
  onError: (msg: string) => void;
};

/** A pause this long between two words gets its own chip (it can be cut like a word). */
const PAUSE = 0.3;
/** A hole this long isn't a pause: it is speech the captions don't list (lines hidden under a card). */
const UNLISTED = 1.5;
/** Breath left on each side when a pause is cut. */
const PAD = 0.06;

type Item =
  | { k: "word"; s: number; e: number; w: Word; join: boolean }
  | { k: "pause"; s: number; e: number }
  | { k: "gap"; s: number; e: number };

function build(words: Word[], duration: number, joins: number[]): Item[] {
  const out: Item[] = [];
  const between = (s: number, e: number) => {
    if (e - s >= UNLISTED) out.push({ k: "gap", s, e });
    else if (e - s >= PAUSE) out.push({ k: "pause", s, e });
  };
  let prev = 0;
  for (const w of words) {
    between(prev, w.s);
    const join = joins.some((j) => j > prev - 0.02 && j <= w.s + 0.02 && j > 0.05);
    out.push({ k: "word", s: w.s, e: w.e, w, join });
    prev = w.e;
  }
  if (words.length) between(prev, duration);
  return out;
}

/** The stretch of time a selection (items lo..hi) removes. Words take the gap to the next word with them. */
function rangeOf(items: Item[], lo: number, hi: number, duration: number): { a: number; b: number } {
  const first = items[lo], last = items[hi];
  const before = items[lo - 1], after = items[hi + 1];
  let a = first.s, b = last.e;
  if (first.k !== "word") a = first.s <= 0.001 ? 0 : first.s + PAD;
  else if (before && before.k !== "word") a = Math.max(before.s + PAD, first.s - 0.04);
  if (last.k !== "word") b = last.e >= duration - 0.001 ? duration : last.e - PAD;
  else if (after?.k === "word") b = after.s;
  else if (after) b = Math.min(last.e + 0.08, Math.max(last.e, after.e - PAD));
  return { a: Math.max(0, a), b: Math.min(duration, b) };
}

const Words = memo(function Words({ items, active, lo, hi, onDown, onEnter }: {
  items: Item[]; active: number; lo: number; hi: number; onDown: (i: number, e: React.PointerEvent) => void; onEnter: (i: number) => void;
}) {
  return (
    <div className="select-none text-[15px] leading-[1.9] text-ink-200">
      {items.map((it, i) => {
        const sel = i >= lo && i <= hi;
        if (it.k === "gap")
          return (
            <span key={i} className="mx-1 my-1 block rounded-md bg-white/[0.03] px-2 py-1 text-[11px] leading-snug text-ink-500" title="The captions don't list these words (lines shown as a card). Mark a range with I and O to cut here.">
              {(it.e - it.s).toFixed(1)} s not listed here
            </span>
          );
        if (it.k === "pause")
          return (
            <span
              key={i}
              data-i={i}
              onPointerDown={(e) => onDown(i, e)}
              onPointerEnter={() => onEnter(i)}
              className={cx("mx-0.5 inline-block cursor-pointer rounded px-1 align-middle font-mono text-[10px] leading-[1.6] tnum", sel ? "bg-red-400/25 text-red-200 line-through" : "bg-white/5 text-ink-400 hover:bg-white/10")}
              title={`A pause of ${(it.e - it.s).toFixed(2)} s`}
            >
              {(it.e - it.s).toFixed(1)}s
            </span>
          );
        return (
          <span key={i}>
            {it.join && <span className="mx-0.5 text-ink-600" title="A cut is here already">|</span>}
            <span
              data-i={i}
              onPointerDown={(e) => onDown(i, e)}
              onPointerEnter={() => onEnter(i)}
              className={cx(
                "cursor-pointer rounded px-[3px] py-[2px]",
                sel ? "bg-red-400/25 text-red-100 line-through decoration-red-300/70" : i === active ? "bg-gold/25 text-ink-100" : "hover:bg-white/10",
              )}
            >
              {it.w.t}
            </span>{" "}
          </span>
        );
      })}
    </div>
  );
});

/**
 * The words of the edit. Click a word to go there; drag (or shift-click) across words and pauses and cut them: the
 * edit closes up at once, without Claude. I and O mark a range at the playhead for anything the words don't show.
 */
export function TranscriptPanel(p: Props) {
  const [tr, setTr] = useState<Transcript | null>(null);
  const [sel, setSel] = useState<{ anchor: number; head: number } | null>(null);
  const [mark, setMark] = useState<{ in: number | null; out: number | null }>({ in: null, out: null });
  const [cutting, setCutting] = useState(false);
  const [extend, setExtend] = useState(false);
  const [audition, setAudition] = useState<{ a: number; b: number; jumped: boolean } | null>(null);
  const drag = useRef<{ moved: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let off = false;
    api.transcript(p.pid).then((t) => !off && setTr(t)).catch(() => {});
    return () => {
      off = true;
    };
  }, [p.pid, p.stamp]);
  // the words moved: what was picked no longer points at the same thing
  useEffect(() => {
    setSel(null);
    setMark({ in: null, out: null });
  }, [p.pid, tr]);

  const duration = p.model.duration;
  const joins = useMemo(() => p.model.cuts.map((c) => c.start), [p.model.cuts]);
  const items = useMemo(() => build(tr?.words ?? [], duration, joins), [tr, duration, joins]);
  const active = useMemo(() => {
    let hit = -1;
    for (let i = 0; i < items.length; i++) {
      if (items[i].k !== "word") continue;
      if (items[i].s <= p.time + 0.02) hit = i;
      else break;
    }
    return hit >= 0 && p.time < items[hit].e + 0.4 ? hit : -1;
  }, [items, p.time]);

  // keep the word being spoken in view while it plays
  useEffect(() => {
    // (not on the phone: there the whole page scrolls, and the player pinned on top would cover the word)
    if (!p.playing || active < 0 || p.full) return;
    box.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [active, p.playing, p.full]);

  const lo = sel ? Math.min(sel.anchor, sel.head) : -1;
  const hi = sel ? Math.max(sel.anchor, sel.head) : -1;
  const marked = mark.in != null && mark.out != null && mark.out > mark.in;
  const range = sel ? rangeOf(items, lo, hi, duration) : marked ? { a: mark.in!, b: mark.out! } : null;
  const picked = sel ? items.slice(lo, hi + 1) : [];
  const text = picked.filter((x) => x.k === "word").map((x) => (x as Extract<Item, { k: "word" }>).w.t).join(" ");
  const label = sel ? (text ? `“${text.length > 48 ? text.slice(0, 46) + "…" : text}”` : picked.length > 1 ? "pauses" : "a pause") : "the marked range";

  const onDown = useCallback((i: number, e: React.PointerEvent) => {
    e.preventDefault();
    setMark({ in: null, out: null });
    if (e.shiftKey || extend) {
      setSel((s) => (s ? { anchor: s.anchor, head: i } : { anchor: i, head: i }));
      setExtend(false);
      return;
    }
    drag.current = { moved: false };
    setSel({ anchor: i, head: i });
    p.onPause();
    p.onSeek(items[i].s);
  }, [items, extend, p.onSeek, p.onPause]);
  const onEnter = useCallback((i: number) => {
    if (!drag.current) return;
    drag.current.moved = true;
    setSel((s) => (s ? { anchor: s.anchor, head: i } : s));
  }, []);
  useEffect(() => {
    const up = () => (drag.current = null);
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);

  const clear = () => {
    setSel(null);
    setMark({ in: null, out: null });
    setAudition(null);
  };

  const cut = async () => {
    if (!range || cutting || !p.canEdit || !tr?.canCut) return;
    const len = range.b - range.a;
    if (len > 5 && !confirm(`Cut ${len.toFixed(1)} seconds out of the video? You can undo it from the comments.`)) return;
    setCutting(true);
    setAudition(null);
    p.onPause();
    try {
      const r = await api.cut(p.pid, range.a, range.b, sel ? (text ? "" : "a pause") : "a marked range");
      clear();
      p.onSeek(Math.max(0, r.at - 1)); // a second before the join, ready to play through it
    } catch (e: any) {
      p.onError(e.message);
    } finally {
      setCutting(false);
    }
  };

  // "Hear it": play up to the cut, skip what would be removed, and stop a moment after, before anything changes
  const hear = () => {
    if (!range) return;
    setAudition({ ...range, jumped: false });
    p.onSeek(Math.max(0, range.a - 1.2));
    p.onPlay();
  };
  useEffect(() => {
    if (!audition) return;
    if (!audition.jumped && p.time >= audition.a - 0.02) {
      setAudition({ ...audition, jumped: true });
      p.onSeek(audition.b);
    } else if (audition.jumped && p.time >= audition.b + 1.2) {
      p.onPause();
      setAudition(null);
    }
  }, [p.time, audition]);
  useEffect(() => {
    if (audition?.jumped && !p.playing && p.time > audition.b + 0.3) setAudition(null); // paused by hand
  }, [p.playing]);

  const keys = useRef({ cut, clear, time: p.time });
  keys.current = { cut, clear, time: p.time };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("textarea, input, select") || e.metaKey || e.ctrlKey) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        keys.current.cut();
      } else if (e.key === "i" || e.key === "I") {
        setSel(null);
        setMark((m) => ({ in: keys.current.time, out: m.out != null && m.out > keys.current.time ? m.out : null }));
      } else if (e.key === "o" || e.key === "O") {
        setSel(null);
        setMark((m) => ({ in: m.in != null && m.in < keys.current.time ? m.in : null, out: keys.current.time }));
      } else if (e.key === "Escape") keys.current.clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const can = p.canEdit && !!tr?.canCut;
  const halfMarked = !sel && !marked && (mark.in != null || mark.out != null);

  return (
    <aside className={cx("flex shrink-0 flex-col bg-ink-900", p.full ? "w-full" : "w-[320px] border-l border-white/5 xl:w-[380px]")}>
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-white/5 px-4">
        {p.header ?? <div className="text-[13px] font-semibold text-ink-100">Words</div>}
        {tr && <span className="text-[11px] text-ink-400">{tr.words.length} words</span>}
      </div>

      {tr && !tr.canCut && p.canEdit && tr.why && (
        <div className="border-b border-white/5 bg-white/[0.03] px-4 py-2 text-[12px] leading-snug text-ink-300">{tr.why}</div>
      )}

      <div ref={box} className={cx("min-h-0 flex-1 px-4 py-3", !p.full && "overflow-y-auto")}>
        {!tr ? (
          <div className="text-[13px] text-ink-400">Loading the words…</div>
        ) : !tr.words.length ? (
          <div className="text-[13px] leading-snug text-ink-400">This edit has no captions yet, so there are no words to show.</div>
        ) : (
          <>
            <Words items={items} active={active} lo={lo} hi={hi} onDown={onDown} onEnter={onEnter} />
            {can && (
              <p className="mt-4 text-[11px] leading-relaxed text-ink-500">
                Click a word to go there. Drag across words or pauses (or shift-click) and press <Kbd>Delete</Kbd> to cut them.{" "}
                <Kbd>I</Kbd> and <Kbd>O</Kbd> mark a range at the playhead, for a sound the words don't show.
              </p>
            )}
          </>
        )}
      </div>

      {can && (range || halfMarked) && (
        <div className={cx("shrink-0 border-t border-white/5 bg-ink-850 px-3 py-2.5", p.full && "sticky bottom-0 pb-[calc(0.625rem+env(safe-area-inset-bottom))]")}>
          {range ? (
            <>
              <div className="flex items-baseline justify-between gap-2 text-[12px]">
                <span className="min-w-0 truncate text-ink-100">Cut {label}</span>
                <span className="shrink-0 font-mono text-[11px] text-ink-400 tnum">
                  {fmt(range.a, true, p.model.fps)} · {(range.b - range.a).toFixed(2)} s
                </span>
              </div>
              <div className="mt-2 flex items-center gap-1.5">
                <button onClick={cut} disabled={cutting || p.busy} className="rounded-lg bg-gold px-3 py-1.5 text-[12px] font-semibold text-ink-950 hover:brightness-110 disabled:opacity-50" title={p.busy ? "Claude is working on this edit: wait for it to finish" : "Cut it out now (Delete)"}>
                  {cutting ? "Cutting…" : "Cut"}
                </button>
                <button onClick={hear} disabled={cutting} className="rounded-lg px-3 py-1.5 text-[12px] text-ink-100 ring-1 ring-white/10 hover:bg-white/5" title="Play across the cut first, without changing anything">
                  {audition ? "Playing…" : "Hear it first"}
                </button>
                {p.full && sel && (
                  <button onClick={() => setExtend(!extend)} className={cx("rounded-lg px-3 py-1.5 text-[12px] ring-1", extend ? "bg-white/10 text-ink-100 ring-white/20" : "text-ink-300 ring-white/10")} title="Then tap the last word to cut">
                    {extend ? "Tap the last word" : "Select to…"}
                  </button>
                )}
                <div className="flex-1" />
                <button onClick={clear} className="rounded-lg px-2 py-1.5 text-[12px] text-ink-400 hover:bg-white/5 hover:text-ink-200" title="Clear (Esc)">
                  Clear
                </button>
              </div>
              {p.busy && <div className="mt-1.5 text-[11px] text-ink-500">Claude is working on this edit. Cut when it has finished.</div>}
            </>
          ) : (
            <div className="flex items-center justify-between text-[12px] text-ink-300">
              <span>
                {mark.in != null ? `Starts at ${fmt(mark.in, true, p.model.fps)}. Move the playhead and press O for the end.` : `Ends at ${fmt(mark.out!, true, p.model.fps)}. Move the playhead and press I for the start.`}
              </span>
              <button onClick={clear} className="rounded-lg px-2 py-1 text-ink-400 hover:bg-white/5 hover:text-ink-200">Clear</button>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
