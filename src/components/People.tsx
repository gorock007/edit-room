import { useEffect, useState } from "react";
import { api } from "../api";
import { ROLE_INFO } from "../Join";
import type { Invite, McpUrls, Person, PersonFull, ProjectInfo, Role } from "../types";
import { cx } from "../util";

/** People are round; agents are square, so you can tell at a glance who is a person. */
export function Avatar({ p, size = 24, ring }: { p: Pick<Person, "name" | "color" | "kind">; size?: number; ring?: boolean }) {
  const initials = p.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
  return (
    <span
      className={cx("grid shrink-0 place-items-center font-bold text-ink-950", p.kind === "agent" ? "rounded-[28%]" : "rounded-full", ring && "ring-2 ring-ink-900")}
      style={{ width: size, height: size, background: p.color, fontSize: Math.round(size * 0.42) }}
      title={p.kind === "agent" ? `${p.name} (agent)` : p.name}
    >
      {initials}
    </span>
  );
}

const INVITABLE: Role[] = ["commenter", "editor", "viewer"];

/**
 * Share (the owner only): who is in the room, what each person may do, and one-time invite links. People reach this Mac
 * over Tailscale, so the link only opens for someone this Mac is shared with.
 */
export function SharePanel({ me, pid, projects, onClose, onMeChanged }: { me: Person; pid: string | null; projects: ProjectInfo[]; onClose: () => void; onMeChanged: () => void }) {
  const [list, setList] = useState<PersonFull[]>([]);
  const [open, setOpen] = useState<Invite[]>([]);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [role, setRole] = useState<Role>("commenter");
  const [scope, setScope] = useState<"this" | "all">(pid ? "this" : "all");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState(me.name);
  // connect an agent
  const [agentName, setAgentName] = useState("");
  const [agentRole, setAgentRole] = useState<Role>("commenter");
  const [agentScope, setAgentScope] = useState<"this" | "all">(pid ? "this" : "all");
  const [made, setMade] = useState<{ name: string; key: string; mcp: McpUrls } | null>(null);

  const load = () =>
    api.people().then((r) => {
      setList(r.people);
      setOpen(r.invites);
      setPublicUrl(r.publicUrl);
    }).catch((e) => setErr(e.message));

  const connect = async () => {
    setErr(null);
    try {
      const r = await api.connectAgent(agentName.trim() || "Agent", agentRole, agentScope === "this" && pid ? [pid] : "all");
      setMade({ name: r.person.name, key: r.key, mcp: r.mcp });
      setAgentName("");
      load();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  useEffect(() => {
    load();
    const close = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  // someone joined or changed: the server pokes the owner's app (see App)
  useEffect(() => {
    const on = () => load();
    window.addEventListener("room:people", on);
    return () => window.removeEventListener("room:people", on);
  }, []);

  const act = (p: Promise<unknown>) => p.then(load).catch((e) => setErr(e.message));
  const projName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const thisName = pid ? projName(pid) : "";

  const invite = async () => {
    setErr(null);
    setCopied(false);
    try {
      const r = await api.makeInvite(role, scope === "this" && pid ? [pid] : "all");
      setLink(r.url ?? `${location.origin}/join#${r.token}`);
      load();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setErr("Couldn't copy; select the link and copy it by hand.");
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-3" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="max-h-[90dvh] w-full max-w-[460px] overflow-y-auto rounded-2xl bg-ink-900 p-5 text-[13px] text-ink-200 shadow-2xl ring-1 ring-white/10">
        <div className="mb-4 flex items-center justify-between">
          <div className="text-[15px] font-semibold text-ink-100">Share{thisName ? ` “${thisName}”` : ""}</div>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-ink-400 hover:bg-white/5 hover:text-ink-200">Close</button>
        </div>

        {/* invite */}
        <div className="rounded-xl bg-ink-850 p-3 ring-1 ring-white/5">
          <div className="mb-2 text-[12px] font-medium text-ink-300">Invite someone</div>
          <div className="flex flex-wrap gap-2">
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} className="rounded-md bg-ink-950 px-2 py-1.5 text-[16px] ring-1 ring-white/10 md:text-[12px]">
              {INVITABLE.map((r) => <option key={r} value={r}>{ROLE_INFO[r].label}</option>)}
            </select>
            <select value={scope} onChange={(e) => setScope(e.target.value as "this" | "all")} className="min-w-0 flex-1 rounded-md bg-ink-950 px-2 py-1.5 text-[16px] ring-1 ring-white/10 md:text-[12px]">
              {pid && <option value="this">Only {thisName}</option>}
              <option value="all">All projects</option>
            </select>
            <button onClick={invite} className="rounded-md bg-gold px-3 py-1.5 text-[12px] font-semibold text-ink-950 hover:brightness-110">Create link</button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-500">{ROLE_INFO[role].what}</p>
          {link && (
            <div className="mt-3 space-y-2">
              <div className="flex gap-2">
                <input readOnly value={link} onFocus={(e) => e.target.select()} className="min-w-0 flex-1 rounded-md bg-ink-950 px-2 py-1.5 font-mono text-[11px] text-ink-100 ring-1 ring-white/10" />
                <button onClick={copy} className="rounded-md px-2.5 py-1.5 text-[12px] text-ink-100 ring-1 ring-white/15 hover:bg-white/5">{copied ? "Copied" : "Copy"}</button>
              </div>
              <p className="text-[11px] leading-relaxed text-ink-400">Works once, for 7 days. Send it only to the person you mean: whoever opens it first gets in.</p>
            </div>
          )}
          {!publicUrl && (
            <p className="mt-3 rounded-md bg-gold/10 px-2 py-1.5 text-[11px] leading-relaxed text-gold">
              This Mac isn't shared on Tailscale yet, so the link can't open on another device. In the edit-room folder run <code className="font-mono">npm run phone</code>, then share this Mac with the person in Tailscale (admin console → Machines → ⋯ → Share).
            </p>
          )}
          {open.length > 0 && (
            <div className="mt-3 flex items-center justify-between text-[11px] text-ink-500">
              <span>{open.length} unused link{open.length > 1 ? "s" : ""} still open</span>
              <button onClick={() => act(api.cancelInvites())} className="hover:text-ink-200">Cancel them</button>
            </div>
          )}
        </div>

        {/* agents */}
        <div className="mt-3 rounded-xl bg-ink-850 p-3 ring-1 ring-white/5">
          <div className="mb-2 text-[12px] font-medium text-ink-300">Connect an agent</div>
          <p className="mb-2 text-[11px] leading-relaxed text-ink-500">
            Claude Code, Codex or any agent that speaks MCP joins the room with its own key: it reads the timeline, looks at frames and leaves comments, under the same role and approvals as a person.
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              value={agentName}
              maxLength={40}
              onChange={(e) => setAgentName(e.target.value)}
              placeholder="Name (e.g. Codex)"
              className="min-w-0 flex-1 basis-[120px] rounded-md bg-ink-950 px-2 py-1.5 text-[16px] text-ink-100 ring-1 ring-white/10 placeholder:text-ink-500 md:text-[12px]"
            />
            <select value={agentRole} onChange={(e) => setAgentRole(e.target.value as Role)} className="rounded-md bg-ink-950 px-2 py-1.5 text-[16px] ring-1 ring-white/10 md:text-[12px]">
              {INVITABLE.map((r) => <option key={r} value={r}>{ROLE_INFO[r].label}</option>)}
            </select>
            <select value={agentScope} onChange={(e) => setAgentScope(e.target.value as "this" | "all")} className="rounded-md bg-ink-950 px-2 py-1.5 text-[16px] ring-1 ring-white/10 md:text-[12px]">
              {pid && <option value="this">Only {thisName}</option>}
              <option value="all">All projects</option>
            </select>
            <button onClick={connect} className="rounded-md bg-gold px-3 py-1.5 text-[12px] font-semibold text-ink-950 hover:brightness-110">Connect</button>
          </div>
          {made && <AgentKey made={made} onError={setErr} />}
        </div>

        {/* people */}
        <div className="mt-4 text-[12px] font-medium text-ink-300">People and agents</div>
        <ul className="mt-2 divide-y divide-white/5">
          {list.map((p) => (
            <li key={p.id} className="flex items-center gap-3 py-2.5">
              <Avatar p={p} size={28} />
              <div className="min-w-0 flex-1">
                {p.id === me.id ? (
                  <input
                    value={name}
                    maxLength={40}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => name.trim() && name.trim() !== me.name && api.rename(name.trim()).then(onMeChanged).then(load).catch((e) => setErr(e.message))}
                    onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    className="w-full rounded bg-transparent px-1 py-0.5 text-[13px] font-medium text-ink-100 outline-none ring-1 ring-transparent hover:ring-white/10 focus:ring-gold/40"
                    title="Your name, as others see it"
                  />
                ) : (
                  <div className="truncate px-1 text-[13px] font-medium text-ink-100">{p.name}</div>
                )}
                <div className="truncate px-1 text-[11px] text-ink-500">
                  {p.id === me.id ? "You · " : p.kind === "agent" ? "Agent · " : ""}{p.projects === "all" ? "All projects" : p.projects.map(projName).join(", ")}
                </div>
              </div>
              {p.role === "owner" ? (
                <span className="text-[12px] text-ink-400">Owner</span>
              ) : (
                <>
                  <select
                    value={p.role}
                    onChange={(e) => act(api.updatePerson(p.id, { role: e.target.value as Role }))}
                    className="rounded-md bg-ink-950 px-1.5 py-1 text-[16px] ring-1 ring-white/10 md:text-[12px]"
                    title={ROLE_INFO[p.role].what}
                  >
                    {INVITABLE.map((r) => <option key={r} value={r}>{ROLE_INFO[r].label}</option>)}
                  </select>
                  <button
                    onClick={() =>
                      confirm(p.kind === "agent" ? `Disconnect ${p.name}? Its key stops working right away.` : `Remove ${p.name}? They're signed out on every device right away.`) &&
                      act(api.removePerson(p.id))
                    }
                    className="rounded-md px-1.5 py-1 text-[12px] text-ink-500 hover:bg-red-500/10 hover:text-red-300"
                    title="Remove from the room"
                  >
                    Remove
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
        {err && <p className="mt-3 rounded-md bg-red-500/10 px-2 py-1.5 text-[12px] text-red-300">{err}</p>}
      </div>
    </div>
  );
}

/** A new agent's key, shown this once, ready to paste into the agent's MCP settings. */
function AgentKey({ made, onError }: { made: { name: string; key: string; mcp: McpUrls }; onError: (e: string) => void }) {
  const [where, setWhere] = useState<"local" | "remote">("local");
  const [copied, setCopied] = useState<string | null>(null);
  const url = where === "remote" && made.mcp.remote ? made.mcp.remote : made.mcp.local;
  const slug = made.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
  const claude = `claude mcp add --transport http edit-room ${url} --header "Authorization: Bearer ${made.key}"`;
  const json = JSON.stringify({ mcpServers: { "edit-room": { type: "http", url, headers: { Authorization: `Bearer ${made.key}` } } } }, null, 2);
  const copy = async (what: string, s: string) => {
    try {
      await navigator.clipboard.writeText(s);
      setCopied(what);
    } catch {
      onError("Couldn't copy; select the text and copy it by hand.");
    }
  };
  const Block = ({ id, label, text }: { id: string; label: string; text: string }) => (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px] text-ink-400">
        <span>{label}</span>
        <button onClick={() => copy(id, text)} className="rounded px-1.5 py-0.5 text-ink-200 ring-1 ring-white/10 hover:bg-white/5">{copied === id ? "Copied" : "Copy"}</button>
      </div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-ink-950 p-2 font-mono text-[10.5px] leading-snug text-ink-100 ring-1 ring-white/10">{text}</pre>
    </div>
  );
  return (
    <div className="mt-3 space-y-2.5" data-agent={slug}>
      <p className="rounded-md bg-gold/10 px-2 py-1.5 text-[11px] leading-relaxed text-gold">
        {made.name}'s key is shown only now. Paste it into the agent's settings; if it's lost, disconnect the agent and connect it again.
      </p>
      <div className="flex rounded-md bg-ink-950 p-0.5 text-[11px] ring-1 ring-white/5">
        {(["local", "remote"] as const).map((w) => (
          <button
            key={w}
            disabled={w === "remote" && !made.mcp.remote}
            onClick={() => setWhere(w)}
            className={cx("flex-1 rounded px-2 py-1 disabled:opacity-40", where === w ? "bg-ink-700 text-ink-100" : "text-ink-400 hover:text-ink-200")}
            title={w === "remote" && !made.mcp.remote ? "Run npm run phone to share this Mac on Tailscale first" : undefined}
          >
            {w === "local" ? "Agent on this Mac" : "Agent on another machine"}
          </button>
        ))}
      </div>
      <Block id="claude" label="Claude Code: run this in a terminal" text={claude} />
      <Block id="json" label="Other agents: MCP settings (Streamable HTTP)" text={json} />
      {where === "remote" && <p className="text-[11px] leading-relaxed text-ink-500">The other machine must be on your Tailscale network (or this Mac shared with it).</p>}
    </div>
  );
}
