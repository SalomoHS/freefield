// Extend a clip with any image-to-video model: its last frame becomes the start frame of a new shot, and once that
// shot is made the two are joined into one video (the clip's size, frame rate and sound kept; silence where a part
// has none). The new shot's first frame repeats the clip's last one, so it is dropped at the join.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FFMPEG, probe, run } from "./editroom.ts";

async function inTemp<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "freefield-extend-"));
  try { return await work(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** The clip's last frame as a PNG. */
export function lastFrame(clip: Uint8Array, ext = "mp4"): Promise<Uint8Array> {
  return inTemp(async (dir) => {
    const src = join(dir, `in.${ext}`);
    const out = join(dir, "last.png");
    writeFileSync(src, clip);
    // read the last second and keep overwriting one image: what is left is the final frame
    await run(FFMPEG(), ["-hide_banner", "-y", "-sseof", "-1", "-i", src, "-update", "1", "-an", out], 120_000);
    return new Uint8Array(readFileSync(out));
  });
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** The clip followed by the new shot, as one mp4 at the clip's size and frame rate. */
export function joinClips(clip: Uint8Array, next: Uint8Array, ext = "mp4"): Promise<Uint8Array> {
  return inTemp(async (dir) => {
    const a = join(dir, `a.${ext}`);
    const b = join(dir, "b.mp4");
    const out = join(dir, "joined.mp4");
    writeFileSync(a, clip);
    writeFileSync(b, next);
    const [pa, pb] = [await probe(a), await probe(b)];
    const [W, H, fps] = [even(pa.width), even(pa.height), pa.fps || 24];
    const skip = 1 / (pb.fps || 24);
    const look = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`;
    const parts = [
      `[0:v]${look}[v0]`,
      `[1:v]trim=start=${skip},setpts=PTS-STARTPTS,${look}[v1]`,
    ];
    const sound = pa.audio || pb.audio;
    if (sound) {
      const fmt = "aresample=48000,aformat=channel_layouts=stereo";
      const d0 = pa.duration;
      const d1 = Math.max(0.1, pb.duration - skip);
      parts.push(pa.audio ? `[0:a]${fmt},apad,atrim=duration=${d0}[a0]` : `anullsrc=r=48000:cl=stereo,atrim=duration=${d0}[a0]`);
      parts.push(pb.audio ? `[1:a]atrim=start=${skip},asetpts=PTS-STARTPTS,${fmt},apad,atrim=duration=${d1}[a1]` : `anullsrc=r=48000:cl=stereo,atrim=duration=${d1}[a1]`);
      parts.push("[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]");
    } else {
      parts.push("[v0][v1]concat=n=2:v=1:a=0[v]");
    }
    await run(FFMPEG(), ["-hide_banner", "-y", "-i", a, "-i", b, "-filter_complex", parts.join(";"), "-map", "[v]",
      ...(sound ? ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"] : []),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-movflags", "+faststart", out]);
    return new Uint8Array(readFileSync(out));
  });
}
