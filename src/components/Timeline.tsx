import { useLayoutEffect, useRef, useState } from "react";
import type { Comment, EditModel, Sfx, Target } from "../types";
import { cx, fmt } from "../util";
import { Composer } from "./Composer";

type Props = {
  model: EditModel;
  time: number;
  comments: Comment[];
  commentMode: boolean;
  onSeek: (t: number) => void;
  onPause: () => void;
  onSolo: (s: Sfx) => void;
  onSubmit: (c: { text: string; t: number; x: null; y: null; target: Target; want: number }) => void;
  onFocus: (id: string) => void;
};

const LABEL_W = 92;

export function Timeline(p: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [draft, setDraft] = useState<{ t: number; target: Target; left: number; lane: number } | null>(null);
  useLayoutEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(scroller.current!);
    return () => ro.disconnect();
  }, []);

  const D = p.model.duration;
  const pps = Math.max((width - LABEL_W - 16) / D, 14); // px per second
  const W = D * pps;
  const x = (t: number) => t * pps;

  const tracks = [...new Set(p.model.sfx.map((s) => s.track))];
  const lanes: { key: string; label: string }[] = [
    { key: "picture", label: "Picture" },
    { key: "captions", label: "Captions" },
    ...tracks.map((t) => ({ key: "sfx:" + t, label: t })),
  ];

  // Scrub: press on the playhead, the ruler or empty lane space and drag; the view scrolls at the edges.
  const [scrubbing, setScrubbing] = useState(false);
  const tAt = (clientX: number) => {
    const r = content.current!.getBoundingClientRect();
    return Math.max(0, Math.min(D, (clientX - r.left - LABEL_W) / pps));
  };
  const startScrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    let lastX = e.clientX, frame = 0, edge = 0;
    p.onSeek(tAt(lastX));
    setScrubbing(true);
    const tick = () => {
      frame = 0;
      const sc = scroller.current!, r = sc.getBoundingClientRect();
      edge = lastX > r.right - 28 ? 14 : lastX < r.left + LABEL_W + 28 ? -14 : 0;
      if (edge) sc.scrollLeft += edge;
      p.onSeek(tAt(lastX));
      if (edge) frame = requestAnimationFrame(tick);
    };
    const move = (ev: PointerEvent) => {
      lastX = ev.clientX;
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const up = () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setScrubbing(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const choose = (target: Target, t: number, lane: number, clickT?: number) => {
    const at = Math.max(0, Math.min(D, clickT ?? t));
    if (p.commentMode) {
      // the comment sits exactly where you clicked: stop playback and park the playhead there while you type
      p.onPause();
      p.onSeek(at);
      setDraft({ t: at, target, left: x(at), lane });
    } else p.onSeek(at);
  };

  // comment mode, click on empty lane space or the ruler: comment on whatever sits on that lane at that moment
  const commentAt = (e: React.MouseEvent, li: number) => {
    if (!p.commentMode || e.target !== e.currentTarget) return;
    const t = tAt(e.clientX);
    const key = li < 0 ? "ruler" : lanes[li].key;
    const inSeg = (s: { start: number; dur: number }) => t >= s.start && t < s.start + s.dur;
    let target: Target = { kind: "general", label: "this moment", detail: li < 0 ? undefined : `${lanes[li].label} lane` };
    if (key === "picture") {
      const b = p.model.broll.find(inSeg), c = p.model.cuts.find(inSeg);
      if (b) target = { kind: "broll", id: b.id, label: `card "${b.label}"`, detail: `${b.start.toFixed(2)}–${(b.start + b.dur).toFixed(2)} s` };
      else if (c) target = { kind: "cut", id: c.id, label: `A-roll ${c.id}`, detail: `${c.start.toFixed(2)}–${(c.start + c.dur).toFixed(2)} s${c.scale !== 1 ? ` · punch-in ${c.scale}×` : ""}` };
    } else if (key === "captions") {
      const g = p.model.captions.find(inSeg);
      if (g) target = { kind: "caption", id: g.id, label: `caption ${g.id} "${g.text}"`, detail: g.big ? `keyword "${g.big}"` : undefined };
    }
    choose(target, t, Math.max(0, li), t);
  };

  // keep the playhead in view when it moves by arrow keys or playback (not while you drag it yourself)
  useLayoutEffect(() => {
    const sc = scroller.current;
    if (!sc || scrubbing) return;
    const px = LABEL_W + x(p.time), left = sc.scrollLeft + LABEL_W + 24, right = sc.scrollLeft + sc.clientWidth - 24;
    if (px < left) sc.scrollLeft = px - LABEL_W - 24;
    else if (px > right) sc.scrollLeft = px - sc.clientWidth + 24 + Math.min(120, sc.clientWidth / 4);
  }, [p.time, pps, scrubbing]);

  const step = Math.max(1,[1, 2, 5, 10, 15, 30, 60].find((s) => s * pps >= 64) ?? 60);
  const ticks = Array.from({ length: Math.floor(D / step) + 1 }, (_, i) => i * step);
  const markers = p.comments.filter((c) => c.status !== "undone");

  return (
    <div className={cx("relative select-none border-t border-white/5 bg-ink-900", p.commentMode ? "comment-cursor" : scrubbing && "cursor-ew-resize [&_*]:!cursor-ew-resize")}>
      <div ref={scroller} className="overflow-x-auto overflow-y-hidden">
        <div ref={content} className="relative" style={{ width: W + LABEL_W + 16 }}>
          {/* ruler */}
          <div className="sticky top-0 z-10 flex h-7 bg-ink-900">
            <div className="sticky left-0 z-10 bg-ink-900" style={{ width: LABEL_W }} />
            <div
              className="relative cursor-ew-resize touch-none"
              style={{ width: W }}
              onPointerDown={(e) => !p.commentMode && startScrub(e)}
              onClick={(e) => commentAt(e, -1)}
            >
              {ticks.map((t) => (
                <div key={t} className="absolute top-0 h-full border-l border-white/10" style={{ left: x(t) }}>
                  <span className="ml-1 font-mono text-[10px] text-ink-500 tnum">{fmt(t)}</span>
                </div>
              ))}
              {markers.map((c) => (
                <button
                  key={c.id}
                  title={c.text}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onSeek(c.t);
                    p.onFocus(c.id);
                  }}
                  className={cx(
                    "absolute bottom-0.5 h-2.5 w-2.5 -translate-x-1/2 rounded-full ring-2 ring-ink-900",
                    c.status === "working" ? "bg-gold pulse-ring" : c.status === "done" ? "bg-ink-200" : c.status === "failed" ? "bg-red-400" : "bg-ink-500",
                  )}
                  style={{ left: x(c.t) }}
                />
              ))}
            </div>
          </div>

          {lanes.map((lane, li) => (
            <div key={lane.key} className="flex h-9 border-t border-white/[0.04]">
              <div className="sticky left-0 z-10 flex items-center bg-ink-900 pl-3 text-[11px] font-medium text-ink-400" style={{ width: LABEL_W }}>
                <span className="truncate">{lane.label}</span>
              </div>
              <div
                className="relative"
                style={{ width: W }}
                onPointerDown={(e) => !p.commentMode && e.target === e.currentTarget && startScrub(e)}
                onClick={(e) => commentAt(e, li)}
              >
                {lane.key === "picture" && (
                  <>
                    {p.model.cuts.map((s) => (
                      <button
                        key={s.id}
                        onClick={(e) => choose({ kind: "cut", id: s.id, label: `A-roll ${s.id}`, detail: `${s.start.toFixed(2)}–${(s.start + s.dur).toFixed(2)} s${s.scale !== 1 ? ` · punch-in ${s.scale}×` : ""}` }, s.start, li, clickT(e, s.start))}
                        className={cx("absolute top-1.5 bottom-1.5 rounded-[3px] border-r border-ink-900 transition-colors", s.scale !== 1 ? "bg-cut/45 hover:bg-cut/60" : "bg-cut/25 hover:bg-cut/40")}
                        style={{ left: x(s.start), width: Math.max(2, x(s.dur)) }}
                        title={`${s.id} · ${s.dur.toFixed(2)} s${s.scale !== 1 ? ` · ${s.scale}×` : ""}`}
                      />
                    ))}
                    {p.model.broll.map((s) => (
                      <button
                        key={s.id}
                        onClick={(e) => choose({ kind: "broll", id: s.id, label: `card "${s.label}"`, detail: `${s.start.toFixed(2)}–${(s.start + s.dur).toFixed(2)} s` }, s.start, li, clickT(e, s.start))}
                        className="absolute top-1 bottom-1 truncate rounded-[4px] bg-broll/80 px-1.5 text-left text-[10px] font-semibold text-ink-950 hover:bg-broll"
                        style={{ left: x(s.start), width: Math.max(4, x(s.dur)) }}
                      >
                        {s.label.replace(/_/g, " ")}
                      </button>
                    ))}
                  </>
                )}
                {lane.key === "captions" &&
                  p.model.captions.map((g) => (
                    <button
                      key={g.id}
                      onClick={(e) => choose({ kind: "caption", id: g.id, label: `caption ${g.id} "${g.text}"`, detail: g.big ? `keyword "${g.big}"` : undefined }, g.start, li, clickT(e, g.start))}
                      className="absolute top-1 bottom-1 truncate rounded-[4px] bg-cap/20 px-1.5 text-left text-[10px] text-cap ring-1 ring-inset ring-cap/25 hover:bg-cap/30"
                      style={{ left: x(g.start), width: Math.max(4, x(g.dur) - 1) }}
                      title={g.text}
                    >
                      <span className="font-serif italic">{g.big}</span> <span className="opacity-60">{g.text}</span>
                    </button>
                  ))}
                {lane.key.startsWith("sfx:") &&
                  p.model.sfx
                    .filter((s) => "sfx:" + s.track === lane.key)
                    .map((s) => (
                      <button
                        key={s.id}
                        onClick={(e) => {
                          if (p.commentMode) choose({ kind: "sfx", id: s.id, label: `sound "${s.name}"`, detail: `${s.start.toFixed(2)} s on ${s.track}, volume ${s.volume}` }, s.start, li);
                          else {
                            p.onSeek(s.start);
                            p.onSolo(s);
                          }
                          e.stopPropagation();
                        }}
                        className="group absolute top-1.5 bottom-1.5 flex items-center overflow-hidden rounded-[4px] bg-sfx/15 ring-1 ring-inset ring-sfx/30 hover:bg-sfx/30"
                        style={{ left: x(s.start), width: Math.max(6, x(s.dur)) }}
                        title={`${s.name} · ${s.start.toFixed(2)} s · vol ${s.volume} — click to hear it alone`}
                      >
                        <span className="h-full w-[2px] shrink-0 bg-sfx" />
                        <span className="truncate px-1 text-[10px] text-sfx/90">{s.name.replace(/^sfx_/, "").replace(/_\d+$/, "")}</span>
                      </button>
                    ))}
              </div>
            </div>
          ))}

          {/* playhead */}
          <div className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-gold" style={{ left: LABEL_W + x(p.time) }}>
            {/* grab area: the head plus a 13 px strip along the line; in comment mode clicks go straight through to the timeline */}
            {!p.commentMode && (
              <div
                title="Drag to scrub"
                onPointerDown={startScrub}
                className="pointer-events-auto absolute top-0 bottom-0 -left-[6px] w-[13px] cursor-ew-resize touch-none"
              />
            )}
            <div
              onPointerDown={p.commentMode ? undefined : startScrub}
              className={cx(
                "absolute -top-0.5 -left-[7px] h-3.5 w-[15px] touch-none rounded-b-sm bg-gold transition-transform",
                p.commentMode ? "pointer-events-none" : "pointer-events-auto cursor-ew-resize hover:scale-110",
                scrubbing && "scale-110",
              )}
            />
          </div>

        </div>
      </div>
      {draft && (
        <div
          className="absolute z-30 mb-2"
          style={{ left: Math.max(8, Math.min(LABEL_W + draft.left - (scroller.current?.scrollLeft ?? 0), width - 330)), bottom: "100%" }}
        >
          <Composer
            target={draft.target}
            t={draft.t}
            onCancel={() => setDraft(null)}
            onSubmit={(text, want) => {
              p.onSubmit({ text, t: draft.t, x: null, y: null, target: draft.target, want });
              setDraft(null);
            }}
          />
        </div>
      )}
    </div>
  );

  function clickT(e: React.MouseEvent, fallback: number) {
    const r = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const t = (e.clientX - r.left) / pps;
    return Number.isFinite(t) ? t : fallback;
  }
}
