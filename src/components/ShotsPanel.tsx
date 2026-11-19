import { useEffect, useRef, useState } from "react";
import { api, type LibClip, type Shot, type ShotList, type Suggestion } from "../api";
import { uploadFile } from "../upload";
import { cx } from "../util";

type Props = {
  pid: string;
  time: number;
  /** changes when the edit changes (refetch the shots) */
  stamp: string;
  canSwap: boolean;
  full?: boolean;
  header?: React.ReactNode;
  onSeek: (t: number) => void;
  onError: (e: string) => void;
};

const secs = (n: number) => `${n.toFixed(2)} s`;
const FRAME = { tall: "full frame", strip: "wide strip", wide: "full frame" } as const;
/** What a shot's clip has to be, in words. */
const needsText = (s: Shot) =>
  s.frame === "strip" ? "a horizontal clip" : s.frame === "wide" ? "a horizontal clip (16:9)" : s.part === "b-roll" ? "a vertical clip, or a horizontal one to crop" : "a vertical clip, or a 4K horizontal one to crop";
/** The preview box: the shot's own shape. */
const boxOf = (s: Shot) => (s.frame === "strip" ? { w: 1080, h: 707 } : s.frame === "wide" ? { w: 16, h: 9 } : { w: 9, h: 16 });
const FPS = 30;
const fmtAt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;

/**
 * Shots like a CapCut template's slots: a montage edit's shots, or a house-style edit's footage b-roll. Each keeps its
 * place and length (so the cuts stay on the beat / the words) and can be swapped for another clip from the footage
 * folders or the phone, choosing exactly which part of it.
 */
export function ShotsPanel(p: Props) {
  const [list, setList] = useState<ShotList | null>(null);
  const [open, setOpen] = useState<Shot | null>(null);
  const load = () => api.shots(p.pid).then(setList).catch((e) => p.onError(e.message));
  useEffect(() => {
    load();
  }, [p.pid, p.stamp]);
  const shots = list?.shots ?? [];
  const now = shots.find((s) => p.time >= s.start && p.time < s.start + s.dur)?.i ?? -1;
  const broll = list?.mode === "broll";

  return (
    <aside className={cx("flex min-h-0 shrink-0 flex-col bg-ink-900", p.full ? "w-full" : "w-[320px] border-l border-white/5 xl:w-[380px]")}>
      {p.header && <div className="flex h-11 shrink-0 items-center border-b border-white/5 px-4">{p.header}</div>}
      <div className={cx("min-h-0 flex-1 px-3 py-3", !p.full && "overflow-y-auto")}>
        {list?.story?.line && (
          <p className="mb-3 rounded-lg bg-ink-950 px-3 py-2 text-[12px] leading-relaxed text-ink-300 ring-1 ring-white/5">
            <span className="text-ink-500">The story: </span>
            {list.story.line}
            {list.story.never.length > 0 && <span className="text-ink-500"> Never: {list.story.never.join(", ")}.</span>}
          </p>
        )}
        {!list && <p className="py-6 text-center text-[13px] text-ink-400">Loading shots…</p>}
        <ol className="space-y-1.5">
          {shots.map((s) => (
            <li key={s.i} className={cx("flex items-center gap-2.5 rounded-lg p-1.5 ring-1", s.i === now ? "bg-gold/5 ring-gold/30" : "ring-white/5")}>
              <button onClick={() => p.onSeek(s.start + 0.01)} className="relative shrink-0 overflow-hidden rounded-md bg-black" style={s.frame === "wide" ? { width: 96, height: 54 } : { width: 54, height: 96 }} aria-label={`Play shot ${s.n}`}>
                {s.file ? <img src={api.shotThumbUrl(p.pid, s.i, s.sig)} alt="" className="h-full w-full object-cover" loading="lazy" /> : null}
                <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px] font-semibold text-ink-100 tnum">{s.n}</span>
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 whitespace-nowrap text-[12px]">
                  <span className={cx("font-semibold text-ink-100", s.part !== "b-roll" && "capitalize")}>{s.part === "b-roll" ? "B-roll" : s.part}</span>
                  <span className="font-mono text-ink-500 tnum">{broll ? `at ${fmtAt(s.start)} · ${s.dur.toFixed(1)} s` : secs(s.dur)}</span>
                  {s.frame && !broll && <span className="text-[11px] text-ink-500">{FRAME[s.frame]}</span>}
                </div>
                <div className="truncate text-[12px] text-ink-300">{s.shows ?? (s.file ? s.name : "black")}</div>
                {s.why && <div className="line-clamp-2 text-[11px] leading-snug text-ink-500">{s.why}</div>}
              </div>
              {p.canSwap && s.needs && (
                <button onClick={() => setOpen(s)} className="shrink-0 rounded-md px-2.5 py-1.5 text-[12px] font-medium text-ink-200 ring-1 ring-white/10 hover:bg-white/5">
                  Swap
                </button>
              )}
            </li>
          ))}
        </ol>
        {list && shots.length === 0 && <p className="py-6 text-center text-[13px] text-ink-400">No footage b-roll in this edit.</p>}
        {shots.length > 0 && p.canSwap && (
          <p className="mt-3 text-[11px] leading-relaxed text-ink-500">
            {broll
              ? "Swapping keeps each b-roll's place and length, so it still lands on the same words. The new clip is graded like the rest (a few seconds), and Undo is in Comments. Cards and graphics aren't listed: ask Claude for those in Comments."
              : "Swapping keeps each shot's length, so the cuts stay on the beat. Only that shot is re-rendered (15–40 s), and Undo is in Comments."}
          </p>
        )}
      </div>
      {open && (
        <SwapSheet
          pid={p.pid}
          shot={open}
          onClose={() => setOpen(null)}
          onError={p.onError}
          onDone={() => {
            setOpen(null);
            load();
          }}
        />
      )}
    </aside>
  );
}

