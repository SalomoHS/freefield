import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequest, modeOf, nearestDuration, type VideoModel } from "../server/openrouter.ts";
import { mediaKind, resolveValues } from "../server/runner.ts";

const model = (over: Partial<VideoModel>): VideoModel => ({
  id: "m", supported_resolutions: null, supported_aspect_ratios: null, supported_durations: null,
  supported_frame_images: null, generate_audio: null, seed: null, ...over,
});

test("an edit sends the clip and the reference as input_references, never frame_images", () => {
  const body = buildRequest({ prompt: "relight", duration: 4.6 }, model({}), { clip: "https://x/s/a.mp4", reference: "https://x/s/b.png" });
  assert.deepEqual(body.input_references, [
    { type: "video_url", video_url: { url: "https://x/s/a.mp4" } },
    { type: "image_url", image_url: { url: "https://x/s/b.png" } },
  ]);
  assert.equal(body.frame_images, undefined);
  assert.equal(body.duration, undefined);   // no list: the model follows the source
});

test("an edit follows the source length where the model takes -1, else the nearest it offers", () => {
  assert.equal(buildRequest({ prompt: "p", duration: 7 }, model({ supported_durations: [-1, 4, 5] }), { clip: "https://c" }).duration, -1);
  assert.equal(buildRequest({ prompt: "p", duration: 3 }, model({ supported_durations: [5, 6, 10] }), { clip: "https://c" }).duration, 5);
  assert.equal(nearestDuration(8, [-1, 4, 10]), 10);
});

test("an upscale sends one video, the factor and creativity inside the model's range, and no length", () => {
  const up = model({ upscale_factor: { min: 1.5, max: 3 }, creativity: [0, 1] });
  const body = buildRequest({ prompt: "", factor: 4, creativity: 0.5, duration: 5 }, up, { clip: "https://c" });
  assert.deepEqual(body.input_references, [{ type: "video_url", video_url: { url: "https://c" } }]);
  assert.equal(body.upscale_factor, 3);
  assert.equal(body.creativity, 0.5);
  assert.equal(body.prompt, undefined);
  assert.equal(body.duration, undefined);
});

test("an edit needs a prompt", () => {
  assert.throws(() => buildRequest({ prompt: " " }, model({}), { clip: "https://c" }), /prompt/);
});

const png = { name: "a.png", type: "image/png", bytes: new Uint8Array([1, 2, 3]) };
const both = model({ supported_frame_images: ["first_frame", "last_frame"] });
const kinds = (body: Record<string, unknown>) => (body.frame_images as { frame_type: string }[] | undefined)?.map((f) => f.frame_type);

test("start frame: one first_frame; no image is text to video; a save without a mode is this one", () => {
  assert.deepEqual(kinds(buildRequest({ prompt: "p", image: png }, both)), ["first_frame"]);
  assert.equal(buildRequest({ prompt: "p" }, both).frame_images, undefined);
  assert.equal(modeOf({}), "frames");
  assert.throws(() => buildRequest({ prompt: "" }, both), /prompt/);
});

test("start and end: both frames; an end frame alone; the end needs a model that takes one", () => {
  assert.deepEqual(kinds(buildRequest({ mode: "start_end", prompt: "p", image: png, end: png }, both)), ["first_frame", "last_frame"]);
  assert.deepEqual(kinds(buildRequest({ mode: "start_end", prompt: "p", end: png }, both)), ["last_frame"]);
  assert.throws(() => buildRequest({ mode: "start_end", prompt: "p", end: png }, model({ supported_frame_images: ["first_frame"] })), /end on an image/);
  assert.throws(() => buildRequest({ mode: "start_end", prompt: "p" }, both), /start frame, an end frame or both/);
});

test("an end frame left from Start & end is not sent with a start frame alone", () => {
  assert.deepEqual(kinds(buildRequest({ mode: "frames", prompt: "p", image: png, end: png }, both)), ["first_frame"]);
});

test("references: every file as a link in input_references by its kind, no frames, and a prompt", () => {
  const body = buildRequest({ mode: "refs", prompt: "they meet", image: png }, both,
    { refs: [{ kind: "image", url: "https://x/1.png" }, { kind: "video", url: "https://x/2.mp4" }, { kind: "audio", url: "https://x/3.mp3" }] });
  assert.deepEqual(body.input_references, [
    { type: "image_url", image_url: { url: "https://x/1.png" } },
    { type: "video_url", video_url: { url: "https://x/2.mp4" } },
    { type: "audio_url", audio_url: { url: "https://x/3.mp3" } },
  ]);
  assert.equal(body.frame_images, undefined);
  assert.throws(() => buildRequest({ mode: "refs", prompt: "" }, both, { refs: [{ kind: "image", url: "https://x" }] }), /prompt/);
  assert.throws(() => buildRequest({ mode: "refs", prompt: "p" }, both, {}), /at least one/);
});

test("extend starts from the clip's last frame (put in image) and needs it", () => {
  assert.deepEqual(kinds(buildRequest({ mode: "extend", prompt: "p", image: png }, both)), ["first_frame"]);
  assert.throws(() => buildRequest({ mode: "extend", prompt: "p" }, both), /extend/);
});

test("a media file's kind comes from its type, else its name", () => {
  assert.equal(mediaKind({ name: "x.bin", type: "video/mp4" }), "video");
  assert.equal(mediaKind({ name: "x.MP3" }), "audio");
  assert.equal(mediaKind({ name: "x.png" }), "image");
});

test("a media input takes a list of files, at most max_files, each under max_mb", () => {
  const app = { id: "a", backend: "openrouter", inputs: [{ id: "refs", type: "media", label: "R", limits: { max_files: 2, max_mb: 1 } }] } as never;
  assert.equal((resolveValues(app, { refs: [png, png] }).refs as unknown[]).length, 2);
  assert.throws(() => resolveValues(app, { refs: [png, png, png] }), /2 files at most/);
  assert.throws(() => resolveValues(app, { refs: [{ name: "big.png", bytes: new Uint8Array(1_000_001) }] }), /over 1 MB/);
  assert.equal(resolveValues(app, {}).refs, undefined);
});
