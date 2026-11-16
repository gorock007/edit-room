import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { can, runsDirectly, type Comment, type Pick, type Target, type Tier, type Usage } from "../types";
import { ago, basename, cx, fmt } from "../util";
import { useMe } from "../room";
import { Composer, TargetChip } from "./Composer";
import { Avatar } from "./People";

type Props = {
  comments: Comment[];
  time: number;
  focusId: string | null;
  onFocus: (id: string | null) => void;
  onSeek: (t: number) => void;
  onStop: (id: string) => void;
  onUndo: (id: string) => void;
  onApprove: (id: string) => void;
  onDecline: (id: string) => void;
  /** start a comment that waits because the plan is nearly used up */
  onRun: (id: string, tier: Tier) => void;
  onSubmit: (c: { text: string; t: number; x: null; y: null; target: Target; want: number; pick?: Pick }) => void;
  onCompare: (id: string) => void;
  /** phone layout: full width, scrolls with the page */
  full?: boolean;
  /** a new edit before its first build: nothing to comment on yet, only the build's progress */
  noComposer?: boolean;
  /** replaces the "Comments" title (the Comments / History switch) */
  header?: React.ReactNode;
};

export function CommentsPanel(p: Props) {
  const me = useMe();
  const editor = can(me, "editor");
  const approver = runsDirectly(me);
  const waiting = p.comments.filter((c) => c.status === "pending");
  const [onlyWaiting, setOnlyWaiting] = useState(false);
  const show = onlyWaiting && waiting.length ? waiting : p.comments;
  const list = [...show].sort((a, b) => b.createdAt - a.createdAt);
  const working = p.comments.filter((c) => c.status === "working" || c.status === "queued").length;
  // the moment you start typing is the comment's time, not the moment you press Send (the video may be playing)
  const [at, setAt] = useState<number | null>(null);
  const usage = useUsage(editor, working);
  return (
    <aside className={cx("flex shrink-0 flex-col bg-ink-900", p.full ? "w-full" : "w-[320px] border-l border-white/5 xl:w-[380px]")}>
      <div className="flex h-11 items-center justify-between gap-2 border-b border-white/5 px-4">
        {p.header ?? <div className="text-[13px] font-semibold text-ink-100">Comments</div>}
        <div className="flex items-center gap-2 text-[11px] text-ink-400">
          {waiting.length > 0 && (
            <button
              onClick={() => setOnlyWaiting(!onlyWaiting)}
              className={cx("rounded-md px-1.5 py-0.5 font-semibold ring-1", onlyWaiting ? "bg-gold text-ink-950 ring-gold" : "text-gold ring-gold/30 hover:bg-gold/10")}
              title={onlyWaiting ? "Show every comment" : "Show only comments waiting for approval"}
            >
              {waiting.length} to approve
            </button>
          )}
          {usage && <UsageMeter u={usage} />}
          <span>{working ? `${working} in progress` : `${p.comments.length} total`}</span>
        </div>
      </div>
      {!p.noComposer && can(me, "commenter") && <div className="border-b border-white/5 p-3">
        <Composer
          compact
          target={{ kind: "general", label: "whole video" }}
          t={at ?? p.time}
          onFocus={() => setAt(p.time)}
          onSubmit={(text, want, model) => {
            p.onSubmit({ text, t: at ?? p.time, x: null, y: null, target: { kind: "general", label: "the whole video" }, want, pick: model });
            setAt(null);
          }}
        />
      </div>}
      <div className={cx("space-y-2 p-3", !p.full && "flex-1 overflow-y-auto")}>
        {list.length === 0 && !p.noComposer && (
          <div className="mt-10 px-6 text-center text-[13px] leading-relaxed text-ink-400">
            {!can(me, "commenter") ? "No comments yet. You can watch the edit and follow the comments here." :
              p.full ? "Tap Comment, then tap anything in the frame to ask for a change." : <>Press <Kbd>C</Kbd> and click anything in the frame or on the timeline to ask for a change.</>}
            {approver && " Claude starts on it the moment you send."}
          </div>
        )}
        {list.map((c) => (
          <Card key={c.id} c={c} focused={p.focusId === c.id} editor={editor} approver={approver} mine={(c.author?.id ?? "owner") === me?.id} {...p} />
        ))}
      </div>
    </aside>
  );
}

