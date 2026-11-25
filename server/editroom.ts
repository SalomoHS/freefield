// The Editing Room's projects (out/editroom/<id>/): one source clip, the cuts that split it into parts, and edits that
// each replace one part. An edit is an ordinary run (History keeps it) whose clip input is that part, cut from the
// current final video, so edits stack. The final video is the source with every finished edit laid over its part,
// the newest on top, joined by ffmpeg; it keeps the source's size, frame rate and sound.
//   out/editroom/<id>/project.json   name, source facts, cuts, edits
//   out/editroom/<id>/source.mp4     the clip as uploaded (or picked from History)
//   out/editroom/<id>/poster.jpg     its first frame, for My videos
//   out/editroom/<id>/final-<hash>.mp4  the latest render (the hash names the edits in it)
// FFMPEG / FFPROBE name the binaries when they are not on PATH.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { InputError } from "./runner.ts";

export type Edit = {
  id: string; op: string; title: string; engine: string; prompt: string;
  start: number; end: number; entry: string; created: string;
};
export type Source = { name: string; duration: number; width: number; height: number; fps: number; audio: boolean };
export type Project = { id: string; name: string; created: string; updated: string; source: Source; cuts: number[]; edits: Edit[] };
/** What a history run left: its status, and the path of its video once it succeeded. */
export type RunLookup = (entryId: string) => { status: string; file: string | null } | null;

const ID = /^[a-z0-9]{12}$/;
export const FFMPEG = () => process.env.FFMPEG || "ffmpeg";
const FFPROBE = () => process.env.FFPROBE || "ffprobe";
const round = (n: number) => Math.round(n * 1000) / 1000;

export function run(bin: string, args: string[], timeoutMs = 10 * 60_000): Promise<string> {
  return new Promise((ok, fail) => {
    const p = spawn(bin, args, { windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { p.kill(); fail(new Error(`${bin} took longer than ${timeoutMs / 1000} s`)); }, timeoutMs);
    p.stdout.on("data", (c) => { out += c; });
    p.stderr.on("data", (c) => { err = (err + c).slice(-4000); });
    p.once("error", (e) => { clearTimeout(timer); fail(new Error(`cannot run ${bin}: ${e.message}. Install ffmpeg or set FFMPEG/FFPROBE`)); });
    p.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) ok(out);
      else fail(new Error(`${bin} failed (${code}): ${err.trim().split("\n").slice(-3).join(" ")}`));
    });
  });
}

export async function probe(file: string): Promise<Source> {
  const j = JSON.parse(await run(FFPROBE(), ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], 60_000)) as {
    streams?: { codec_type: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; duration?: string }[];
    format?: { duration?: string };
  };
  const v = j.streams?.find((s) => s.codec_type === "video");
  if (!v?.width || !v.height) throw new InputError("that file has no video in it");
  const rate = (r?: string) => { const [a, b] = String(r ?? "").split("/").map(Number); return a && b ? a / b : 0; };
  const fps = rate(v.avg_frame_rate) || rate(v.r_frame_rate) || 24;
  const duration = Number(j.format?.duration ?? v.duration ?? 0);
  if (!(duration > 0)) throw new InputError("could not read how long that video is");
  return { name: "", duration: round(duration), width: v.width, height: v.height, fps: Math.min(60, round(fps)),
    audio: Boolean(j.streams?.some((s) => s.codec_type === "audio")) };
}

/**
 * The parts of the final video: [from, to) on the timeline, each taken from the newest finished edit that covers it
 * (at offset from - edit.start in that edit's video), or from the source.
 */
export function layout(duration: number, edits: { start: number; end: number; file: string; created: string }[]) {
  const marks = [...new Set([0, duration, ...edits.flatMap((e) => [e.start, e.end])])].filter((t) => t >= 0 && t <= duration).sort((a, b) => a - b);
  const newestFirst = [...edits].sort((a, b) => (a.created < b.created ? 1 : -1));
  const parts: { from: number; to: number; file: string | null; offset: number }[] = [];
  for (let i = 0; i < marks.length - 1; i++) {
    const [from, to] = [marks[i], marks[i + 1]];
    if (to - from < 0.001) continue;
    const e = newestFirst.find((x) => x.start <= from + 1e-6 && x.end >= to - 1e-6);
    const part = { from, to, file: e ? e.file : null, offset: e ? round(from - e.start) : from };
    const last = parts.at(-1);
    // the same file running on joins into one part (fewer cuts in the render)
    if (last && last.file === part.file && Math.abs(last.offset + (last.to - last.from) - part.offset) < 0.002) last.to = to;
    else parts.push(part);
  }
  return parts;
}

