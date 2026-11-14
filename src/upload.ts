import { api, LOGIN_EVENT } from "./api";

/** 16 MB pieces: small enough to resend cheaply on a phone connection, big enough to keep the line busy. */
const CHUNK = 16 * 1024 * 1024;

type Put = { received: number; done: boolean; name: string };
type PutError = Error & { status?: number; received?: number };

function put(url: string, body: Blob, onLoaded: (n: number) => void, signal: AbortSignal): Promise<Put> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    x.setRequestHeader("content-type", "application/octet-stream");
    x.upload.onprogress = (e) => onLoaded(e.loaded);
    x.onload = () => {
      let r: any = {};
      try {
        r = JSON.parse(x.responseText);
      } catch {}
      if (x.status === 401) window.dispatchEvent(new Event(LOGIN_EVENT));
      if (x.status >= 200 && x.status < 300) return resolve(r);
      reject(Object.assign(new Error(r.error ?? `upload failed (${x.status})`), { status: x.status, received: r.received }));
    };
    x.onerror = () => reject(Object.assign(new Error("connection lost"), { status: 0 }));
    x.onabort = () => reject(Object.assign(new Error("cancelled"), { status: -1 }));
    signal.addEventListener("abort", () => x.abort(), { once: true });
    x.send(body);
  });
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res) => {
    const t = setTimeout(res, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), res()), { once: true });
  });

/**
 * Send one file in chunks. Resumes from whatever the server already has (also after a page reload, when the same
 * file is picked again), and keeps retrying through dropped connections with a growing pause.
 */
export async function uploadFile(projectId: string, file: File, onProgress: (sent: number) => void, signal: AbortSignal): Promise<string> {
  const st = await api.startUpload(projectId, file.name, file.size);
  if (st.done) {
    onProgress(file.size);
    return st.name;
  }
  let offset = st.received;
  onProgress(offset);
  let fails = 0;
  while (true) {
    if (signal.aborted) throw new Error("cancelled");
    const end = Math.min(file.size, offset + CHUNK);
    try {
      const r = await put(`/api/projects/${projectId}/uploads/${st.key}?offset=${offset}`, file.slice(offset, end), (n) => onProgress(offset + n), signal);
      offset = r.received;
      fails = 0;
      onProgress(offset);
      if (r.done) return r.name;
    } catch (e) {
      const err = e as PutError;
      if (err.status === -1 || err.status === 401 || err.status === 404 || signal.aborted) throw err;
      if (++fails > 10) throw err;
      await sleep(Math.min(30_000, 1000 * 2 ** fails), signal);
      // ask the server where it got to: part of the last piece may have arrived
      if (err.received != null) offset = err.received;
      else
        try {
          offset = (await api.startUpload(projectId, file.name, file.size)).received;
        } catch {}
      onProgress(offset);
    }
  }
}

/** Keep the phone's screen on while uploading: a locked phone stops the browser sending. */
export async function keepAwake(): Promise<() => void> {
  try {
    const lock = await (navigator as any).wakeLock?.request("screen");
    return () => lock?.release().catch(() => {});
  } catch {
    return () => {};
  }
}
