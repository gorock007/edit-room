import { useEffect, useRef, useState } from "react";
import type { Comment, Target } from "../types";
import { ago, basename, cx, fmt } from "../util";
import { Composer, TargetChip } from "./Composer";

type Props = {
  comments: Comment[];
  time: number;
  focusId: string | null;
  onFocus: (id: string | null) => void;
  onSeek: (t: number) => void;
  onStop: (id: string) => void;
  onUndo: (id: string) => void;
  onSubmit: (c: { text: string; t: number; x: null; y: null; target: Target }) => void;
};

export function CommentsPanel(p: Props) {
  const list = [...p.comments].sort((a, b) => b.createdAt - a.createdAt);
  const working = p.comments.filter((c) => c.status === "working" || c.status === "queued").length;
  return (
    <aside className="flex w-[320px] xl:w-[380px] shrink-0 flex-col border-l border-white/5 bg-ink-900">
      <div className="flex h-11 items-center justify-between border-b border-white/5 px-4">
        <div className="text-[13px] font-semibold text-ink-100">Comments</div>
        <div className="text-[11px] text-ink-400">{working ? `${working} in progress` : `${p.comments.length} total`}</div>
      </div>
      <div className="border-b border-white/5 p-3">
        <Composer compact target={{ kind: "general", label: "whole video" }} t={p.time} onSubmit={(text) => p.onSubmit({ text, t: p.time, x: null, y: null, target: { kind: "general", label: "the whole video" } })} />
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {list.length === 0 && (
          <div className="mt-10 px-6 text-center text-[13px] leading-relaxed text-ink-400">
            Press <Kbd>C</Kbd> and click anything in the frame or on the timeline to ask for a change. Claude starts on it the moment you send.
          </div>
        )}
        {list.map((c) => (
          <Card key={c.id} c={c} focused={p.focusId === c.id} {...p} />
        ))}
      </div>
    </aside>
  );
}

function Card({ c, focused, onFocus, onSeek, onStop, onUndo }: { c: Comment; focused: boolean } & Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focused]);
  const live = c.status === "working" || c.status === "queued";
  const steps = c.activity.filter((a) => a.kind !== "text");
  const latest = [...c.activity].reverse().find((a) => a.kind === "tool" || a.kind === "info");
  return (
    <div
      ref={ref}
      onClick={() => {
        onFocus(c.id);
        onSeek(c.t);
      }}
      className={cx(
        "relative cursor-pointer overflow-hidden rounded-xl bg-ink-850 p-3 ring-1 transition",
        focused ? "ring-gold/50" : "ring-white/5 hover:ring-white/10",
        c.status === "undone" && "opacity-55",
      )}
    >
      {c.status === "working" && <div className="shimmer pointer-events-none absolute inset-0" />}
      <div className="relative">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <TargetChip target={c.target} t={c.t} />
          <StatusBadge c={c} />
        </div>
        <p className="text-[13px] leading-snug text-ink-100">{c.text}</p>

        {live && (
          <div className="mt-2 flex items-center gap-2 text-[12px] text-ink-300">
            <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", c.status === "working" ? "bg-gold pulse-ring" : "bg-ink-500")} />
            <span className="truncate">{c.status === "queued" ? "Waiting for the previous comment to finish" : latest?.text ?? "Starting…"}</span>
          </div>
        )}

        {c.reply && !live && (
          <div className="mt-2.5 flex gap-2">
            <div className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-gold text-[10px] font-bold text-ink-950">C</div>
            <p className="text-[13px] leading-snug text-ink-200">{c.reply}</p>
          </div>
        )}

        <div className="mt-2.5 flex items-center justify-between">
          <div className="flex items-center gap-3 text-[11px] text-ink-500">
            <span>{ago(c.createdAt)}</span>
            {steps.length > 0 && (
              <button
                className="hover:text-ink-200"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(!open);
                }}
              >
                {open ? "Hide" : "Show"} {steps.length} steps
              </button>
            )}
            {c.changed && c.changed.length > 0 && c.status !== "undone" && (
              <span title={c.changed.join("\n")}>{c.changed.length} file{c.changed.length > 1 ? "s" : ""} changed</span>
            )}
          </div>
          <div className="flex gap-1">
            {live && (
              <SmallBtn
                onClick={() => onStop(c.id)}
              >
                Stop
              </SmallBtn>
            )}
            {!live && c.status !== "undone" && (c.changed?.length ?? 0) > 0 && <SmallBtn onClick={() => onUndo(c.id)}>Undo</SmallBtn>}
          </div>
        </div>

        {open && (
          <ol className="mt-2 space-y-1 border-t border-white/5 pt-2 font-mono text-[11px] leading-snug text-ink-400">
            {c.activity.map((a, i) => (
              <li key={i} className={cx("flex gap-2", a.kind === "error" && "text-red-300", a.kind === "text" && "font-sans text-ink-300")}>
                <span className="shrink-0 text-ink-600 tnum">{fmt((a.at - c.createdAt) / 1000)}</span>
                <span className="break-words">{a.text}</span>
              </li>
            ))}
            {c.changed?.map((f) => (
              <li key={f} className="text-sfx/80">
                changed {basename(f)}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ c }: { c: Comment }) {
  const map: Record<Comment["status"], [string, string]> = {
    queued: ["Queued", "text-ink-400 bg-white/5"],
    working: ["Working", "text-gold bg-gold/10"],
    done: ["Done", "text-sfx bg-sfx/10"],
    failed: ["Failed", "text-red-300 bg-red-400/10"],
    stopped: ["Stopped", "text-ink-400 bg-white/5"],
    undone: ["Undone", "text-ink-400 bg-white/5"],
  };
  const [label, style] = map[c.status];
  return <span className={cx("shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide", style)}>{label}</span>;
}

function SmallBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="rounded-md px-2 py-0.5 text-[11px] font-medium text-ink-200 ring-1 ring-white/10 hover:bg-white/5"
    >
      {children}
    </button>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="mx-0.5 rounded bg-white/10 px-1.5 py-0.5 font-mono text-[11px] text-ink-100 ring-1 ring-white/10">{children}</kbd>;
}
