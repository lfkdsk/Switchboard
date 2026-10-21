"use strict";

// Text rendering is deliberately byte-stream friendly: callers retain the
// returned state between chunks so split escape sequences and alternate-screen
// spans are handled without corrupting offsets or leaking full-screen UI noise.
const ALT_RE = /^\x1b\[\?(?:47|1047|1049)([hl])/;
const CSI_RE = /^\x1b\[[0-?]*[ -/]*[@-~]/;
const OSC_RE = /^\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)/;
const CONTROL_STRING_RE = /^\x1b[PX^_](?:[^\x1b]|\x1b(?!\\))*\x1b\\/;
const ESC_RE = /^\x1b(?:[@-_]|[()][0-2A-Z])/;

function createTextState() {
  return { pending: "", alt: null, line: "", lastLine: "" };
}

function alternateLabel(line) {
  const match = String(line).match(/(?:^|[\s$#;|&])(vim?|nvim|nano|less|more|man|top|htop|ssh|tmux)(?=\s|$)/i);
  return match ? match[1].toLowerCase() : "alternate screen";
}

function rememberText(state, text) {
  const parts = text.split("\n");
  state.line += parts[0];
  for (let index = 1; index < parts.length; index++) {
    if (state.line.trim()) state.lastLine = state.line;
    state.line = parts[index];
  }
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h && `${h}h`, (m || h) && `${m}m`, `${s}s`].filter(Boolean).join("");
}

function renderHistoryText(value, state = createTextState(), options = {}) {
  let input = state.pending + (Buffer.isBuffer(value) ? value.toString("utf8") : String(value));
  state.pending = "";
  let output = "";
  let index = 0;
  while (index < input.length) {
    const rest = input.slice(index);
    if (rest[0] !== "\x1b") {
      const end = rest.indexOf("\x1b");
      const text = end < 0 ? rest : rest.slice(0, end);
      const normalized = text.replace(/\r(?!\n)/g, "\n");
      if (!state.alt) rememberText(state, normalized);
      if (!state.alt || options.includeAlt) output += normalized;
      index += text.length;
      continue;
    }
    const alt = ALT_RE.exec(rest);
    if (alt) {
      if (alt[1] === "h" && !state.alt) {
        state.alt = {
          startedAt: options.now ?? Date.now(),
          label: alternateLabel(state.line || state.lastLine),
        };
      }
      if (alt[1] === "l" && state.alt) {
        const duration = formatDuration((options.now ?? Date.now()) - state.alt.startedAt);
        if (!options.includeAlt) output += `${output && !output.endsWith("\n") ? "\n" : ""}[${state.alt.label} ${duration}]\n`;
        state.alt = null;
      }
      index += alt[0].length;
      continue;
    }
    const sequence = CSI_RE.exec(rest) || OSC_RE.exec(rest) || CONTROL_STRING_RE.exec(rest) ||
      (!/^\x1b[\[\]PX^_]/.test(rest) && ESC_RE.exec(rest));
    if (sequence) { index += sequence[0].length; continue; }
    // Hold incomplete control strings and escape sequences for the next chunk.
    // OSC payloads may be much longer than a protocol chunk, so length is not
    // a safe signal that an unterminated sequence is malformed.
    if (rest.startsWith("\x1b]") || rest.startsWith("\x1bP") ||
        rest.startsWith("\x1bX") || rest.startsWith("\x1b^") ||
        rest.startsWith("\x1b_") ||
        (rest.length < 256 && !/[A-Za-z\\\x07]/.test(rest.slice(1)))) {
      state.pending = rest;
      break;
    }
    index++;
  }
  return output;
}

function filterGrep(text, pattern, options = {}) {
  const expression = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), options.ignoreCase ? "i" : "");
  return text.split("\n").filter((line) => expression.test(line)).join("\n");
}

module.exports = { createTextState, filterGrep, formatDuration, renderHistoryText };
