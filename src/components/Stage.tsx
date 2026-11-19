import { createPortal } from "react-dom";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { Comment, Device, EditModel, Pick, Target, TitleChange } from "../types";
import { cx } from "../util";
import { Composer } from "./Composer";
import { PLATFORMS, fractions, marginsFor, type Platform, type SafeMode } from "../safezones";

export type StageHandle = { video: HTMLVideoElement | null; seekOverlay: (t: number) => void };

type Props = {
  model: EditModel;
  proxyUrl: string | null;
  proxyNote: string | null;
  overlayUrl: string | null;
  device: Device;
  time: number;
  commentMode: boolean;
  comments: Comment[];
  focusId: string | null;
  onFocus: (id: string) => void;
  onSubmit: (c: { text: string; t: number; x: number | null; y: number | null; target: Target; want: number; pick?: Pick }) => void;
  muted?: boolean;
  /** draw where each app's UI sits (vertical) or title-safe (16:9) */
  safe?: SafeMode;
  /** space around the device frame */
  pad?: number;
  /** phone-width window: the comment box opens as a sheet at the bottom of the screen */
  sheet?: boolean;
  onPickDisabled?: boolean;
  /** editors, on the live edit: move or change a title (the hook) right in the picture */
  onTitle?: (b: TitleChange) => Promise<void>;
  onVideoEvent: (e: "play" | "pause" | "seeked" | "loaded") => void;
};

type Box = { w: number; h: number };

function fit(aspect: number, avail: Box): Box {
  return avail.w / avail.h > aspect ? { w: avail.h * aspect, h: avail.h } : { w: avail.w, h: avail.w / aspect };
}

