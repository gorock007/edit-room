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
- **New edit** (`+` in the header): drop the raw camera file, or pick it from Photos/Files on the phone, add an
  optional note ("starts at …"), and Claude builds the first edit with the talking-head-reel-edit skill. The file goes
  to `<MMDD> edit/raw/` (today's date; `<MMDD>b` if that name is taken here or in CapCut) in 16 MB pieces, so a
  dropped connection or a reload resumes: pick the same file again. The phone's screen stays on while it uploads.
- **Export** (header): one upload-ready MP4 for Instagram Reels and TikTok, made straight from the CapCut draft (no
  CapCut export needed): 1080×1920 (or 1920×1080), 30 fps, H.264 High, AAC 320k, loudness −14 LUFS with true peak under
  −1 dBTP. It checks the file it wrote (frame count, format, loudness), offers it as a download (on the phone too) and
  saves a copy next to the edit. The menu lists the app settings that keep the quality when you post.

## On your phone (Tailscale)

The server only listens on `127.0.0.1`, on two ports: `4310` for this Mac (no login) and `4320`, where every request
must log in. Other devices reach `4320` through `tailscale serve`, which gives this Mac an HTTPS address that only
devices in your own tailnet can open. Never point `tailscale serve` at `4310`, and never use `tailscale funnel`
(public).

1. Install Tailscale on the phone and sign in to the same tailnet as the Mac.
2. On the Mac, set the password the phone will use: `npm run password`
3. Share the server on the tailnet: `npm run phone` (once; it stays on across restarts). It prints the address,
   `https://<this-mac>.<tailnet>.ts.net`.
4. Open that address on the phone and log in. Add it to the home screen for a full-screen app.

Anything that is not this Mac itself must log in: the password is stored only as an scrypt hash in `data/auth.json`,
the phone gets a 30-day `HttpOnly; Secure; SameSite=Strict` session cookie, and 5 wrong tries lock login for 15
minutes. `npm run password` again signs your own devices out. Turn sharing off with `tailscale serve --https=443 off`.

## Working with other people

**Share** (header, owner only) invites people into the room, like sharing a Google Doc:

- Pick a role and whether they see **only this project** or **all projects**, then **Create link**. The link works
  once, for 7 days; they open it, type their name, and stay in on that device for 30 days.
- **Viewer** watches and follows the comments. **Commenter** comments too, but each comment waits as *Needs approval*
  until an editor approves it (the agent runs commands on this Mac, so someone trusted reads every request first).
  **Editor** works like you: comments run right away, approves others, picks options, undoes, exports. Only people
  with all projects can start a new edit. The owner (this Mac, or your password) does everything.
- Change a role or **Remove** someone in the same panel; a change reaches their screen at once, and removing signs
  them out everywhere.
- **Live room**: everyone in a project shows as an avatar in the header and as a playhead in their colour on the
  timeline; click either to jump to where they are. Comments show who wrote them.
- Commenters and viewers see what was asked and Claude's answers, not the agent's command log, costs or file paths.

They reach this Mac the same way your phone does: over Tailscale. Share this Mac with them from the Tailscale admin
console (Machines → ⋯ → Share), so the `https://<this-mac>…ts.net` link opens for them, on the same Wi-Fi or
anywhere. There is no plain-Wi-Fi mode on purpose: without HTTPS anyone on the network could read their session.
People, invites (hashed) and sessions live in `data/people.json` and `data/sessions.json`.

Server code is in `server/` (projects, proxy, agent, store), the app in `src/`. Data (proxies, comments, undo
snapshots, the password hash and sessions) lives in `data/`, outside iCloud and outside git. Every request is also
checked for its Host and Origin, so other websites open in your browser can't reach the server. A comment makes the
agent run commands on this Mac, so keep the password strong and the server off the public internet.

Settings (env): `ROOM_VIDEO_ROOT`, `ROOM_CAPCUT_DRAFTS`, `ROOM_SKILL_DIR`, `ROOM_DATA_DIR`, `ROOM_PORT`,
`ROOM_PUBLIC_HOST` (the Tailscale name, detected by default), `ROOM_REQUIRE_LOGIN=1` (ask for the password on this Mac
too).
