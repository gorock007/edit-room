import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { Comment, Device, EditModel, Target } from "../types";
import { cx } from "../util";
import { Composer } from "./Composer";

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
  onSubmit: (c: { text: string; t: number; x: number | null; y: number | null; target: Target }) => void;
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

  const W = p.model.width, H = p.model.height;
  const aspect = W / H;
  const portraitVideo = aspect < 1;
  const pad = 28;
  const room = { w: Math.max(200, avail.w - pad * 2), h: Math.max(200, avail.h - pad * 2) };

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
      const word = el?.closest(".w, .big") as HTMLElement | null;
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

  const pins = p.comments.filter((c) => c.x != null && Math.abs(c.t - p.time) < 1.2 && c.status !== "undone");

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
                preload="auto"
                onPlay={() => p.onVideoEvent("play")}
                onPause={() => p.onVideoEvent("pause")}
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
                onLoad={() => seekOverlay(lastT.current || p.time)}
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
            {/* click layer: plays/pauses, or in comment mode drops a pin */}
            <div className={cx("absolute inset-0", p.commentMode ? "cursor-crosshair" : "cursor-pointer")} onClick={pick} />
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
                <div
                  className="absolute z-20"
                  style={{
                    left: `clamp(8px, calc(${draft.x * 100}% - 160px), calc(100% - 328px))`,
                    top: draft.y > 0.55 ? undefined : `calc(${draft.y * 100}% + 14px)`,
                    bottom: draft.y > 0.55 ? `calc(${(1 - draft.y) * 100}% + 14px)` : undefined,
                  }}
                >
                  <Composer
                    target={draft.target}
                    t={draft.t}
                    onCancel={() => setDraft(null)}
                    onSubmit={(text) => {
                      p.onSubmit({ text, t: draft.t, x: draft.x, y: draft.y, target: draft.target });
                      setDraft(null);
                    }}
                  />
                </div>
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
