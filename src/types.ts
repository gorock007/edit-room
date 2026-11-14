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
export type Comment = {
  id: string; project: string; createdAt: number; text: string; t: number; x: number | null; y: number | null;
  target: Target; status: "queued" | "working" | "review" | "done" | "failed" | "stopped" | "undone";
  activity: Activity[]; reply?: string; changed?: string[]; costUsd?: number; finishedAt?: number;
  want?: number; options?: Option[]; chosen?: string;
};
export type Option = { key: string; note: string; files: string[]; pictureChanged: boolean; picture?: "building" | "ready" | "failed" };
export type Device = "desktop" | "phone" | "feed";
