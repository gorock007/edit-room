# Edit Room

Claude Design for video editing: a live preview of an edit, click anything in it, and Claude makes the change.

```bash
npm run dev        # server on :4310 + app on http://127.0.0.1:5310 (also keeps dist/ built for the phone)
```

- **Projects** are the `NNNN edit` folders in the Video Editor folder, linked to their CapCut draft (which stays the
  edit document; CapCut itself is optional, the free plan is enough).
- **Preview**: a 960 px picture proxy (cuts + cards, built by the skill's `preview.py`), the caption composition
  played live as HTML, and every sound effect played live from its file. Caption and sound changes show instantly;
  picture changes rebuild the proxy (about a minute).
- **Comments**: press `C`, click a caption word, a spot in the frame, or anything on the timeline. The comment goes to
  a Claude Agent SDK session (your Claude login, your skills and memory) the moment you send it. Comments on one
  project run one at a time; each shows live steps, Claude's reply, and **Undo** (restores every file it changed).
- **Options**: pick "2 options" or "3 options" in the comment box. Claude makes each take without touching the edit,
  then they play side by side, in sync, next to the current version; **Use this** applies one, **Keep current** drops
  them.
- **Devices**: Desktop / Phone / In feed (`1` `2` `3`).

## On your phone (Tailscale)

The server only listens on `127.0.0.1`. Other devices reach it through `tailscale serve`, which gives this Mac an
HTTPS address that only devices in your own tailnet can open (never use `tailscale funnel`, which is public).

1. Install Tailscale on the phone and sign in to the same tailnet as the Mac.
2. On the Mac, set the password the phone will use: `npm run password`
3. Share the server on the tailnet: `npm run phone` (once; it stays on across restarts). It prints the address,
   `https://<this-mac>.<tailnet>.ts.net`.
4. Open that address on the phone and log in. Add it to the home screen for a full-screen app.

Anything that is not this Mac itself must log in: the password is stored only as an scrypt hash in `data/auth.json`,
the phone gets a 30-day `HttpOnly; Secure; SameSite=Strict` session cookie, and 5 wrong tries lock login for 15
minutes. `npm run password` again signs every device out. Turn sharing off with `tailscale serve --https=443 off`.

Server code is in `server/` (projects, proxy, agent, store), the app in `src/`. Data (proxies, comments, undo
snapshots, the password hash and sessions) lives in `data/`, outside iCloud and outside git. Every request is also
checked for its Host and Origin, so other websites open in your browser can't reach the server. A comment makes the
agent run commands on this Mac, so keep the password strong and the server off the public internet.

Settings (env): `ROOM_VIDEO_ROOT`, `ROOM_CAPCUT_DRAFTS`, `ROOM_SKILL_DIR`, `ROOM_DATA_DIR`, `ROOM_PORT`,
`ROOM_PUBLIC_HOST` (the Tailscale name, detected by default), `ROOM_REQUIRE_LOGIN=1` (ask for the password on this Mac
too).
