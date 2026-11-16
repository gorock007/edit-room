import { useCallback, useEffect, useRef, useState } from "react";
import type { Comment, EditModel, ExportState, Invite, McpUrls, Person, PersonFull, Presence, ProjectInfo, ProxyState, RawInfo, Role, Target, VersionInfo } from "./types";

/** Fired when the server says this device's session is gone; the app swaps to the login screen. */
export const LOGIN_EVENT = "room:login";

const j = async <T,>(r: Response): Promise<T> => {
  if (r.status === 401) window.dispatchEvent(new Event(LOGIN_EVENT));
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
  return r.json();
};
/** For the login and join screens: an error is shown on the form, not sent back to the login screen. */
const plain = async <T,>(r: Response): Promise<T> => {
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
  return r.json();
};

const send = (method: string, url: string, body: unknown) => fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const postJson = (url: string, body: unknown) => send("POST", url, body);

export type Me = { remote: boolean; authed: boolean; hasPassword: boolean; person: (Person & { projects: "all" | string[] }) | null; publicUrl: string | null };

export const api = {
  me: () => fetch("/api/me").then(j<Me>),
  login: (password: string) => postJson("/api/login", { password }).then(plain),
  logout: () => fetch("/api/logout", { method: "POST" }),
  invite: (token: string) => postJson("/api/invite", { token }).then(plain<{ role: Role; from: string; projects: string[] | null }>),
  join: (token: string, name: string) => postJson("/api/join", { token, name }).then(plain),
  rename: (name: string) => send("PATCH", "/api/me", { name }).then(j<Person>),
  people: () => fetch("/api/people").then(j<{ people: PersonFull[]; invites: Invite[]; publicUrl: string | null; mcp: McpUrls }>),
  connectAgent: (name: string, role: Role, projects: "all" | string[]) =>
    postJson("/api/people/agents", { name, role, projects }).then(j<{ person: PersonFull; key: string; mcp: McpUrls }>),
  makeInvite: (role: Role, projects: "all" | string[]) =>
    postJson("/api/people/invites", { role, projects }).then(j<{ token: string; expires: number; url: string | null }>),
  cancelInvites: () => fetch("/api/people/invites", { method: "DELETE" }).then(j),
  updatePerson: (id: string, patch: { role?: Role; projects?: "all" | string[]; name?: string }) => send("PATCH", `/api/people/${id}`, patch).then(j<PersonFull>),
  removePerson: (id: string) => fetch(`/api/people/${id}`, { method: "DELETE" }).then(j),
  projects: () => fetch("/api/projects").then(j<ProjectInfo[]>),
  model: (id: string) => fetch(`/api/projects/${id}/model`).then(j<{ model: EditModel; proxy: ProxyState }>),
  comments: (id: string) => fetch(`/api/projects/${id}/comments`).then(j<Comment[]>),
  rebuild: (id: string) => fetch(`/api/projects/${id}/proxy`, { method: "POST" }).then(j<ProxyState>),
  post: (id: string, body: { text: string; t: number; x: number | null; y: number | null; target: Target; want?: number }) =>
    postJson(`/api/projects/${id}/comments`, body).then(j<Comment>),
  stop: (id: string, cid: string) => fetch(`/api/projects/${id}/comments/${cid}/stop`, { method: "POST" }).then(j<Comment>),
  undo: (id: string, cid: string) => fetch(`/api/projects/${id}/comments/${cid}/undo`, { method: "POST" }).then(j<Comment>),
  approve: (id: string, cid: string) => fetch(`/api/projects/${id}/comments/${cid}/approve`, { method: "POST" }).then(j<Comment>),
  decline: (id: string, cid: string, reason: string) => postJson(`/api/projects/${id}/comments/${cid}/decline`, { reason }).then(j<Comment>),
  optionModel: (id: string, cid: string, key: string) => fetch(`/api/projects/${id}/options/${cid}/${key}/model`).then(j<{ model: EditModel; proxy: ProxyState }>),
  pick: (id: string, cid: string, key: string) => postJson(`/api/projects/${id}/comments/${cid}/pick`, { key }).then(j<Comment>),
  newEdit: () => fetch("/api/new-edit", { method: "POST" }).then(j<{ id: string }>),
  raw: (id: string) => fetch(`/api/projects/${id}/raw`).then(j<RawInfo>),
  startUpload: (id: string, name: string, size: number) =>
    postJson(`/api/projects/${id}/uploads`, { name, size }).then(j<{ key: string; name: string; size: number; received: number; done: boolean }>),
  build: (id: string, note: string) => postJson(`/api/projects/${id}/build`, { note }).then(j<Comment>),
  exportState: (id: string) => fetch(`/api/projects/${id}/export`).then(j<ExportState>),
  startExport: (id: string) => fetch(`/api/projects/${id}/export`, { method: "POST" }).then(j<ExportState>),
  fileUrl: (id: string, path: string) => `/media/${id}/file?p=${encodeURIComponent(path)}`,
  versions: (id: string) => fetch(`/api/projects/${id}/versions`).then(j<{ versions: VersionInfo[]; current: number | null }>),
  nameVersion: (id: string, n: number, label: string) => postJson(`/api/projects/${id}/versions/${n}/name`, { label }).then(j<VersionInfo>),
  restoreVersion: (id: string, n: number) => fetch(`/api/projects/${id}/versions/${n}/restore`, { method: "POST" }).then(j<VersionInfo | null>),
  versionModel: (id: string, n: number) => fetch(`/api/projects/${id}/versions/${n}/model`).then(j<{ model: EditModel; proxy: ProxyState; samePicture: boolean }>),
};

type Msg =
  | { type: "hello"; sid: string }
  | { type: "comment"; comment: Comment }
  | { type: "project"; id: string; proxy: ProxyState }
  | { type: "overlay"; id: string; at: number }
  | { type: "export"; id: string; export: ExportState }
  | { type: "presence"; people: Presence[] }
  | { type: "versions"; id: string }
  | { type: "me" }
  | { type: "people" };

/** One socket for the whole app; reconnects on its own. `send` drops messages while it is reconnecting. */
export function useSocket(onMsg: (m: Msg) => void) {
  const handler = useRef(onMsg);
  handler.current = onMsg;
  const sock = useRef<WebSocket | null>(null);
  const [online, setOnline] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let closed = false;
    const connect = () => {
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      sock.current = ws;
      ws.onopen = () => setOnline(true);
      ws.onmessage = (e) => handler.current(JSON.parse(e.data));
      ws.onclose = (e) => {
        setOnline(false);
        if (e.code === 4401) window.dispatchEvent(new Event(LOGIN_EVENT)); // removed from the room
        if (!closed) timer = setTimeout(connect, 1200);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      sock.current?.close();
    };
  }, []);
  const sendMsg = useCallback((m: unknown) => {
    const ws = sock.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  }, []);
  return { online, send: sendMsg };
}
