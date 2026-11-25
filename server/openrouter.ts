// Apps with "backend": "openrouter": a hosted video model through OpenRouter's video API instead of a ComfyUI
// workflow on the GPU. The run looks like any other to the history (a JobLike): submit, poll until it ends, then the
// mp4 is copied next to the record, so History, Library, cancel and the progress bar work as they do for ComfyUI.
//   POST /api/v1/videos              { model, prompt, duration, resolution, aspect_ratio, generate_audio, frame_images }
//   GET  /api/v1/videos/{id}         status: pending | in_progress | completed | failed | cancelled | expired
//   GET  /api/v1/videos/{id}/content?index=0   the mp4 (needs the key)
//   GET  /api/v1/videos/models       what each model supports (durations, resolutions, aspect ratios, first frame)
// The key: OPENROUTER_API_KEY, or OPENROUTER_ENV_FILE naming a file with an OPENROUTER_API_KEY= line (kept out of the
// repo, read on every request so a new key needs no restart). OpenRouter bills each completed video.
import { existsSync, readFileSync } from "node:fs";
import type { ComfyEvent } from "@comfyorg/sdk";
import type { App } from "./registry.ts";
import { InputError, mediaKind, type FileValue, type Values } from "./runner.ts";
import type { JobLike } from "./history.ts";
import { shareFile, type Shared } from "./share.ts";
import { joinClips, lastFrame } from "./extend.ts";

const API = "https://openrouter.ai/api/v1";
/** History job ids of OpenRouter runs carry this prefix, so a restart knows whom to ask. */
export const JOB_PREFIX = "openrouter:";

export const isOpenRouterApp = (app: Pick<App, "backend">) => app.backend === "openrouter";
export const isOpenRouterJob = (jobId: string) => jobId.startsWith(JOB_PREFIX);

