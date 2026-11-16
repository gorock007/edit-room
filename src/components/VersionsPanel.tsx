import { useState } from "react";
import type { VersionInfo, VersionStats } from "../types";
import { ago, cx, fmt } from "../util";
import { Avatar } from "./People";

type Props = {
  versions: VersionInfo[]; // newest first
  current: number | null;
  comparing: number | null;
  canEdit: boolean;
  full?: boolean;
  header?: React.ReactNode;
  onCompare: (n: number | null) => void;
  onRestore: (n: number) => void;
  onName: (n: number, label: string) => void;
  onShowComment: (id: string) => void;
};

const KIND_ICON: Record<VersionInfo["kind"], string> = {
  start: "•",
  build: "★",
  comment: "✎",
  pick: "◆",
  undo: "↶",
  restore: "⟲",
  outside: "⇢",
};

/** What changed from the version before, in the edit's own terms ("−1.2 s", "+1 sound"). */
function delta(v: VersionInfo, prev: VersionInfo | undefined): string[] {
  const a = prev?.stats, b = v.stats;
  if (!a || !b) return [];
  const out: string[] = [];
  const d = Math.round((b.duration - a.duration) * 10) / 10;
  if (d) out.push(`${d > 0 ? "+" : "−"}${Math.abs(d)} s`);
  const words: [keyof VersionStats, string][] = [["cuts", "cut"], ["cards", "card"], ["captions", "caption"], ["sounds", "sound"]];
  for (const [k, w] of words) {
    const n = b[k] - a[k];
    if (n) out.push(`${n > 0 ? "+" : "−"}${Math.abs(n)} ${w}${Math.abs(n) > 1 ? "s" : ""}`);
  }
  return out;
}

/**
 * Version history (like Google Docs): every change to the edit, who asked for it, and a way back. Compare plays a
 * version side by side with the current edit; Restore puts it back (the edit as it was stays in the list).
 */
