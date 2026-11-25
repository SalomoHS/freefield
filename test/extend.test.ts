import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { joinClips, lastFrame } from "../server/extend.ts";
import { probe } from "../server/editroom.ts";

const ffmpeg = process.env.FFMPEG || "ffmpeg";
const has = spawnSync(ffmpeg, ["-version"]).status === 0;

/** A test clip: a solid colour, with or without a tone. */
function clip(dir: string, name: string, color: string, size: string, seconds: number, sound: boolean) {
  const out = join(dir, name);
  const args = ["-hide_banner", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=${size}:r=24:d=${seconds}`];
  if (sound) args.push("-f", "lavfi", "-i", `sine=f=440:d=${seconds}`, "-shortest");
  args.push("-pix_fmt", "yuv420p", out);
  assert.equal(spawnSync(ffmpeg, args).status, 0);
  return new Uint8Array(readFileSync(out));
}

test("the last frame of a clip, and the clip joined to a new shot at the clip's size, keeping its sound", { skip: !has && "no ffmpeg" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "extend-test-"));
  try {
    const a = clip(dir, "a.mp4", "red", "320x240", 2, true);
    const b = clip(dir, "b.mp4", "blue", "640x360", 3, false);
    const frame = await lastFrame(a);
    assert.deepEqual([...frame.slice(1, 4)], [0x50, 0x4e, 0x47]);   // PNG
    const joined = await joinClips(a, b);
    writeFileSync(join(dir, "j.mp4"), joined);
    const p = await probe(join(dir, "j.mp4"));
    assert.equal(p.width, 320);
    assert.equal(p.height, 240);
    assert.equal(p.audio, true);
    assert.ok(Math.abs(p.duration - 5) < 0.2, `duration ${p.duration}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