export class EditRoom {
  readonly dir: string;
  private lookup: RunLookup;
  private renders = new Map<string, Promise<string>>();

  constructor(dir: string, lookup: RunLookup) {
    this.dir = dir;
    this.lookup = lookup;
    mkdirSync(dir, { recursive: true });
  }

  private path(id: string, ...rest: string[]) {
    if (!ID.test(id)) throw new InputError("unknown project");
    return join(this.dir, id, ...rest);
  }

  get(id: string): Project | null {
    if (!ID.test(id)) return null;
    const f = this.path(id, "project.json");
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf-8").replace(/^﻿/, "")) as Project) : null;   // a BOM from a hand edit
  }

  private save(p: Project) {
    p.updated = new Date().toISOString();
    const f = this.path(p.id, "project.json");
    writeFileSync(`${f}.tmp`, JSON.stringify(p, null, 2));
    renameSync(`${f}.tmp`, f);
    return p;
  }

  list(): Project[] {
    return readdirSync(this.dir).filter((d) => ID.test(d)).map((d) => this.get(d)).filter((p): p is Project => Boolean(p))
      .sort((a, b) => (a.updated < b.updated ? 1 : -1));
  }

  /** A new project from a clip (re-encoded to H.264 so every model and browser takes it). */
  async create(bytes: Uint8Array, name: string): Promise<Project> {
    const id = randomBytes(9).toString("hex").slice(0, 12);
    mkdirSync(this.path(id), { recursive: true });
    try {
      const raw = this.path(id, "upload.bin");
      writeFileSync(raw, bytes);
      await run(FFMPEG(), ["-y", "-v", "error", "-i", raw, "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", this.path(id, "source.mp4")]);
      rmSync(raw, { force: true });
      const source = { ...(await probe(this.path(id, "source.mp4"))), name: name || "clip.mp4" };
      await run(FFMPEG(), ["-y", "-v", "error", "-ss", String(Math.min(0.1, source.duration / 2)), "-i", this.path(id, "source.mp4"),
        "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", this.path(id, "poster.jpg")], 60_000);
      const now = new Date().toISOString();
      return this.save({ id, name: (name || "Untitled").replace(/\.[a-z0-9]{2,4}$/i, ""), created: now, updated: now, source, cuts: [], edits: [] });
    } catch (e) {
      rmSync(this.path(id), { recursive: true, force: true });
      throw e;
    }
  }

  update(id: string, patch: { name?: unknown; cuts?: unknown }): Project {
    const p = this.get(id);
    if (!p) throw new InputError("unknown project");
    if (typeof patch.name === "string" && patch.name.trim()) p.name = patch.name.trim().slice(0, 120);
    if (Array.isArray(patch.cuts)) {
      p.cuts = [...new Set(patch.cuts.map(Number).filter((t) => t > 0.05 && t < p.source.duration - 0.05).map(round))].sort((a, b) => a - b).slice(0, 200);
    }
    return this.save(p);
  }

  remove(id: string): boolean {
    if (!this.get(id)) return false;
    rmSync(this.path(id), { recursive: true, force: true });
    return true;
  }

  removeEdit(id: string, editId: string): Project {
    const p = this.get(id);
    if (!p) throw new InputError("unknown project");
    p.edits = p.edits.filter((e) => e.id !== editId);
    return this.save(p);
  }

  addEdit(id: string, edit: Omit<Edit, "id" | "created">): Project {
    const p = this.get(id);
    if (!p) throw new InputError("unknown project");
    p.edits.push({ ...edit, id: randomBytes(6).toString("hex"), created: new Date().toISOString() });
    return this.save(p);
  }

  /** A project file a browser may fetch: the source, the poster, a render. */
  file(id: string, name: string): string | null {
    if (!ID.test(id) || !/^(source\.mp4|poster\.jpg|final-[a-f0-9]{12}\.mp4)$/.test(name)) return null;
    const f = this.path(id, name);
    return existsSync(f) ? f : null;
  }

