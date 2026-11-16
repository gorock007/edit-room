import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, useSocket } from "./api";
import { SoundEngine } from "./sound";
import { can, type Comment, type Device, type EditModel, type ExportState, type Person, type Presence, type ProjectInfo, type ProxyState, type Target } from "./types";
import { MeContext } from "./room";
import { Avatar, SharePanel } from "./components/People";
import { ROLE_INFO } from "./Join";
import { clamp, cx, fmt } from "./util";
import { Stage, type StageHandle } from "./components/Stage";
import { Timeline } from "./components/Timeline";
import { CommentsPanel, Kbd } from "./components/CommentsPanel";
import { NewEdit } from "./components/NewEdit";
import { ExportMenu } from "./components/ExportMenu";
import { SAFE_LABEL, modesFor, type SafeMode } from "./safezones";

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

type Cell = { key: string; title: string; note?: string; model: EditModel; proxyUrl: string | null; proxyNote: string | null; overlayUrl: string | null };
const VERTICAL_ASK =
  "Make the 9:16 version of this edit as its own CapCut project. Follow the talking-head-reel-edit skill's " +
  "\"9:16 version\" section: re-lay out every card and animation with verticalize_card.py and check each one, build " +
  "the 9:16 captions (canvas 1080x1920, below the face, inside the all-apps safe box), then make_vertical.py with the " +
  "framing fixed per take. Leave the 16:9 project untouched. Reply with what you made and anything that still looks off.";

/** The "New edit" page before its folder exists (it is made when the first file is picked). */
const NEW = "__new";

type NewComment = { text: string; t: number; x: number | null; y: number | null; target: Target; want: number };

/** True while the window is phone-width. */
function useNarrow() {
  const q = "(max-width: 767px)";
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return m;
}

type AppProps = { me: Person & { projects: "all" | string[] }; remote: boolean; publicUrl: string | null; onMeChanged: () => void; onLogout: () => void };

