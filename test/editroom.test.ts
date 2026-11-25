import { test } from "node:test";
import assert from "node:assert/strict";
import { layout } from "../server/editroom.ts";

const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

test("no edits: the whole source in one part", () => {
  assert.deepEqual(layout(10, []), [{ from: 0, to: 10, file: null, offset: 0 }]);
});

test("an edit replaces its part; the source fills the rest at its own times", () => {
  assert.deepEqual(layout(10, [{ start: 2, end: 5, file: "a.mp4", created: at(1) }]), [
    { from: 0, to: 2, file: null, offset: 0 },
    { from: 2, to: 5, file: "a.mp4", offset: 0 },
    { from: 5, to: 10, file: null, offset: 5 },
  ]);
});

test("the newest edit wins where two overlap, and the older one shows around it at the right offset", () => {
  assert.deepEqual(layout(10, [
    { start: 0, end: 6, file: "old.mp4", created: at(1) },
    { start: 2, end: 4, file: "new.mp4", created: at(2) },
  ]), [
    { from: 0, to: 2, file: "old.mp4", offset: 0 },
    { from: 2, to: 4, file: "new.mp4", offset: 0 },
    { from: 4, to: 6, file: "old.mp4", offset: 4 },
    { from: 6, to: 10, file: null, offset: 6 },
  ]);
});
