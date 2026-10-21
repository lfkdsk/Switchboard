import test from "node:test";
import assert from "node:assert/strict";
import text from "../cli/lib/session-text.js";

const {
  createTextState,
  foldIndexedAlternateScreens,
  formatDuration,
  renderHistoryText,
} = text;

test("history text strips ANSI across chunks", () => {
  const state = createTextState();
  assert.equal(renderHistoryText("before\x1b[31", state), "before");
  assert.equal(renderHistoryText("mafter\x1b[0m\n", state), "after\n");
});

test("history text strips split terminal control strings without losing later output", () => {
  for (const introducer of ["P", "X", "^", "_"]) {
    const state = createTextState();
    assert.equal(renderHistoryText(`before\x1b${introducer}ignored\x1b`, state), "before");
    assert.equal(renderHistoryText("\\after\n", state), "after\n");
    assert.equal(state.pending, "");
  }
});

test("history text folds alternate screens with the application name", () => {
  const state = createTextState();
  assert.equal(renderHistoryText("$ vim file.txt\n\x1b[?1049hvim noise", state, { now: 1_000 }),
    "$ vim file.txt\n");
  assert.equal(renderHistoryText("more noise\x1b[?1049ldone\n", state, { now: 193_000 }),
    "[vim 3m12s]\ndone\n");
});

test("history text uses a generic alternate-screen label when unknown", () => {
  const state = createTextState();
  assert.equal(renderHistoryText("prompt\n\x1b[?1049hnoise", state, { now: 1_000 }), "prompt\n");
  assert.equal(renderHistoryText("more noise\x1b[?1049l", state, { now: 2_000 }),
    "[alternate screen 1s]\n");
});

test("history text includes alternate-screen content when requested", () => {
  const state = createTextState();
  assert.equal(renderHistoryText("a\x1b[?1047hinside\n\x1b[?1047lb", state,
    { now: 1_000, includeAlt: true }), "ainside\nb");
});

test("history text supports split alternate-screen controls", () => {
  const state = createTextState();
  assert.equal(renderHistoryText("x\x1b[?104", state, { now: 1_000 }), "x");
  assert.equal(renderHistoryText("9hhidden\x1b[?1049l", state, { now: 2_000 }),
    "[alternate screen 0s]\n");
});

test("indexed alternate screens use recorded offsets and duration", () => {
  const input = Buffer.from("before<fullscreen bytes>after");
  const start = Buffer.byteLength("before");
  const end = Buffer.byteLength("before<fullscreen bytes>");
  const folded = foldIndexedAlternateScreens(input, 100, [{
    start: 100 + start,
    end: 100 + end,
    startedAt: 1_000,
    endedAt: 193_000,
    application: "vim",
  }]);
  assert.equal(folded.toString(), "before\n[vim 3m12s]\nafter");
  assert.equal(foldIndexedAlternateScreens(input, 100, [], {}).toString(), input.toString());
  assert.equal(foldIndexedAlternateScreens(input, 100, [{
    start: 100 + start,
    end: 100 + end,
    startedAt: 1_000,
    endedAt: 193_000,
    application: "vim",
  }], { includeAlt: true }).toString(), input.toString());
});

test("active indexed alternate screens hide content without emitting a completed label", () => {
  const input = Buffer.from("secret live output");
  assert.equal(foldIndexedAlternateScreens(input, 50, [{
    start: 40,
    end: 50 + input.length,
    startedAt: 1_000,
    application: "top",
    active: true,
  }]).toString(), "");
});

test("history duration formatting is compact", () => {
  assert.equal(formatDuration(192_000), "3m12s");
  assert.equal(formatDuration(3_661_000), "1h1m1s");
});
