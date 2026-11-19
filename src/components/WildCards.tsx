import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { cx } from "../util";

/**
 * Wild cards: reels shared from the phone ("Edit Room" in the share sheet), broken down on the Mac by the
 * reel-breakdown skill. Read why each one worked, then decide: keep it as a reference, dismiss it, plan your own
 * version of one of its ideas, or make its look a template.
 */

export type Idea = { title: string; hook?: string; fits?: string };
export type Job = { kind: "plan" | "template"; status: "running" | "done" | "failed"; started: number; finished?: number; error?: string; idea?: number; slug?: string };
export type WildCard = {
  id: string;
  state: "working" | "ready" | "failed";
  decision: "new" | "reference" | "dismissed" | "planned" | "template";
  summary: {
    link?: string; handle?: string; title?: string; why?: string; length_s?: number; ideas?: Idea[];
    template?: string; template_worthy?: boolean; template_note?: string; seen_before?: string; error?: string;
  } | null;
  thumb: string | null;
  added: number;
  job: Job | null;
  plans: number[];
  template: string | null;
};
export type WildList = { cards: WildCard[]; waiting: number; templates: string[] };
export type WildDetail = WildCard & { breakdown: string | null; planText: Record<string, string>; templateText: string | null; numbers: Record<string, unknown> };

type Filter = "new" | "kept" | "all";
const media = (id: string, f: string) => `/media/wild/${encodeURIComponent(id)}/${f}`;
const isNew = (c: WildCard) => c.decision === "new";
const isKept = (c: WildCard) => c.decision === "reference" || c.decision === "planned" || c.decision === "template";
const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
};
const titleOf = (c: WildCard) => c.summary?.title || (c.state === "working" ? "Breaking it down…" : c.id);
const templateLabel = (c: WildCard) => {
  const t = (c.summary?.template ?? (c.summary?.template_worthy ? "yes" : c.summary?.template_worthy === false ? "no" : "")).toLowerCase();
  return t.startsWith("yes") ? "Worth a template" : t.startsWith("already") ? "Already your look" : t.startsWith("no") ? "Not a template" : null;
};

function Chip({ c }: { c: WildCard }) {
  const [label, tone] =
    c.job?.status === "running"
      ? [c.job.kind === "plan" ? "Planning…" : "Making template…", "text-gold bg-gold/10"]
      : c.state === "working"
        ? ["Breaking down…", "text-gold bg-gold/10"]
        : c.state === "failed"
          ? ["Failed", "text-red-300 bg-red-500/10"]
          : {
              new: ["New", "text-ink-950 bg-gold"],
              reference: ["Reference", "text-cap bg-cap/10"],
              planned: ["Planned", "text-sfx bg-sfx/10"],
              template: ["Template", "text-cut bg-cut/10"],
              dismissed: ["Dismissed", "text-ink-400 bg-white/5"],
            }[c.decision];
  return <span className={cx("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide", tone)}>{label}</span>;
}

