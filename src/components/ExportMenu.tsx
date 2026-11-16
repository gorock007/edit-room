import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { ExportState } from "../types";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/**
 * Export for Instagram Reels and TikTok: one upload-ready MP4 made straight from the CapCut draft (1080x1920 H.264,
 * AAC 320k, -14 LUFS). The state comes from the server (live over the socket), so a phone sees an export the Mac started.
 */
export function ExportMenu({ pid, state, busy, narrow, canEdit = true }: { pid: string; state: ExportState | null; busy: boolean; narrow: boolean; canEdit?: boolean }) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const st = state?.status ?? "none";
  const running = st === "running";
  const start = () => {
    setErr(null);
    api.startExport(pid).catch((e) => setErr(String(e.message ?? e)));
  };
  const r = state?.report;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cx(
          "flex items-center gap-1.5 rounded-md px-2 py-1 ring-1",
          running ? "text-gold ring-gold/30" : st === "ready" ? "text-ink-100 ring-white/15 hover:bg-white/5" : "text-ink-200 ring-white/10 hover:bg-white/5",
        )}
        title="Export an MP4 for Instagram Reels and TikTok"
      >
        <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
          <path d="M6 1.5v6.5M3.2 5.4 6 8.2l2.8-2.8M1.8 10.5h8.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{running ? (state?.stage?.startsWith("encoding") ? state.stage.replace("encoding ", "") : "Exporting") : "Export"}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-9 z-50 w-[min(340px,calc(100vw-24px))] rounded-xl bg-ink-900 p-4 text-[12px] text-ink-200 shadow-2xl ring-1 ring-white/10">
          <div className="text-[13px] font-semibold text-ink-100">Export for Reels &amp; TikTok</div>
          <div className="mt-1 text-ink-400">One MP4 in the format both apps play: 1080×1920, 30 fps, H.264, AAC 320k, −14 LUFS.</div>

          {running && (
            <div className="mt-3 flex items-center gap-2 text-gold">
              <span className="h-1.5 w-1.5 rounded-full bg-gold pulse-ring" />
              <span>{state?.stage ?? "Starting"}… about 1–2 minutes</span>
            </div>
          )}

          {(st === "ready" || st === "stale") && r && (
            <div className="mt-3 space-y-2">
              {st === "stale" && <div className="rounded-md bg-gold/10 px-2 py-1.5 text-gold">The edit changed since this export.</div>}
              <div className="font-mono text-[11px] leading-relaxed text-ink-300 tnum">
                {r.width}×{r.height} · {r.fps.replace("/1", "")} fps · {r.duration.toFixed(1)} s<br />
                {r.video} · {r.video_mbps} Mb/s<br />
                {r.audio} · {r.lufs} LUFS · peak {r.true_peak} dBTP<br />
                {r.size_mb} MB
              </div>
              <a
                href={`/media/${pid}/export.mp4?download=1&v=${state?.at ?? 0}`}
                className="flex w-full items-center justify-center rounded-md bg-gold px-3 py-2 text-[13px] font-semibold text-ink-950 hover:bg-gold/90"
              >
                Download MP4
              </a>
              {state?.savedTo && <div className="break-all text-[11px] text-ink-500">Also saved next to the edit: {state.savedTo.split("/").slice(-3).join("/")}</div>}
            </div>
          )}

          {st === "failed" && <div className="mt-3 whitespace-pre-wrap break-words rounded-md bg-red-500/10 px-2 py-1.5 text-red-300">{state?.error}</div>}
          {err && <div className="mt-3 rounded-md bg-red-500/10 px-2 py-1.5 text-red-300">{err}</div>}

          {!running && !canEdit && st !== "ready" && <div className="mt-3 text-ink-400">No export yet. An editor can make one.</div>}
          {!running && canEdit && (
            <button
              onClick={start}
              disabled={busy}
              className={cx(
                "mt-3 w-full rounded-md px-3 py-2 text-[13px] font-medium ring-1 disabled:opacity-40",
                st === "ready" ? "text-ink-200 ring-white/10 hover:bg-white/5" : "bg-white/10 text-ink-100 ring-white/10 hover:bg-white/15",
              )}
            >
              {st === "none" ? "Export" : st === "failed" ? "Try again" : "Export again"}
            </button>
          )}
          {canEdit && busy && !running && <div className="mt-1 text-center text-[11px] text-ink-500">Wait for Claude to finish editing.</div>}

          <div className="mt-4 border-t border-white/5 pt-3 text-[11px] leading-relaxed text-ink-400">
            <div className="mb-1 font-medium text-ink-300">To keep the quality when you post</div>
            Post this file itself, not a screen recording or a copy re-saved by another app.
            <br />
            <span className="text-ink-300">Instagram:</span> Settings → Data usage and media quality → turn on <i>Upload at highest quality</i>.
            <br />
            <span className="text-ink-300">TikTok:</span> on the post screen, More options → turn on <i>Upload high quality</i> (HD).
            <br />
            Upload on Wi-Fi: on mobile data both apps may compress harder.
          </div>
        </div>
      )}
    </div>
  );
}
