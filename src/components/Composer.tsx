import { useEffect, useRef, useState } from "react";
import type { Target } from "../types";
import { cx, fmt } from "../util";

export const KIND_STYLE: Record<Target["kind"], string> = {
  caption: "bg-cap/15 text-cap ring-cap/30",
  sfx: "bg-sfx/15 text-sfx ring-sfx/30",
  cut: "bg-cut/15 text-cut ring-cut/30",
  broll: "bg-broll/15 text-broll ring-broll/30",
  frame: "bg-white/10 text-ink-200 ring-white/15",
  general: "bg-white/10 text-ink-200 ring-white/15",
};

export function TargetChip({ target, t }: { target: Target; t?: number }) {
  return (
    <span className={cx("inline-flex max-w-full items-center gap-1.5 truncate rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1", KIND_STYLE[target.kind])}>
      {t != null && <span className="font-mono opacity-80 tnum">{fmt(t, true)}</span>}
      <span className="truncate">{target.label}</span>
    </span>
  );
}

export function Composer({ target, t, onSubmit, onCancel, compact }: { target: Target; t: number; onSubmit: (text: string) => void; onCancel?: () => void; compact?: boolean }) {
  const [text, setText] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!compact) ta.current?.focus();
  }, [compact]);
  const send = () => {
    if (text.trim()) {
      onSubmit(text.trim());
      setText("");
    }
  };
  return (
    <div
      className={cx("w-[320px] rounded-xl bg-ink-850/95 p-2.5 shadow-2xl ring-1 ring-white/10 backdrop-blur", compact && "w-full shadow-none")}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center gap-2">
        <TargetChip target={target} t={t} />
        {target.detail && <span className="truncate text-[11px] text-ink-400">{target.detail}</span>}
      </div>
      <textarea
        ref={ta}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
          if (e.key === "Escape") onCancel?.();
        }}
        rows={compact ? 2 : 3}
        placeholder={compact ? "Ask for a change to the whole video…" : "What should change here?"}
        className="w-full resize-none rounded-lg bg-ink-950/60 px-2.5 py-2 text-[13px] leading-snug text-ink-100 placeholder:text-ink-500 outline-none ring-1 ring-white/5 focus:ring-gold/40"
      />
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] text-ink-500">Enter to send · Claude starts right away</span>
        <div className="flex gap-1.5">
          {onCancel && (
            <button onClick={onCancel} className="rounded-md px-2 py-1 text-[12px] text-ink-300 hover:bg-white/5">
              Cancel
            </button>
          )}
          <button
            onClick={send}
            disabled={!text.trim()}
            className="rounded-md bg-gold px-2.5 py-1 text-[12px] font-semibold text-ink-950 transition disabled:opacity-30 hover:brightness-110"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