export function apiKey(): string {
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const file = process.env.OPENROUTER_ENV_FILE;
  if (file && existsSync(file)) {
    const m = /^\s*OPENROUTER_API_KEY\s*=\s*(.*?)\s*$/m.exec(readFileSync(file, "utf-8"));
    const key = m?.[1].replace(/^["']|["']$/g, "");
    if (key) return key;
  }
  throw new InputError("no OpenRouter key: set OPENROUTER_API_KEY, or OPENROUTER_ENV_FILE to a file with an OPENROUTER_API_KEY= line");
}

class HttpError extends Error {
  readonly httpStatus: number;
  constructor(message: string, httpStatus: number) {
    super(message);
    this.httpStatus = httpStatus;
  }
}

async function call(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 60_000, ...rest } = init;
  return fetch(path.startsWith("http") ? path : `${API}${path}`, {
    ...rest,
    headers: { ...(rest.headers as Record<string, string> ?? {}), authorization: `Bearer ${apiKey()}`, "x-title": "Freefield" },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** The error text of an OpenRouter answer: { error: { message } }, or the body itself. */
async function reason(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string };
    const msg = typeof j.error === "string" ? j.error : j.error?.message;
    if (msg) return msg.slice(0, 400);
  } catch { /* not JSON */ }
  return text.slice(0, 400) || res.statusText;
}

export type VideoModel = {
  id: string;
  name?: string;
  supported_resolutions: string[] | null;
  supported_aspect_ratios: string[] | null;
  supported_durations: number[] | null;
  supported_frame_images: string[] | null;
  generate_audio: boolean | null;
  seed: boolean | null;
  /** upscale models only: the factors they take, and the creativity range */
  upscale_factor?: { min: number; max: number } | null;
  creativity?: number[] | null;
};

let modelCache: { at: number; byId: Map<string, VideoModel> } | null = null;

/** OpenRouter's video models (public, kept an hour). */
export async function videoModels(): Promise<Map<string, VideoModel>> {
  if (modelCache && Date.now() - modelCache.at < 3600_000) return modelCache.byId;
  const res = await fetch(`${API}/videos/models`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`OpenRouter's model list answered ${res.status}`);
  const body = (await res.json()) as { data?: VideoModel[] };
  modelCache = { at: Date.now(), byId: new Map((body.data ?? []).map((m) => [m.id, m])) };
  return modelCache.byId;
}

const RES_ORDER = ["360p", "480p", "720p", "768p", "1080p", "1K", "2K", "4K"];

/** The supported value nearest to the one asked for (ties go to the smaller one), or null when the model lists none. */
export function nearestDuration(want: number, supported: number[] | null): number | null {
  const ok = (supported ?? []).filter((n) => n > 0).sort((a, b) => a - b);
  if (!ok.length) return null;
  return ok.reduce((best, n) => (Math.abs(n - want) < Math.abs(best - want) ? n : best));
}

export function nearestResolution(want: string, supported: string[] | null): string | null {
  const ok = (supported ?? []).filter((r) => RES_ORDER.includes(r));
  if (!ok.length) return null;
  if (ok.includes(want)) return want;
  const rank = RES_ORDER.indexOf(want);
  return ok.sort((a, b) => RES_ORDER.indexOf(a) - RES_ORDER.indexOf(b))
    .reduce((best, r) => (Math.abs(RES_ORDER.indexOf(r) - rank) < Math.abs(RES_ORDER.indexOf(best) - rank) ? r : best));
}

const isFile = (v: unknown): v is FileValue => typeof v === "object" && v !== null && (v as FileValue).bytes instanceof Uint8Array;

const imageType = (f: FileValue) => f.type || (/\.png$/i.test(f.name) ? "image/png" : /\.webp$/i.test(f.name) ? "image/webp" : "image/jpeg");
const dataUrl = (f: FileValue) => `data:${imageType(f)};base64,${Buffer.from(f.bytes).toString("base64")}`;

/** How the video starts (the app's mode input; a save without one means a start frame). */
export type Mode = "frames" | "start_end" | "refs" | "extend";
export const modeOf = (values: Values): Mode => {
  const m = values.mode;
  return m === "start_end" || m === "refs" || m === "extend" ? m : "frames";
};

/** The files of the media input "refs" (images, videos and audio), in order. */
export function refFiles(values: Values): FileValue[] {
  const v = values.refs;
  return (Array.isArray(v) ? v : [v]).filter(isFile);
}

export type RefLink = { kind: "image" | "video" | "audio"; url: string };
export type Links = { clip?: string; reference?: string; refs?: RefLink[] };

/**
 * The request body for the app's resolved values: model, prompt, how it starts (mode), duration, resolution, aspect
 * ratio, audio. Modes: "frames" a start frame (image); "start_end" a start and/or an end frame (image, end), both in
 * frame_images as data URLs; "refs" the references as https links in input_references (links.refs: images, and video
 * and audio where the model takes them, e.g. Seedance 2; the model takes the look, not the exact frame); "extend" the
 * clip's last frame, already in values.image (submitOpenRouter), as the start frame. Other modes' inputs are left
 * out; with no image at all it is text to video. A value the chosen model does not offer moves to the nearest one it
 * does; one it has no list for is left to the model.
 */
export function buildRequest(values: Values, model: VideoModel, links: Links = {}): Record<string, unknown> {
  const prompt = String(values.prompt ?? "").trim();
  const body: Record<string, unknown> = { model: model.id };
  if (prompt) body.prompt = prompt;
  if (links.clip) return editRequest(body, values, model, links);
  const mode = modeOf(values);
  const frames = model.supported_frame_images ?? [];
  if (mode === "refs") {
    const refs = links.refs ?? [];
    if (!refs.length) throw new InputError("references: add at least one image, video or audio clip");
    if (!prompt) throw new InputError("prompt: say what happens with the references");
    body.input_references = refs.map(({ kind, url }) => ({ type: `${kind}_url`, [`${kind}_url`]: { url } }));
  } else {
    const start = isFile(values.image) ? values.image : null;
    const end = mode === "start_end" && isFile(values.end) ? values.end : null;
    if (mode === "extend" && !start) throw new InputError("extend: add the video to continue");
    if (mode === "start_end" && !start && !end) throw new InputError("start and end: add a start frame, an end frame or both");
    if (start && !frames.includes("first_frame")) {
      throw new InputError(`${model.id} cannot start from an image: pick another model${mode === "frames" ? ", or leave the image empty" : ""}`);
    }
    if (end && !frames.includes("last_frame")) throw new InputError(`${model.id} cannot end on an image: pick a model that takes an end frame`);
    const list = [
      ...(start ? [{ type: "image_url", frame_type: "first_frame", image_url: { url: dataUrl(start) } }] : []),
      ...(end ? [{ type: "image_url", frame_type: "last_frame", image_url: { url: dataUrl(end) } }] : []),
    ];
    if (list.length) body.frame_images = list;
    else if (!prompt) throw new InputError("prompt: required when there is no start image");
  }
  const duration = nearestDuration(Number(values.duration ?? 5), model.supported_durations);
  if (duration !== null) body.duration = duration;
  const resolution = nearestResolution(String(values.resolution ?? "720p"), model.supported_resolutions);
  if (resolution) body.resolution = resolution;
  const aspect = String(values.aspect ?? "auto");
  if (aspect !== "auto" && (model.supported_aspect_ratios ?? []).includes(aspect)) body.aspect_ratio = aspect;
  if (model.generate_audio) body.generate_audio = values.audio === true;
  return body;
}

/**
 * A video-to-video edit: the source clip (and a reference image, e.g. the new person or place) as https links in
 * input_references. The length follows the source where the model allows it (-1), else the nearest it offers to the
 * source's; the aspect ratio is left to follow the source.
 */
function editRequest(body: Record<string, unknown>, values: Values, model: VideoModel, links: Links) {
  if (model.upscale_factor) return upscaleRequest(body, values, model, links.clip!);
  if (!body.prompt) throw new InputError("prompt: say what to change in the video");
  body.input_references = [
    { type: "video_url", video_url: { url: links.clip } },
    ...(links.reference ? [{ type: "image_url", image_url: { url: links.reference } }] : []),
  ];
  const durations = model.supported_durations ?? [];
  if (durations.includes(-1)) body.duration = -1;
  else {
    const d = nearestDuration(Math.round(Number(values.duration ?? 5)), durations);
    if (d !== null) body.duration = d;
  }
  const resolution = nearestResolution(String(values.resolution ?? "720p"), model.supported_resolutions);
  if (resolution) body.resolution = resolution;
  if (model.generate_audio) body.generate_audio = values.audio === true;
  return body;
}

/**
 * An upscale: exactly one source video, the factor (kept inside what the model takes) and creativity (0 keeps the
 * detail as it is; higher invents finer detail, billed at the "creative" rate). The prompt is optional; length and
 * aspect follow the source.
 */
function upscaleRequest(body: Record<string, unknown>, values: Values, model: VideoModel, clip: string) {
  const { min, max } = model.upscale_factor!;
  body.input_references = [{ type: "video_url", video_url: { url: clip } }];
  body.upscale_factor = Math.min(max, Math.max(min, Number(values.factor ?? 2) || 2));
  const [lo, hi] = model.creativity ?? [0, 1];
  const creativity = Number(values.creativity ?? 0);
  if (Number.isFinite(creativity)) body.creativity = Math.min(hi, Math.max(lo, creativity));
  return body;
}

const extOf = (f: FileValue, fallback: string) => /\.([a-z0-9]{2,4})$/i.exec(f.name)?.[1].toLowerCase() ?? fallback;

type Poll = {
  id: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled" | "expired" | string;
  status_detail?: string;
  progress?: number;
  unsigned_urls?: string[];
  error?: string;
  usage?: { cost: number | null };
};

const TERMINAL = new Set(["completed", "failed", "cancelled", "expired"]);
const STATUS: Record<string, string> = {
  pending: "queued", in_progress: "running", completed: "succeeded", failed: "failed", cancelled: "canceled", expired: "expired",
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One OpenRouter video job, shaped like the SDK's Job as far as the history needs (history.ts, JobLike). */
export class OpenRouterJob implements JobLike {
  readonly id: string;
  readonly remoteId: string;
  readonly queuePosition = null;
  startedAt: Date | null = null;
  completedAt: Date | null = null;
  private raw: Poll;
  private canceledHere = false;
  private onEnd: (() => void) | null;
  private finish: ((video: Uint8Array) => Promise<Uint8Array>) | null;

  /** onEnd: called once when the job ends on OpenRouter's side (drops the public links to its inputs).
   * finish: what to make of the downloaded video (an extend joins it to the clip it continues). */
  constructor(remoteId: string, raw: Poll, onEnd: (() => void) | null = null, finish: ((video: Uint8Array) => Promise<Uint8Array>) | null = null) {
    this.remoteId = remoteId;
    this.raw = raw;
    this.id = JOB_PREFIX + remoteId;
    this.onEnd = onEnd;
    this.finish = finish;
    this.note();
  }

  get status(): string {
    if (this.canceledHere && !TERMINAL.has(this.raw.status)) return "canceled";
    return STATUS[this.raw.status] ?? "running";
  }

  get progress() {
    const p = typeof this.raw.progress === "number" ? this.raw.progress / 100 : 0;
    return { value: Math.max(0, Math.min(1, p)), step: null, steps: null, currentNodeClass: this.raw.status_detail ?? null };
  }

  get error() {
    if (this.canceledHere && !TERMINAL.has(this.raw.status)) {
      return { message: "canceled here; OpenRouter has no cancel call, so the job may still finish (and be billed) on their side" };
    }
    if (this.raw.status === "completed" || !TERMINAL.has(this.raw.status)) return null;
    return { message: this.raw.error ? `OpenRouter: ${this.raw.error}` : `OpenRouter: the job ${this.raw.status}` };
  }

  /** The cost OpenRouter reports once the video is done (USD), or null. */
  get cost(): number | null {
    return this.raw.usage?.cost ?? null;
  }

  get outputs() {
    if (this.raw.status !== "completed") return [];
    const n = Math.max(1, this.raw.unsigned_urls?.length ?? 1);
    return Array.from({ length: n }, (_, i) => ({
      name: `openrouter-${this.remoteId}-${i}.mp4`, type: "video", nodeId: "openrouter", contentType: "video/mp4",
      toBytes: () => this.download(i),
    }));
  }

  private note() {
    if (this.raw.status === "in_progress" || TERMINAL.has(this.raw.status)) this.startedAt ??= new Date();
    if (TERMINAL.has(this.raw.status)) {
      this.completedAt ??= new Date();
      const end = this.onEnd;
      this.onEnd = null;
      end?.();
    }
  }

  private async download(index: number): Promise<Uint8Array> {
    const res = await call(`/videos/${encodeURIComponent(this.remoteId)}/content?index=${index}`, { timeoutMs: 10 * 60_000 });
    if (!res.ok) throw new HttpError(`OpenRouter content answered ${res.status}: ${await reason(res)}`, res.status);
    const video = new Uint8Array(await res.arrayBuffer());
    if (!this.finish) return video;
    try {
      return await this.finish(video);
    } catch (e) {
      // the new shot is paid for: keep it as it came rather than lose it
      console.warn(`[openrouter] ${this.remoteId}: could not join the clips (${(e as Error).message}); keeping the new shot alone`);
      return video;
    }
  }

  async refresh(): Promise<this> {
    const res = await call(`/videos/${encodeURIComponent(this.remoteId)}`);
    if (!res.ok) throw new HttpError(`OpenRouter answered ${res.status}: ${await reason(res)}`, res.status);
    this.raw = (await res.json()) as Poll;
    this.note();
    return this;
  }

  /** Poll until the job ends (5 s apart). Errors that reaching OpenRouter can cause are thrown as they are, so the
   * history's waitPatiently tries again (history.ts, isTransient). */
  async wait(timeoutMs = 6 * 3600_000): Promise<this> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.canceledHere) return this;
      await this.refresh();
      if (TERMINAL.has(this.raw.status)) return this;
      if (Date.now() > deadline) throw new Error(`OpenRouter job ${this.remoteId} not terminal after ${timeoutMs} ms`);
      await sleep(5000);
    }
  }

  // no event stream: the history mirrors status and progress from the poll every second
  async *events(): AsyncIterable<ComfyEvent> {}

  async cancel(): Promise<this> {
    this.canceledHere = true;
    this.completedAt ??= new Date();
    return this;
  }
}

