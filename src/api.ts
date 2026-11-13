import { useEffect, useRef, useState } from "react";
import type { Comment, EditModel, ProjectInfo, ProxyState, Target } from "./types";

const j = async <T,>(r: Response): Promise<T> => {
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
  return r.json();
};

export const api = {
  projects: () => fetch("/api/projects").then(j<ProjectInfo[]>),
  model: (id: string) => fetch(`/api/projects/${id}/model`).then(j<{ model: EditModel; proxy: ProxyState }>),
  comments: (id: string) => fetch(`/api/projects/${id}/comments`).then(j<Comment[]>),
  rebuild: (id: string) => fetch(`/api/projects/${id}/proxy`, { method: "POST" }).then(j<ProxyState>),
  post: (id: string, body: { text: string; t: number; x: number | null; y: number | null; target: Target }) =>
    fetch(`/api/projects/${id}/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(j<Comment>),
  stop: (id: string, cid: string) => fetch(`/api/projects/${id}/comments/${cid}/stop`, { method: "POST" }).then(j<Comment>),
  undo: (id: string, cid: string) => fetch(`/api/projects/${id}/comments/${cid}/undo`, { method: "POST" }).then(j<Comment>),
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