function Card({ c, focused, editor, approver, mine, onFocus, onSeek, onStop, onUndo, onApprove, onDecline, onCompare, onRun }: { c: Comment; focused: boolean; editor: boolean; approver: boolean; mine: boolean } & Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focused]);
  const live = c.status === "working" || c.status === "queued";
  const steps = c.activity.filter((a) => a.kind !== "text");
  const latest = [...c.activity].reverse().find((a) => a.kind === "tool" || a.kind === "info");
  const author = c.author ?? null;
  return (
    <div
      ref={ref}
      onClick={() => {
        onFocus(c.id);
        onSeek(c.t);
      }}
      className={cx(
        "relative cursor-pointer overflow-hidden rounded-xl bg-ink-850 p-3 ring-1 transition",
        focused ? "ring-gold/50" : c.status === "pending" ? "ring-gold/25 hover:ring-gold/40" : "ring-white/5 hover:ring-white/10",
        (c.status === "undone" || c.status === "declined") && "opacity-55",
      )}
    >
      {c.status === "working" && <div className="shimmer pointer-events-none absolute inset-0" />}
      <div className="relative">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <TargetChip target={c.target} t={c.t} />
          <StatusBadge c={c} />
        </div>
        <div className="flex gap-2">
          {author && <span className="mt-0.5"><Avatar p={author} size={18} /></span>}
          <p className="min-w-0 text-[13px] leading-snug text-ink-100">
            {author && <span className="mr-1 font-semibold" style={{ color: author.color }}>{mine ? "You" : author.name}</span>}
            {author?.kind === "agent" && <span className="mr-1 rounded bg-white/10 px-1 py-px align-[1px] text-[9px] font-semibold uppercase tracking-wide text-ink-300">agent</span>}
            {c.text}
          </p>
        </div>

        {c.status === "pending" && approver && (
          // everything the agent will be told about the click, so nothing reaches it that the approver didn't read
          <div className="mt-2 rounded-md bg-ink-950/50 px-2 py-1.5 text-[11px] leading-snug text-ink-400">
            Clicked: <span className="text-ink-200">{c.target.label}</span>{c.target.detail ? <> · {c.target.detail}</> : null} at {fmt(c.t, true)}
          </div>
        )}
        {c.status === "pending" && (
          approver ? (
            <div className="mt-2.5 flex gap-1.5">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onApprove(c.id);
                }}
                className="flex-1 rounded-lg bg-gold py-1.5 text-[12px] font-semibold text-ink-950 hover:brightness-110"
                title="Claude starts on it now"
              >
                Approve
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDecline(c.id);
                }}
                className="rounded-lg px-3 py-1.5 text-[12px] text-ink-200 ring-1 ring-white/10 hover:bg-white/5"
              >
                Decline
              </button>
            </div>
          ) : (
            <div className="mt-2 text-[12px] text-ink-400">Waiting for an editor to approve it</div>
          )
        )}

        {c.status === "held" && (
          <div className="mt-2 rounded-md bg-gold/5 px-2 py-1.5 text-[11.5px] leading-snug text-ink-300 ring-1 ring-gold/20">
            {c.held}
            {approver ? (
              <div className="mt-2 flex gap-1.5">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRun(c.id, "light");
                  }}
                  className="flex-1 rounded-lg bg-gold py-1.5 text-[12px] font-semibold text-ink-950 hover:brightness-110"
                  title="Sonnet 5.5, low effort: uses the least of your plan"
                >
                  Run on Sonnet
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRun(c.id, c.route?.tier === "deep" ? "deep" : "standard");
                  }}
                  className="flex-1 rounded-lg py-1.5 text-[12px] font-medium text-ink-100 ring-1 ring-white/10 hover:bg-white/5"
                  title={c.route?.tier === "deep" ? "Opus 5.5, high effort" : "Opus 5.5, medium effort"}
                >
                  Run on Opus
                </button>
              </div>
            ) : null}
          </div>
        )}

        {live && (
          <div className="mt-2 flex items-center gap-2 text-[12px] text-ink-300">
            <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", c.status === "working" ? "bg-gold pulse-ring" : "bg-ink-500")} />
            <span className="truncate">{c.status === "queued" ? (latest?.text === "Choosing a model" ? "Choosing a model…" : "Waiting for the previous comment to finish") : latest?.text ?? "Starting…"}</span>
          </div>
        )}

        {c.options && c.options.length > 0 && (
          <div className="mt-2.5 space-y-1">
            {c.options.map((o) => (
              <div key={o.key} className={cx("flex items-center gap-2 text-[12px]", c.chosen === o.key ? "text-ink-100" : "text-ink-300")}>
                <span className={cx("grid h-4 w-4 shrink-0 place-items-center rounded text-[10px] font-bold", c.chosen === o.key ? "bg-gold text-ink-950" : "bg-white/10 text-ink-200")}>{o.key}</span>
                <span className="truncate">{o.note}</span>
                {o.picture === "building" && <span className="shrink-0 text-[10px] text-ink-500">picture…</span>}
              </div>
            ))}
            {c.status === "review" && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onCompare(c.id);
                }}
                className="mt-1.5 w-full rounded-lg bg-gold py-1.5 text-[12px] font-semibold text-ink-950 hover:brightness-110"
              >
                {editor ? "Compare side by side" : "See the options side by side"}
              </button>
            )}
            {c.chosen && <div className="pt-1 text-[11px] text-ink-500">{c.chosen === "current" ? "Kept the current version" : `Using option ${c.chosen}`}</div>}
          </div>
        )}

        {c.reply && !live && (
          <div className="mt-2.5 flex gap-2">
            {c.status === "declined" ? null : <div className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-gold text-[10px] font-bold text-ink-950">C</div>}
            <p className="text-[13px] leading-snug text-ink-200">{c.reply}</p>
          </div>
        )}

        <div className="mt-2.5 flex items-center justify-between">
          <div className="flex items-center gap-3 text-[11px] text-ink-500">
            <span>{ago(c.createdAt)}</span>
            {c.approvedBy && c.status !== "declined" && c.status !== "pending" && <span>approved by {c.approvedBy}</span>}
            {c.status === "declined" && c.approvedBy && <span>declined by {c.approvedBy}</span>}
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
            {editor && c.route && c.status !== "held" && (
              <span
                className={cx("rounded px-1 py-px", c.route.stepped ? "bg-gold/10 text-gold/90" : "bg-white/5 text-ink-400")}
                title={[`${c.route.label}: ${c.route.why}`, c.route.by === "you" ? "Picked by hand" : `Chosen by ${c.route.by === "rules" ? "Edit Room's rules" : "Haiku"}`, c.route.stepped, `Plan usage then: ${c.route.usage}`].filter(Boolean).join("\n")}
              >
                {c.route.label.replace(" 5.5", "")}
              </span>
            )}
            {editor && c.changed && c.changed.length > 0 && c.status !== "undone" && (
              <span title={c.changed.join("\n")}>{c.changed.length} file{c.changed.length > 1 ? "s" : ""} changed</span>
            )}
          </div>
          <div className="flex gap-1">
            {(live && editor) || (c.status === "held" && editor) || ((live || c.status === "pending" || c.status === "held") && mine && c.status !== "working") ? (
              <SmallBtn onClick={() => onStop(c.id)}>{mine && c.status !== "working" ? "Withdraw" : "Stop"}</SmallBtn>
            ) : null}
            {editor && !live && c.status !== "undone" && (c.changed?.length ?? 0) > 0 && <SmallBtn onClick={() => onUndo(c.id)}>Undo</SmallBtn>}
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
            {editor && c.changed?.map((f) => (
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
    pending: ["Needs approval", "text-gold bg-gold/10 ring-1 ring-gold/30"],
    held: ["Waiting", "text-gold bg-gold/10 ring-1 ring-gold/30"],
    declined: ["Declined", "text-ink-400 bg-white/5"],
    queued: ["Queued", "text-ink-400 bg-white/5"],
    working: ["Working", "text-gold bg-gold/10"],
    review: ["Pick one", "text-ink-950 bg-gold"],
    done: ["Done", "text-sfx bg-sfx/10"],
    failed: ["Failed", "text-red-300 bg-red-400/10"],
    stopped: ["Stopped", "text-ink-400 bg-white/5"],
    undone: ["Undone", "text-ink-400 bg-white/5"],
  };
  const [label, style] = map[c.status];
  return <span className={cx("shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide", style)}>{label}</span>;
}

/** The plan's usage, for editors: it decides which model comments run on. Refreshed every 2 minutes and after a run. */
function useUsage(editor: boolean, working: number) {
  const [u, setU] = useState<Usage | null>(null);
  useEffect(() => {
    if (!editor) return;
    let gone = false;
    const load = () => api.usage().then((x) => !gone && setU(x)).catch(() => {});
    load();
    const t = setInterval(load, 120_000);
    return () => {
      gone = true;
      clearInterval(t);
    };
  }, [editor, working]);
  return u;
}

function UsageMeter({ u }: { u: Usage }) {
  if (u.band === "unknown") return null;
  const tone = u.band === "red" ? "text-red-300 ring-red-400/30" : u.band === "amber" ? "text-gold ring-gold/30" : "text-ink-400 ring-white/10";
  const effect =
    u.band === "red" ? "Near the limit: small fixes run on Sonnet, big ones wait for you." :
    u.band === "amber" ? "Getting close: Opus runs at medium effort, not high." :
    "Plenty left: each comment gets the model it needs.";
  const main = u.sevenDay != null && (u.fiveHour == null || u.sevenDay >= u.fiveHour) ? `Week ${u.sevenDay}%` : `5h ${u.fiveHour}%`;
  return (
    <span className={cx("rounded-md px-1.5 py-0.5 font-medium ring-1", tone)} title={`Claude plan usage: 5-hour ${u.fiveHour ?? "?"}%, week ${u.sevenDay ?? "?"}%.\n${effect}`}>
      {main}
    </span>
  );
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
