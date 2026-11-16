import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

/**
 * How much of the Claude plan is used, so the router can step down to cheaper models before a limit stops an edit.
 * Read live from Claude Code (the same numbers as /usage; no model call), kept fresh by the rate-limit events of each
 * run, with Jarvis's statusline reading (~/.jarvis/usage.json) as a fallback.
 */
export type Band = "green" | "amber" | "red" | "unknown";
export type Usage = { fiveHour: number | null; sevenDay: number | null; at: number; source: "live" | "run" | "jarvis" | "none"; band: Band };

const FRESH_MS = 2 * 60_000;
const STALE_MS = 30 * 60_000;
let cached: Usage | null = null;
let inflight: Promise<Usage> | null = null;

/** Thresholds: the week matters most (it runs out for days); the 5-hour window refills soon. */
export function bandOf(five: number | null, seven: number | null): Band {
  if (five == null && seven == null) return "unknown";
  if ((five ?? 0) >= 90 || (seven ?? 0) >= 95) return "red";
  if ((five ?? 0) >= 70 || (seven ?? 0) >= 85) return "amber";
  return "green";
}

const make = (fiveHour: number | null, sevenDay: number | null, source: Usage["source"], at = Date.now()): Usage => ({
  fiveHour,
  sevenDay,
  at,
  source,
  band: bandOf(fiveHour, sevenDay),
});

const pct = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v <= 1 && v > 0 ? v * 100 : v) : null);

/** Ask Claude Code for the plan's usage. Starts the CLI with no prompt and no tools, so no model is called. */
async function live(): Promise<Usage | null> {
  const abort = new AbortController();
  async function* idle() {
    await new Promise((r) => abort.signal.addEventListener("abort", r));
  }
  const timer = setTimeout(() => abort.abort(), 20_000);
  try {
    const q = query({ prompt: idle() as any, options: { abortController: abort, settingSources: [], tools: [], persistSession: false, cwd: os.tmpdir() } });
    const u: any = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    if (!u?.rate_limits_available || !u.rate_limits) return null; // an API key: no plan limits
    return make(pct(u.rate_limits.five_hour?.utilization), pct(u.rate_limits.seven_day?.utilization), "live");
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

/** Jarvis's statusline tap writes the same numbers whenever a Claude Code window redraws its status line. */
function jarvis(): Usage | null {
  const file = process.env.ROOM_USAGE_FILE ?? path.join(process.env.JARVIS_HOME ?? path.join(os.homedir(), ".jarvis"), "usage.json");
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    const at = Number(d.ts) * 1000;
    if (!(Date.now() - at < STALE_MS)) return null;
    return make(pct(d.five_hour?.used_percentage), pct(d.seven_day?.used_percentage), "jarvis", at);
  } catch {
    return null;
  }
}

export async function readUsage(force = false): Promise<Usage> {
  if (!force && cached && Date.now() - cached.at < FRESH_MS) return cached;
  inflight ??= (async () => {
    const u = (await live()) ?? jarvis() ?? (cached && Date.now() - cached.at < STALE_MS ? cached : make(null, null, "none"));
    cached = u;
    inflight = null;
    return u;
  })();
  return inflight;
}

/** A run's rate-limit event (sent by Claude Code as a run gets close to a limit) updates the reading at once. */
export function noteRateLimit(info: { rateLimitType?: string; utilization?: number; status?: string }) {
  const v = pct(info.utilization);
  const base = cached ?? make(null, null, "none");
  let five = base.fiveHour, seven = base.sevenDay;
  if (info.rateLimitType === "five_hour") five = v ?? (info.status === "rejected" ? 100 : five);
  else if (info.rateLimitType?.startsWith("seven_day")) seven = Math.max(seven ?? 0, v ?? (info.status === "rejected" ? 100 : 0)) || seven;
  else return;
  cached = make(five, seven, "run");
}

export function usageText(u: Usage) {
  const parts = [u.fiveHour != null ? `5-hour ${u.fiveHour}%` : "", u.sevenDay != null ? `week ${u.sevenDay}%` : ""].filter(Boolean);
  return parts.join(", ") || "unknown";
}
