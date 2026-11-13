import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, useSocket } from "./api";
import { SoundEngine } from "./sound";
import type { Comment, Device, EditModel, ProjectInfo, ProxyState, Target } from "./types";
import { clamp, cx, fmt } from "./util";
import { Stage, type StageHandle } from "./components/Stage";
import { Timeline } from "./components/Timeline";
import { CommentsPanel, Kbd } from "./components/CommentsPanel";

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

export default function App() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [pid, setPid] = useState<string | null>(store.get("room.project"));
  const [model, setModel] = useState<EditModel | null>(null);
  const [proxy, setProxy] = useState<ProxyState | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [device, setDevice] = useState<Device>((store.get("room.device") as Device) || "desktop");
  const [commentMode, setCommentMode] = useState(false);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [overlayAt, setOverlayAt] = useState(0);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [sfxOn, setSfxOn] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const stage = useRef<StageHandle>(null);
  const engine = useMemo(() => new SoundEngine(), []);

  useEffect(() => {
    api.projects().then((ps) => {
      setProjects(ps);
      if (!pid || !ps.some((p) => p.id === pid)) setPid(ps[0]?.id ?? null);
    }).catch((e) => setError(String(e.message)));
  }, []);

  const loadModel = useCallback(async (id: string) => {
    try {
      const r = await api.model(id);
      setModel(r.model);
      setProxy(r.proxy);
      setError(null);
      engine.load(r.model.sfx, (s) => api.fileUrl(id, s.file));
    } catch (e: any) {
      setError(e.message);
    }
  }, [engine]);

  useEffect(() => {
    if (!pid) return;
    store.set("room.project", pid);
    setModel(null);
    setTime(0);
    loadModel(pid);
    api.comments(pid).then(setComments);
  }, [pid, loadModel]);
  useEffect(() => store.set("room.device", device), [device]);
  useEffect(() => engine.setMuted(!sfxOn), [sfxOn, engine]);

  const online = useSocket((m) => {
    if (m.type === "comment" && m.comment.project === pid)
      setComments((cs) => (cs.some((c) => c.id === m.comment.id) ? cs.map((c) => (c.id === m.comment.id ? m.comment : c)) : [...cs, m.comment]));
    if (m.type === "project" && m.id === pid) {
      setProxy(m.proxy);
      loadModel(pid); // sounds, cuts or b-roll may have changed in the draft
    }
    if (m.type === "overlay" && m.id === pid) setOverlayAt(m.at);
  });

  // playback clock: the video drives everything else
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = stage.current?.video;
      if (v) {
        setTime(v.currentTime);
        stage.current?.seekOverlay(v.currentTime);
      }
      raf = requestAnimationFrame(tick);
    };
    if (playing) raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const seek = useCallback((t: number) => {
    const v = stage.current?.video;
    const d = model?.duration ?? 0;
    const tt = clamp(t, 0, Math.max(0, d - 0.01));
    if (v) v.currentTime = tt;
    setTime(tt);
    stage.current?.seekOverlay(tt);
  }, [model]);

  const toggle = useCallback(() => {
    const v = stage.current?.video;
    if (!v) return;
    v.paused ? v.play() : v.pause();
  }, []);

  const onVideoEvent = (e: "play" | "pause" | "seeked" | "loaded") => {
    const v = stage.current?.video;
    if (!v) return;
    if (e === "play") {
      setPlaying(true);
      engine.schedule(v.currentTime);
    }
    if (e === "pause") {
      setPlaying(false);
      engine.stop();
    }
    if (e === "seeked") {
      if (!v.paused) engine.schedule(v.currentTime);
      setTime(v.currentTime);
      stage.current?.seekOverlay(v.currentTime);
    }
    if (e === "loaded") {
      v.currentTime = time;
      stage.current?.seekOverlay(time);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("textarea, input, select")) return;
      const fps = model?.fps ?? 30;
      if (e.key === " ") {
        e.preventDefault();
        toggle();
      } else if (e.key === "c" || e.key === "C") setCommentMode((m) => !m);
      else if (e.key === "Escape") setCommentMode(false);
      else if (e.key === "ArrowLeft") seek(time - (e.shiftKey ? 1 : 1 / fps));
      else if (e.key === "ArrowRight") seek(time + (e.shiftKey ? 1 : 1 / fps));
      else if (e.key === "1") setDevice("desktop");
      else if (e.key === "2") setDevice("phone");
      else if (e.key === "3") setDevice("feed");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, seek, time, model]);

  const submit = async (c: { text: string; t: number; x: number | null; y: number | null; target: Target }) => {
    if (!pid) return;
    const saved = await api.post(pid, c);
    setComments((cs) => (cs.some((x) => x.id === saved.id) ? cs : [...cs, saved]));
    setFocusId(saved.id);
    setCommentMode(false);
  };

  const proxyUrl = pid && proxy && proxy.version > 0 ? `/media/${pid}/proxy.mp4?v=${proxy.version}` : null;
  const proxyNote =
    !proxy ? "Loading…" :
    proxy.status === "building" ? (proxy.version ? "Updating the picture…" : "Building the preview — about a minute") :
    proxy.status === "failed" ? `Picture build failed` :
    proxy.status === "missing" ? "Preparing preview…" : null;
  const overlayUrl = pid && model?.hasOverlay ? `/overlay/${pid}/index.html?at=${overlayAt}` : null;
  const busy = comments.filter((c) => c.status === "working").length;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-white/5 bg-ink-900 px-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="grid h-6 w-6 place-items-center rounded-md bg-gold text-[12px] font-black text-ink-950">E</div>
            <span className="text-[13px] font-semibold tracking-tight">Edit Room</span>
          </div>
          <span className="text-ink-600">/</span>
          <select
            value={pid ?? ""}
            onChange={(e) => setPid(e.target.value)}
            className="rounded-md bg-transparent py-1 pr-1 text-[13px] font-medium text-ink-100 outline-none hover:bg-white/5"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id} className="bg-ink-900">
                {p.name}
              </option>
            ))}
          </select>
          {model && <span className="font-mono text-[11px] text-ink-500 tnum">{model.width}×{model.height} · {fmt(model.duration)}</span>}
        </div>

        <Segmented
          value={device}
          onChange={setDevice}
          options={[
            ["desktop", "Desktop", "1"],
            ["phone", "Phone", "2"],
            ["feed", "In feed", "3"],
          ]}
        />

        <div className="flex items-center gap-3 text-[12px]">
          {proxy?.status === "stale" && (
            <button onClick={() => pid && api.rebuild(pid)} className="rounded-md px-2 py-1 text-gold ring-1 ring-gold/30 hover:bg-gold/10">
              Picture changed · rebuild
            </button>
          )}
          <span className={cx("flex items-center gap-1.5", busy ? "text-gold" : "text-ink-400")}>
            <span className={cx("h-1.5 w-1.5 rounded-full", busy ? "bg-gold pulse-ring" : online ? "bg-sfx" : "bg-red-400")} />
            {busy ? `Claude is editing` : online ? "Connected" : "Reconnecting…"}
          </span>
        </div>
      </header>

      {error && <div className="bg-red-500/10 px-4 py-2 text-[12px] text-red-300">{error}</div>}

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          {model ? (
            <Stage
              ref={stage}
              model={model}
              proxyUrl={proxyUrl}
              proxyNote={proxyNote}
              overlayUrl={overlayUrl}
              device={device}
              time={time}
              commentMode={commentMode}
              comments={comments}
              focusId={focusId}
              onFocus={setFocusId}
              onSubmit={submit}
              onVideoEvent={onVideoEvent}
            />
          ) : (
            <div className="grid flex-1 place-items-center text-[13px] text-ink-400">{error ? "" : "Loading project…"}</div>
          )}

          {model && (
            <>
              <div className="flex h-11 shrink-0 items-center gap-3 border-t border-white/5 bg-ink-900 px-4">
                <button onClick={toggle} className="grid h-7 w-7 place-items-center rounded-full bg-ink-100 text-ink-950 hover:bg-white" title="Play / pause (Space)">
                  {playing ? (
                    <svg width="10" height="12" viewBox="0 0 10 12"><rect width="3" height="12" fill="currentColor" /><rect x="7" width="3" height="12" fill="currentColor" /></svg>
                  ) : (
                    <svg width="11" height="12" viewBox="0 0 11 12" className="ml-0.5"><path d="M0 0L11 6L0 12Z" fill="currentColor" /></svg>
                  )}
                </button>
                <span className="font-mono text-[12px] text-ink-200 tnum">
                  {fmt(time, true, model.fps)} <span className="text-ink-500">/ {fmt(model.duration)}</span>
                </span>
                <button
                  onClick={() => setSfxOn(!sfxOn)}
                  className={cx("rounded-md px-2 py-1 text-[11px] ring-1", sfxOn ? "text-sfx ring-sfx/30" : "text-ink-500 ring-white/10 line-through")}
                  title="Sound effects on/off (voice stays on)"
                >
                  SFX
                </button>
                <div className="flex-1" />
                <span className="hidden text-[11px] text-ink-500 lg:block">
                  <Kbd>Space</Kbd> play · <Kbd>←</Kbd><Kbd>→</Kbd> frame · <Kbd>1</Kbd><Kbd>2</Kbd><Kbd>3</Kbd> device
                </span>
                <button
                  onClick={() => setCommentMode(!commentMode)}
                  className={cx(
                    "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition",
                    commentMode ? "bg-gold text-ink-950" : "bg-white/5 text-ink-100 ring-1 ring-white/10 hover:bg-white/10",
                  )}
                  title="Comment mode (C)"
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v6a1.5 1.5 0 01-1.5 1.5H7l-3.5 3v-3h0A1.5 1.5 0 012 9.5v-6z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>
                  {commentMode ? "Click what to change" : "Comment"}
                  {!commentMode && <span className="font-mono text-[10px] opacity-50">C</span>}
                </button>
              </div>
              <Timeline
                model={model}
                time={time}
                comments={comments}
                commentMode={commentMode}
                onSeek={seek}
                onSolo={(s) => engine.solo(s)}
                onSubmit={submit}
                onFocus={setFocusId}
              />
            </>
          )}
        </main>

        <CommentsPanel
          comments={comments}
          time={time}
          focusId={focusId}
          onFocus={setFocusId}
          onSeek={seek}
          onStop={(id) => pid && api.stop(pid, id)}
          onUndo={(id) => pid && api.undo(pid, id).catch((e) => setError(e.message))}
          onSubmit={submit}
        />
      </div>
    </div>
  );
}

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string, string][] }) {
  return (
    <div className="flex rounded-lg bg-ink-950 p-0.5 ring-1 ring-white/5">
      {options.map(([v, label, key]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={cx("rounded-md px-3 py-1 text-[12px] font-medium transition", value === v ? "bg-ink-700 text-ink-100 shadow" : "text-ink-400 hover:text-ink-200")}
          title={`${label} (${key})`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
