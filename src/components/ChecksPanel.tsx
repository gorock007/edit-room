import { useState } from "react";
import type { Checks, Issue } from "../types";
import { ago, cx, fmt } from "../util";

type Props = {
  checks: Checks | null;
  fps: number;
  canEdit: boolean;
  /** may send Claude a comment */
  canAsk: boolean;
  /** Claude is changing the edit: cuts wait */
  busy: boolean;
  full?: boolean;
  header?: React.ReactNode;
  onSeek: (t: number) => void;
  onCut: (issue: Issue) => Promise<void>;
  onAsk: (issue: Issue) => void;
  onOk: (id: string, ok: boolean) => void;
  onRun: () => void;
};

const KIND: Record<Issue["kind"], string> = {
  media: "Media", timeline: "Timeline", pause: "Pause", colour: "Colour", black: "Picture", sync: "Captions", extra: "Voice", missing: "Captions",
};

/**
 * What Edit Room found watching and listening to the preview, so the same faults don't have to be found by hand:
 * each is a place to look. A pause can be cut on the spot; anything else goes to Claude with what was measured.
 */
export function ChecksPanel(p: Props) {
  const [cutting, setCutting] = useState<string | null>(null);
  const c = p.checks;
  const open = c?.issues.filter((i) => !c.ok.includes(i.id)) ?? [];
  const fine = c?.issues.filter((i) => c.ok.includes(i.id)) ?? [];
  const listening = c?.status === "ready" && (c.listened === "running" || c.listened === "waiting");

  const cut = async (i: Issue) => {
    setCutting(i.id);
    try {
      await p.onCut(i);
    } finally {
      setCutting(null);
    }
  };

  return (
    <aside className={cx("flex shrink-0 flex-col bg-ink-900", p.full ? "w-full" : "w-[320px] border-l border-white/5 xl:w-[380px]")}>
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-white/5 px-4">
        {p.header ?? <div className="text-[13px] font-semibold text-ink-100">Checks</div>}
      </div>

      <div className={cx("min-h-0 flex-1 px-3 py-3", !p.full && "overflow-y-auto")}>
        {!c || c.status === "none" ? (
          <p className="px-1 text-[13px] leading-snug text-ink-400">The edit is checked as soon as its preview is ready.</p>
        ) : c.status === "failed" ? (
          <p className="px-1 text-[13px] leading-snug text-red-300">The checks could not run: {c.error}</p>
        ) : (
          <>
            <div className="mb-3 px-1 text-[12px] leading-snug text-ink-300">
              {c.status === "running" ? (
                <span className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-gold pulse-ring" />Looking at the picture and the sound…</span>
              ) : open.length === 0 ? (
                <span className="text-sfx">Nothing found{c.listened === "yes" ? ": no long pauses, the captions match the voice, and the cuts match in colour." : " in the picture or the pauses."}</span>
              ) : (
                <span>
                  <b className="font-semibold text-ink-100">{open.length} to look at.</b> Click one to go there.
                </span>
              )}
              {listening && (
                <span className="mt-1.5 flex items-center gap-2 text-ink-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-ink-400 pulse-ring" />
                  {c.listened === "running" ? "Listening to the voice against the captions (about half a minute)…" : "Will listen to the voice once the edit is still."}
                </span>
              )}
              {(c.listened === "unavailable" || c.listened === "failed") && c.listenNote && <span className="mt-1.5 block text-ink-500">{c.listenNote}</span>}
            </div>

            <ul className="space-y-2">
              {open.map((i) => (
                <li
                  key={i.id}
                  onClick={() => p.onSeek(i.t)}
                  className="cursor-pointer rounded-xl bg-ink-850 p-3 ring-1 ring-white/5 hover:ring-white/15"
                >
                  <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide">
                    <span className={cx("rounded px-1.5 py-0.5", i.level === "fix" ? "bg-red-400/15 text-red-300" : "bg-gold/15 text-gold")}>{KIND[i.kind]}</span>
                    <span className="font-mono font-normal normal-case tracking-normal text-ink-500 tnum">{fmt(i.t, true, p.fps)}</span>
                  </div>
                  <p className="mt-1.5 text-[13px] leading-snug text-ink-100">{i.title}</p>
                  {i.detail && <p className="mt-1 text-[12px] leading-snug text-ink-400">{i.detail}</p>}
                  {(p.canEdit || p.canAsk) && (
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                      {i.cut && p.canEdit && (
                        <button
                          onClick={() => cut(i)}
                          disabled={cutting != null || p.busy}
                          title={p.busy ? "Claude is working on this edit: wait for it to finish" : `Cut ${(i.cut.b - i.cut.a).toFixed(2)} s out now, without Claude`}
                          className="rounded-lg bg-gold px-2.5 py-1 text-[12px] font-semibold text-ink-950 hover:brightness-110 disabled:opacity-50"
                        >
                          {cutting === i.id ? "Cutting…" : i.kind === "pause" ? "Cut it" : "Cut these words"}
                        </button>
                      )}
                      {i.ask && p.canAsk && (
                        <button onClick={() => p.onAsk(i)} className="rounded-lg px-2.5 py-1 text-[12px] text-ink-100 ring-1 ring-white/10 hover:bg-white/5" title="Send this to Claude as a comment, with what was measured">
                          Ask Claude
                        </button>
                      )}
                      <div className="flex-1" />
                      {p.canEdit && (
                        <button onClick={() => p.onOk(i.id, true)} className="rounded-lg px-2 py-1 text-[12px] text-ink-400 hover:bg-white/5 hover:text-ink-200" title="Leave it as it is and stop listing it">
                          It's fine
                        </button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>

            {fine.length > 0 && (
              <div className="mt-4">
                <div className="px-1 text-[11px] text-ink-500">Marked fine</div>
                <ul className="mt-1.5 space-y-1">
                  {fine.map((i) => (
                    <li key={i.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-ink-400 hover:bg-white/[0.03]">
                      <button className="min-w-0 flex-1 truncate text-left" onClick={() => p.onSeek(i.t)}>{i.title}</button>
                      {p.canEdit && <button onClick={() => p.onOk(i.id, false)} className="shrink-0 text-ink-500 hover:text-ink-200">Bring back</button>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {c.at && c.status === "ready" && (
              <p className="mt-4 px-1 text-[11px] text-ink-500">
                Checked {ago(c.at)}. It runs again after every change.
                {p.canEdit && (
                  <button onClick={p.onRun} className="ml-2 text-ink-300 underline decoration-ink-600 underline-offset-2 hover:text-ink-100">
                    Check again now
                  </button>
                )}
              </p>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
