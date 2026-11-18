import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Comment, Dest, Format, LibraryFolder, RawInfo } from "../types";
import { cx } from "../util";
import { keepAwake, uploadFile } from "../upload";

type Row = { file: File; dest: Dest; sent: number; state: "waiting" | "sending" | "done" | "failed"; error?: string };

const size = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${Math.max(0.1, n / 1024 ** 2).toFixed(1)} MB`);
const ACCEPT = "video/*,audio/*,.mts,.m2ts,.mxf,.mkv";
const ACCEPT_EXTRA = ACCEPT + ",image/*,.heic";
const FORMAT_KEY = "room.newedit.format";
const lastFormat = (): Format => {
  try {
    return localStorage.getItem(FORMAT_KEY) === "16:9" ? "16:9" : "9:16";
  } catch {
    return "9:16";
  }
};

/**
 * A new edit: drop the raw footage (or pick it on the phone), add whatever goes with this video (b-roll, screen
 * recordings, screenshots), pick the format, and Claude builds the whole first edit without asking anything.
 * `projectId` is null until the first file is picked; the "<MMDD> edit" folder is made then, not on a click.
 */
export function NewEdit({ projectId, comments, narrow, onCreated, onError }: {
  projectId: string | null;
  comments: Comment[];
  narrow: boolean;
  onCreated: (id: string) => void;
  onError: (msg: string) => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [raw, setRaw] = useState<RawInfo | null>(null);
  const [note, setNote] = useState("");
  const [auto, setAuto] = useState(true);
  const [format, setFormat] = useState<Format>(lastFormat);
  const [library, setLibrary] = useState<LibraryFolder[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [over, setOver] = useState<Dest | null>(null);
  const [starting, setStarting] = useState(false);
  const idRef = useRef(projectId);
  idRef.current = projectId;
  const abort = useRef(new AbortController());
  const input = useRef<HTMLInputElement>(null);
  const extraInput = useRef<HTMLInputElement>(null);
  // uploads take minutes: read what the user set by the time they finish, not when they began
  const live = useRef({ note, auto, rows, building: false, format, folders, hasRaw: false });

  const build = comments.find((c) => c.target.kind === "build" && c.status !== "stopped" && c.status !== "failed");
  const lastBuild = [...comments].reverse().find((c) => c.target.kind === "build");
  const sending = rows.some((r) => r.state === "sending" || r.state === "waiting");
  const hasRaw = rows.some((r) => r.dest === "raw") || !!raw?.files.length;
  live.current = { note, auto, rows, building: !!build, format, folders, hasRaw };
  const allDone = hasRaw && rows.every((r) => r.state === "done") && !(rows.length === 0 && raw?.pending.length);

  const refresh = () => projectId && api.raw(projectId).then((r) => {
    setRaw(r);
    if (r.note && !note) setNote(r.note.trim());
    if (r.format) setFormat(r.format);
    if (r.folders.length) setFolders(r.folders);
  }).catch(() => {});
  useEffect(() => {
    api.libraryFolders().then(setLibrary).catch(() => {});
  }, []);
  const pickFormat = (f: Format) => {
    setFormat(f);
    try {
      localStorage.setItem(FORMAT_KEY, f);
    } catch {}
  };
  useEffect(() => {
    setRaw(null);
    refresh();
  }, [projectId]);
  useEffect(() => () => abort.current.abort(), []);

  // leaving mid-upload loses the rest (it resumes if the same file is picked again)
  useEffect(() => {
    if (!sending) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    let release = () => {};
    const lock = () => keepAwake().then((r) => (release = r));
    lock();
    const vis = () => document.visibilityState === "visible" && lock(); // the lock drops when the tab is hidden
    document.addEventListener("visibilitychange", vis);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("visibilitychange", vis);
      release();
    };
  }, [sending]);

  const set = (f: File, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.file === f ? { ...r, ...patch } : r)));

  const send = async (files: File[], dest: Dest) => {
    let id = idRef.current;
    if (!id) {
      try {
        id = (await api.newEdit()).id;
      } catch (e: any) {
        return onError(e.message);
      }
      idRef.current = id;
      onCreated(id);
    }
    let ok = true;
    for (const f of files) {
      set(f, { state: "sending" });
      try {
        await uploadFile(id, f, (n) => set(f, { sent: n }), abort.current.signal, dest);
        set(f, { state: "done", sent: f.size });
      } catch (e: any) {
        ok = false;
        set(f, { state: "failed", error: e.message });
      }
    }
    return ok ? id : null;
  };

  const add = async (list: FileList | null, dest: Dest) => {
    const files = [...(list ?? [])].filter((f) => !rows.some((r) => r.file.name === f.name && r.file.size === f.size && r.state !== "failed"));
    if (!files.length) return;
    setRows((rs) => [...rs.filter((r) => !files.some((f) => f.name === r.file.name && f.size === r.file.size)), ...files.map((file): Row => ({ file, dest, sent: 0, state: "waiting" }))]);
    const id = await send(files, dest);
    refresh();
    // extra material alone never starts the edit: the recording has to be there
    if (id && live.current.auto && live.current.hasRaw && !live.current.building && live.current.rows.every((r) => files.includes(r.file) || r.state === "done")) start(id);
  };

  const retry = async (r: Row) => {
    const id = await send([r.file], r.dest);
    refresh();
    if (id && live.current.auto && live.current.hasRaw && !live.current.building && live.current.rows.every((x) => x.file === r.file || x.state === "done")) start(id);
  };

  const start = async (id = idRef.current) => {
    if (!id) return;
    setStarting(true);
    try {
      await api.build(id, live.current.note, live.current.format, live.current.folders);
    } catch (e: any) {
      onError(e.message);
    } finally {
      setStarting(false);
    }
  };

  const pending = (raw?.pending ?? []).filter((p) => !rows.some((r) => r.file.name === p.name && r.file.size === p.size));
  const serverFiles = [
    ...(raw?.files ?? []).map((f) => ({ ...f, dest: "raw" as Dest })),
    ...(raw?.resources ?? []).map((f) => ({ ...f, dest: "resources" as Dest })),
  ].filter((f) => !rows.some((r) => r.file.name === f.name && r.dest === f.dest));
  const tag = (dest: Dest | undefined) => (dest === "resources" ? <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-400">extra</span> : null);
  const latest = build && [...build.activity].reverse().find((a) => a.kind === "info" || a.kind === "tool");

  return (
    <div className={cx("mx-auto w-full max-w-xl px-4", narrow ? "py-5" : "py-10")}>
      <h1 className="text-[18px] font-semibold tracking-tight">New edit</h1>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-400">
        Add the raw recording straight from the camera or your phone. No need to trim it: Claude picks the best takes and cuts the rest.
      </p>

      {!build && (
        <button
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver("raw");
          }}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(null);
            add(e.dataTransfer.files, "raw");
          }}
          className={cx(
            "mt-5 flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition",
            over === "raw" ? "border-gold bg-gold/5" : "border-white/10 hover:border-white/20 hover:bg-white/[0.02]",
          )}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className={over === "raw" ? "text-gold" : "text-ink-400"}>
            <path d="M12 16V4m0 0l-4.5 4.5M12 4l4.5 4.5M4 15v3.5A1.5 1.5 0 005.5 20h13a1.5 1.5 0 001.5-1.5V15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-[14px] font-medium text-ink-100">{narrow ? "Choose footage" : "Drop footage here"}</span>
          <span className="text-[12px] text-ink-400">{narrow ? "From Photos or Files · big files are fine" : "or click to choose · MP4, MOV, MTS · big files are fine"}</span>
        </button>
      )}
      <input ref={input} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => (add(e.target.files, "raw"), (e.target.value = ""))} />

      {!build && (
        <button
          onClick={() => extraInput.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver("resources");
          }}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(null);
            add(e.dataTransfer.files, "resources");
          }}
          className={cx(
            "mt-3 flex w-full items-center gap-3 rounded-2xl border border-dashed px-4 py-3 text-left transition",
            over === "resources" ? "border-gold bg-gold/5" : "border-white/10 hover:border-white/20 hover:bg-white/[0.02]",
          )}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className={cx("shrink-0", over === "resources" ? "text-gold" : "text-ink-400")}>
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-ink-100">Extra material for this video <span className="font-normal text-ink-500">(optional)</span></span>
            <span className="block text-[12px] text-ink-400">B-roll, screen recordings, screenshots. Claude puts each one where it fits the line.</span>
          </span>
        </button>
      )}
      <input ref={extraInput} type="file" multiple accept={ACCEPT_EXTRA} className="hidden" onChange={(e) => (add(e.target.files, "resources"), (e.target.value = ""))} />

      {(rows.length > 0 || serverFiles.length > 0 || pending.length > 0) && (
        <ul className="mt-4 space-y-2">
          {serverFiles.map((f) => (
            <li key={f.dest + f.name} className="flex items-center gap-3 rounded-xl bg-ink-900 px-3 py-2.5 ring-1 ring-white/5">
              <span className="min-w-0 flex-1 truncate text-[13px]">{f.name}</span>
              {tag(f.dest)}
              <span className="text-[12px] text-sfx">{size(f.size)} · uploaded</span>
            </li>
          ))}
          {pending.map((f) => (
            <li key={(f.dest ?? "raw") + f.name} className="rounded-xl bg-ink-900 px-3 py-2.5 ring-1 ring-white/5">
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-[13px]">{f.name}</span>
                {tag(f.dest)}
                <span className="text-[12px] text-ink-400">{Math.floor((100 * f.received) / f.size)}%</span>
              </div>
              <div className="mt-1 text-[12px] text-ink-400">Stopped part way. Choose the same file again to carry on from here.</div>
            </li>
          ))}
          {rows.map((r) => {
            const pct = r.file.size ? Math.floor((100 * r.sent) / r.file.size) : 0;
            return (
              <li key={r.dest + r.file.name + r.file.size} className="rounded-xl bg-ink-900 px-3 py-2.5 ring-1 ring-white/5">
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-[13px]">{r.file.name}</span>
                  {tag(r.dest)}
                  <span className={cx("whitespace-nowrap text-[12px] tnum", r.state === "done" ? "text-sfx" : r.state === "failed" ? "text-red-300" : "text-ink-300")}>
                    {r.state === "done" ? `${size(r.file.size)} · uploaded` : r.state === "waiting" ? "waiting" : r.state === "failed" ? "failed" : `${pct}% of ${size(r.file.size)}`}
                  </span>
                  {r.state === "failed" && (
                    <button onClick={() => retry(r)} className="rounded-md px-2 py-0.5 text-[12px] text-gold ring-1 ring-gold/30 hover:bg-gold/10">
                      Retry
                    </button>
                  )}
                </div>
                {r.state !== "done" && (
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/5">
                    <div className={cx("h-full rounded-full transition-[width]", r.state === "failed" ? "bg-red-400" : "bg-gold")} style={{ width: `${pct}%` }} />
                  </div>
                )}
                {r.error && <div className="mt-1 text-[12px] text-red-300">{r.error}</div>}
              </li>
            );
          })}
        </ul>
      )}
      {sending && narrow && <p className="mt-2 text-[12px] text-ink-400">Keep this page open until it finishes; the screen stays on while it uploads.</p>}

      {build ? (
        <div className="mt-6 rounded-2xl bg-gold/5 p-4 ring-1 ring-gold/20">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-gold">
            {build.status === "working" || build.status === "queued" ? <span className="h-1.5 w-1.5 rounded-full bg-gold pulse-ring" /> : null}
            {build.status === "queued" ? "Waiting to start" : build.status === "working" ? "Claude is building the first edit" : build.status === "done" ? "First edit built" : "Build ended"}
          </div>
          {latest && build.status === "working" && <div className="mt-1 truncate text-[12px] text-ink-300">{latest.text}</div>}
          {build.reply && <div className="mt-2 text-[13px] leading-relaxed text-ink-200">{build.reply}</div>}
          <div className="mt-2 text-[12px] text-ink-400">This takes a while. Every step shows in Comments; the preview opens here when the draft is ready.</div>
        </div>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-[12px] font-medium text-ink-300">Format</span>
            <div className="flex rounded-lg bg-ink-900 p-0.5 ring-1 ring-white/10" role="radiogroup" aria-label="Format">
              {(["9:16", "16:9"] as Format[]).map((f) => (
                <button
                  key={f}
                  role="radio"
                  aria-checked={format === f}
                  onClick={() => pickFormat(f)}
                  className={cx("rounded-md px-3 py-1 text-[12px] font-medium transition", format === f ? "bg-gold text-ink-950" : "text-ink-300 hover:text-ink-100")}
                >
                  {f === "9:16" ? "9:16 vertical" : "16:9 wide"}
                </button>
              ))}
            </div>
          </div>
          {library.length > 0 && (
            <div className="mt-4">
              <div className="text-[12px] font-medium text-ink-300">Also draw b-roll from <span className="font-normal text-ink-500">(your footage folders, optional)</span></div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {library.map((f) => {
                  const on = folders.includes(f.name);
                  return (
                    <button
                      key={f.name}
                      aria-pressed={on}
                      onClick={() => setFolders((cur) => (on ? cur.filter((x) => x !== f.name) : [...cur, f.name]))}
                      className={cx("rounded-full px-2.5 py-1 text-[12px] ring-1 transition", on ? "bg-gold/15 text-gold ring-gold/40" : "text-ink-300 ring-white/10 hover:ring-white/25")}
                    >
                      {f.name} <span className={on ? "text-gold/70" : "text-ink-500"}>{f.files}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <label className="mt-5 block text-[12px] font-medium text-ink-300" htmlFor="brief">Anything Claude should know <span className="text-ink-500">(optional)</span></label>
          <textarea
            id="brief"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder={"Where it starts and ends, lines to drop…\ne.g. starts at \"so here's the thing\", skip the last minute"}
            className="mt-1.5 w-full resize-none rounded-xl bg-ink-900 px-3 py-2.5 text-[16px] leading-relaxed text-ink-100 outline-none ring-1 ring-white/10 placeholder:text-ink-500 focus:ring-gold/40 md:text-[13px]"
          />
          {lastBuild && (lastBuild.status === "failed" || lastBuild.status === "stopped") && (
            <div className="mt-2 text-[12px] text-red-300">The last build {lastBuild.status === "stopped" ? "was stopped" : "failed"}: {lastBuild.reply}</div>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              onClick={() => start()}
              disabled={!allDone || sending || starting || !projectId}
              className="rounded-lg bg-gold px-4 py-2 text-[13px] font-semibold text-ink-950 hover:brightness-110 disabled:opacity-40"
            >
              {starting ? "Starting…" : "Start the edit"}
            </button>
            {sending && (
              <label className="flex items-center gap-2 text-[12px] text-ink-300">
                <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="accent-[var(--color-gold)]" />
                Start when the upload finishes
              </label>
            )}
          </div>
        </>
      )}
    </div>
  );
}