// ---- a small markdown reader: headings, lists, tables, quotes, code, bold/italic, links; m:ss timestamps seek ----
const TS = /\b(\d{1,2}):(\d{2}(?:\.\d+)?)\b/;
function inline(text: string, onSeek: (t: number) => void, key = ""): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\b\d{1,2}:\d{2}(?:\.\d+)?\b|(?<![\w*])\*[^*\s][^*]*\*(?!\w))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${key}-${i++}`;
    if (tok.startsWith("**")) out.push(<strong key={k} className="font-semibold text-ink-100">{inline(tok.slice(2, -2), onSeek, k)}</strong>);
    else if (tok.startsWith("`") && /^`\d{1,2}:\d{2}(\.\d+)?`$/.test(tok)) out.push(...inline(tok.slice(1, -1), onSeek, k));
    else if (tok.startsWith("`")) out.push(<code key={k} className="rounded bg-white/5 px-1 font-mono text-[0.92em] text-ink-200">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("[")) {
      const [, label, href] = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      out.push(/^https?:\/\//.test(href) ? <a key={k} href={href} target="_blank" rel="noreferrer noopener" className="text-cap underline decoration-cap/40 hover:decoration-cap">{label}</a> : <span key={k}>{label}</span>);
    } else if (tok === "9:16" || tok === "16:9") {
      out.push(tok); // an aspect ratio, not a time
    } else if (TS.test(tok) && /^\d/.test(tok)) {
      const [, mm, ss] = tok.match(TS)!;
      const t = Number(mm) * 60 + Number(ss);
      out.push(
        <button key={k} onClick={() => onSeek(t)} className="rounded px-0.5 font-mono text-[0.92em] text-gold hover:bg-gold/10" title="Play the reel from here">
          {tok}
        </button>,
      );
    } else out.push(<em key={k}>{inline(tok.slice(1, -1), onSeek, k)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Md({ text, onSeek }: { text: string; onSeek: (t: number) => void }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push(<p key={blocks.length} className="my-2">{inline(para.join(" "), onSeek, `p${blocks.length}`)}</p>);
    para = [];
  };
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      blocks.push(<pre key={blocks.length} className="my-2 overflow-x-auto rounded-md bg-ink-850 p-3 font-mono text-[12px] text-ink-200">{body.join("\n")}</pre>);
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flush();
      const cls = h[1].length === 1 ? "mt-1 mb-2 text-[18px] font-semibold text-ink-100" : h[1].length === 2 ? "mt-6 mb-1 text-[14px] font-semibold text-gold" : "mt-4 mb-1 text-[13px] font-semibold text-ink-100";
      blocks.push(<div key={blocks.length} className={cls}>{inline(h[2], onSeek, `h${blocks.length}`)}</div>);
      i++;
      continue;
    }
    if (/^\s*\|/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const row = (s: string) => s.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = row(l);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(row(lines[i]));
      const k = blocks.length;
      blocks.push(
        <div key={k} className="my-3 overflow-x-auto">
          <table className="w-full border-collapse text-left text-[12px]">
            <thead>
              <tr>{head.map((c, j) => <th key={j} className="border-b border-white/10 px-2 py-1.5 font-semibold text-ink-200">{inline(c, onSeek, `t${k}h${j}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="align-top">{r.map((c, j) => <td key={j} className="border-b border-white/5 px-2 py-1.5">{inline(c, onSeek, `t${k}r${ri}c${j}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const li = l.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      flush();
      const items: { depth: number; ordered: string | null; text: string }[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (m) {
          items.push({ depth: Math.min(3, Math.floor(m[1].length / 2)), ordered: /\d/.test(m[2]) ? m[2] : null, text: m[3] });
          i++;
        } else if (/^\s{2,}\S/.test(lines[i]) && items.length) {
          items[items.length - 1].text += " " + lines[i].trim();
          i++;
        } else break;
      }
      const k = blocks.length;
      blocks.push(
        <ul key={k} className="my-2 space-y-1">
          {items.map((it, j) => (
            <li key={j} className="flex gap-2" style={{ paddingLeft: it.depth * 16 }}>
              <span className="shrink-0 text-ink-500">{it.ordered ?? "•"}</span>
              <span className="min-w-0">{inline(it.text, onSeek, `l${k}-${j}`)}</span>
            </li>
          ))}
        </ul>,
      );
      continue;
    }
    if (/^>\s?/.test(l)) {
      flush();
      const q: string[] = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) q.push(lines[i].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={blocks.length} className="my-2 border-l-2 border-gold/50 pl-3 text-ink-300">{inline(q.join(" "), onSeek, `q${blocks.length}`)}</blockquote>);
      continue;
    }
    if (!l.trim()) flush();
    else para.push(l.trim());
    i++;
  }
  flush();
  return <div className="text-[13px] leading-relaxed text-ink-300">{blocks}</div>;
}

// ---- the view ----

export function WildCards({ narrow, tick, owner, onClose, onError, onUse }: {
  narrow: boolean;
  tick: number;
  owner: boolean;
  onClose: () => void;
  onError: (e: string) => void;
  /** start a new edit in this template */
  onUse: (slug: string) => void;
}) {
  const [list, setList] = useState<WildList | null>(null);
  const [filter, setFilter] = useState<Filter>("new");
  const [sel, setSel] = useState<string | null>(() => new URLSearchParams(location.hash.slice(1)).get("card"));
  const [detail, setDetail] = useState<WildDetail | null>(null);
  const [tab, setTab] = useState<string>("breakdown");
  const video = useRef<HTMLVideoElement>(null);

  const load = useCallback(() => {
    api.wildcards().then(setList).catch((e) => onError(e.message));
  }, [onError]);
  useEffect(load, [load, tick]);
  useEffect(() => {
    if (!sel) return setDetail(null);
    api.wildcard(sel).then(setDetail).catch((e) => onError(e.message));
  }, [sel, tick, onError]);
  useEffect(() => {
    history.replaceState(null, "", sel ? `#wild&card=${encodeURIComponent(sel)}` : "#wild");
  }, [sel]);
  useEffect(() => setTab("breakdown"), [sel]);

  const cards = useMemo(() => {
    const all = list?.cards ?? [];
    return filter === "new" ? all.filter(isNew) : filter === "kept" ? all.filter(isKept) : all;
  }, [list, filter]);
  // desktop: always show something on the right
  useEffect(() => {
    if (!narrow && !sel && cards.length) setSel(cards[0].id);
  }, [narrow, sel, cards]);

  const seek = (t: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = t;
    v.play().catch(() => {});
    if (narrow) v.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const decide = (state: "new" | "reference" | "dismissed") => {
    if (!detail) return;
    api.wildDecision(detail.id, state).then(load).catch((e) => onError(e.message));
  };

  const count = (f: Filter) => (list?.cards ?? []).filter(f === "new" ? isNew : f === "kept" ? isKept : () => true).length;

  const listPane = (
    <div className={cx("flex min-h-0 flex-col", narrow ? "flex-1" : "w-[340px] shrink-0 border-r border-white/5")}>
      <div className="flex items-center gap-1 border-b border-white/5 px-3 py-2">
        {(["new", "kept", "all"] as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cx("rounded-md px-2.5 py-1 text-[12px]", filter === f ? "bg-white/10 text-ink-100" : "text-ink-400 hover:text-ink-200")}
          >
            {f === "new" ? "New" : f === "kept" ? "Kept" : "All"} <span className="text-ink-500 tnum">{count(f)}</span>
          </button>
        ))}
        {!!list?.waiting && (
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-gold" title="Links shared from the phone that the Mac hasn't broken down yet">
            <span className="h-1.5 w-1.5 rounded-full bg-gold pulse-ring" />
            {list.waiting} in the inbox
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list && cards.length === 0 && (
          <div className="px-5 py-10 text-center text-[12px] leading-relaxed text-ink-400">
            {filter === "new" ? (
              <>
                Nothing new. On your phone, tap <b className="text-ink-200">Share › Edit Room</b> on a reel you like; the breakdown shows up here a few minutes later.
              </>
            ) : filter === "kept" ? (
              "Nothing kept yet. Keep a reel as a reference, plan your version, or make it a template."
            ) : (
              "No wild cards yet."
            )}
          </div>
        )}
        {cards.map((c) => (
          <button
            key={c.id}
            onClick={() => setSel(c.id)}
            className={cx("flex w-full gap-3 border-b border-white/5 px-3 py-2.5 text-left hover:bg-white/[0.03]", sel === c.id && !narrow && "bg-white/[0.06]")}
          >
            <div className="h-[72px] w-[41px] shrink-0 overflow-hidden rounded bg-ink-800">
              {c.thumb && <img src={media(c.id, c.thumb)} alt="" loading="lazy" className="h-full w-full object-cover" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink-100">{titleOf(c)}</span>
                <Chip c={c} />
              </div>
              <div className="mt-0.5 text-[11px] text-ink-500">
                {c.summary?.handle ? `@${c.summary.handle}` : c.id} · {ago(c.added)}
              </div>
              {c.summary?.why && <div className="mt-1 line-clamp-2 text-[12px] leading-snug text-ink-300">{c.summary.why}</div>}
              {c.state === "failed" && <div className="mt-1 line-clamp-2 text-[12px] text-red-300">{c.summary?.error ?? "The breakdown failed."}</div>}
            </div>
          </button>
        ))}
      </div>
    </div>
  );

  const d = detail && detail.id === sel ? detail : null;
  const job = d?.job;
  const running = job?.status === "running";
  const ideas = d?.summary?.ideas ?? [];
  const tabs: [string, string][] = d
    ? [
        ["breakdown", "Breakdown"],
        ["ideas", `Ideas${ideas.length ? ` ${ideas.length}` : ""}`],
        ...d.plans.map((n) => [`plan-${n}`, `Plan ${n}`] as [string, string]),
        ...(d.templateText ? [["template", "Template"] as [string, string]] : []),
      ]
    : [];

  const detailPane = d ? (
    <div className={cx("flex min-h-0 flex-1", narrow ? "flex-col overflow-y-auto" : "")}>
      <div className={cx("shrink-0", narrow ? "bg-black" : "flex w-[340px] flex-col items-center gap-3 overflow-y-auto border-r border-white/5 p-4")}>
        {narrow && (
          <button onClick={() => setSel(null)} className="flex items-center gap-1 px-3 py-2 text-[12px] text-ink-300">
            <svg width="8" height="12" viewBox="0 0 8 12"><path d="M6.5 1L1.5 6l5 5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" /></svg>
            All wild cards
          </button>
        )}
        <video
          ref={video}
          key={d.id}
          src={media(d.id, "reel.mp4")}
          poster={d.thumb ? media(d.id, d.thumb) : undefined}
          controls
          playsInline
          preload="metadata"
          className={cx("aspect-[9/16] bg-black object-contain", narrow ? "mx-auto max-h-[60dvh] w-auto" : "w-full rounded-lg")}
        />
        {!narrow && <Numbers d={d} />}
      </div>

      <div className={cx("min-w-0 flex-1", !narrow && "overflow-y-auto")}>
        <div className="mx-auto max-w-[760px] px-4 py-4 md:px-6">
          <div className="flex flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h1 className="text-[17px] font-semibold leading-tight text-ink-100">{titleOf(d)}</h1>
                <Chip c={d} />
              </div>
              <div className="mt-1 text-[12px] text-ink-500">
                {d.summary?.handle && <>@{d.summary.handle} · </>}
                {d.summary?.length_s ? `${Math.round(d.summary.length_s)} s · ` : ""}
                shared {ago(d.added)}
                {d.summary?.link && (
                  <>
                    {" · "}
                    <a href={d.summary.link} target="_blank" rel="noreferrer noopener" className="text-ink-300 underline decoration-white/20 hover:text-ink-100">
                      original
                    </a>
                  </>
                )}
              </div>
            </div>
          </div>

          {d.summary?.why && <p className="mt-3 rounded-lg bg-gold/[0.07] px-3 py-2.5 text-[13px] leading-relaxed text-ink-100 ring-1 ring-gold/20">{d.summary.why}</p>}
          {d.summary?.seen_before && <p className="mt-2 text-[11px] text-ink-500">Studied before: {d.summary.seen_before}</p>}

          {d.state === "ready" && (
            <Actions d={d} running={running} owner={owner} live={!!d.template && !!list?.templates.includes(d.template)} onUse={onUse} onDecide={decide} onError={onError} onDone={load} />
          )}

          {job && job.status !== "done" && (
            <div className={cx("mt-3 flex items-center gap-2 rounded-md px-3 py-2 text-[12px]", running ? "bg-gold/10 text-gold" : "bg-red-500/10 text-red-300")}>
              {running && <span className="h-1.5 w-1.5 rounded-full bg-gold pulse-ring" />}
              <span className="flex-1">
                {running
                  ? `${job.kind === "plan" ? `Planning idea ${job.idea}` : `Making the template "${job.slug}"`}… started ${ago(job.started)}, usually 3-5 min.`
                  : `${job.kind === "plan" ? "Planning" : "Making the template"} failed: ${job.error ?? "unknown error"}`}
              </span>
              {running && owner && (
                <button onClick={() => api.wildStop(d.id).catch((e) => onError(e.message))} className="rounded px-2 py-0.5 text-ink-200 ring-1 ring-white/10 hover:bg-white/5">
                  Stop
                </button>
              )}
            </div>
          )}

          {d.state === "working" && <p className="mt-6 text-[13px] text-ink-400">The Mac is still breaking this reel down. It shows up here by itself when it's done (usually 5-8 minutes).</p>}
          {d.state === "failed" && <p className="mt-6 text-[13px] text-red-300">{d.summary?.error ?? "The breakdown failed."} The link file is in wild cards/inbox/failed.</p>}

          {tabs.length > 0 && d.state === "ready" && (
            <>
              <div className="mt-5 flex gap-1 overflow-x-auto border-b border-white/5">
                {tabs.map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setTab(k)}
                    className={cx("-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[12px]", tab === k ? "border-gold text-ink-100" : "border-transparent text-ink-400 hover:text-ink-200")}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="py-2">
                {tab === "breakdown" && (d.breakdown ? <Md text={d.breakdown} onSeek={seek} /> : <p className="py-4 text-[13px] text-ink-400">No breakdown.md in this folder.</p>)}
                {tab === "ideas" && <Ideas d={d} running={running} owner={owner} onError={onError} onDone={load} onOpen={(n) => setTab(`plan-${n}`)} />}
                {tab.startsWith("plan-") && <Md text={d.planText[tab.slice(5)] ?? ""} onSeek={seek} />}
                {tab === "template" && d.templateText && (
                  <>
                    <p className="mb-2 text-[11px] text-ink-500">
                      Saved as <code className="font-mono text-ink-300">Video Editor/templates/{d.template}</code>.{" "}
                      {d.template && list?.templates.includes(d.template) ? (
                        <button onClick={() => onUse(d.template!)} className="text-gold underline-offset-2 hover:underline">Make one like this →</button>
                      ) : (
                        "It has been deleted."
                      )}
                    </p>
                    <Md text={d.templateText} onSeek={seek} />
                  </>
                )}
              </div>
              {narrow && <Numbers d={d} />}
            </>
          )}
        </div>
      </div>
    </div>
  ) : (
    <div className="grid flex-1 place-items-center text-[13px] text-ink-500">{sel ? "Loading…" : ""}</div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-white/5 bg-ink-900 px-3 md:px-4">
        <span className="text-[13px] font-semibold text-ink-100">Wild cards</span>
        <span className="hidden text-[12px] text-ink-500 md:inline">Reels you shared from your phone, broken down. Decide what to build.</span>
        <button onClick={onClose} className="ml-auto rounded-md px-2 py-1 text-[12px] text-ink-300 ring-1 ring-white/10 hover:bg-white/5">
          Back to edits
        </button>
      </div>
      <div className="flex min-h-0 flex-1">{narrow ? (sel ? detailPane : listPane) : <>{listPane}{detailPane}</>}</div>
    </div>
  );
}

function Numbers({ d }: { d: WildDetail }) {
  const n = d.numbers as Record<string, any>;
  const rows: [string, string | null][] = [
    ["Length", n.length_s ? `${Number(n.length_s).toFixed(1)} s` : null],
    ["Picture changes", n.changes_per_s != null ? `${n.changes_per_s} per s` : null],
    ["Hard cuts", n.hard_cuts != null ? String(n.hard_cuts) : null],
    ["Voice", n.wpm ? `${n.wpm} wpm` : null],
    ["Loudness", n.lufs != null ? `${n.lufs} LUFS` : null],
    ["Likes", n.likes != null ? Number(n.likes).toLocaleString() : null],
  ];
  const tl = templateLabel(d);
  return (
    <div className="w-full space-y-1 px-1 py-3 text-[12px]">
      {rows.filter(([, v]) => v).map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3">
          <span className="text-ink-500">{k}</span>
          <span className="font-mono text-ink-200 tnum">{v}</span>
        </div>
      ))}
      {tl && (
        <div className="pt-2 text-ink-400">
          <span className="text-ink-200">{tl}.</span> {d.summary?.template_note}
        </div>
      )}
    </div>
  );
}

function Actions({ d, running, owner, live, onUse, onDecide, onError, onDone }: {
  d: WildDetail;
  running: boolean;
  owner: boolean;
  live: boolean;
  onUse: (slug: string) => void;
  onDecide: (s: "new" | "reference" | "dismissed") => void;
  onError: (e: string) => void;
  onDone: () => void;
}) {
  const [making, setMaking] = useState(false);
  const [exact, setExact] = useState(false);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const btn = "rounded-md px-2.5 py-1.5 text-[12px] ring-1 ring-white/10 hover:bg-white/5 disabled:opacity-40";
  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-2">
        {d.template && live ? (
          <button onClick={() => onUse(d.template!)} className={cx(btn, "bg-gold text-ink-950 ring-0 hover:bg-gold/90 font-medium")} title={`New edit in the "${d.template}" template`}>
            Make one like this
          </button>
        ) : !owner ? null : d.template ? (
          <span className="rounded-md bg-cut/10 px-2.5 py-1.5 text-[12px] text-cut">Template: {d.template} (deleted)</span>
        ) : (
          <button onClick={() => setMaking((m) => !m)} disabled={running} className={cx(btn, "bg-gold text-ink-950 ring-0 hover:bg-gold/90 font-medium")}>
            Make template
          </button>
        )}
        {d.decision === "reference" ? (
          <button onClick={() => onDecide("new")} className={btn}>Kept as reference · undo</button>
        ) : (
          <button onClick={() => onDecide("reference")} className={btn} title="Keep it to look back at, without building anything">
            Keep as reference
          </button>
        )}
        {d.decision === "dismissed" ? (
          <button onClick={() => onDecide("new")} className={btn}>Dismissed · restore</button>
        ) : (
          <button onClick={() => onDecide("dismissed")} className={cx(btn, "text-ink-400")}>Dismiss</button>
        )}
      </div>
      {making && !d.template && (
        <form
          className="mt-3 space-y-2 rounded-lg bg-ink-850 p-3 ring-1 ring-white/5"
          onSubmit={(e) => {
            e.preventDefault();
            api
              .wildTemplate(d.id, name, note, exact)
              .then(() => {
                setMaking(false);
                onDone();
              })
              .catch((er) => onError(er.message));
          }}
        >
          <p className="text-[12px] leading-relaxed text-ink-400">
            Claude writes the look as rules (pace, layout, screenshots, animation, {exact ? "the original's colours and logo" : "colours in your grade"}, fonts, captions, a "never do" list)
            into Video Editor/templates. It stays opt-in: your house style is still the default.
          </p>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={d.summary?.title ? `Name (e.g. "${d.summary.title.split(" ").slice(0, 3).join(" ")}")` : "Name"} className="w-full rounded-md bg-ink-900 px-2.5 py-1.5 text-[16px] text-ink-100 outline-none ring-1 ring-white/10 focus:ring-gold/50 md:text-[13px]" />
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Anything to keep or change? (optional)" className="w-full resize-none rounded-md bg-ink-900 px-2.5 py-1.5 text-[16px] text-ink-100 outline-none ring-1 ring-white/10 focus:ring-gold/50 md:text-[13px]" />
          <label className="flex items-center gap-2 text-[12px] text-ink-300">
            <input type="checkbox" checked={exact} onChange={(e) => setExact(e.target.checked)} className="accent-[var(--color-gold)]" />
            Copy the look exactly (the original's colours, logo and font) instead of adapting it to yours
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setMaking(false)} className="rounded-md px-2.5 py-1.5 text-[12px] text-ink-400 hover:text-ink-200">Cancel</button>
            <button className="rounded-md bg-gold px-3 py-1.5 text-[12px] font-medium text-ink-950 hover:bg-gold/90">Make it</button>
          </div>
        </form>
      )}
    </div>
  );
}

function Ideas({ d, running, owner, onError, onDone, onOpen }: { d: WildDetail; running: boolean; owner: boolean; onError: (e: string) => void; onDone: () => void; onOpen: (n: number) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const ideas = d.summary?.ideas ?? [];
  if (!ideas.length) return <p className="py-4 text-[13px] text-ink-400">No ideas in summary.json; read them in the breakdown.</p>;
  return (
    <div className="space-y-3 py-2">
      {ideas.map((idea, i) => {
        const n = i + 1;
        const has = d.plans.includes(n);
        const busy = running && d.job?.kind === "plan" && d.job.idea === n;
        return (
          <div key={n} className="rounded-lg bg-ink-850 p-3 ring-1 ring-white/5">
            <div className="flex items-start gap-2">
              <span className="font-mono text-[12px] text-ink-500">{n}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-ink-100">{idea.title}</div>
                {idea.hook && <p className="mt-1 text-[13px] italic leading-relaxed text-ink-300">"{idea.hook}"</p>}
                {idea.fits && <div className="mt-1.5 text-[11px] text-ink-500">Fits: {idea.fits}</div>}
              </div>
            </div>
            <div className="mt-2 flex justify-end gap-2">
              {has && (
                <button onClick={() => onOpen(n)} className="rounded-md px-2.5 py-1 text-[12px] text-sfx ring-1 ring-sfx/30 hover:bg-sfx/10">
                  Open plan
                </button>
              )}
              {!owner ? null : busy ? (
                <span className="flex items-center gap-1.5 px-2 text-[12px] text-gold"><span className="h-1.5 w-1.5 rounded-full bg-gold pulse-ring" />Planning…</span>
              ) : (
                <button onClick={() => setOpen(open === n ? null : n)} disabled={running} className="rounded-md px-2.5 py-1 text-[12px] text-ink-200 ring-1 ring-white/10 hover:bg-white/5 disabled:opacity-40">
                  {has ? "Plan again" : "Plan this"}
                </button>
              )}
            </div>
            {open === n && (
              <form
                className="mt-2 space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  api
                    .wildPlan(d.id, n, note)
                    .then(() => {
                      setOpen(null);
                      setNote("");
                      onDone();
                    })
                    .catch((er) => onError(er.message));
                }}
              >
                <p className="text-[12px] text-ink-400">Claude writes a one-page plan: the hook, the whole script in your voice with what's on screen per line, what to record, and anything new to build.</p>
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Your angle or anything to change (optional)" className="w-full resize-none rounded-md bg-ink-900 px-2.5 py-1.5 text-[16px] text-ink-100 outline-none ring-1 ring-white/10 focus:ring-gold/50 md:text-[13px]" />
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setOpen(null)} className="rounded-md px-2.5 py-1 text-[12px] text-ink-400 hover:text-ink-200">Cancel</button>
                  <button className="rounded-md bg-gold px-3 py-1 text-[12px] font-medium text-ink-950 hover:bg-gold/90">Write the plan</button>
                </div>
              </form>
            )}
          </div>
        );
      })}
    </div>
  );
}