/** Start a video. `values` are already resolved (runner.ts resolveValues): defaults filled, file inputs as bytes. */
export async function submitOpenRouter(app: App, values: Values): Promise<OpenRouterJob> {
  const modelId = String(values.model ?? "");
  const model = (await videoModels()).get(modelId);
  if (!model) throw new InputError(`${app.id}: OpenRouter has no video model "${modelId}" (any more)`);
  // an edit: OpenRouter takes the source video only as an https link, so it gets a short-lived public one (share.ts)
  const shared: Shared[] = [];
  const release = () => { for (const s of shared.splice(0)) s.release(); };
  const links: Links = {};
  let finish: ((video: Uint8Array) => Promise<Uint8Array>) | null = null;
  const mode = modeOf(values);
  const share = async (f: FileValue, fallback: string) => {
    const ext = extOf(f, fallback);
    const kind = mediaKind(f);
    const type = f.type || (kind === "image" ? (ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`) : kind === "video" ? "video/mp4" : `audio/${ext === "mp3" ? "mpeg" : ext}`);
    const s = await shareFile(f.bytes, type, ext);
    shared.push(s);
    return s.url;
  };
  try {
    // references go as https links too (share.ts), like an edit's clip; start and end frames go inline
    if (!isFile(values.clip) && mode === "refs") {
      const refs = refFiles(values);
      if (!refs.length) throw new InputError("references: add at least one image, video or audio clip");
      if (!String(values.prompt ?? "").trim()) throw new InputError("prompt: say what happens with the references");
      links.refs = [];
      for (const f of refs) {
        const kind = mediaKind(f);
        links.refs.push({ kind, url: await share(f, kind === "image" ? "png" : kind === "video" ? "mp4" : "mp3") });
      }
    }
    // extend: the clip's last frame starts the new shot, and the finished shot is joined to the clip (extend.ts)
    if (!isFile(values.clip) && mode === "extend") {
      const prev = values.previous;
      if (!isFile(prev)) throw new InputError("extend: add the video to continue");
      const ext = extOf(prev, "mp4");
      const frame = await lastFrame(prev.bytes, ext);
      values = { ...values, image: { name: "last-frame.png", type: "image/png", bytes: frame } satisfies FileValue };
      finish = (video) => joinClips(prev.bytes, video, ext);
    }
    if (isFile(values.clip)) {
      if (!model.upscale_factor && !String(values.prompt ?? "").trim()) throw new InputError("prompt: say what to change in the video");
      const clip = values.clip;
      shared.push(await shareFile(clip.bytes, clip.type || "video/mp4", extOf(clip, "mp4")));
      links.clip = shared[0].url;
      if (isFile(values.reference)) links.reference = await share(values.reference, "png");
    }
    const body = buildRequest(values, model, links);
    const res = await call("/videos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), timeoutMs: 120_000 });
    if (!res.ok) {
      const msg = `OpenRouter refused the video (${res.status}): ${await reason(res)}`;
      // a 4xx is never billed; a 5xx may have started a job anyway (their docs): say so rather than retry
      throw res.status >= 500 ? new Error(`${msg}. It may still have started: check openrouter.ai/activity before trying again`) : new InputError(msg);
    }
    const created = (await res.json()) as Poll;
    if (!created.id) throw new Error("OpenRouter accepted the video but sent no job id");
    console.log(`[${app.id}] OpenRouter job ${created.id}: ${model.id} ${body.upscale_factor ? `x${body.upscale_factor}` : `${body.duration ?? "?"} s ${body.resolution ?? ""}`}`
      + `${links.clip ? ` editing a clip${links.reference ? " with a reference image" : ""}` : ` ${mode}${links.refs ? ` (${links.refs.length} references)` : ""}`}`);
    return new OpenRouterJob(created.id, { ...created, status: created.status ?? "pending" }, shared.length ? release : null, finish);
  } catch (e) {
    release();
    throw e;
  }
}

/** A run picked up again after a restart, or looked at twice (history.ts secondLook). */
export async function openRouterJob(jobId: string): Promise<OpenRouterJob> {
  return new OpenRouterJob(jobId.slice(JOB_PREFIX.length), { id: jobId, status: "pending" }).refresh();
}
