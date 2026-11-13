import { useState } from "react";
import { api } from "./api";

/** Shown on any device that is not the Mac itself (the phone over Tailscale) until it logs in. */
export function Login({ hasPassword, onDone }: { hasPassword: boolean; onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pw || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(pw);
      onDone();
    } catch (err: any) {
      setError(err.message);
      setPw("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid h-full place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-[340px] rounded-2xl bg-ink-900 p-5 ring-1 ring-white/5">
        <div className="mb-5 flex items-center gap-2">
          <div className="grid h-7 w-7 place-items-center rounded-md bg-gold text-[13px] font-black text-ink-950">E</div>
          <span className="text-[15px] font-semibold tracking-tight">Edit Room</span>
        </div>
        {hasPassword ? (
          <>
            <label htmlFor="pw" className="mb-1.5 block text-[12px] text-ink-300">Password</label>
            <input
              id="pw"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              className="w-full rounded-lg bg-ink-950/70 px-3 py-2.5 text-[16px] text-ink-100 outline-none ring-1 ring-white/10 focus:ring-gold/50"
            />
            {error && <p className="mt-2 text-[12px] text-red-300">{error}</p>}
            <button
              disabled={!pw || busy}
              className="mt-4 w-full rounded-lg bg-gold py-2.5 text-[14px] font-semibold text-ink-950 transition disabled:opacity-40 hover:brightness-110"
            >
              {busy ? "Checking…" : "Log in"}
            </button>
            <p className="mt-3 text-[11px] leading-relaxed text-ink-500">Stays logged in on this device for 30 days.</p>
          </>
        ) : (
          <p className="text-[13px] leading-relaxed text-ink-300">
            No password is set yet. On the Mac, in the edit-room folder, run <code className="rounded bg-ink-950 px-1 py-0.5 font-mono text-[12px] text-gold">npm run password</code>, then reload this page.
          </p>
        )}
      </form>
    </div>
  );
}
