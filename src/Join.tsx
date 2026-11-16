import { useEffect, useState } from "react";
import { api } from "./api";
import type { Role } from "./types";

export const ROLE_INFO: Record<Role, { label: string; what: string }> = {
  owner: { label: "Owner", what: "Everything, and who is in the room." },
  editor: { label: "Editor", what: "Comments go straight to Claude. Approves others' comments, picks options, undoes, exports." },
  commenter: { label: "Commenter", what: "Comments on the edit; an editor approves each one before Claude makes the change." },
  viewer: { label: "Viewer", what: "Watches the edit and follows the comments." },
};

/**
 * The page an invite link opens (/join#token). The token stays in the URL's #part, so it never reaches a server log;
 * the person types their name and gets a session on this device.
 */
export function Join({ onDone }: { onDone: () => void }) {
  const token = location.hash.slice(1);
  const [info, setInfo] = useState<{ role: Role; from: string; projects: string[] | null } | null>(null);
  const [error, setError] = useState<string | null>(token ? null : "This link is missing its invite code. Ask for a new link.");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (token) api.invite(token).then(setInfo).catch((e) => setError(e.message));
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.join(token, name.trim());
      history.replaceState(null, "", "/"); // the code is used up; don't leave it in the address bar
      onDone();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid h-full place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-[360px] rounded-2xl bg-ink-900 p-5 ring-1 ring-white/5">
        <div className="mb-5 flex items-center gap-2">
          <div className="grid h-7 w-7 place-items-center rounded-md bg-gold text-[13px] font-black text-ink-950">E</div>
          <span className="text-[15px] font-semibold tracking-tight">Edit Room</span>
        </div>
        {info ? (
          <>
            <p className="text-[14px] leading-snug text-ink-100">
              {info.from} invited you to {info.projects ? <b className="font-semibold">{info.projects.join(", ")}</b> : "their edits"} as{" "}
              <b className="font-semibold text-gold">{ROLE_INFO[info.role].label.toLowerCase()}</b>.
            </p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-400">{ROLE_INFO[info.role].what}</p>
            <label htmlFor="name" className="mb-1.5 mt-5 block text-[12px] text-ink-300">Your name</label>
            <input
              id="name"
              autoComplete="name"
              autoFocus
              maxLength={40}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="So others know who's commenting"
              className="w-full rounded-lg bg-ink-950/70 px-3 py-2.5 text-[16px] text-ink-100 outline-none ring-1 ring-white/10 placeholder:text-ink-500 focus:ring-gold/50"
            />
            {error && <p className="mt-2 text-[12px] text-red-300">{error}</p>}
            <button
              disabled={!name.trim() || busy}
              className="mt-4 w-full rounded-lg bg-gold py-2.5 text-[14px] font-semibold text-ink-950 transition hover:brightness-110 disabled:opacity-40"
            >
              {busy ? "Joining…" : "Join"}
            </button>
            <p className="mt-3 text-[11px] leading-relaxed text-ink-500">The link works once. You stay in on this device for 30 days.</p>
          </>
        ) : (
          <p className="text-[13px] leading-relaxed text-ink-300">{error ?? "Checking the invite…"}</p>
        )}
      </form>
    </div>
  );
}
