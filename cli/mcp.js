/**
 * MCP server — the door an agent walks through.
 *
 * `switchboard mcp` speaks the Model Context Protocol over stdio, so Claude Code
 * and Codex can reach every machine this account can reach: list them, run a
 * command on one, move a file either way. It is the same exec channel
 * `switchboard exec` uses, with the same identity and the same grants, which is
 * the point — there is no second permission system to keep in step, and
 * revoking a share in the dashboard stops the agent too.
 *
 * The protocol is implemented here rather than pulled from the MCP SDK on
 * purpose: this package's dependencies are frozen by the macOS app's hot-update
 * path (a version whose deps differ from the bundled ones is refused and has to
 * ship as a DMG). A tools-only stdio server is five JSON-RPC methods, and five
 * methods are not worth breaking that.
 *
 * stdout belongs to the protocol. Anything this file wants to say to a human
 * goes to stderr, which is where MCP clients collect server logs.
 */

const readline = require("readline");
const { dial, machines: reachableMachines } = require("./target");
const { execRemote } = require("./flow");

const PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const LATEST = PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1];
const DEFAULT_TIMEOUT_MS = 600000;

// ---- tools ---------------------------------------------------------------
// Descriptions are written for the model, not for a man page: they say when to
// reach for the tool and what it will not do, because that is what stops an
// agent from trying to open an interactive shell through a one-shot channel.
const TOOLS = [
  {
    name: "list_machines",
    description:
      "List the machines reachable from this host — the ones this account owns, plus the ones other people have shared with it. " +
      "Use this first: every other tool addresses a machine by the name or id that appears here. " +
      "A machine marked 'shell only' was shared for a person to use interactively and will refuse commands.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "run_on",
    description:
      "Run one shell command on another machine and wait for it to finish. Returns stdout, stderr and the exit code separately. " +
      "There is no terminal on the far end, so this is for commands that finish on their own — not for interactive programs, " +
      "editors, or anything that expects a TTY. Each call is independent: the working directory and environment do not carry " +
      "over from a previous call, so chain with '&&' or pass 'cwd' instead.",
    inputSchema: {
      type: "object",
      properties: {
        machine: { type: "string", description: "Name or id from list_machines, or a share token." },
        cmd: { type: "string", description: "The command line, interpreted by the far machine's login shell." },
        cwd: { type: "string", description: "Directory to run in. Defaults to the daemon user's home." },
        stdin: { type: "string", description: "Text to feed the command on stdin." },
        timeout_ms: { type: "number", description: `Give up and signal the command after this long. Default ${DEFAULT_TIMEOUT_MS}.` },
      },
      required: ["machine", "cmd"],
      additionalProperties: false,
    },
  },
  {
    name: "upload",
    description:
      "Write a file onto another machine, creating or overwriting it. Text by default; set encoding to 'base64' to send bytes. " +
      "Parent directories are not created.",
    inputSchema: {
      type: "object",
      properties: {
        machine: { type: "string", description: "Name or id from list_machines, or a share token." },
        path: { type: "string", description: "Absolute path on the far machine." },
        content: { type: "string" },
        encoding: { type: "string", enum: ["utf8", "base64"], description: "How 'content' is encoded. Default utf8." },
      },
      required: ["machine", "path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "download",
    description:
      "Read a file from another machine. Returns its text; set encoding to 'base64' for a binary file.",
    inputSchema: {
      type: "object",
      properties: {
        machine: { type: "string", description: "Name or id from list_machines, or a share token." },
        path: { type: "string", description: "Absolute path on the far machine." },
        encoding: { type: "string", enum: ["utf8", "base64"], description: "How to return the content. Default utf8." },
      },
      required: ["machine", "path"],
      additionalProperties: false,
    },
  },
];

// A single-quoted shell word: the only thing that can end it is a quote, so
// close, escape, reopen. Paths arrive from a model and land in a command line —
// this is the seam where "my file.txt" and "; rm -rf /" stop being different.
const q = (s) => "'" + String(s).replace(/'/g, `'\\''`) + "'";

// ---- tool implementations ------------------------------------------------
async function callTool(ctx, name, args) {
  const a = args || {};
  if (name === "list_machines") {
    const all = await reachableMachines(ctx.server, ctx.agentToken);
    if (!all.length) {
      return text("No machines. Run `switchboard login` on a host to bind it to this account.");
    }
    const now = Date.now();
    return text(all.map((m) => {
      const online = now - m.last_seen < 6000;
      const how = m.owned ? "yours" : `shared by @${m.owner_login}${m.can_exec ? "" : " · shell only"}`;
      return `${m.name || "(unnamed)"}  [${m.machine_id.slice(0, 8)}]  ${online ? "online" : "offline"}  ${how}`;
    }).join("\n"));
  }

  if (name === "run_on") {
    const r = await run(ctx, a.machine, a.cmd, { stdin: a.stdin, cwd: a.cwd, timeout: a.timeout_ms });
    // Both streams and the code, always labelled, even when empty: an agent that
    // cannot tell "no output" from "output I forgot to look at" will retry.
    const parts = [`exit ${r.signal ? `${r.code} (${r.signal})` : r.code} · ${r.ms}ms`];
    parts.push(`--- stdout ---\n${r.stdout || "(empty)"}`);
    parts.push(`--- stderr ---\n${r.stderr || "(empty)"}`);
    return text(parts.join("\n"), r.code !== 0);
  }

  if (name === "upload") {
    const body = a.encoding === "base64" ? Buffer.from(a.content, "base64") : Buffer.from(String(a.content), "utf8");
    // `cat > path` rather than a protocol message: the daemon's own upload path
    // puts files where a shell window is standing, which is meaningless without
    // one — and routing this through exec means a shell-only share cannot write
    // files either, which is the answer you want.
    const r = await run(ctx, a.machine, `cat > ${q(a.path)}`, { stdinBuf: body });
    if (r.code !== 0) return text(`Could not write ${a.path}: ${r.stderr.trim() || "exit " + r.code}`, true);
    return text(`Wrote ${body.length} bytes to ${a.path}`);
  }

  if (name === "download") {
    const r = await run(ctx, a.machine, `cat ${q(a.path)}`);
    if (r.code !== 0) return text(`Could not read ${a.path}: ${r.stderr.trim() || "exit " + r.code}`, true);
    return text(a.encoding === "base64" ? r.stdoutBuf.toString("base64") : r.stdout);
  }

  return text(`No such tool: ${name}`, true);
}

async function run(ctx, machine, cmd, opts = {}) {
  if (!machine) throw new Error("which machine? call list_machines first");
  if (!cmd) throw new Error("no command given");
  const how = await dial(ctx.server, machine, ctx.agentToken);
  return execRemote(ctx.server, how, cmd, {
    stdin: opts.stdinBuf != null ? opts.stdinBuf : (opts.stdin != null ? Buffer.from(String(opts.stdin), "utf8") : null),
    cwd: opts.cwd,
    timeout: Number(opts.timeout) || DEFAULT_TIMEOUT_MS,
  });
}

const text = (s, isError) => ({ content: [{ type: "text", text: s }], ...(isError ? { isError: true } : {}) });

// ---- JSON-RPC over stdio -------------------------------------------------
function serve(server, agentToken) {
  const ctx = { server, agentToken };
  const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
  const reply = (id, result) => out({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => out({ jsonrpc: "2.0", id, error: { code, message } });

  readline.createInterface({ input: process.stdin }).on("line", async (line) => {
    if (!line.trim()) return;
    let m;
    try { m = JSON.parse(line); } catch { return fail(null, -32700, "parse error"); }
    // A notification has no id and must never be answered — replying to one is
    // the classic way to wedge a client that is waiting for something else.
    const isRequest = m.id !== undefined && m.id !== null;

    try {
      switch (m.method) {
        case "initialize": {
          const want = m.params && m.params.protocolVersion;
          return reply(m.id, {
            protocolVersion: PROTOCOL_VERSIONS.includes(want) ? want : LATEST,
            capabilities: { tools: {} },
            serverInfo: { name: "switchboard", version: require("./package.json").version },
          });
        }
        case "notifications/initialized":
        case "notifications/cancelled":
          return;
        case "ping":
          return isRequest && reply(m.id, {});
        case "tools/list":
          return reply(m.id, { tools: TOOLS });
        case "tools/call": {
          const { name, arguments: args } = m.params || {};
          try {
            return reply(m.id, await callTool(ctx, name, args));
          } catch (e) {
            // A tool that failed is a result, not a protocol error: the model
            // should see "that machine is shared with you for shell access
            // only" and pick another machine, not have the call disappear.
            return reply(m.id, text(String(e.message || e), true));
          }
        }
        default:
          if (isRequest) return fail(m.id, -32601, `method not found: ${m.method}`);
      }
    } catch (e) {
      if (isRequest) fail(m.id, -32603, String(e.message || e));
    }
  }).on("close", () => process.exit(0));

  process.stderr.write(`switchboard mcp: serving ${TOOLS.length} tools against ${server}\n`);
}

module.exports = { serve, TOOLS };