  /** The finished edits with their videos, and how many are still running. */
  private finished(p: Project) {
    let waiting = 0;
    const done: { start: number; end: number; file: string; created: string; id: string }[] = [];
    for (const e of p.edits) {
      const r = this.lookup(e.entry);
      if (r?.status === "succeeded" && r.file) done.push({ start: e.start, end: e.end, file: r.file, created: e.created, id: e.id });
      else if (r && !["failed", "canceled", "expired", "lost", "succeeded"].includes(r.status)) waiting++;
    }
    return { done, waiting };
  }

  /**
   * The final video as it stands: the source when no edit has finished, else a render with every finished edit in
   * place (made once per set of edits, then reused). Returns the file name (source.mp4 or final-<hash>.mp4).
   */
  async render(id: string): Promise<{ file: string; edits: number; waiting: number }> {
    const p = this.get(id);
    if (!p) throw new InputError("unknown project");
    const { done, waiting } = this.finished(p);
    if (!done.length) return { file: "source.mp4", edits: 0, waiting };
    const parts = layout(p.source.duration, done);
    const hash = createHash("sha1").update(JSON.stringify(parts.map((x) => [x.from, x.to, x.file, x.offset, x.file ? statSync(x.file).mtimeMs : 0])))
      .digest("hex").slice(0, 12);
    const name = `final-${hash}.mp4`;
    const key = `${id}/${hash}`;
    if (!existsSync(this.path(id, name))) {
      if (!this.renders.has(key)) {
        this.renders.set(key, this.compose(p, parts, name).finally(() => this.renders.delete(key)));
      }
      await this.renders.get(key);
    }
    return { file: name, edits: done.length, waiting };
  }

  private async compose(p: Project, parts: ReturnType<typeof layout>, name: string): Promise<string> {
    const { width, height, fps, duration, audio } = p.source;
    const src = this.path(p.id, "source.mp4");
    const args = ["-y", "-v", "error"];
    const filters: string[] = [];
    parts.forEach((part, k) => {
      args.push("-i", part.file ?? src);
      const len = round(part.to - part.from);
      // an edit's video can come back a little shorter than its part: hold its last frame rather than lose time
      filters.push(`[${k}:v]tpad=stop_mode=clone:stop_duration=${len + 1},trim=start=${part.offset}:duration=${len},setpts=PTS-STARTPTS,`
        + `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${k}]`);
    });
    filters.push(`${parts.map((_, k) => `[v${k}]`).join("")}concat=n=${parts.length}:v=1:a=0[v]`);
    if (audio) args.push("-i", src);
    const tmp = this.path(p.id, `${name}.tmp.mp4`);
    args.push("-filter_complex", filters.join(";"), "-map", "[v]");
    if (audio) args.push("-map", `${parts.length}:a:0`, "-c:a", "aac", "-b:a", "192k");
    args.push("-t", String(duration), "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-movflags", "+faststart", tmp);
    await run(FFMPEG(), args);
    renameSync(tmp, this.path(p.id, name));
    // older renders go: only the newest is ever shown
    for (const f of readdirSync(this.path(p.id))) if (/^final-[a-f0-9]{12}\.mp4$/.test(f) && f !== name) rmSync(this.path(p.id, f), { force: true });
    return name;
  }

  /** The part [start, end) of the final video as it stands, as an mp4 to send to a model. */
  async part(id: string, start: number, end: number): Promise<Uint8Array> {
    const p = this.get(id);
    if (!p) throw new InputError("unknown project");
    const s = Math.max(0, round(start));
    const e = Math.min(p.source.duration, round(end));
    if (!(e - s >= 1)) throw new InputError("pick a part at least 1 second long");
    const { file } = await this.render(id);
    const out = this.path(id, `part-${randomBytes(4).toString("hex")}.mp4`);
    try {
      await run(FFMPEG(), ["-y", "-v", "error", "-ss", String(s), "-i", this.path(id, file), "-t", String(round(e - s)),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", out]);
      return new Uint8Array(readFileSync(out));
    } finally {
      rmSync(out, { force: true });
    }
  }
}