export default function App({ me, remote, onMeChanged, onLogout }: AppProps) {
  const editor = can(me, "editor");
  const commenter = can(me, "commenter");
  const startsEdits = editor && me.projects === "all";
  const [presence, setPresence] = useState<Presence[]>([]);
  const [sharing, setSharing] = useState(false);
  const narrow = useNarrow();
  const [tab, setTab] = useState<"comments" | "timeline">("comments");
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [pid, setPid] = useState<string | null>(store.get("room.project"));
  const [model, setModel] = useState<EditModel | null>(null);
  const [proxy, setProxy] = useState<ProxyState | null>(null);
  const [exportSt, setExportSt] = useState<ExportState | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [device, setDevice] = useState<Device>((store.get("room.device") as Device) || "desktop");
  const [commentMode, setCommentMode] = useState(false);
  const [time, setTime] = useState(0);
  const timeRef = useRef(0); // latest time, so a held arrow key keeps stepping between renders
  timeRef.current = time;
  const [playing, setPlaying] = useState(false);
  const [overlayAt, setOverlayAt] = useState(0);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [sfxOn, setSfxOn] = useState(true);
  const [safePick, setSafePick] = useState<SafeMode>((store.get("room.safe") as SafeMode) || "off");
  const portrait = !!model && model.height > model.width;
  const safeModes = modesFor(portrait);
  // one remembered choice: "on" in one shape stays on when the next project has the other shape
  const safe: SafeMode = safeModes.includes(safePick) ? safePick : safePick === "off" ? "off" : portrait ? "all" : "title";
  const setSafe = (m: SafeMode) => {
    setSafePick(m);
    store.set("room.safe", m);
  };
  const [error, setError] = useState<string | null>(null);
  // side-by-side compare of a comment's options
  const [compareId, setCompareId] = useState<string | null>(null);
  const [optModels, setOptModels] = useState<Record<string, { model: EditModel; proxy: ProxyState }>>({});
  const [listen, setListen] = useState("current");
  const players = useRef<(StageHandle | null)[]>([]);
  const engine = useMemo(() => new SoundEngine(), []);
  const focusRef = useRef(focusId);
  focusRef.current = focusId;

  useEffect(() => {
    api.projects().then((ps) => {
      setProjects(ps);
      if (!pid || !ps.some((p) => p.id === pid)) setPid(ps[0]?.id ?? (startsEdits ? NEW : null)); // no edits yet: start one
    }).catch((e) => setError(String(e.message)));
  }, []);

  const loadModel = useCallback(async (id: string) => {
    try {
      const r = await api.model(id);
      setModel(r.model);
      setProxy(r.proxy);
      setError(null);
    } catch (e: any) {
      if (!/no CapCut draft/.test(e.message)) setError(e.message); // a new edit before its first build
    }
  }, []);

  const info = projects.find((p) => p.id === pid);
  const draftless = pid === NEW || (!!info && !info.hasDraft);
  useEffect(() => {
    if (!pid) return;
    setModel(null);
    setProxy(null);
    setExportSt(null);
    setTime(0);
    setCompareId(null);
    if (pid === NEW) return setComments([]);
    store.set("room.project", pid);
    api.comments(pid).then(setComments);
    api.exportState(pid).then(setExportSt).catch(() => {});
  }, [pid]);
  // the model needs a draft: a new edit gets one when Claude has built it
  useEffect(() => {
    if (pid && pid !== NEW && info?.hasDraft !== false) loadModel(pid);
  }, [pid, info?.hasDraft, loadModel]);
  const showNew = draftless && !model;
  useEffect(() => store.set("room.device", device), [device]);
  useEffect(() => engine.setMuted(!sfxOn), [sfxOn, engine]);
  useEffect(() => {
    const wake = () => {
      if (engine.ctx.state === "suspended") engine.ctx.resume();
    };
    window.addEventListener("pointerdown", wake);
    return () => window.removeEventListener("pointerdown", wake);
  }, [engine]);

  const compare = comments.find((c) => c.id === compareId && c.status === "review") ?? null;

  // fetch each option's model (its captions and sounds); refetch when an option's picture finishes
  const optionSig = compare?.options?.map((o) => `${o.key}:${o.picture}`).join(",") ?? "";
  useEffect(() => {
    if (!pid || !compare) return;
    for (const o of compare.options ?? [])
      api.optionModel(pid, compare.id, o.key).then((r) => setOptModels((m) => ({ ...m, [`${compare.id}/${o.key}`]: r }))).catch(() => {});
  }, [pid, compare?.id, optionSig]);

  const proxyUrl = pid && proxy && proxy.version > 0 ? `/media/${pid}/proxy.mp4?v=${proxy.version}` : null;
  const proxyNote =
    !proxy ? "Loading…" :
    proxy.status === "building" ? (proxy.version ? "Updating the picture…" : "Building the preview — about a minute") :
    proxy.status === "failed" ? "Picture build failed" :
    proxy.status === "missing" ? "Preparing preview…" : null;
  const overlayUrl = pid && model?.hasOverlay ? `/overlay/${pid}/index.html?at=${overlayAt}` : null;

  const cells: Cell[] = useMemo(() => {
    if (!model) return [];
    const current: Cell = { key: "current", title: compare ? "Current" : "", model, proxyUrl, proxyNote, overlayUrl };
    if (!compare || !pid) return [current];
    return [
      current,
      ...(compare.options ?? []).map((o): Cell => {
        const om = optModels[`${compare.id}/${o.key}`];
        const own = o.pictureChanged;
        return {
          key: o.key,
          title: `Option ${o.key}`,
          note: o.note,
          model: om?.model ?? model,
          proxyUrl: own ? (o.picture === "ready" && om ? `/media/${pid}/options/${compare.id}/${o.key}/proxy.mp4?v=${om.proxy.version}` : null) : proxyUrl,
          proxyNote: own && o.picture !== "ready" ? (o.picture === "failed" ? "This option's picture failed to build" : "Building this option's picture…") : own && !om ? "Loading…" : proxyNote,
          overlayUrl: model.hasOverlay ? `/overlay/${pid}/o/${compare.id}/${o.key}/index.html?at=${overlayAt}` : null,
        };
      }),
    ];
  }, [model, compare, pid, optModels, proxyUrl, proxyNote, overlayUrl, overlayAt]);

  // the sounds you hear are the listened cell's (or the edit's, outside compare)
  const listened = cells.find((c) => c.key === listen) ?? cells[0];
  useEffect(() => {
    if (!pid || !listened) return;
    engine.load(listened.model.sfx, (s) => api.fileUrl(pid, s.file)).then(() => {
      const v = players.current[0]?.video;
      if (v && !v.paused) engine.schedule(v.currentTime);
    });
  }, [listened?.model, pid, engine]);
  useEffect(() => {
    if (!compare) setListen("current");
  }, [compare]);

  const { online, send } = useSocket((m) => {
    if (m.type === "presence") setPresence(m.people);
    if (m.type === "me") onMeChanged(); // the owner changed my role or projects
    if (m.type === "people") window.dispatchEvent(new Event("room:people"));
    if (m.type === "comment" && m.comment.project === pid) {
      setComments((cs) => {
        const prev = cs.find((c) => c.id === m.comment.id);
        // open the comparison by itself when the options you are looking at are ready
        if (m.comment.status === "review" && prev?.status !== "review" && focusRef.current === m.comment.id) setCompareId(m.comment.id);
        return prev ? cs.map((c) => (c.id === m.comment.id ? m.comment : c)) : [...cs, m.comment];
      });
    }
    if (m.type === "project" && m.id === pid) {
      setProxy(m.proxy);
      loadModel(pid); // sounds, cuts or b-roll may have changed in the draft
    }
    if (m.type === "overlay" && m.id === pid) setOverlayAt(m.at);
    if (m.type === "export" && m.id === pid) setExportSt(m.export);
  });

  // tell the room where I am: the project I have open and my playhead (at most 4 times a second, the last one always)
  const presTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const presLast = useRef(0);
  useEffect(() => {
    if (!online) return;
    const msg = { type: "presence", project: pid && pid !== NEW ? pid : null, t: time, playing };
    clearTimeout(presTimer.current);
    const out = () => {
      presLast.current = Date.now();
      send(msg);
    };
    if (Date.now() - presLast.current > 250) out();
    else presTimer.current = setTimeout(out, 260);
  }, [online, pid, time, playing, send]);
  useEffect(() => () => clearTimeout(presTimer.current), []);
  // everyone else with this project open (my own other devices too would only be noise)
  const others = presence.filter((x) => x.project === pid && x.id !== me.id);
  const othersByPerson = [...new Map(others.map((o) => [o.id, o])).values()];

  const leader = () => players.current[0];
  const all = () => players.current.slice(0, cells.length).filter(Boolean) as StageHandle[];

  // playback clock: the first player's video drives the others, the captions and the sounds
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = leader()?.video;
      if (v) {
        const t = v.currentTime;
        setTime(t);
        for (const p of all()) {
          const f = p.video;
          if (f && f !== v) {
            if (Math.abs(f.currentTime - t) > 0.12) f.currentTime = t;
            if (f.paused) f.play().catch(() => {});
          }
          p.seekOverlay(t);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    if (playing) raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, cells.length]);

  const seek = useCallback((t: number) => {
    const tt = clamp(t, 0, Math.max(0, (model?.duration ?? 0) - 0.01));
    for (const p of all()) {
      if (p.video) p.video.currentTime = tt;
      p.seekOverlay(tt);
    }
    setTime(tt);
  }, [model, cells.length]);

  const toggle = useCallback(() => {
    const v = leader()?.video;
    if (v) v.paused ? v.play() : v.pause();
  }, []);

  const leaderEvent = (e: "play" | "pause" | "seeked" | "loaded") => {
    const v = leader()?.video;
    if (!v) return;
    if (e === "play") {
      setPlaying(true);
      engine.schedule(v.currentTime);
    }
    if (e === "pause") {
      setPlaying(false);
      engine.stop();
      for (const p of all()) if (p.video && p.video !== v) p.video.pause();
    }
    if (e === "seeked") {
      if (!v.paused) engine.schedule(v.currentTime);
      setTime(v.currentTime);
      for (const p of all()) p.seekOverlay(v.currentTime);
    }
    if (e === "loaded") {
      v.currentTime = time;
      leader()?.seekOverlay(time);
    }
  };
  const followerEvent = (i: number) => (e: "play" | "pause" | "seeked" | "loaded") => {
    const f = players.current[i]?.video;
    if (e === "loaded" && f) {
      f.currentTime = leader()?.video?.currentTime ?? time;
      players.current[i]?.seekOverlay(f.currentTime);
      if (playing) f.play().catch(() => {});
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("textarea, input, select")) return;
      const fps = model?.fps ?? 30;
      if (e.key === " ") {
        e.preventDefault();
        toggle();
      } else if ((e.key === "c" || e.key === "C") && !compare && commenter) setCommentMode((m) => !m);
      else if (e.key === "Escape") {
        setCommentMode(false);
        setCompareId(null);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        // like CapCut: one frame per press (hold to keep moving), Shift = one second
        e.preventDefault();
        const dir = e.key === "ArrowLeft" ? -1 : 1;
        timeRef.current = clamp(timeRef.current + dir * (e.shiftKey ? 1 : 1 / fps), 0, Math.max(0, (model?.duration ?? 0) - 0.01));
        seek(timeRef.current);
      }
      else if (e.key === "1") setDevice("desktop");
      else if (e.key === "2") setDevice("phone");
      else if (e.key === "3") setDevice("feed");
      else if (e.key === "s" || e.key === "S") setSafe(safeModes[(safeModes.indexOf(safe) + 1) % safeModes.length]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, seek, time, model, compare, safe]);

  // a finished request can create a project (the 9:16 version): pick it up
  const doneCount = comments.filter((c) => c.status === "done").length;
  useEffect(() => {
    api.projects().then(setProjects).catch(() => {});
  }, [doneCount]);

  const submit = async (c: NewComment) => {
    if (!pid) return;
    const saved = await api.post(pid, c);
    setComments((cs) => (cs.some((x) => x.id === saved.id) ? cs : [...cs, saved]));
    setFocusId(saved.id);
    setCommentMode(false);
  };

  const pick = async (key: string) => {
    if (!pid || !compare) return;
    try {
      await api.pick(pid, compare.id, key);
      setCompareId(null);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const busy = comments.filter((c) => c.status === "working").length;
  const cols = narrow || cells.length <= 1 ? 1 : 2;
  const dev: Device = narrow ? "desktop" : device; // on a real phone the phone is the frame
  const aspect = model ? `${model.width} / ${model.height}` : "16 / 9";
  const rows = Math.ceil(cells.length / cols);

  const decline = (cid: string) => {
    if (!pid) return;
    const reason = prompt("Decline this comment? Add a short reason if you like; they'll see it.");
    if (reason === null) return;
    api.decline(pid, cid, reason).catch((e) => setError(e.message));
  };

  return (
    <MeContext.Provider value={me}>
    <div className="flex h-full flex-col">
      {sharing && <SharePanel me={me} pid={pid && pid !== NEW ? pid : null} projects={projects} onClose={() => setSharing(false)} onMeChanged={onMeChanged} />}
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-white/5 bg-ink-900 px-3 md:px-4">
        <div className="flex min-w-0 items-center gap-2 md:gap-3">
          <div className="flex items-center gap-2">
            <div className="grid h-6 w-6 place-items-center rounded-md bg-gold text-[12px] font-black text-ink-950">E</div>
            <span className="hidden whitespace-nowrap text-[13px] font-semibold tracking-tight lg:inline">Edit Room</span>
          </div>
          <span className="hidden text-ink-600 lg:inline">/</span>
          <select
            value={pid ?? ""}
            onChange={(e) => setPid(e.target.value)}
            title="Project"
            className="min-w-0 rounded-md bg-transparent py-1 pr-1 text-[16px] font-medium text-ink-100 outline-none hover:bg-white/5 md:text-[13px]"
          >
            {pid === NEW && <option value={NEW} className="bg-ink-900">New edit</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id} className="bg-ink-900">
                {p.name}{!p.hasDraft ? " · new" : ""}
              </option>
            ))}
          </select>
          {pid !== NEW && startsEdits && (
            <button
              onClick={() => setPid(NEW)}
              className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-200 ring-1 ring-white/10 hover:bg-white/5"
              title="Start a new edit from raw footage"
            >
              <svg width="10" height="10" viewBox="0 0 10 10"><path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              <span className={cx(narrow && "hidden")}>New edit</span>
            </button>
          )}
          {model && <span className="hidden whitespace-nowrap font-mono text-[11px] text-ink-500 tnum xl:inline">{model.width}×{model.height} · {fmt(model.duration)}</span>}
        </div>

        <div className="hidden md:block">
        <Segmented
          value={device}
          onChange={setDevice}
          options={[
            ["desktop", "Desktop", "1"],
            ["phone", "Phone", "2"],
            ["feed", "In feed", "3"],
          ]}
        />
        </div>

        <div className="flex shrink-0 items-center gap-2 text-[12px] md:gap-3">
          {othersByPerson.length > 0 && (
            <div className="flex items-center -space-x-1.5" aria-label="Also here">
              {othersByPerson.slice(0, 5).map((o) => (
                <button
                  key={o.id}
                  onClick={() => seek(o.t)}
                  className="rounded-full"
                  title={`${o.name} (${ROLE_INFO[o.role].label.toLowerCase()}) is at ${fmt(o.t)}${o.playing ? ", playing" : ""}. Click to go there.`}
                >
                  <Avatar p={o} size={22} ring />
                </button>
              ))}
              {othersByPerson.length > 5 && <span className="grid h-[22px] min-w-[22px] place-items-center rounded-full bg-ink-700 px-1 text-[10px] text-ink-200 ring-2 ring-ink-900">+{othersByPerson.length - 5}</span>}
            </div>
          )}
          {me.role === "owner" && (
            <button
              onClick={() => setSharing(true)}
              className="flex items-center gap-1.5 rounded-md bg-white/5 px-2 py-1 font-medium text-ink-100 ring-1 ring-white/10 hover:bg-white/10"
              title="Invite people and choose what they can do"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden><circle cx="6" cy="5.5" r="2.5" stroke="currentColor" strokeWidth="1.5" /><path d="M1.5 13.5c.6-2.4 2.3-3.6 4.5-3.6s3.9 1.2 4.5 3.6M11.5 4v5M9 6.5h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              <span className={cx(narrow && "hidden")}>Share</span>
            </button>
          )}
          {me.role !== "owner" && (
            <span className="flex items-center gap-1.5 text-ink-400" title={`You're in as ${me.name}, ${ROLE_INFO[me.role].label.toLowerCase()}: ${ROLE_INFO[me.role].what}`}>
              <Avatar p={me} size={20} />
              <span className={cx(narrow && "hidden")}>{ROLE_INFO[me.role].label}</span>
            </span>
          )}
          {editor && model && !portrait && pid && !pid.endsWith("v") && !projects.some((p) => p.id === `${pid}v`) && !compare && (
            <button
              onClick={() => {
                if (!confirm("Make a 9:16 version? Claude builds it as a separate CapCut project: new card layouts, captions and face framing. It takes a while (about 20-40 min) and the 16:9 edit stays as it is.")) return;
                submit({ text: VERTICAL_ASK, t: 0, x: null, y: null, target: { kind: "general", label: "whole video", detail: "9:16 version" }, want: 1 });
              }}
              disabled={comments.some((c) => c.text === VERTICAL_ASK && (c.status === "working" || c.status === "queued"))}
              className="rounded-md px-2 py-1 text-ink-200 ring-1 ring-white/10 hover:bg-white/5 disabled:opacity-40"
              title="Build a vertical (9:16) version of this edit as its own project"
            >
              {narrow ? "9:16" : "Make 9:16 version"}
            </button>
          )}
          {model && pid && pid !== NEW && <ExportMenu pid={pid} state={exportSt} busy={busy > 0} narrow={narrow} canEdit={editor} />}
          {editor && proxy?.status === "stale" && (
            <button onClick={() => pid && api.rebuild(pid)} className="rounded-md px-2 py-1 text-gold ring-1 ring-gold/30 hover:bg-gold/10">
              {narrow ? "Rebuild" : "Picture changed · rebuild"}
            </button>
          )}
          <span className={cx("flex items-center gap-1.5", busy ? "text-gold" : "text-ink-400")}>
            <span className={cx("h-1.5 w-1.5 rounded-full", busy ? "bg-gold pulse-ring" : online ? "bg-sfx" : "bg-red-400")} />
            <span className={cx(narrow && !busy && "hidden")}>{busy ? (narrow ? "Editing" : "Claude is editing") : online ? "Connected" : "Reconnecting…"}</span>
          </span>
          {remote && (
            <button onClick={onLogout} className="rounded-md px-2 py-1 text-ink-400 hover:bg-white/5 hover:text-ink-200" title="Log this device out">
              Log out
            </button>
          )}
        </div>
      </header>

      {error && (
        <button onClick={() => setError(null)} className="bg-red-500/10 px-4 py-2 text-left text-[12px] text-red-300">
          {error}
        </button>
      )}

      <div className={cx("flex min-h-0 flex-1", narrow && "flex-col overflow-y-auto")}>
        <main className={cx("flex min-w-0 flex-col", narrow ? (compare || !model ? "" : "sticky top-0 z-30 bg-ink-950") : "flex-1 overflow-y-auto")}>
          {compare && (
            <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/5 bg-ink-900/60 px-3 py-1.5 text-[12px] md:px-4">
              <span className="rounded bg-gold px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ink-950">Compare</span>
              <span className="min-w-0 flex-1 truncate text-ink-200">“{compare.text}”</span>
              {editor && (
                <button onClick={() => pick("current")} className="rounded-md px-2 py-1 text-ink-300 ring-1 ring-white/10 hover:bg-white/5">
                  Keep current
                </button>
              )}
              <button onClick={() => setCompareId(null)} className="rounded-md px-2 py-1 text-ink-400 hover:bg-white/5" title="Close (Esc); the options stay on the comment">
                Close
              </button>
            </div>
          )}

          {model ? (
            <div
              className={cx(narrow ? "" : "min-h-0 flex-1", compare ? "grid gap-2 p-2" : "flex")}
              style={compare ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: narrow ? undefined : `repeat(${rows}, minmax(0, 1fr))` } : undefined}
            >
              {cells.map((cell, i) => (
                <div key={cell.key} className={cx("flex min-h-0 min-w-0 flex-1 flex-col", compare && cx("overflow-hidden rounded-xl bg-ink-900/70 ring-1", listen === cell.key ? "ring-gold/40" : "ring-white/5"))}>
                  {compare && (
                    <div className="flex h-9 shrink-0 items-center gap-2 px-3">
                      <span className={cx("grid h-5 min-w-5 place-items-center rounded px-1 text-[10px] font-bold", cell.key === "current" ? "bg-white/10 text-ink-200" : "bg-gold text-ink-950")}>
                        {cell.key === "current" ? "NOW" : cell.key}
                      </span>
                      <span className="truncate text-[12px] text-ink-200" title={cell.note}>{cell.note ?? "Current version"}</span>
                      <div className="flex-1" />
                      <button
                        onClick={() => setListen(cell.key)}
                        className={cx("rounded-md px-2 py-0.5 text-[11px] ring-1", listen === cell.key ? "text-gold ring-gold/40" : "text-ink-400 ring-white/10 hover:text-ink-200")}
                        title="Hear this one"
                      >
                        {listen === cell.key ? "Listening" : "Listen"}
                      </button>
                      {cell.key !== "current" && editor && (
                        <button onClick={() => pick(cell.key)} className="rounded-md bg-gold px-2 py-0.5 text-[11px] font-semibold text-ink-950 hover:brightness-110">
                          Use this
                        </button>
                      )}
                    </div>
                  )}
                  <div className={cx("flex min-h-0 min-w-0", narrow ? "w-full" : "flex-1")} style={narrow ? { aspectRatio: aspect, maxHeight: portrait ? "62svh" : undefined } : undefined}>
                  <Stage
                    ref={(el) => {
                      players.current[i] = el;
                    }}
                    model={cell.model}
                    proxyUrl={cell.proxyUrl}
                    proxyNote={cell.proxyNote}
                    overlayUrl={cell.overlayUrl}
                    device={dev}
                    pad={narrow ? 0 : 28}
                    sheet={narrow}
                    time={time}
                    commentMode={commentMode && !compare}
                    comments={compare ? [] : comments}
                    focusId={focusId}
                    onFocus={setFocusId}
                    onSubmit={submit}
                    muted={compare ? listen !== cell.key : false}
                    safe={safe}
                    onVideoEvent={i === 0 ? leaderEvent : followerEvent(i)}
                  />
                  </div>
                </div>
              ))}
            </div>
          ) : showNew ? (
            <NewEdit
              key="new-edit"
              projectId={pid === NEW ? null : pid}
              comments={comments}
              narrow={narrow}
              onCreated={async (id) => {
                setProjects(await api.projects());
                setPid(id);
              }}
              onError={setError}
            />
          ) : (
            <div className="grid flex-1 place-items-center px-6 text-center text-[13px] text-ink-400">{error ? "" : pid ? "Loading project…" : "Nothing is shared with you yet. Ask the owner to add a project."}</div>
          )}

          {model && (
            <>
              <div className="flex h-11 shrink-0 items-center gap-3 border-t border-white/5 bg-ink-900 px-3 md:px-4">
                <button onClick={toggle} className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-ink-100 text-ink-950 hover:bg-white" title="Play / pause (Space)">
                  {playing ? (
                    <svg width="10" height="12" viewBox="0 0 10 12"><rect width="3" height="12" fill="currentColor" /><rect x="7" width="3" height="12" fill="currentColor" /></svg>
                  ) : (
                    <svg width="11" height="12" viewBox="0 0 11 12" className="ml-0.5"><path d="M0 0L11 6L0 12Z" fill="currentColor" /></svg>
                  )}
                </button>
                <span className="whitespace-nowrap font-mono text-[12px] text-ink-200 tnum">
                  {fmt(time, true, model.fps)} <span className="text-ink-500">/ {fmt(model.duration)}</span>
                </span>
                <button
                  onClick={() => setSfxOn(!sfxOn)}
                  className={cx("rounded-md px-2 py-1 text-[11px] ring-1", sfxOn ? "text-sfx ring-sfx/30" : "text-ink-500 ring-white/10 line-through")}
                  title="Sound effects on/off (voice stays on)"
                >
                  SFX
                </button>
                <label
                  className={cx("flex items-center gap-1 rounded-md py-1 pl-2 pr-1 text-[11px] ring-1", safe !== "off" ? "text-gold ring-gold/30" : "text-ink-400 ring-white/10")}
                  title="Safe zones: where each app's buttons and captions cover the picture (S)"
                >
                  <span className={cx(narrow && "hidden")}>Safe</span>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={cx(!narrow && "hidden")}><rect x="1" y="1" width="10" height="10" rx="1.5" stroke="currentColor" strokeDasharray="2 1.5" /></svg>
                  <select value={safe} onChange={(e) => setSafe(e.target.value as SafeMode)} className="bg-transparent text-[16px] outline-none md:text-[11px]">
                    {safeModes.map((m) => (
                      <option key={m} value={m} className="bg-ink-900">{SAFE_LABEL[m]}</option>
                    ))}
                  </select>
                </label>
                <div className="flex-1" />
                <span className="hidden text-[11px] text-ink-500 xl:block">
                  <Kbd>Space</Kbd> play · <Kbd>←</Kbd><Kbd>→</Kbd> frame · <Kbd>1</Kbd><Kbd>2</Kbd><Kbd>3</Kbd> device · <Kbd>S</Kbd> safe zones
                </span>
                {!compare && commenter && (
                  <button
                    onClick={() => setCommentMode(!commentMode)}
                    className={cx(
                      "flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-[12px] font-semibold transition",
                      commentMode ? "bg-gold text-ink-950" : "bg-white/5 text-ink-100 ring-1 ring-white/10 hover:bg-white/10",
                    )}
                    title="Comment mode (C)"
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v6a1.5 1.5 0 01-1.5 1.5H7l-3.5 3v-3h0A1.5 1.5 0 012 9.5v-6z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>
                    {commentMode ? (narrow ? "Tap the frame" : "Click what to change") : "Comment"}
                    {!commentMode && !narrow && <span className="font-mono text-[10px] opacity-50">C</span>}
                  </button>
                )}
              </div>
              {narrow && (
                <div className="flex shrink-0 border-t border-white/5 bg-ink-900 px-3">
                  {(["comments", "timeline"] as const).map((k) => (
                    <button
                      key={k}
                      onClick={() => setTab(k)}
                      className={cx("-mb-px border-b-2 px-3 py-2.5 text-[13px] font-medium capitalize", tab === k ? "border-gold text-ink-100" : "border-transparent text-ink-400")}
                    >
                      {k}
                      {k === "comments" && comments.length > 0 && <span className="ml-1.5 text-ink-500">{comments.length}</span>}
                    </button>
                  ))}
                </div>
              )}
              {(!narrow || tab === "timeline") && (
              <Timeline
                model={model}
                time={time}
                comments={comments}
                commentMode={commentMode && !compare}
                onSeek={seek}
                onPause={() => leader()?.video?.pause()}
                onSolo={(s) => engine.solo(s)}
                onSubmit={submit}
                onFocus={setFocusId}
                others={others}
              />
              )}
            </>
          )}
        </main>

        {(!narrow || tab === "comments") && pid !== NEW && !(showNew && comments.length === 0) && (
        <CommentsPanel
          noComposer={showNew}
          full={narrow}
          comments={comments}
          time={time}
          focusId={focusId}
          onFocus={setFocusId}
          onSeek={seek}
          onStop={(id) => pid && api.stop(pid, id)}
          onUndo={(id) => pid && api.undo(pid, id).catch((e) => setError(e.message))}
          onApprove={(id) => pid && api.approve(pid, id).catch((e) => setError(e.message))}
          onDecline={decline}
          onSubmit={submit}
          onCompare={(id) => {
            setFocusId(id);
            setCompareId(id);
            if (narrow) document.querySelector("main")?.scrollIntoView({ block: "start" });
          }}
        />
        )}
      </div>
    </div>
    </MeContext.Provider>
  );
}

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string, string][] }) {
  return (
    <div className="flex rounded-lg bg-ink-950 p-0.5 ring-1 ring-white/5">
      {options.map(([v, label, key]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={cx("whitespace-nowrap rounded-md px-3 py-1 text-[12px] font-medium transition", value === v ? "bg-ink-700 text-ink-100 shadow" : "text-ink-400 hover:text-ink-200")}
          title={`${label} (${key})`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
