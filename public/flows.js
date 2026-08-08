/**
 * The flow editor — drawing a control flow in a browser, and handing it to a
 * machine to conduct.
 *
 * The page never conducts anything. It reads and writes flow files on one
 * machine and asks that machine to run them, over the same circuit a terminal
 * uses; the graph walk stays in the daemon, where it has always been. So closing
 * this tab doesn't stop a run — it stops you watching one — and reopening it
 * re-attaches to whatever is still going.
 *
 * The canvas is the point of drawing this rather than typing it: control flow is
 * a graph, and a graph read as a list of JSON objects is a graph you are
 * simulating in your head. Two rules make it honest. Every edge the runner can
 * take is drawn, including the ones nobody wrote down — a step with no
 * on_success falls through to the next in document order, so that fall-through
 * is drawn dashed rather than left to be inferred. And a step's failure edge,
 * when unwired, says "stop" on its face, because that is what will happen.
 */
(function () {
  "use strict";

  const NODE_W = 260;
  const COL_X = 90, ROW_Y = 50, ROW_GAP = 195;
  const dec = new TextDecoder();

  let host = null;       // the #view-flows element, filled in by mount()
  let hooks = {};        // showView / goDashboard / toast, owned by index.html
  let conductor = null;  // { machineId, label } — the machine that holds and runs these

  let sock = null, retry = null, retryMs = 1000, wantOpen = false;
  const queued = [];     // frames written before the socket finished opening

  let flows = [];        // what the conductor has saved
  let targets = [];      // what the conductor can reach, asked of the conductor
  let spec = null;       // the flow on the canvas
  let name = "";         // its filename over there
  let savedJson = "";    // what it looked like when last read or written
  let selected = null;   // whose output the drawer is showing
  let run = null;        // { id, state, out, taken, done, ok, error }
  let jsonOpen = false;

  const els = {};
  const nodeEls = new Map();  // step id -> element, so edges can measure real geometry
  let linking = null;         // a connection being dragged

  const $ = (t, cls, txt) => { const e = document.createElement(t); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const stepById = (id) => (spec && spec.steps || []).find((s) => s.id === id) || null;
  const toast = (t, k) => hooks.toast && hooks.toast(t, k);
  function b64ToBytes(b64) { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; }

  // ---- the wire ----------------------------------------------------------
  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    sock = new WebSocket(`${proto}//${location.host}/ws?role=browser&machine=${encodeURIComponent(conductor.machineId)}`);
    sock.onopen = () => {
      retryMs = 1000;
      setStatus("connected");
      while (queued.length) sock.send(queued.shift());
      send({ type: "flow-ls" });
      send({ type: "flow-targets" });
    };
    sock.onmessage = (ev) => { if (typeof ev.data === "string") handle(ev.data); };
    sock.onclose = () => {
      sock = null;
      if (!wantOpen) return;
      setStatus("reconnecting…");
      retry = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 15000);
    };
    sock.onerror = () => { try { sock.close(); } catch {} };
  }
  function send(o) {
    const s = JSON.stringify(o);
    if (sock && sock.readyState === WebSocket.OPEN) sock.send(s); else queued.push(s);
  }
  function disconnect() {
    wantOpen = false;
    if (retry) { clearTimeout(retry); retry = null; }
    queued.length = 0;
    if (sock) { const s = sock; sock = null; try { s.close(); } catch {} }
  }

  function handle(str) {
    let m; try { m = JSON.parse(str); } catch { return; }
    switch (m.type) {
      case "_relay":
        // The conductor itself going away matters more here than in a terminal:
        // there is nothing to type into, and a Run button that looks armed while
        // the machine is gone is a lie.
        setStatus(m.event === "daemon-online" ? "connected" : "machine offline");
        break;
      case "flow-list":
        flows = m.flows || [];
        els.dir.textContent = m.dir || "";
        adoptRuns(m.runs || []);
        renderRail();
        break;
      case "flow-targets": targets = m.machines || []; if (spec) renderCanvas(); break;
      case "flow-spec":
        if (m.name !== name) break; // a reply for a flow we've since navigated away from
        loadSpec(m.spec);
        break;
      case "flow-saved":
        if (m.name === name) { savedJson = JSON.stringify(spec); renderBar(); toast(`Saved ${m.name}`, "ok"); }
        break;
      case "flow-removed":
        if (m.name === name) { spec = null; name = ""; syncName(); renderAll(); }
        toast(`Deleted ${m.name}`, "ok");
        break;
      case "flow-error": toast(m.message, "err"); setProblems([m.message]); break;
      case "flow-ev": onEvent(m.run, m.ev); break;
      case "flow-out": onOutput(m.run, m.id, m.stream, m.data); break;
      case "flow-attached": onAttached(m); break;
    }
  }

  // ---- opening and leaving -----------------------------------------------
  function open(c) {
    conductor = c;
    wantOpen = true;
    flows = []; targets = []; spec = null; name = ""; savedJson = ""; run = null; selected = null;
    els.where.innerHTML = "";
    els.where.append("flows on ", Object.assign($("b"), { textContent: c.label || c.machineId.slice(0, 8) }));
    syncName();
    renderAll();
    setStatus("connecting…");
    connect();
    hooks.showView("flows");
  }
  function leave() { disconnect(); }

  function setStatus(t) { els.status.textContent = t; }

  // ---- the flow on the canvas --------------------------------------------
  function loadSpec(s) {
    spec = s && typeof s === "object" ? s : { steps: [] };
    if (!Array.isArray(spec.steps)) spec.steps = [];
    layout();
    savedJson = JSON.stringify(spec);
    selected = null;
    syncName();
    renderAll();
  }

  // Anything hand-written arrives without coordinates. Stacking those in
  // document order isn't a guess at what the author meant — it *is* what the
  // runner does when no edges are written, so the default layout and the default
  // control flow are the same shape.
  function layout() {
    spec.ui = spec.ui || {};
    spec.steps.forEach((s, i) => {
      if (!s.ui || typeof s.ui.x !== "number" || typeof s.ui.y !== "number") {
        s.ui = { x: COL_X, y: ROW_Y + i * ROW_GAP };
      }
    });
    if (!spec.ui.stop) {
      const lowest = spec.steps.reduce((y, s) => Math.max(y, s.ui.y), ROW_Y);
      spec.ui.stop = { x: COL_X + NODE_W + 130, y: lowest + 90 };
    }
  }

  function newFlow() {
    const n = uniqueName("flow");
    name = n;
    loadSpec({ name: n, conductor: conductor.label || conductor.machineId, steps: [
      { id: "step1", target: conductor.label || conductor.machineId, cmd: "echo hello" },
    ] });
    savedJson = ""; // never saved yet, so it counts as unsaved from the first frame
    renderAll();
  }
  function uniqueName(base) {
    const taken = new Set(flows.map((f) => f.name));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(base + i)) return base + i;
  }

  function pickFlow(n) {
    if (dirty() && !confirm(`“${name}” has unsaved changes. Discard them?`)) return;
    name = n;
    run = null; selected = null;
    send({ type: "flow-get", name: n });
    renderRail();
  }
  function dirty() { return !!spec && JSON.stringify(spec) !== savedJson; }

  function save() {
    if (!spec) return;
    const n = els.name.value.trim();
    if (!n) { toast("A flow needs a name to be saved under.", "err"); return; }
    const problems = validate(spec);
    if (problems.length) { setProblems(problems); toast("Fix the problems first — this wouldn't run.", "err"); return; }
    // The title inside the file follows the filename until someone gives it one
    // of its own. Two names for the same flow that drift apart is a small thing
    // that costs a real minute every time you go looking for the right file.
    if (!spec.name || spec.name === name) spec.name = n;
    name = n;
    send({ type: "flow-save", name: n, spec });
  }
  function remove() {
    if (!name) return;
    if (!confirm(`Delete “${name}” from ${conductor.label}?\n\nThe file is removed from that machine.`)) return;
    send({ type: "flow-rm", name });
  }

  // ---- the rulebook, as far as a canvas can break it ---------------------
  // The daemon validates again before it writes, and its answer is the one that
  // counts. This copy exists so a problem shows up as you make it rather than
  // when you press Save — which is also why it's short: an editor that only
  // draws edges between nodes that exist can't produce most of the failures the
  // file format allows.
  function validate(f) {
    const errs = [];
    if (!f.steps.length) errs.push("a flow needs at least one step");
    const seen = new Set();
    f.steps.forEach((s, i) => {
      const where = `step ${i + 1}${s.id ? ` (${s.id})` : ""}`;
      if (!s.id) errs.push(`${where}: needs an id`);
      else if (seen.has(s.id)) errs.push(`${where}: another step already has this id`);
      else seen.add(s.id);
      if (!s.target) errs.push(`${where}: needs a machine to run on`);
      if (isAgent(s) && !(s.ui.agent.prompt || "").trim()) errs.push(`${where}: the agent needs something to do`);
      else if (!s.cmd || !s.cmd.trim()) errs.push(`${where}: needs a command`);
    });
    return errs;
  }
  function stepProblem(s, i) {
    if (!s.id) return "needs an id";
    if (spec.steps.some((o, j) => j !== i && o.id === s.id)) return "duplicate id";
    if (!s.target) return "no machine";
    // An agent step always has a cmd — the editor wrote it — so the empty thing
    // to catch is the prompt inside it.
    if (isAgent(s) && !(s.ui.agent.prompt || "").trim()) return "the agent needs something to do";
    if (!s.cmd || !s.cmd.trim()) return "no command";
    return null;
  }

  // ---- running -----------------------------------------------------------
  function start() {
    if (!spec) return;
    if (dirty()) { toast("Save first — the machine runs the file, not the canvas.", "err"); return; }
    const id = crypto.randomUUID();
    run = { id, name, state: {}, out: {}, taken: new Set(), done: false, ok: null, last: null };
    selected = null;
    send({ type: "flow-run", name, run: id });
    renderAll();
  }
  function stop() { if (run && !run.done) send({ type: "flow-kill", run: run.id }); }

  // A run the conductor already knows about — because it was started from
  // another tab, or from this one before it was closed. Re-attaching is what
  // makes the browser a window rather than the owner.
  function adoptRuns(list) {
    if (run && !run.done) return;
    const live = list.filter((r) => !r.done && (!name || r.name === name)).pop();
    if (!live) return;
    run = { id: live.id, name: live.name, state: {}, out: {}, taken: new Set(), done: false, ok: null, last: null };
    if (live.name !== name) { name = live.name; send({ type: "flow-get", name }); }
    send({ type: "flow-attach", run: live.id });
  }
  function onAttached(m) {
    if (!run || run.id !== m.run) return;
    run.done = m.done; run.ok = m.ok;
    for (const ev of m.events || []) applyEvent(ev);
    for (const [id, o] of Object.entries(m.out || {})) run.out[id] = { stdout: o.stdout || "", stderr: o.stderr || "" };
    renderAll();
  }

  function onEvent(runId, ev) {
    if (!run || run.id !== runId) return;
    applyEvent(ev);
    renderCanvasState();
    renderDrawer();
    if (ev.ev === "flow-end") renderRail(); // the rail says "running…" until told otherwise
  }
  function applyEvent(ev) {
    switch (ev.ev) {
      case "step-start":
        run.state[ev.id] = "running";
        // The edge actually taken, learned from the order things happened rather
        // than from re-deciding it here: the runner's choice is the only one that
        // matters, and a second implementation of that choice would eventually
        // disagree with it on screen.
        if (run.last) run.taken.add(run.last + ">" + ev.id);
        run.last = ev.id;
        if (!selected) selected = ev.id;
        break;
      case "step-end":
        run.state[ev.id] = ev.cancelled ? "cancelled" : ev.ok ? "done" : "failed";
        run.ms = run.ms || {};
        run.ms[ev.id] = ev.ms;
        run.code = run.code || {};
        run.code[ev.id] = ev.unreachable ? "unreachable" : ev.signal || ev.code;
        break;
      case "halt": run.halt = ev.reason; if (run.last) run.taken.add(run.last + ">stop"); break;
      case "flow-end":
        run.done = true; run.ok = ev.ok; run.cancelled = ev.cancelled;
        run.failed = ev.failed || []; run.total = ev.ms; run.error = ev.error || null;
        if (run.last && !ev.error) run.taken.add(run.last + ">stop");
        break;
      case "conductor-mismatch":
        run.warn = `this flow names “${ev.want}” as its conductor but is running on ${ev.here} — every step pays an extra relay hop`;
        break;
    }
  }
  function onOutput(runId, id, stream, data) {
    if (!run || run.id !== runId) return;
    const slot = run.out[id] || (run.out[id] = { stdout: "", stderr: "" });
    slot[stream] += dec.decode(b64ToBytes(data));
    if (selected === id) renderOut();
  }

  // ---- chrome ------------------------------------------------------------
  function mount(el, h) {
    host = el; hooks = h;

    const bar = $("div", "fl-bar");
    els.back = $("button", null, "← Machines");
    els.where = $("span", "fl-where");
    els.status = $("span", "muted");
    els.name = Object.assign(document.createElement("input"), { className: "fl-name", placeholder: "flow name", spellcheck: false, autocomplete: "off" });
    els.dirtyMark = $("span", "fl-dirty", "● unsaved");
    els.addStep = $("button", null, "+ step");
    els.addAgent = $("button", null, "+ agent");
    els.addAgent.title = "Put an agent on one machine and let it drive the others";
    els.save = $("button", "primary", "Save");
    els.runBtn = $("button", null, "Run");
    els.stopBtn = $("button", "danger", "Stop");
    els.jsonBtn = $("button", null, "JSON");
    els.delBtn = $("button", "danger", "Delete");
    els.dir = $("span", "muted");
    els.dir.style.fontSize = "11px";
    bar.append(els.back, els.where, els.status, spacer(), els.name, els.dirtyMark,
      els.addStep, els.addAgent, els.jsonBtn, els.save, els.runBtn, els.stopBtn, els.delBtn);

    const main = $("div", "fl-main");
    els.rail = $("div", "fl-rail");
    els.wrap = $("div", "fl-canvas-wrap");
    els.canvas = $("div", "fl-canvas");
    els.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    els.stop = $("div", "fl-stop", "■ stop");
    els.side = $("div", "fl-side");
    els.problems = $("div", "fl-problems");
    els.legend = $("div", "fl-legend");
    els.legend.innerHTML =
      '<span><i style="border-color:var(--ok)"></i>on success</span>' +
      '<span><i style="border-color:var(--err)"></i>on failure</span>' +
      '<span><i style="border-color:#3a4454;border-top-style:dashed"></i>falls through</span>' +
      '<span><i style="border-color:var(--accent);border-top-style:dotted"></i>stdin</span>';
    els.side.append(els.problems, els.legend);
    els.canvas.append(els.svg, els.stop);
    els.wrap.append(els.canvas, els.side);

    els.json = $("div", "fl-json");
    els.jsonText = document.createElement("textarea");
    els.jsonText.spellcheck = false;
    els.jsonErr = $("div", "fl-j-err");
    els.json.append(els.jsonText, els.jsonErr);
    els.json.hidden = true;

    main.append(els.rail, els.wrap, els.json);

    els.drawer = $("div", "fl-drawer");
    const dh = $("div", "fl-d-head");
    els.dTitle = $("span", "fl-d-title");
    els.dTabs = $("div", "fl-d-tabs");
    els.dSummary = $("span", "muted");
    dh.append(els.dTitle, els.dTabs, spacer(), els.dSummary, els.dir);
    els.out = $("div", "fl-out");
    els.drawer.append(dh, els.out);

    host.append(bar, main, els.drawer);

    els.back.onclick = () => { if (dirty() && !confirm("Leave with unsaved changes?")) return; leave(); hooks.goDashboard(); };
    els.addStep.onclick = () => addStep(false);
    els.addAgent.onclick = () => addStep(true);
    els.save.onclick = save;
    els.runBtn.onclick = start;
    els.stopBtn.onclick = stop;
    els.delBtn.onclick = remove;
    els.jsonBtn.onclick = toggleJson;
    els.name.oninput = renderBar;
    els.jsonText.oninput = jsonEdited;
    makeDraggable(els.stop, () => spec && spec.ui.stop, () => renderEdges());

    // A wire is only being dragged for as long as a button is held, so the
    // listeners live on the window: releasing outside the canvas has to cancel
    // it, and a mouseup the canvas never sees would otherwise leave the page
    // drawing a line to the cursor forever.
    window.addEventListener("mousemove", onLinkMove);
    window.addEventListener("mouseup", onLinkDrop);
  }
  function spacer() { const s = $("span", "spacer"); s.style.flex = "1"; return s; }

  // ---- rail --------------------------------------------------------------
  function renderRail() {
    els.rail.textContent = "";
    const head = $("h2", null, "Flows");
    const add = $("button", null, "+ New");
    add.style.cssText = "width:100%;margin-bottom:8px";
    add.onclick = () => { if (dirty() && !confirm("Discard unsaved changes?")) return; newFlow(); };
    els.rail.append(head, add);
    if (!flows.length) {
      els.rail.append($("div", "empty-rail", "Nothing saved on this machine yet."));
      return;
    }
    for (const f of flows) {
      const item = $("div", "fl-item" + (f.name === name ? " on" : "") + (f.invalid ? " bad" : ""));
      item.append($("span", "n", f.name));
      const live = run && !run.done && run.name === f.name;
      if (live) item.classList.add("live");
      item.append($("span", "s", live ? "running…" : f.invalid ? "needs fixing" : `${f.steps} step${f.steps === 1 ? "" : "s"}`));
      item.onclick = () => pickFlow(f.name);
      els.rail.append(item);
    }
  }

  // ---- bar ---------------------------------------------------------------
  function renderBar() {
    const has = !!spec;
    els.name.hidden = !has;
    els.addStep.disabled = !has;
    els.addAgent.disabled = !has;
    els.save.disabled = !has;
    els.delBtn.hidden = !has || !flows.some((f) => f.name === name);
    els.jsonBtn.disabled = !has;
    const live = !!run && !run.done;
    els.runBtn.hidden = live;
    els.stopBtn.hidden = !live;
    els.runBtn.disabled = !has || dirty();
    els.runBtn.title = dirty() ? "Save first — the machine runs the saved file, not the canvas" : "Conduct this flow on " + (conductor ? conductor.label : "");
    els.dirtyMark.hidden = !has || !dirty();
  }
  // The name box follows the flow being loaded and nothing else. Re-syncing it
  // on every repaint would mean a run event arriving mid-rename quietly puts the
  // old name back, and you'd save over the flow you were trying to copy.
  function syncName() { els.name.value = name; }

  function renderAll() { renderBar(); renderRail(); renderCanvas(); renderDrawer(); }

  // ---- canvas ------------------------------------------------------------
  function renderCanvas() {
    nodeEls.clear();
    for (const n of [...els.canvas.querySelectorAll(".fl-node")]) n.remove();
    els.stop.hidden = !spec;
    els.wrap.hidden = jsonOpen;
    if (!spec) { renderEdges(); setProblems([]); return; }
    spec.steps.forEach((s, i) => {
      const el = buildNode(s, i);
      nodeEls.set(s.id, el);
      els.canvas.append(el);
    });
    els.stop.style.left = spec.ui.stop.x + "px";
    els.stop.style.top = spec.ui.stop.y + "px";
    renderCanvasState();
    renderEdges();
    setProblems(validate(spec));
  }

  function buildNode(s, i) {
    const el = $("div", "fl-node");
    el.dataset.id = s.id;
    el.style.left = s.ui.x + "px";
    el.style.top = s.ui.y + "px";

    const head = $("div", "fl-n-head");
    const id = Object.assign(document.createElement("input"), { className: "fl-n-id", value: s.id, spellcheck: false });
    id.onchange = () => renameStep(s, id.value.trim());
    id.onkeydown = (e) => { if (e.key === "Enter") id.blur(); };
    const state = $("span", "fl-n-state");
    const kind = $("button", "fl-n-kind");
    kind.textContent = isAgent(s) ? "✦ agent" : "$ command";
    kind.title = isAgent(s)
      ? "An agent runs here and drives the machines you tick. Click for a plain command."
      : "A plain command runs here. Click to put an agent here instead.";
    kind.onclick = () => { setKind(s, !isAgent(s)); touched(true); };
    const del = $("button", "fl-n-del", "✕");
    del.title = "Remove this step";
    del.onclick = () => removeStep(s);
    head.append(id, state, kind, del);

    const body = $("div", "fl-n-body");
    const target = document.createElement("select");
    target.title = isAgent(s) ? "where the agent itself runs" : "where this command runs";
    fillTargets(target, s.target);
    target.onchange = () => {
      if (target.selectedOptions[0] && target.selectedOptions[0].dataset.other) {
        const v = prompt("Machine name, id prefix, or share token:", s.target || "");
        fillTargets(target, v || s.target);
        if (!v) return;
        s.target = v;
      } else s.target = target.value;
      if (isAgent(s)) compileAgent(s);
      touched();
    };
    body.append(target);

    if (isAgent(s)) body.append(...agentFields(s));
    else {
      const cmd = document.createElement("textarea");
      cmd.value = s.cmd || "";
      cmd.rows = 2;
      cmd.placeholder = "command to run there";
      cmd.oninput = () => { s.cmd = cmd.value; touched(); };
      body.append(cmd);
    }
    const err = $("div", "fl-n-err");
    body.append(err);

    const foot = $("div", "fl-n-foot");
    const ok = $("span", "fl-port ok");
    const fail = $("span", "fl-port fail");
    ok.dataset.port = "on_success";
    fail.dataset.port = "on_failure";
    foot.append(ok, spacer(), fail);

    const inPort = $("span", "fl-in");
    const stdin = $("span", "fl-stdin");
    stdin.title = "stdin — drop a step's stdout here";
    const stdout = $("span", "fl-port stdout", "stdout ▸");
    stdout.dataset.port = "stdout";

    el.append(head, body, foot, inPort, stdin, stdout);
    el.onmousedown = (e) => { if (!e.target.closest(".fl-port")) selectStep(s.id); };
    makeDraggable(head, () => s.ui, () => renderEdges(), el);
    for (const p of [ok, fail, stdout]) p.addEventListener("mousedown", (e) => startLink(e, s, p.dataset.port));
    // Clicking a wired port clears it — the same gesture in reverse, so nobody
    // has to find a menu to undo a connection they just dragged.
    for (const p of [ok, fail]) p.addEventListener("click", () => {
      if (!s[p.dataset.port]) return;
      delete s[p.dataset.port];
      touched(true);
    });
    stdin.addEventListener("click", () => { if (s.stdin_from) { delete s.stdin_from; touched(true); } });

    paintPorts(el, s, i);
    return el;
  }

  // ---- agent steps: the AI on one node, the machines it drives on others ----
  /**
   * An agent step is an ordinary step. It has a target and a cmd like any other,
   * and `switchboard flow run` needs to know nothing about it — the editor just
   * writes the command for you and keeps the pieces it was built from under
   * `ui`, which the runner and the validator already ignore.
   *
   * That is the whole trick, and it's deliberate. The alternative — teaching the
   * flow format an "agent" kind — would put a second thing the runner has to
   * understand between you and a machine, and the first time the generated
   * command needed a flag the format didn't have, you'd be stuck. Here the
   * command is right there in the file: read it, edit it, run it by hand.
   *
   * What makes it drive *another* machine is `switchboard mcp`, started on the
   * agent's own host. It reaches exactly what that host can reach, under the
   * same grants the dashboard shows — so "which machines may this AI touch?" has
   * one answer, and revoking a share in the browser takes it away here too.
   */
  const AGENT_TOOLS = { claude: "Claude Code", codex: "Codex" };
  const MCP_TOOLS = ["list_machines", "run_on", "upload", "download"].map((t) => "mcp__switchboard__" + t).join(",");

  const isAgent = (s) => !!(s.ui && s.ui.agent);
  const sq = (v) => "'" + String(v).replace(/'/g, `'\\''`) + "'";

  function setKind(s, agent) {
    if (!agent) { if (s.ui) delete s.ui.agent; return; }
    s.ui.agent = s.ui.agent || { tool: "claude", prompt: "", drives: [] };
    compileAgent(s);
  }

  function compileAgent(s) {
    const a = s.ui.agent;
    // The relay this page is served from is the relay the agent should dial:
    // the conductor and the browser are on the same one by construction, and
    // hard-coding the production origin would break every local run.
    const mcp = JSON.stringify({ mcpServers: { switchboard: { command: "switchboard", args: ["mcp", "--server", location.origin] } } });
    const drives = (a.drives || []).filter((d) => d !== s.target);
    // Naming the machines in the prompt rather than trusting the model to go
    // looking: it has list_machines, but a step that says which host it is about
    // is a step you can read back later and know what it was for.
    const prompt = a.prompt + (drives.length
      ? `\n\nWork on ${drives.length > 1 ? "these machines" : "the machine"} ${drives.join(", ")} — use the switchboard MCP tools to reach ${drives.length > 1 ? "them" : "it"} (run_on to run a command there, upload/download for files).`
      : "");
    s.cmd = a.tool === "codex"
      ? `codex exec --skip-git-repo-check -c ${sq("mcp_servers.switchboard.command=switchboard")} ` +
        `-c ${sq('mcp_servers.switchboard.args=["mcp","--server","' + location.origin + '"]')} ${sq(prompt)}`
      : `claude -p ${sq(prompt)} --mcp-config ${sq(mcp)} --allowedTools ${sq(MCP_TOOLS)}`;
  }

  function agentFields(s) {
    const a = s.ui.agent;
    const out = [];

    const tool = document.createElement("select");
    for (const [v, label] of Object.entries(AGENT_TOOLS)) {
      const o = document.createElement("option");
      o.value = v; o.textContent = label;
      tool.append(o);
    }
    tool.value = a.tool || "claude";
    tool.title = "which agent CLI runs on that machine";
    tool.onchange = () => { a.tool = tool.value; compileAgent(s); touched(); };
    out.push(tool);

    const prompt = document.createElement("textarea");
    prompt.value = a.prompt || "";
    prompt.rows = 3;
    prompt.placeholder = "what to ask the agent to do";
    prompt.oninput = () => { a.prompt = prompt.value; compileAgent(s); touched(); };
    out.push(prompt);

    const drives = $("div", "fl-drives");
    drives.append($("span", "fl-drives-label", "may drive"));
    // Only machines other than the one the agent sits on: an agent doesn't need
    // a relay hop to touch its own filesystem, and offering it invites a flow
    // that goes out to the network to talk to itself.
    const others = targets.filter((m) => m.can_exec && (m.name || m.machine_id) !== s.target);
    if (!others.length) drives.append($("span", "muted", "no other machine reachable from there"));
    for (const m of others) {
      const v = m.name || m.machine_id;
      const chip = $("label", "fl-chip" + ((a.drives || []).includes(v) ? " on" : ""));
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = (a.drives || []).includes(v);
      box.onchange = () => {
        a.drives = box.checked ? [...(a.drives || []), v] : (a.drives || []).filter((d) => d !== v);
        compileAgent(s);
        touched(true);
      };
      chip.append(box, document.createTextNode(v));
      drives.append(chip);
    }
    out.push(drives);

    // The generated command, foldable and read-only. Hidden by default because
    // it is long, present at all because a step that runs something you can't
    // see is not a step you can trust on a machine you care about.
    const wrap = document.createElement("details");
    wrap.className = "fl-gen";
    const sum = document.createElement("summary");
    sum.textContent = "command";
    const pre = $("pre", null, s.cmd || "");
    wrap.append(sum, pre);
    out.push(wrap);

    return out;
  }

  function paintPorts(el, s, i) {
    const ok = el.querySelector(".fl-port.ok"), fail = el.querySelector(".fl-port.fail");
    const next = spec.steps[i + 1];
    ok.textContent = "ok ▸ " + (s.on_success || (next ? next.id : "end"));
    ok.classList.toggle("wired", !!s.on_success);
    ok.title = s.on_success ? "goes to " + s.on_success : next ? `falls through to ${next.id} (the next step)` : "nothing follows — the flow ends here";
    fail.textContent = "fail ▸ " + (s.on_failure || "stop");
    fail.classList.toggle("wired", !!s.on_failure);
    fail.title = s.on_failure ? "goes to " + s.on_failure : "unhandled — the flow stops";
    el.classList.toggle("stdin-wired", !!s.stdin_from);
    el.classList.toggle("agent", isAgent(s));
    // The generated command is recomputed on every keystroke in the prompt, and
    // this is the only place that runs for a non-structural edit.
    const gen = el.querySelector(".fl-gen pre");
    if (gen) gen.textContent = s.cmd || "";
    const problem = stepProblem(s, i);
    el.classList.toggle("bad", !!problem);
    el.querySelector(".fl-n-err").textContent = problem || "";
  }

  // Only the run's colours, so this can be called on every event without
  // rebuilding inputs the user might be typing into.
  function renderCanvasState() {
    for (const [id, el] of nodeEls) {
      const st = run ? run.state[id] : null;
      el.classList.toggle("running", st === "running");
      el.classList.toggle("done", st === "done");
      el.classList.toggle("failed", st === "failed" || st === "cancelled");
      el.classList.toggle("sel", id === selected);
      const label = el.querySelector(".fl-n-state");
      label.textContent = !st ? "" :
        st === "running" ? "running…" :
        st === "cancelled" ? "stopped" :
        (st === "done" ? "✓ " : "✗ ") + (run.ms && run.ms[id] != null ? fmtMs(run.ms[id]) : "");
    }
    renderEdges();
    renderBar();
  }
  function fmtMs(ms) { return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s"; }

  // ---- edges -------------------------------------------------------------
  function portPoint(id, kind) {
    const el = nodeEls.get(id);
    const s = stepById(id);
    if (!el || !s) return null;
    const h = el.offsetHeight || 150;
    if (kind === "in") return { x: s.ui.x + NODE_W / 2, y: s.ui.y };
    if (kind === "stdin") return { x: s.ui.x, y: s.ui.y + h / 2 };
    if (kind === "stdout") return { x: s.ui.x + NODE_W, y: s.ui.y + h / 2 };
    const p = el.querySelector(".fl-port." + (kind === "on_success" ? "ok" : "fail"));
    if (!p) return { x: s.ui.x + NODE_W / 2, y: s.ui.y + h };
    return { x: s.ui.x + p.offsetLeft + p.offsetWidth / 2, y: s.ui.y + p.offsetTop + p.offsetHeight };
  }
  function stopPoint() { return { x: spec.ui.stop.x + els.stop.offsetWidth / 2, y: spec.ui.stop.y }; }

  function curveV(a, b) {
    const d = Math.min(Math.max(Math.abs(b.y - a.y) / 2, 34), 90);
    return `M ${a.x} ${a.y} C ${a.x} ${a.y + d}, ${b.x} ${b.y - d}, ${b.x} ${b.y}`;
  }
  function curveH(a, b) {
    const d = Math.min(Math.max(Math.abs(b.x - a.x) / 2, 34), 110);
    return `M ${a.x} ${a.y} C ${a.x + d} ${a.y}, ${b.x - d} ${b.y}, ${b.x} ${b.y}`;
  }

  function renderEdges() {
    els.svg.textContent = "";
    if (!spec) return;
    const add = (d, cls, onClear) => {
      const ns = "http://www.w3.org/2000/svg";
      if (onClear) {
        const hit = document.createElementNS(ns, "path");
        hit.setAttribute("d", d); hit.setAttribute("class", "hit");
        hit.addEventListener("click", onClear);
        const t = document.createElementNS(ns, "title");
        t.textContent = "click to disconnect";
        hit.append(t);
        els.svg.append(hit);
      }
      const p = document.createElementNS(ns, "path");
      p.setAttribute("d", d); p.setAttribute("class", "wire " + cls);
      els.svg.append(p);
    };

    spec.steps.forEach((s, i) => {
      const from = (k) => portPoint(s.id, k);
      const to = (id) => (id === "stop" ? stopPoint() : portPoint(id, "in"));
      const taken = (id) => (run && run.taken.has(s.id + ">" + id) ? " taken" : "");

      if (s.on_success) {
        const b = to(s.on_success);
        if (b) add(curveV(from("on_success"), b), "ok" + taken(s.on_success), () => { delete s.on_success; touched(true); });
      } else {
        // The fall-through. Drawn because the runner will take it, dashed
        // because nobody chose it — an edge you can see is an edge you can
        // notice is wrong.
        const next = spec.steps[i + 1];
        if (next) { const b = to(next.id); if (b) add(curveV(from("on_success"), b), "implicit" + taken(next.id)); }
      }
      if (s.on_failure) {
        const b = to(s.on_failure);
        if (b) add(curveV(from("on_failure"), b), "fail" + taken(s.on_failure), () => { delete s.on_failure; touched(true); });
      }
      if (s.stdin_from) {
        const a = portPoint(s.stdin_from, "stdout"), b = from("stdin");
        if (a && b) add(curveH(a, b), "stdin", () => { delete s.stdin_from; touched(true); });
      }
    });

    if (linking && linking.at) {
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", linking.kind === "stdout" ? curveH(linking.from, linking.at) : curveV(linking.from, linking.at));
      p.setAttribute("class", "ghost");
      els.svg.append(p);
    }
  }

  // ---- editing gestures ---------------------------------------------------
  // `structural` means an id changed or a step came or went, so the nodes have
  // to be rebuilt. Everything else repaints edges and problems only, because a
  // rebuild would take the focus out of the box being typed into.
  function touched(structural) {
    if (structural) renderCanvas();
    else {
      spec.steps.forEach((s, i) => { const el = nodeEls.get(s.id); if (el) paintPorts(el, s, i); });
      renderEdges();
      setProblems(validate(spec));
    }
    if (jsonOpen) els.jsonText.value = JSON.stringify(spec, null, 2);
    renderBar();
    renderRail();
  }

  function addStep(agent) {
    const id = uniqueStepId();
    const last = spec.steps[spec.steps.length - 1];
    // Below the last node's real height rather than a fixed gap: an agent step
    // is twice as tall as a command, and stacking by a constant puts the new
    // step on top of the one it follows.
    const lastEl = last && nodeEls.get(last.id);
    const step = {
      id, target: last ? last.target : (conductor.label || conductor.machineId), cmd: "",
      ui: {
        x: last ? last.ui.x : COL_X,
        y: last ? last.ui.y + Math.max(lastEl ? lastEl.offsetHeight + 34 : 0, ROW_GAP) : ROW_Y,
      },
    };
    spec.steps.push(step);
    // An agent step defaults to driving every other machine its host can reach:
    // that is what you came here to set up, and un-ticking one is a smaller ask
    // than finding out later that the box you meant was never ticked.
    if (agent) {
      setKind(step, true);
      step.ui.agent.drives = targets.filter((m) => m.can_exec && (m.name || m.machine_id) !== step.target)
        .map((m) => m.name || m.machine_id);
      compileAgent(step);
    }
    touched(true);
    selectStep(id);
    const el = nodeEls.get(id);
    if (el) { el.scrollIntoView({ block: "nearest" }); el.querySelector("textarea").focus(); }
  }
  function uniqueStepId() {
    const taken = new Set(spec.steps.map((s) => s.id));
    for (let i = spec.steps.length + 1; ; i++) if (!taken.has("step" + i)) return "step" + i;
  }

  function removeStep(s) {
    const i = spec.steps.indexOf(s);
    if (i < 0) return;
    spec.steps.splice(i, 1);
    // Edges into a step that no longer exists would be a file that can't be
    // saved, so they go with it rather than being left for the validator to
    // complain about something the canvas can no longer show.
    for (const o of spec.steps) {
      for (const k of ["on_success", "on_failure", "stdin_from"]) if (o[k] === s.id) delete o[k];
    }
    if (spec.start === s.id) delete spec.start;
    if (selected === s.id) selected = null;
    touched(true);
    renderDrawer();
  }

  function renameStep(s, next) {
    if (!next || next === s.id) { touched(true); return; }
    if (spec.steps.some((o) => o !== s && o.id === next)) { toast(`Another step is already called “${next}”.`, "err"); touched(true); return; }
    const old = s.id;
    s.id = next;
    for (const o of spec.steps) {
      for (const k of ["on_success", "on_failure", "stdin_from"]) if (o[k] === old) o[k] = next;
    }
    if (spec.start === old) spec.start = next;
    if (selected === old) selected = next;
    touched(true);
  }

  function selectStep(id) {
    selected = id;
    renderCanvasState();
    renderDrawer();
  }

  // Dragging: nodes and the stop chip both just move a {x,y} the caller owns.
  function makeDraggable(handle, getPos, after, raise) {
    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.target.closest("button, input, select, textarea, .fl-port")) return;
      const pos = getPos();
      if (!pos) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY, ox = pos.x, oy = pos.y;
      const el = raise || handle;
      const move = (ev) => {
        pos.x = Math.max(0, ox + ev.clientX - sx);
        pos.y = Math.max(0, oy + ev.clientY - sy);
        el.style.left = pos.x + "px";
        el.style.top = pos.y + "px";
        after();
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        renderBar();
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  }

  function startLink(e, s, kind) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    linking = { step: s, kind, from: portPoint(s.id, kind), at: null };
    els.canvas.classList.add("linking");
  }
  function onLinkMove(e) {
    if (!linking) return;
    const r = els.canvas.getBoundingClientRect();
    linking.at = { x: e.clientX - r.left, y: e.clientY - r.top };
    const over = document.elementFromPoint(e.clientX, e.clientY);
    const node = over && over.closest(".fl-node");
    const stopChip = over && over.closest(".fl-stop");
    for (const el of nodeEls.values()) el.classList.toggle("droppable", el === node && dropOk(linking, node));
    els.stop.classList.toggle("droppable", !!stopChip && linking.kind !== "stdout");
    renderEdges();
  }
  // Takes the link rather than reading the one in flight: the drop handler has
  // to clear that before it can commit anything, and asking afterwards would
  // mean every drop looked like it landed on nothing.
  function dropOk(l, node) {
    if (!l || !node) return false;
    // stdout wires a producer into a consumer, so it may not land on itself; an
    // ok/fail edge back to the same step is a one-step loop, which the runner
    // refuses at run time — better to refuse the gesture than to draw a lie.
    return node.dataset.id !== l.step.id;
  }
  function onLinkDrop(e) {
    if (!linking) return;
    const over = document.elementFromPoint(e.clientX, e.clientY);
    const node = over && over.closest(".fl-node");
    const stopChip = over && over.closest(".fl-stop");
    const l = linking;
    linking = null;
    els.canvas.classList.remove("linking");
    for (const el of nodeEls.values()) el.classList.remove("droppable");
    els.stop.classList.remove("droppable");

    if (stopChip && l.kind !== "stdout") { l.step[l.kind] = "stop"; touched(true); return; }
    if (!node || !dropOk(l, node)) { renderEdges(); return; }
    const id = node.dataset.id;
    if (l.kind === "stdout") {
      const consumer = stepById(id);
      if (consumer) { consumer.stdin_from = l.step.id; touched(true); }
      return;
    }
    l.step[l.kind] = id;
    touched(true);
  }

  function setProblems(list) {
    els.problems.textContent = "";
    els.problems.hidden = !list.length;
    for (const p of list) els.problems.append($("div", null, p));
  }

  // ---- JSON pane ---------------------------------------------------------
  // The canvas can't express everything the format allows — per-step timeouts,
  // a `start` that isn't the first step — and a format with a corner the editor
  // hides is a format people stop trusting the editor with.
  function toggleJson() {
    jsonOpen = !jsonOpen;
    els.json.hidden = !jsonOpen;
    els.wrap.hidden = jsonOpen;
    els.jsonBtn.classList.toggle("primary", jsonOpen);
    if (jsonOpen) { els.jsonText.value = JSON.stringify(spec, null, 2); els.jsonErr.textContent = ""; }
    else renderCanvas();
  }
  function jsonEdited() {
    let next;
    try { next = JSON.parse(els.jsonText.value); }
    catch (e) { els.jsonErr.textContent = e.message; return; }
    els.jsonErr.textContent = "";
    spec = next;
    if (!Array.isArray(spec.steps)) spec.steps = [];
    layout();
    renderBar();
  }

  // ---- drawer ------------------------------------------------------------
  function renderDrawer() {
    const has = !!run;
    els.drawer.hidden = !has;
    if (!has) return;
    els.dTitle.textContent = run.name;
    els.dTabs.textContent = "";
    for (const s of (spec ? spec.steps : [])) {
      const st = run.state[s.id];
      if (!st && !run.out[s.id]) continue;
      const tab = $("div", "fl-d-tab" + (s.id === selected ? " on" : "") + (st === "done" ? " ok" : st === "failed" ? " failed" : ""), s.id);
      tab.onclick = () => selectStep(s.id);
      els.dTabs.append(tab);
    }
    els.dSummary.textContent =
      run.error ? "could not start — " + run.error :
      !run.done ? "running…" :
      run.cancelled ? "stopped" :
      (run.ok ? "finished" : "failed") +
        (run.total != null ? " in " + fmtMs(run.total) : "") +
        (run.failed && run.failed.length ? ` (failed: ${run.failed.join(", ")})` : "");
    renderOut();
  }
  function renderOut() {
    els.out.textContent = "";
    if (run && run.warn) els.out.append(Object.assign($("div", "muted"), { textContent: "⚠ " + run.warn }));
    if (run && run.error) { els.out.append($("div", "e", run.error)); return; }
    if (!selected) { els.out.append($("div", "muted", "Pick a step to see what it printed.")); return; }
    const o = (run && run.out[selected]) || null;
    const code = run && run.code ? run.code[selected] : undefined;
    if (!o || (!o.stdout && !o.stderr)) {
      els.out.append($("div", "muted", run.state[selected] === "running" ? "running — no output yet" : "no output"));
    } else {
      if (o.stdout) els.out.append(document.createTextNode(o.stdout));
      if (o.stderr) els.out.append($("span", "e", o.stderr));
    }
    if (code !== undefined && code !== null) {
      els.out.append($("div", "muted", typeof code === "string" ? `— ${code}` : `— exit ${code}`));
    }
    els.out.scrollTop = els.out.scrollHeight;
  }

  // ---- targets -----------------------------------------------------------
  // Filled from the *conductor's* list, not the browser's: a flow's targets are
  // dialled by the machine that runs it, and on a machine someone shared with
  // you those two lists are not the same set.
  function fillTargets(sel, current) {
    sel.textContent = "";
    const seen = new Set();
    for (const m of targets) {
      const v = m.name || m.machine_id;
      if (seen.has(v)) continue;
      seen.add(v);
      const o = document.createElement("option");
      o.value = v;
      o.textContent = v + (m.owned ? "" : " (shared)") + (m.can_exec ? "" : " — shell only");
      o.disabled = !m.can_exec;
      sel.append(o);
    }
    if (current && !seen.has(current)) {
      const o = document.createElement("option");
      o.value = current;
      o.textContent = current + (targets.length ? " (not reachable from here)" : "");
      sel.prepend(o);
    }
    const other = document.createElement("option");
    other.value = "";
    other.dataset.other = "1";
    other.textContent = "other…";
    sel.append(other);
    sel.value = current || (targets[0] ? targets[0].name || targets[0].machine_id : "");
  }

  window.Flows = { mount, open, leave };
})();
