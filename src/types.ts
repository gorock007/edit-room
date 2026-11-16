export type Seg = { id: string; start: number; dur: number; label: string; file: string; scale: number; src: number };
export type CapGroup = { id: string; start: number; dur: number; text: string; big: string };
export type Sfx = { id: string; track: string; start: number; dur: number; src: number; volume: number; file: string; name: string };
export type EditModel = {
  project: { id: string; name: string };
  duration: number; fps: number; width: number; height: number;
  cuts: Seg[]; broll: Seg[]; captions: CapGroup[]; sfx: Sfx[];
  hasOverlay: boolean; pictureHash: string; draftMtime: number;
};
export type ExportReport = {
  width: number; height: number; fps: string; frames: number; expected_frames: number; video: string; video_mbps: number;
  audio: string; size_mb: number; duration: number; lufs: number; true_peak: number;
};
export type ExportState = { status: "none" | "running" | "ready" | "stale" | "failed"; stage?: string; error?: string; report?: ExportReport; savedTo?: string; at?: number };
export type ProxyState = { status: "missing" | "ready" | "stale" | "building" | "failed"; error?: string; version: number };
export type ProjectInfo = { id: string; name: string; hasDraft: boolean; hasOverlay: boolean; hasRaw: boolean };
export type RawInfo = { files: { name: string; size: number }[]; pending: { name: string; size: number; received: number }[]; note: string };
export type Target = { kind: "caption" | "frame" | "sfx" | "cut" | "broll" | "general" | "build"; id?: string; label: string; detail?: string };
export type Activity = { at: number; kind: "tool" | "text" | "info" | "error"; text: string };

export type Role = "owner" | "editor" | "commenter" | "viewer";
export const ROLES: Role[] = ["viewer", "commenter", "editor", "owner"];
export const can = (p: { role: Role } | null | undefined, role: Role) => !!p && ROLES.indexOf(p.role) >= ROLES.indexOf(role);
/** Starts Claude without review, and approves others: an editor with every project (the server checks the same). */
export const runsDirectly = (p: { role: Role; projects?: "all" | string[] } | null | undefined) => can(p, "editor") && p?.projects === "all";
/** A person in the room (me, or someone else). */
export type Person = { id: string; name: string; role: Role; color: string; projects?: "all" | string[] };
export type PersonFull = Person & { projects: "all" | string[]; createdAt: number };
export type Invite = { role: Role; projects: "all" | string[]; createdAt: number; expires: number };
/** Someone with a project open right now, and where their playhead is. */
export type Presence = Person & { sid: string; project: string; t: number; playing: boolean; at: number };
export type Author = { id: string; name: string; color: string; role: string };

export type Comment = {
  id: string; project: string; createdAt: number; text: string; t: number; x: number | null; y: number | null;
  target: Target; status: "pending" | "declined" | "queued" | "working" | "review" | "done" | "failed" | "stopped" | "undone";
  activity: Activity[]; reply?: string; changed?: string[]; costUsd?: number; finishedAt?: number;
  want?: number; options?: Option[]; chosen?: string; author?: Author; approvedBy?: string;
};
export type Option = { key: string; note: string; files: string[]; pictureChanged: boolean; picture?: "building" | "ready" | "failed" };
export type Device = "desktop" | "phone" | "feed";
