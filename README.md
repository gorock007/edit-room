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
- **Words**: the **Words** tab (next to Comments) is the edit's transcript. Click a word to go there; drag across words
  or pauses (or shift-click) and press `Delete` to cut them. `I` and `O` mark a range at the playhead for a sound the
  words don't show (a stutter, a breath). **Hear it first** plays across the cut before anything changes. A cut runs
  without Claude (`server/cut.ts`): every track of the draft closes up on the frame grid, caption words and their
  sounds go with it, captions are laid out again, and the preview is patched in about two seconds. It is listed with
  the comments (Undo, who did it) and saved as a version. It needs the edit's `overlays/build_captions.py` to be the
  skill's current one (older edits say so, and take the cut as a comment instead), and it won't split a clip that has
  a moving zoom.
- **Checks**: the **Checks** tab lists what Edit Room found watching and listening to the preview, so the same faults
  don't have to be found by hand (`server/checks.ts`). A quick pass runs after every change (a few seconds, ffmpeg
  only): pauses over 0.45 s, a brightness or colour jump across a cut in the same shot, black frames, a hole in the
  main track, media files the export needs that are missing. A listening pass (Whisper, `server/listen.py`, about
  half a minute, once the edit is still) compares the voice with the captions: words said but not captioned (a
  repeat, a stray word), captioned but not said (a clipped word, a leftover caption), and captions running early or
  late. Click a finding to go there; **Cut it** removes a pause on the spot, **Ask Claude** sends the finding as a
  comment with what was measured, **It's fine** stops listing it. Claude has the same checks as the `room_check` tool
  and runs them on a first edit before it reports back. Whisper can mishear, so its findings say "listen here"; lines
  hidden under a card and single small words are not reported.
- **Options**: pick "2 options" or "3 options" in the comment box. A short Sonnet call plans clearly different takes,
  then Claude makes them **all at once**, each in its own sealed copy of the project (`server/workspace.ts`): the edit
  folder and draft mirrored under `data/<project>/work/`, text files copied with their full paths rewritten to the
  copy's, media linked. The real edit can't change meanwhile: Edit/Write may only write in the copy (plus deny rules
  on the real folders), and shell commands run in Claude Code's sandbox with the real video and CapCut folders
  write-protected (a linked media file is read-only; new media gets a new name and comes home with the option). Each
  finished copy comes back as an option, paths rewritten to the real ones; then they play side by side, in sync, next
  to the current version; **Use this** applies one, **Keep current** drops them. If a copy can't be made, options are
  made one after another as before.
