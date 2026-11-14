import { useEffect, useRef, useState } from "react";
import type { Comment, EditModel, ProjectInfo, ProxyState, RawInfo, Target } from "./types";

/** Fired when the server says this device's session is gone; the app swaps to the login screen. */
export const LOGIN_EVENT = "room:login";

const j = async <T,>(r: Response): Promise<T> => {
  if (r.status === 401) window.dispatchEvent(new Event(LOGIN_EVENT));
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
  return r.json();
};

const postJson = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const api = {
  me: () => fetch("/api/me").then(j<{ remote: boolean; authed: boolean; hasPassword: boolean }>),
  login: (password: string) => postJson("/api/login", { password }).then(async (r) => {
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
    return r.json();
  }),
  logout: () => fetch("/api/logout", { method: "POST" }),
  projects: () => fetch("/api/projects").then(j<ProjectInfo[]>),
  model: (id: string) => fetch(`/api/projects/${id}/model`).then(j<{ model: EditModel; proxy: ProxyState }>),
  comments: (id: string) => fetch(`/api/projects/${id}/comments`).then(j<Comment[]>),
  rebuild: (id: string) => fetch(`/api/projects/${id}/proxy`, { method: "POST" }).then(j<ProxyState>),
  post: (id: string, body: { text: string; t: number; x: number | null; y: number | null; target: Target; want?: number }) =>
    fetch(`/api/projects/${id}/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(j<Comment>),
  stop: (id: string, cid: string) => fetch(`/api/projects/${id}/comments/${cid}/stop`, { method: "POST" }).then(j<Comment>),
  undo: (id: string, cid: string) => fetch(`/api/projects/${id}/comments/${cid}/undo`, { method: "POST" }).then(j<Comment>),
  optionModel: (id: string, cid: string, key: string) => fetch(`/api/projects/${id}/options/${cid}/${key}/model`).then(j<{ model: EditModel; proxy: ProxyState }>),
  pick: (id: string, cid: string, key: string) =>
    fetch(`/api/projects/${id}/comments/${cid}/pick`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) }).then(j<Comment>),
  newEdit: () => fetch("/api/new-edit", { method: "POST" }).then(j<{ id: string }>),
  raw: (id: string) => fetch(`/api/projects/${id}/raw`).then(j<RawInfo>),
  startUpload: (id: string, name: string, size: number) =>
    postJson(`/api/projects/${id}/uploads`, { name, size }).then(j<{ key: string; name: string; size: number; received: number; done: boolean }>),
  build: (id: string, note: string) => postJson(`/api/projects/${id}/build`, { note }).then(j<Comment>),
  fileUrl: (id: string, path: string) => `/media/${id}/file?p=${encodeURIComponent(path)}`,
};

type Msg =
  | { type: "comment"; comment: Comment }
  | { type: "project"; id: string; proxy: ProxyState }
  | { type: "overlay"; id: string; at: number };

/** One socket for the whole app; reconnects on its own. */
export function useSocket(onMsg: (m: Msg) => void) {
  const handler = useRef(onMsg);
  handler.current = onMsg;
  const [online, setOnline] = useState(false);
  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout>;
    let closed = false;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      ws.onopen = () => setOnline(true);
      ws.onmessage = (e) => handler.current(JSON.parse(e.data));
      ws.onclose = () => {
        setOnline(false);
        if (!closed) timer = setTimeout(connect, 1200);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);
  return online;
}
