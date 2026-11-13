# Edit Room

Claude Design for video editing: a live preview of an edit, click anything in it, and Claude makes the change.

```bash
npm run dev        # server on :4310 + app on http://127.0.0.1:5310
```

- **Projects** are the `NNNN edit` folders in the Video Editor folder, linked to their CapCut draft (which stays the
  edit document; CapCut itself is optional, the free plan is enough).
- **Preview**: a 960 px picture proxy (cuts + cards, built by the skill's `preview.py`), the caption composition
  played live as HTML, and every sound effect played live from its file. Caption and sound changes show instantly;
  picture changes rebuild the proxy (about a minute).
- **Comments**: press `C`, click a caption word, a spot in the frame, or anything on the timeline. The comment goes to
  a Claude Agent SDK session (your Claude login, your skills and memory) the moment you send it. Comments on one
  project run one at a time; each shows live steps, Claude's reply, and **Undo** (restores every file it changed).
- **Devices**: Desktop / Phone / In feed (`1` `2` `3`).

Server code is in `server/` (projects, proxy, agent, store), the app in `src/`. Data (proxies, comments, undo
snapshots) lives in `data/`, outside iCloud. The server listens on localhost only: anyone who can reach it can make
the agent run commands, so add auth before exposing it (e.g. over Tailscale).