export function VersionsPanel(p: Props) {
  const [naming, setNaming] = useState<number | null>(null);
  const [label, setLabel] = useState("");
  const [onlyNamed, setOnlyNamed] = useState(false);
  const list = onlyNamed ? p.versions.filter((v) => v.label) : p.versions;
  const named = p.versions.filter((v) => v.label).length;

  const startNaming = (v: VersionInfo) => {
    setNaming(v.n);
    setLabel(v.label ?? "");
  };
  const saveName = () => {
    if (naming != null) p.onName(naming, label.trim());
    setNaming(null);
  };

  return (
    <aside className={cx("flex shrink-0 flex-col bg-ink-900", p.full ? "w-full" : "w-[320px] border-l border-white/5 xl:w-[380px]")}>
      <div className="flex h-11 items-center justify-between gap-2 border-b border-white/5 px-4">
        {p.header ?? <div className="text-[13px] font-semibold text-ink-100">History</div>}
        <div className="flex items-center gap-2 text-[11px] text-ink-400">
          {named > 0 && (
            <button
              onClick={() => setOnlyNamed(!onlyNamed)}
              className={cx("rounded-md px-1.5 py-0.5 ring-1", onlyNamed ? "bg-gold font-semibold text-ink-950 ring-gold" : "text-ink-300 ring-white/10 hover:bg-white/5")}
              title={onlyNamed ? "Show every version" : "Show only named versions"}
            >
              Named {named}
            </button>
          )}
          <span>{p.versions.length} versions</span>
        </div>
      </div>
      <div className={cx("p-3", !p.full && "flex-1 overflow-y-auto")}>
        {p.versions.length === 0 && (
          <div className="mt-10 px-6 text-center text-[13px] leading-relaxed text-ink-400">
            The history starts here. Every change to the edit becomes a version you can compare with and go back to.
          </div>
        )}
        <ol className="relative space-y-1.5">
          {list.map((v) => {
            const prev = p.versions[p.versions.indexOf(v) + 1];
            const isNow = v.n === p.current;
            const isCompared = v.n === p.comparing;
            const changes = delta(v, prev);
            return (
              <li
                key={v.n}
                className={cx(
                  "rounded-xl p-2.5 ring-1 transition",
                  isCompared ? "bg-ink-850 ring-gold/50" : isNow ? "bg-ink-850 ring-white/10" : "ring-transparent hover:bg-ink-850/60 hover:ring-white/5",
                )}
              >
                <div className="flex items-start gap-2.5">
                  <span
                    className={cx("mt-0.5 grid h-6 min-w-6 shrink-0 place-items-center rounded-md px-1 font-mono text-[10px] font-bold tnum", isNow ? "bg-gold text-ink-950" : "bg-white/10 text-ink-200")}
                    title={isNow ? "The edit is at this version now" : `Version ${v.n}`}
                  >
                    {v.n}
                  </span>
                  <div className="min-w-0 flex-1">
                    {naming === v.n ? (
                      <input
                        autoFocus
                        value={label}
                        maxLength={60}
                        placeholder="Name this version (e.g. Sent to client v1)"
                        onChange={(e) => setLabel(e.target.value)}
                        onBlur={saveName}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") saveName();
                          if (e.key === "Escape") setNaming(null);
                        }}
                        className="mb-1 w-full rounded-md bg-ink-950 px-2 py-1 text-[16px] text-ink-100 outline-none ring-1 ring-gold/40 md:text-[12px]"
                      />
                    ) : (
                      v.label && <div className="mb-0.5 truncate text-[13px] font-semibold text-gold" title={v.labelledBy ? `Named by ${v.labelledBy}` : undefined}>{v.label}</div>
                    )}
                    <p className={cx("text-[12.5px] leading-snug", v.kind === "outside" || v.kind === "start" ? "text-ink-400" : "text-ink-100")}>
                      <span className="mr-1 text-ink-500" aria-hidden>{KIND_ICON[v.kind]}</span>
                      {v.comment ? (
                        <button className="text-left hover:underline" onClick={() => p.onShowComment(v.comment!)} title="Show the comment">{v.what}</button>
                      ) : (
                        v.what
                      )}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-500">
                      {v.by && (
                        <span className="flex items-center gap-1">
                          <Avatar p={v.by} size={14} />
                          <span style={{ color: v.by.color }}>{v.by.name}</span>
                        </span>
                      )}
                      <span title={new Date(v.at).toLocaleString()}>{ago(v.at)}</span>
                      {changes.map((c) => <span key={c} className="rounded bg-white/5 px-1 text-ink-300">{c}</span>)}
                      {v.stats && !prev && <span className="text-ink-500">{fmt(v.stats.duration)} long</span>}
                    </div>
                    {(isNow || isCompared || p.canEdit || !v.sameAsNow) && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {isNow ? (
                          <span className="rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-gold">Current</span>
                        ) : v.sameAsNow ? (
                          <span className="rounded-md px-1.5 py-0.5 text-[11px] text-ink-400" title="This version's files are the same as the edit's now">Same as now</span>
                        ) : (
                          <button
                            onClick={() => p.onCompare(isCompared ? null : v.n)}
                            className={cx("rounded-md px-2 py-0.5 text-[11px] font-medium ring-1", isCompared ? "bg-gold text-ink-950 ring-gold" : "text-ink-200 ring-white/10 hover:bg-white/5")}
                            title="Play this version side by side with the current edit"
                          >
                            {isCompared ? "Comparing" : "Compare"}
                          </button>
                        )}
                        {p.canEdit && !isNow && !v.sameAsNow && (
                          <button
                            onClick={() => confirm(`Restore version ${v.n}? The edit goes back to it; the edit as it is now stays in the history, so you can come back.`) && p.onRestore(v.n)}
                            className="rounded-md px-2 py-0.5 text-[11px] font-medium text-ink-200 ring-1 ring-white/10 hover:bg-white/5"
                          >
                            Restore
                          </button>
                        )}
                        {p.canEdit && naming !== v.n && (
                          <button onClick={() => startNaming(v)} className="rounded-md px-2 py-0.5 text-[11px] text-ink-400 hover:bg-white/5 hover:text-ink-200">
                            {v.label ? "Rename" : "Name"}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
        {!onlyNamed && p.versions.length > 0 && (
          <p className="mt-4 px-2 text-[11px] leading-relaxed text-ink-500">
            Versions keep the edit's files (draft, captions, plans). Footage and rendered cards play as they are today.
          </p>
        )}
      </div>
    </aside>
  );
}