type Pick = { file: string; name: string; at: number; duration?: number };

function SwapSheet({ pid, shot, onClose, onError, onDone }: { pid: string; shot: Shot; onClose: () => void; onError: (e: string) => void; onDone: () => void }) {
  const [data, setData] = useState<{ clips: LibClip[]; suggestions: Suggestion[] } | null>(null);
  const [tab, setTab] = useState<"suggested" | "clips">("suggested");
  const [pick, setPick] = useState<Pick | null>(null);
  const [upload, setUpload] = useState<{ name: string; pct: number } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const abort = useRef(new AbortController());
  const load = () =>
    api
      .shotClips(pid, shot.i)
      .then((d) => setData({ clips: d.clips, suggestions: d.suggestions }))
      .catch((e) => onError(e.message));
  useEffect(() => {
    load();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("keydown", esc);
      abort.current.abort();
    };
  }, []);

  const fromPhone = async (f: File | undefined) => {
    if (!f) return;
    setUpload({ name: f.name, pct: 0 });
    try {
      const name = await uploadFile(pid, f, (n) => setUpload({ name: f.name, pct: Math.round((100 * n) / f.size) }), abort.current.signal, "shots");
      const d = await api.shotClips(pid, shot.i);
      setData({ clips: d.clips, suggestions: d.suggestions });
      const mine = d.clips.find((c) => c.mine && c.name === name);
      if (mine) setPick({ file: mine.file, name: mine.name, at: 0, duration: mine.duration });
      else onError(`That clip doesn't fit this shot: it needs ${needsText(shot)}.`);
    } catch (e: any) {
      if (e?.name !== "AbortError") onError(e.message);
    } finally {
      setUpload(null);
    }
  };

  const clipOf = (f: string) => data?.clips.find((c) => c.file === f);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 md:items-center" onClick={onClose}>
      <div
        role="dialog"
        aria-label={`Swap shot ${shot.n}`}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl bg-ink-900 ring-1 ring-white/10 md:max-w-2xl md:rounded-2xl"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-white/5 px-4 py-3">
          {pick && (
            <button onClick={() => setPick(null)} className="text-[13px] text-ink-300 hover:text-ink-100" aria-label="Back to clips">
              ←
            </button>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold text-ink-100">
              {shot.part === "b-roll" ? `Swap b-roll ${shot.n}` : `Swap shot ${shot.n}`}{" "}
              <span className={cx("font-normal text-ink-400", shot.part !== "b-roll" && "capitalize")}>
                · {shot.part === "b-roll" ? `at ${fmtAt(shot.start)}` : shot.part} · {secs(shot.dur)}
              </span>
            </div>
            <div className="truncate text-[12px] text-ink-500">
              {pick ? pick.name : `Needs ${needsText(shot)}. Now: ${shot.shows ?? shot.name}`}
            </div>
          </div>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-[13px] text-ink-400 hover:text-ink-100" aria-label="Close">
            ✕
          </button>
        </div>

        {pick ? (
          <Trimmer pid={pid} shot={shot} pick={{ ...pick, duration: pick.duration ?? clipOf(pick.file)?.duration }} onError={onError} onDone={onDone} />
        ) : (
          <>
            <div className="flex shrink-0 items-center gap-1 border-b border-white/5 px-3 py-2">
              {(
                [
                  ["suggested", `Suggested${data ? ` ${data.suggestions.length}` : ""}`],
                  ["clips", `Your clips${data ? ` ${data.clips.length}` : ""}`],
                ] as const
              ).map(([k, label]) => (
                <button key={k} onClick={() => setTab(k)} className={cx("rounded-md px-2.5 py-1 text-[12px] font-medium", tab === k ? "bg-ink-700 text-ink-100" : "text-ink-400 hover:text-ink-200")}>
                  {label}
                </button>
              ))}
              <div className="flex-1" />
              <button onClick={() => file.current?.click()} disabled={!!upload} className="rounded-md bg-gold px-2.5 py-1 text-[12px] font-semibold text-ink-950 hover:brightness-110 disabled:opacity-50">
                {upload ? `Uploading ${upload.pct}%` : "From phone…"}
              </button>
              <input ref={file} type="file" accept="video/*" className="hidden" onChange={(e) => (fromPhone(e.target.files?.[0]), (e.target.value = ""))} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {!data && <p className="py-8 text-center text-[13px] text-ink-400">Finding clips that fit…</p>}
              {data && tab === "suggested" && (
                <>
                  <p className="mb-2 text-[11px] text-ink-500">
                    {shot.part === "b-roll" ? "Best-looking moments of the right shape" : "Best-looking moments that fit the story"}, labelled on this Mac. Moments the edit already uses are left out.
                  </p>
                  {data.suggestions.length === 0 && <p className="py-6 text-center text-[13px] text-ink-400">No suggestions: try Your clips, or add one from your phone.</p>}
                  <div className={cx("grid gap-2", shot.frame === "tall" ? "grid-cols-3 md:grid-cols-4" : "grid-cols-2 md:grid-cols-3")}>
                    {data.suggestions.map((s) => (
                      <button key={`${s.file}@${s.t}`} onClick={() => setPick({ file: s.file, name: s.file.split("/").pop()!, at: s.t })} className="group overflow-hidden rounded-lg bg-black text-left ring-1 ring-white/10 hover:ring-gold/50">
                        <img src={api.clipFrameUrl(pid, s.file, s.t)} alt="" loading="lazy" className="aspect-video w-full object-cover" />
                        <div className="px-2 py-1.5">
                          <div className="truncate text-[11px] text-ink-200">{s.file.split("/").pop()} · {s.t.toFixed(1)} s</div>
                          <div className="truncate text-[10px] text-ink-500">{s.labels.join(", ")}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}
              {data && tab === "clips" && (
                <div className={cx("grid gap-2", "grid-cols-2 md:grid-cols-3")}>
                  {data.clips.map((c) => (
                    <button key={c.file} onClick={() => setPick({ file: c.file, name: c.name, at: c.at, duration: c.duration })} className="overflow-hidden rounded-lg bg-black text-left ring-1 ring-white/10 hover:ring-gold/50">
                      <img src={api.clipFrameUrl(pid, c.file, c.at)} alt="" loading="lazy" className="aspect-video w-full object-cover" />
                      <div className="px-2 py-1.5">
                        <div className="truncate text-[11px] text-ink-200">{c.name}</div>
                        <div className="flex gap-1.5 text-[10px] text-ink-500">
                          <span className="tnum">{c.duration.toFixed(1)} s</span>
                          {c.mine && <span className="text-gold">from phone</span>}
                          {c.screens >= 0.15 && <span className="text-red-300">screens {Math.round(c.screens * 100)} %</span>}
                          {c.outdoors >= 0.5 && <span>outdoors</span>}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Pick which part of the clip fills the shot: a window locked to the shot's length, looped and framed as it'll look. */
function Trimmer({ pid, shot, pick, onError, onDone }: { pid: string; shot: Shot; pick: Pick; onError: (e: string) => void; onDone: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [dur, setDur] = useState(pick.duration ?? 0);
  const [start, setStart] = useState(Math.max(0, pick.at));
  const [frame, setFrame] = useState(0.5);
  const box = boxOf(shot);
  // the clip's shape once it loads: the framing slider only matters when the clip is cropped to fit
  const [shape, setShape] = useState<{ w: number; h: number } | null>(null);
  const cropsSideways = !shape || shape.w / shape.h > box.w / box.h + 0.01;
  const [saving, setSaving] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const len = shot.dur;
  const max = Math.max(0, dur - len - 0.02);

  // the small H.264 copy for scrubbing; made once per clip (a long 4K clip takes a little while the first time)
  useEffect(() => {
    let stop = false;
    let t: ReturnType<typeof setTimeout>;
    const poll = () =>
      api
        .clipPreview(pid, pick.file)
        .then((r) => {
          if (stop) return;
          if (r.state === "ready" && r.url) setUrl(r.url);
          else if (r.state === "failed") onError("Couldn't make a preview of that clip.");
          else t = setTimeout(poll, 1500);
        })
        .catch((e) => onError(e.message));
    poll();
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [pick.file]);

  // loop the chosen window
  useEffect(() => {
    const v = video.current;
    if (!v || !url) return;
    let raf = 0;
    const tick = () => {
      if (v.currentTime < start - 0.05 || v.currentTime >= start + len) v.currentTime = start;
      raf = requestAnimationFrame(tick);
    };
    v.currentTime = start;
    v.play().catch(() => {});
    raf = requestAnimationFrame(tick);
    // animation frames stop in a background tab: the time events keep the loop inside the window there too
    const onTime = () => {
      if (v.currentTime < start - 0.05 || v.currentTime >= start + len) v.currentTime = start;
    };
    v.addEventListener("timeupdate", onTime);
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener("timeupdate", onTime);
    };
  }, [url, start, len]);

  const clampStart = (t: number) => Math.max(0, Math.min(max, Math.round(t * FPS) / FPS));
  const nudge = (d: number) => setStart((s) => clampStart(s + d));
  const tall = shot.frame === "tall";
  const save = async () => {
    setSaving(true);
    try {
      await api.swapShot(pid, shot.i, { file: pick.file, src: start, cx: frame });
      onDone();
    } catch (e: any) {
      onError(e.message);
      setSaving(false);
    }
  };
  const pct = (t: number) => `${dur ? (100 * t) / dur : 0}%`;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto overflow-hidden rounded-lg bg-black ring-1 ring-white/10" style={{ aspectRatio: `${box.w} / ${box.h}`, maxHeight: tall ? "46dvh" : undefined, width: tall ? "auto" : "100%" }}>
        {url ? (
          <video
            ref={video}
            src={url}
            muted
            playsInline
            preload="auto"
            onLoadedMetadata={(e) => {
              setDur(e.currentTarget.duration || dur);
              setShape({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight });
            }}
            className="h-full w-full object-cover"
            style={{ objectPosition: `${frame * 100}% 50%` }}
          />
        ) : (
          <div className="grid h-full w-full place-items-center px-6 text-center text-[12px] text-ink-400">Preparing a preview of this clip…</div>
        )}
      </div>
      <p className="mt-1.5 text-center text-[11px] text-ink-500">Looping the {secs(len)} that will fill the shot, framed as it will look.</p>

      <div className="mt-4">
        <div className="relative h-8 rounded-md bg-ink-950 ring-1 ring-white/10">
          <div className="absolute inset-y-0 rounded-md bg-gold/30 ring-1 ring-gold" style={{ left: pct(start), width: `max(6px, ${pct(len)})` }} />
          <input
            type="range"
            min={0}
            max={max || 0}
            step={1 / FPS}
            value={Math.min(start, max)}
            onChange={(e) => setStart(clampStart(Number(e.target.value)))}
            aria-label="Which part of the clip"
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 text-[12px]">
          <div className="flex gap-1">
            {[
              [-1, "−1 s"],
              [-1 / FPS, "−1 f"],
            ].map(([d, l]) => (
              <button key={l as string} onClick={() => nudge(d as number)} className="rounded-md px-2 py-1 text-ink-300 ring-1 ring-white/10 hover:bg-white/5">
                {l}
              </button>
            ))}
          </div>
          <span className="font-mono text-ink-300 tnum">
            {start.toFixed(2)}–{(start + len).toFixed(2)} s <span className="text-ink-500">of {dur.toFixed(1)} s</span>
          </span>
          <div className="flex gap-1">
            {[
              [1 / FPS, "+1 f"],
              [1, "+1 s"],
            ].map(([d, l]) => (
              <button key={l as string} onClick={() => nudge(d as number)} className="rounded-md px-2 py-1 text-ink-300 ring-1 ring-white/10 hover:bg-white/5">
                {l}
              </button>
            ))}
          </div>
        </div>
      </div>

      <label className={cx("mt-4 block text-[12px] text-ink-300", !cropsSideways && "hidden")}>
        Framing <span className="text-ink-500">(slide to move the picture left or right)</span>
        <input type="range" min={0} max={1} step={0.01} value={frame} onChange={(e) => setFrame(Number(e.target.value))} className="mt-1.5 w-full accent-[var(--color-gold)]" />
      </label>

      <div className="mt-5 flex items-center justify-end gap-3">
        {saving && <span className="text-[12px] text-ink-400">{shot.part === "b-roll" ? "Grading the clip… about 5–15 s" : "Rendering the shot… 15–40 s"}</span>}
        <button onClick={save} disabled={saving || !dur || dur < len} className="rounded-lg bg-gold px-4 py-2 text-[13px] font-semibold text-ink-950 hover:brightness-110 disabled:opacity-40">
          {saving ? "Saving…" : "Use this part"}
        </button>
      </div>
      {dur > 0 && dur < len && <p className="mt-2 text-right text-[12px] text-red-300">This clip is shorter than the shot ({secs(len)}).</p>}
    </div>
  );
}