export const Stage = forwardRef<StageHandle, Props>(function Stage(p, ref) {
  const wrap = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [avail, setAvail] = useState<Box>({ w: 800, h: 450 });
  const [draft, setDraft] = useState<{ x: number; y: number; t: number; target: Target } | null>(null);
  const lastT = useRef(0);
  const [paused, setPaused] = useState(true);
  const [boxes, setBoxes] = useState<TitleBox[]>([]);
  const [editing, setEditing] = useState<string | null>(null);

  useLayoutEffect(() => {
    const ro = new ResizeObserver(([e]) => setAvail({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(wrap.current!);
    return () => ro.disconnect();
  }, []);

  const seekOverlay = (t: number) => {
    lastT.current = t;
    try {
      (frame.current?.contentWindow as any)?.__room?.seek(t);
    } catch {}
  };
  useImperativeHandle(ref, () => ({
    get video() {
      return video.current;
    },
    seekOverlay,
  }), []);
  useEffect(() => {
    if (!p.commentMode) setDraft(null);
  }, [p.commentMode]);

  // where each title sits in the picture right now (read from the live composition), so it can be dragged or edited
  const titlesOn = !!p.onTitle && !!p.model.titles?.length && paused && !p.commentMode;
  const measure = () => {
    try {
      const doc = frame.current?.contentDocument;
      if (!doc) return setBoxes([]);
      const out: TitleBox[] = [];
      doc.querySelectorAll<HTMLElement>(".ttl[data-title]").forEach((el) => {
        const st = el.ownerDocument.defaultView!.getComputedStyle(el);
        if (st.visibility === "hidden" || parseFloat(st.opacity) < 0.5) return;
        const r = el.getBoundingClientRect();
        out.push({ id: el.dataset.title!, l: r.left, t: r.top, w: r.width, h: r.height });
      });
      setBoxes(out);
    } catch {
      setBoxes([]);
    }
  };
  useEffect(() => {
    if (!titlesOn) return setBoxes([]);
    const id = requestAnimationFrame(() => requestAnimationFrame(measure));
    return () => cancelAnimationFrame(id);
  }, [titlesOn, p.time, p.model, p.overlayUrl]);
  useEffect(() => {
    if (!titlesOn) setEditing(null);
  }, [titlesOn]);

  const W = p.model.width, H = p.model.height;
  const aspect = W / H;
  const portraitVideo = aspect < 1;
  const pad = p.pad ?? 28;
  const room = { w: Math.max(120, avail.w - pad * 2), h: Math.max(80, avail.h - pad * 2) };

  // device geometry: the phone body, its screen, and the video box inside the screen
  let body: Box, screen: Box, bezel = 0, radius = 10, videoBox: Box, videoTop = 0;
  if (p.device === "desktop") {
    body = screen = videoBox = fit(aspect, room);
    radius = 10;
  } else {
    const landscapePhone = p.device === "phone" && !portraitVideo;
    const phoneAspect = landscapePhone ? 19.5 / 9 : 9 / 19.5;
    body = fit(phoneAspect, room);
    bezel = Math.max(6, Math.round(Math.min(body.w, body.h) * 0.035));
    radius = Math.round(Math.min(body.w, body.h) * 0.13);
    screen = { w: body.w - bezel * 2, h: body.h - bezel * 2 };
    videoBox = fit(aspect, screen);
    videoTop = (screen.h - videoBox.h) / 2;
    if (p.device === "feed" && !portraitVideo) videoTop = Math.max(screen.h * 0.18, (screen.h - videoBox.h) / 2 - screen.h * 0.06);
  }
  const scale = videoBox.w / W;

  const pick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!p.commentMode) {
      const v = video.current;
      if (v) v.paused ? v.play() : v.pause();
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    const t = p.time;
    video.current?.pause();
    setDraft({ x, y, t, target: hitTest(x, y, t) });
  };

  const hitTest = (x: number, y: number, t: number): Target => {
    try {
      const doc = frame.current?.contentDocument;
      const el = doc?.elementFromPoint(x * W, y * H) as HTMLElement | null;
      // a title (the hook) of a stage-format edit
      const ttl = el?.closest(".ttl[data-title]") as HTMLElement | null;
      if (ttl) {
        const row = el?.closest(".trow") as HTMLElement | null;
        return { kind: "frame", id: ttl.dataset.title, label: `title “${ttl.dataset.title}” (${(ttl.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60)})`, detail: row ? `the words "${row.textContent?.trim()}"` : undefined };
      }
      const word = el?.closest(".w, .big") as HTMLElement | null;
      // a stage-format caption line (line_captions.py): lines are in time order, ids l0, l1…
      const line = word?.closest(".line") as HTMLElement | null;
      if (line && doc) {
        const i = Array.from(doc.querySelectorAll(".line")).indexOf(line);
        const g = p.model.captions.find((c) => c.id === `l${i}`);
        return { kind: "caption", id: `l${i}`, label: `caption line l${i}${g ? ` "${g.text}"` : ""}`, detail: `word "${word!.textContent?.trim()}"` };
      }
      const grp = word?.closest(".grp") as HTMLElement | null;
      if (grp) {
        const g = p.model.captions.find((c) => c.id === grp.id);
        const isBig = word!.classList.contains("big");
        return {
          kind: "caption",
          id: grp.id,
          label: `caption ${grp.id}${g ? ` "${g.text}"` : ""}`,
          detail: `${isBig ? "keyword" : "word"} "${word!.textContent?.trim()}"`,
        };
      }
    } catch {}
    const inSeg = (s: { start: number; dur: number }) => t >= s.start && t < s.start + s.dur;
    const b = p.model.broll.find(inSeg);
    if (b) return { kind: "broll", id: b.id, label: `card "${b.label}"`, detail: `${b.start.toFixed(2)}–${(b.start + b.dur).toFixed(2)} s` };
    const c = p.model.cuts.find(inSeg);
    return { kind: "frame", id: c?.id, label: "this spot in the frame", detail: c ? `A-roll ${c.id}${c.scale !== 1 ? `, punch-in ${c.scale}×` : ""}` : undefined };
  };

  // a pin on a title would cover it while it can be dragged; those comments are still in the list
  const onTitle = (c: Comment) => boxes.some((b) => c.x! * W >= b.l - 20 && c.x! * W <= b.l + b.w + 20 && c.y! * H >= b.t - 20 && c.y! * H <= b.t + b.h + 20);
  const pins = p.comments.filter((c) => c.x != null && Math.abs(c.t - p.time) < 1.2 && c.status !== "undone" && !(titlesOn && onTitle(c)));

  return (
    <div ref={wrap} className="relative flex-1 min-h-0 flex items-center justify-center overflow-hidden">
      <div
        className={cx("relative", p.device !== "desktop" && "bg-[#050506] shadow-[0_30px_80px_-20px_rgba(0,0,0,.8),inset_0_0_0_1px_rgba(255,255,255,.07)]")}
        style={{ width: body.w, height: body.h, borderRadius: radius, padding: bezel }}
      >
        <div className="relative overflow-hidden bg-black" style={{ width: screen.w, height: screen.h, borderRadius: Math.max(4, radius - bezel) }}>
          {p.device === "feed" && <FeedChrome portrait={portraitVideo} />}
          <div
            className={cx("absolute left-1/2 -translate-x-1/2 overflow-hidden", p.device === "desktop" && "ring-1 ring-white/10")}
            style={{ top: videoTop, width: videoBox.w, height: videoBox.h, borderRadius: p.device === "desktop" ? radius : 0 }}
          >
            {p.proxyUrl && (
              <video
                ref={video}
                src={p.proxyUrl}
                className="absolute inset-0 h-full w-full"
                playsInline
                muted={p.muted}
                preload="auto"
                onPlay={() => (setPaused(false), p.onVideoEvent("play"))}
                onPause={() => (setPaused(true), p.onVideoEvent("pause"))}
                onSeeked={() => p.onVideoEvent("seeked")}
                onLoadedData={() => p.onVideoEvent("loaded")}
              />
            )}
            {p.overlayUrl && (
              <iframe
                ref={frame}
                key={p.overlayUrl}
                src={p.overlayUrl}
                title="captions"
                onLoad={() => {
                  seekOverlay(lastT.current || p.time);
                  requestAnimationFrame(() => requestAnimationFrame(() => titlesOn && measure()));
                }}
                className="pointer-events-none absolute left-0 top-0 origin-top-left border-0 bg-transparent"
                style={{ width: W, height: H, transform: `scale(${scale})`, colorScheme: "normal" }}
              />
            )}
            {p.proxyNote && (
              <div className="absolute inset-0 grid place-items-center bg-black/55 backdrop-blur-[2px]">
                <div className="flex items-center gap-2.5 rounded-full bg-ink-900/90 px-4 py-2 text-[13px] text-ink-200 ring-1 ring-white/10">
                  <span className="h-1.5 w-1.5 rounded-full bg-gold pulse-ring" />
                  {p.proxyNote}
                </div>
              </div>
            )}
            {p.safe && p.safe !== "off" && <SafeOverlay mode={p.safe} width={videoBox.w} />}
            {/* click layer: plays/pauses, or in comment mode drops a pin */}
            <div className={cx("absolute inset-0", p.commentMode ? "cursor-crosshair" : "cursor-pointer")} onClick={pick} />
            {titlesOn &&
              boxes.map((b) => {
                const T = p.model.titles!.find((x) => x.id === b.id);
                if (!T) return null;
                return (
                  <TitleHandle
                    key={b.id}
                    box={b}
                    title={T}
                    scale={scale}
                    frameDoc={() => frame.current?.contentDocument ?? null}
                    editing={editing === b.id}
                    onEdit={(on) => setEditing(on ? b.id : null)}
                    onSave={async (ch) => {
                      await p.onTitle!(ch);
                      setEditing(null);
                    }}
                    below={b.t + b.h < H * 0.55}
                  />
                );
              })}
            {pins.map((c) => (
              <button
                key={c.id}
                onClick={() => p.onFocus(c.id)}
                className={cx(
                  "absolute -translate-x-1/2 -translate-y-full grid h-7 w-7 place-items-center rounded-full rounded-bl-none text-[11px] font-semibold shadow-lg ring-2 transition-transform hover:scale-110",
                  c.status === "working" ? "bg-gold text-ink-950 ring-gold/40 pulse-ring" : c.status === "done" ? "bg-ink-100 text-ink-950 ring-white/30" : c.status === "failed" ? "bg-red-400 text-ink-950 ring-red-300/40" : "bg-ink-700 text-ink-100 ring-white/20",
                  p.focusId === c.id && "scale-110 ring-gold",
                )}
                style={{ left: `${c.x! * 100}%`, top: `${c.y! * 100}%` }}
                title={c.text}
              >
                {c.status === "done" ? "✓" : c.status === "working" ? "…" : "●"}
              </button>
            ))}
            {draft && (
              <>
                <span className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gold ring-4 ring-gold/30" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%` }} />
                {(() => {
                  const composer = (
                    <Composer
                      target={draft.target}
                      t={draft.t}
                      wide={p.sheet}
                      onCancel={() => setDraft(null)}
                      onSubmit={(text, want, model) => {
                        p.onSubmit({ text, t: draft.t, x: draft.x, y: draft.y, target: draft.target, want, pick: model });
                        setDraft(null);
                      }}
                    />
                  );
                  if (p.sheet)
                    return createPortal(
                      <div className="fixed inset-x-0 bottom-0 z-50 p-2 pb-[max(8px,env(safe-area-inset-bottom))]">{composer}</div>,
                      document.body,
                    );
                  return (
                    <div
                      className="absolute z-20"
                      style={{
                        left: `clamp(8px, calc(${draft.x * 100}% - 160px), calc(100% - 328px))`,
                        top: draft.y > 0.55 ? undefined : `calc(${draft.y * 100}% + 14px)`,
                        bottom: draft.y > 0.55 ? `calc(${(1 - draft.y) * 100}% + 14px)` : undefined,
                      }}
                    >
                      {composer}
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        </div>
        {p.device !== "desktop" && (
          <div
            className="absolute rounded-full bg-black/80"
            style={
              p.device === "phone" && !portraitVideo
                ? { left: bezel * 0.35, top: "50%", width: bezel * 0.3, height: body.h * 0.18, transform: "translateY(-50%)" }
                : { top: bezel * 0.35, left: "50%", height: bezel * 0.3, width: body.w * 0.28, transform: "translateX(-50%)" }
            }
          />
        )}
      </div>
    </div>
  );
});

type TitleBox = { id: string; l: number; t: number; w: number; h: number };

const SWATCHES = [
  { c: "#FFFFFF", n: "White" },
  { c: "#F2EFE8", n: "Ink" },
  { c: "#FFD60A", n: "Yellow" },
  { c: "#E2401C", n: "Red" },
  { c: "#D9B871", n: "Gold" },
  { c: "#C9D3D9", n: "Steel" },
];

/**
 * A title in the picture, editable in place: drag it to move it, click it for its words, colours and sizes. Changes
 * show live in the composition and are saved (in stage_captions.json, so no rebuild loses them) on release or Save.
 */
function TitleHandle(props: {
  box: TitleBox;
  title: import("../types").Title;
  scale: number;
  frameDoc: () => Document | null;
  editing: boolean;
  below: boolean;
  onEdit: (on: boolean) => void;
  onSave: (ch: TitleChange) => Promise<void>;
}) {
  const { box, title: T, scale } = props;
  const [off, setOff] = useState({ x: 0, y: 0 });
  const [rows, setRows] = useState(() => T.rows.map((r) => ({ text: r.text ?? "", color: r.color ?? "#F2EFE8", size: r.size ?? 46 })));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  useEffect(() => {
    if (!props.editing) setRows(T.rows.map((r) => ({ text: r.text ?? "", color: r.color ?? "#F2EFE8", size: r.size ?? 46 })));
  }, [T, props.editing]);
  useEffect(() => setOff({ x: 0, y: 0 }), [T.x, T.y]);

  const el = () => props.frameDoc()?.querySelector<HTMLElement>(`.ttl[data-title="${CSS.escape(T.id)}"]`) ?? null;
  /** show a change in the composition at once, before it is saved */
  const live = (r = rows, o = off) => {
    const e = el();
    if (!e) return;
    e.style.left = `${T.x + o.x}px`;
    e.style.top = `${T.y + o.y}px`;
    Array.from(e.children).forEach((c, i) => {
      const row = T.rows[i], v = r[i];
      if (!row || !v) return;
      const h = c as HTMLElement;
      if (row.rule) h.style.background = v.color;
      else Object.assign(h.style, { color: v.color, fontSize: `${v.size}px` }), (h.textContent = v.text);
    });
  };
  const save = async (ch: TitleChange) => {
    setBusy(true);
    setErr(null);
    try {
      await props.onSave(ch);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setOff({ x: 0, y: 0 });
      live(T.rows.map((r) => ({ text: r.text ?? "", color: r.color ?? "#F2EFE8", size: r.size ?? 46 })), { x: 0, y: 0 });
    } finally {
      setBusy(false);
    }
  };
  const set = (i: number, v: Partial<(typeof rows)[number]>) => {
    const next = rows.map((r, k) => (k === i ? { ...r, ...v } : r));
    setRows(next);
    live(next);
  };
  const cancel = () => {
    const orig = T.rows.map((r) => ({ text: r.text ?? "", color: r.color ?? "#F2EFE8", size: r.size ?? 46 }));
    setRows(orig);
    live(orig, { x: 0, y: 0 });
    props.onEdit(false);
  };

  return (
    <>
      <div
        className={cx("absolute z-10 cursor-move rounded-[3px] outline-dashed outline-[1.5px] outline-offset-4 touch-none", props.editing ? "outline-gold" : "outline-gold/60 hover:outline-gold")}
        style={{ left: (box.l + off.x) * scale, top: (box.t + off.y) * scale, width: box.w * scale, height: box.h * scale }}
        title="Drag to move · click to change the words and colours"
        onPointerDown={(e) => {
          if (busy) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = (e.clientX - d.x) / scale, dy = (e.clientY - d.y) / scale;
          if (!d.moved && Math.hypot(dx, dy) * scale < 4) return;
          d.moved = true;
          const o = { x: Math.round(dx), y: Math.round(dy) };
          setOff(o);
          live(rows, o);
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (!d) return;
          if (!d.moved) return props.onEdit(!props.editing);
          save({ id: T.id, x: T.x + off.x, y: T.y + off.y, what: "Moved the title" });
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="absolute -top-6 left-0 whitespace-nowrap rounded bg-gold px-1.5 py-0.5 text-[10px] font-semibold text-ink-950">
          {busy ? "Saving…" : "Title · drag or click"}
        </span>
      </div>
      {props.editing && (
        <div
          className="absolute left-1/2 z-30 w-[min(320px,92%)] -translate-x-1/2 space-y-2 rounded-xl bg-ink-900/95 p-3 text-[12px] text-ink-100 shadow-2xl ring-1 ring-white/10 backdrop-blur"
          style={props.below ? { top: (box.t + box.h + off.y) * scale + 14 } : { bottom: `calc(100% - ${(box.t + off.y) * scale - 14}px)` }}
          onClick={(e) => e.stopPropagation()}
        >
          {T.rows.map((r, i) => (
            <div key={i} className="space-y-1">
              {r.rule ? (
                <div className="text-[11px] text-ink-400">Line</div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <input
                    value={rows[i].text}
                    onChange={(e) => set(i, { text: e.target.value })}
                    className="min-w-0 flex-1 rounded-md bg-ink-800 px-2 py-1 text-ink-50 outline-none ring-1 ring-white/10 focus:ring-gold/60"
                  />
                  <button className="h-6 w-6 rounded-md bg-ink-800 ring-1 ring-white/10 hover:bg-ink-700" title="Smaller" onClick={() => set(i, { size: Math.max(12, rows[i].size - 4) })}>−</button>
                  <span className="w-7 text-center tabular-nums text-ink-300">{rows[i].size}</span>
                  <button className="h-6 w-6 rounded-md bg-ink-800 ring-1 ring-white/10 hover:bg-ink-700" title="Bigger" onClick={() => set(i, { size: Math.min(400, rows[i].size + 4) })}>+</button>
                </div>
              )}
              <div className="flex gap-1.5">
                {SWATCHES.map((sw) => (
                  <button
                    key={sw.c}
                    title={sw.n}
                    onClick={() => set(i, { color: sw.c })}
                    className={cx("h-5 w-5 rounded-full ring-1 ring-white/20", rows[i].color.toUpperCase() === sw.c && "ring-2 ring-gold ring-offset-1 ring-offset-ink-900")}
                    style={{ background: sw.c }}
                  />
                ))}
              </div>
            </div>
          ))}
          {err && <div className="text-red-300">{err}</div>}
          <div className="flex items-center gap-2 pt-1">
            <button
              disabled={busy}
              className="rounded-md bg-gold px-3 py-1 font-semibold text-ink-950 disabled:opacity-50"
              onClick={() =>
                save({ id: T.id, rows: rows.map((r, i) => (T.rows[i].rule ? { color: r.color } : r)), x: T.x + off.x, y: T.y + off.y, what: "Changed the title" })
              }
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button disabled={busy} className="rounded-md px-2 py-1 text-ink-300 hover:text-ink-100" onClick={cancel}>Cancel</button>
            <button
              disabled={busy}
              className="ml-auto rounded-md px-2 py-1 text-red-300/80 hover:text-red-300"
              onClick={() => confirm("Remove this title from the video?") && save({ id: T.id, remove: true, what: "Removed the title" })}
            >
              Remove
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** A quiet stand-in for a social feed around the video, so placement reads like it will on a phone. */
function FeedChrome({ portrait }: { portrait: boolean }) {
  if (portrait)
    return (
      <div className="pointer-events-none absolute inset-0 z-10">
        <div className="absolute right-[4%] bottom-[16%] flex flex-col items-center gap-[3.2%] w-[11%]">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="aspect-square w-full rounded-full bg-white/25" />
          ))}
        </div>
        <div className="absolute left-[4%] right-[20%] bottom-[5%] space-y-1.5">
          <div className="h-2 w-1/3 rounded bg-white/35" />
          <div className="h-2 w-4/5 rounded bg-white/20" />
        </div>
        <div className="absolute inset-x-0 bottom-0 h-[5%] bg-black/40" />
      </div>
    );
  return (
    <div className="pointer-events-none absolute inset-0">
      <div className="absolute inset-x-[5%] top-[9%] flex items-center gap-2">
        <div className="h-7 w-7 rounded-full bg-white/20" />
        <div className="space-y-1">
          <div className="h-1.5 w-20 rounded bg-white/30" />
          <div className="h-1.5 w-12 rounded bg-white/15" />
        </div>
      </div>
      <div className="absolute inset-x-[5%] bottom-[18%] space-y-2">
        <div className="flex gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-5 w-5 rounded-full bg-white/20" />
          ))}
        </div>
        <div className="h-1.5 w-2/3 rounded bg-white/25" />
        <div className="h-1.5 w-1/2 rounded bg-white/15" />
      </div>
    </div>
  );
}

/**
 * Safe zones over the picture. Vertical: shades where the app's buttons, header and caption block sit, and outlines what
 * stays clear. 16:9: the classic title-safe (90%) and action-safe (93%) boxes.
 */
function SafeOverlay({ mode, width }: { mode: SafeMode; width: number }) {
  const fs = Math.max(9, Math.min(13, width * 0.026));
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  if (mode === "title")
    return (
      <div className="pointer-events-none absolute inset-0 z-10">
        <div className="absolute border border-dashed border-white/35" style={{ inset: "3.5%" }} />
        <div className="absolute border border-dashed border-gold/80" style={{ inset: "5%" }}>
          <span className="absolute left-1 top-0.5 font-medium text-gold/90" style={{ fontSize: fs }}>Title safe 90%</span>
        </div>
      </div>
    );
  const m = marginsFor(mode)!;
  const f = fractions(m);
  const plat = mode === "all" ? null : PLATFORMS[mode as Platform];
  const ui = plat?.ui;
  const shade = "absolute bg-[repeating-linear-gradient(135deg,rgba(255,80,60,.16)_0_6px,rgba(255,80,60,.05)_6px_12px)]";
  const tag = (text: string) => (
    <span className="rounded bg-black/55 px-1.5 py-0.5 font-medium leading-tight text-white/85" style={{ fontSize: fs }}>{text}</span>
  );
  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      <div className={cx(shade, "inset-x-0 top-0 flex items-start justify-center pt-[1.5%]")} style={{ height: pct(f.top) }}>{tag(ui ? ui.top : "App header")}</div>
      <div className={cx(shade, "inset-x-0 bottom-0 flex items-end justify-center pb-[1.5%]")} style={{ height: pct(f.bottom) }}>{tag(ui ? ui.bottom : "Caption, handle, sound")}</div>
      <div className={cx(shade, "right-0 flex items-start justify-center pt-[2%]")} style={{ top: pct(f.top), bottom: pct(f.bottom), width: pct(f.right) }}>
        <span className="rounded bg-black/55 px-0.5 py-1.5 font-medium text-white/85 [writing-mode:vertical-rl]" style={{ fontSize: fs }}>{ui ? ui.right : "Buttons"}</span>
      </div>
      <div className={shade} style={{ top: pct(f.top), bottom: pct(f.bottom), left: 0, width: pct(f.left) }} />
      <div className="absolute border border-dashed border-gold/90" style={{ top: pct(f.top), bottom: pct(f.bottom), left: pct(f.left), right: pct(f.right) }}>
        <span className="absolute left-1 top-0.5 font-semibold text-gold" style={{ fontSize: fs }}>
          {mode === "all" ? "Clear on TikTok, Reels and Shorts" : `Clear on ${plat!.label}`}
        </span>
      </div>
    </div>
  );
}