- **Models**: each comment runs on the model it needs (`server/router.ts`). Small fixes to one thing (a caption's
  colour, a sound's volume, nudging a cut) run on Sonnet 5.5 at low effort in a fresh session; normal edits and options
  on Opus 5.5 at medium; the hook, pacing, story or anything new on Opus 5.5 at high. Rules decide most comments; one
  short Haiku call decides the rest. Opus comments continue the project's one conversation, so Claude remembers the
  earlier ones. **Auto** next to Send lets you pick by hand (Quick / Opus / Opus+); each comment shows what it ran on
  and why (hover).
- **Plan usage**: Edit Room reads your Claude plan's usage from Claude Code (the same numbers as `/usage`, no model
  call; Jarvis's `~/.jarvis/usage.json` as a fallback) and shows it next to Comments. Past 70% of the 5-hour window or
  85% of the week, Opus runs at medium instead of high; past 90% / 95%, Opus work runs on Sonnet and big jobs (a
  first edit, options, a high-effort change) wait as *Waiting* until you press Run. A model you pick by hand is never
  stepped down.
- **Devices**: Desktop / Phone / In feed (`1` `2` `3`).
- **Wild cards** (header): reels you shared from your phone (Share › **Edit Room**), broken down on the Mac by the
  `reel-breakdown` skill's inbox watcher into `Video Editor/wild cards/<MMDD>-<handle>-<id>/` (`server/wildcards.ts`).
  Each card shows the reel, why it worked, the full breakdown (click any `m:ss` time to play the reel from there), its
  numbers, and three ideas for your own version. Decide: **Keep as reference**, **Dismiss**, **Plan this** on an idea
  (Claude writes `plan-<n>.md`: hook, the whole script in your voice with what's on screen per line, what to record,
  what's new to build) or **Make template** (Claude writes the look as rules into `Video Editor/templates/<name>/`:
  `style.md` under one page with a "never do" list, `tokens.json`, reference frames). Templates are opt-in and never
  touch CLAUDE.md, so the house style stays the default. Plans and templates run headless Claude Code that may read
  anything but write only that one file or folder, with no web access (about 3 minutes each). The view updates by
  itself as new breakdowns land; the header badge counts new ones.
- **New edit** (`+` in the header): drop the raw camera file, or pick it from Photos/Files on the phone, add an
  optional note ("starts at …"), and Claude builds the first edit with the talking-head-reel-edit skill. The file goes
  to `<MMDD> edit/raw/` (today's date; `<MMDD>b` if that name is taken here or in CapCut) in 16 MB pieces, so a
  dropped connection or a reload resumes: pick the same file again. The phone's screen stays on while it uploads.
  - **Extra material for this video**: b-roll, screen recordings and screenshots go to `<MMDD> edit/resources/`. The
    build catalogues them and must put each one on screen or say why not.
  - **Format**: 9:16 or 16:9, chosen before the build starts (it remembers the last choice). The build is refused
    without one, because nobody is there to ask once it runs.
  - **Also draw b-roll from**: your own footage folders inside the video folder ("Brolls shots", a shoot's folder).
  - The build runs unattended: it reviews its own cut, writes `edit-data/edit_plan.json` (what goes on screen for
    each line, and why) and works the checks until they pass before handing over.
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
  **Editor** works like you: comments run right away, approves others, picks options, undoes, exports. The owner (this
  Mac, or your password) does everything.
- The agent runs shell commands on this Mac and only its prompt keeps it to one project, so only an editor with **all
  projects** starts it directly, approves comments or starts a new edit. An editor kept to one project picks options,
  undoes and exports, but their comments wait for approval like a commenter's. The approval card shows everything the
  agent will be told about the comment.
- Change a role or **Remove** someone in the same panel; a change reaches their screen at once, and removing signs
  them out everywhere.
- **Live room**: everyone in a project shows as an avatar in the header and as a playhead in their colour on the
  timeline; click either to jump to where they are. Comments show who wrote them.
- Commenters and viewers see what was asked and Claude's answers, not the agent's command log, costs or file paths.

They reach this Mac the same way your phone does: over Tailscale. Share this Mac with them from the Tailscale admin
console (Machines → ⋯ → Share), so the `https://<this-mac>…ts.net` link opens for them, on the same Wi-Fi or
anywhere. There is no plain-Wi-Fi mode on purpose: without HTTPS anyone on the network could read their session.
People, invites (hashed) and sessions live in `data/people.json` and `data/sessions.json`.

## Version history

**History** (next to Comments; a tab on the phone) lists every version of the edit, newest first, like Google Docs:

- A version is saved after every change: a finished comment, a picked option, an undo, a restore. A change made outside
  Edit Room (CapCut, a chat with Claude, a script) becomes its own version, *Changed outside Edit Room*, the next time
  anything happens, so it never mixes with Claude's.
- Each shows who asked (people round, agents square), what was asked (click it to jump to the comment), and what moved
  (−1.2 s, +1 sound…). Editors **Name** a version (*Sent to client v1*); **Named** filters to those.
- **Compare** plays a version side by side with the current edit, in sync (Listen switches the sound between them);
  it reuses the current picture when the cuts are the same, else builds the version's own (about a minute).
- **Restore** (editors) puts the edit back to that version. It is saved as a new version, so restoring is undoable
  too. Not while Claude is working on a comment.

A version is the edit's files (the CapCut draft, the caption composition and its data, the edit-data plans), each
content stored once in `data/<project>/versions/` by its hash. Footage and rendered cards are not versioned: an old
version plays with today's media. Agents get the same over MCP: `list_versions`, `name_version`, `restore_version`.

## Agents (MCP)

Other agents join the room like people do. Edit Room is an MCP server at `/mcp` (Streamable HTTP): **Share → Connect
an agent**, give it a name, role and projects, and paste the command it shows into the agent (the key is shown once):

```bash
claude mcp add --transport http edit-room http://127.0.0.1:4310/mcp --header "Authorization: Bearer er_…"
```

Any MCP client works the same way (URL plus that `Authorization` header). An agent on another machine uses
`https://<this-mac>…ts.net/mcp` over Tailscale. Tools: `whoami`, `list_projects`, `get_edit` (the timeline with ids),
`look_at_frame` (a still at a time), `list_comments`, `get_comment` (with `wait_seconds` to follow one), `add_comment`
(point at a caption, cut, card or sound by id, or a time; ask for 2-3 options), `approve_comment`, `decline_comment`,
`pick_option`, `undo_comment`, `stop_comment`, `export_video`.

An agent never edits files itself: it comments, and Edit Room's own Claude makes each change. It has a person's role and
project limits and goes through the same room actions (`server/room.ts`), so a commenter agent's comments wait for
approval and a viewer agent only reads. Its avatar is square, it shows in the room while it works (its playhead at the
moment it is looking at) and its comments say "agent". Every request is checked against its key (only a hash is kept;
never a browser cookie), so **Remove** in Share stops it at once.

Server code is in `server/` (projects, proxy, agent, store), the app in `src/`. Data (proxies, comments, undo
snapshots, the password hash and sessions) lives in `data/`, outside iCloud and outside git. Every request is also
checked for its Host and Origin, so other websites open in your browser can't reach the server. A comment makes the
agent run commands on this Mac, so keep the password strong and the server off the public internet.

Settings (env): `ROOM_VIDEO_ROOT`, `ROOM_CAPCUT_DRAFTS`, `ROOM_SKILL_DIR`, `ROOM_DATA_DIR`, `ROOM_PORT`,
`ROOM_PUBLIC_HOST` (the Tailscale name, detected by default), `ROOM_REQUIRE_LOGIN=1` (ask for the password on this Mac
too).
