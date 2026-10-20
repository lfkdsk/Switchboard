// End-to-end: drive this Windows desktop the way another machine would.
//
// Starts a stand-in relay on localhost, signs the tray app in with a throwaway
// credential, and launches the real Switchboard.exe. The app auto-starts its
// daemon (signed in), the daemon dials the stand-in, and from there every step
// is an `exec` frame — exactly what `switchboard exec <this-pc>` sends:
//
//   1. the daemon runs in the interactive session (not session 0)
//   2. open a window on the desktop
//   3. click into its text box and type into it (real mouse + keyboard input)
//   4. take a screenshot and check the window is really on screen
//   5. click its button; the window reports back what it received
//
// and finally kills Switchboard.exe outright and checks the daemon follows it
// down (its stdin closes) rather than lingering as an orphan.
//
// CI only: it overwrites ~/.switchboard/config.json and HKCU\Software\Switchboard.
//
//   runtime\node.exe scripts\remote-control-test.js <Switchboard.exe> [screenshot.png]
"use strict";
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const appExe = path.resolve(process.argv[2] || path.join(__dirname, "..", "build", "Switchboard", "Switchboard.exe"));
const shotPath = path.resolve(process.argv[3] || path.join(__dirname, "..", "build", "remote-control.png"));
const { WebSocketServer } = require(path.join(path.dirname(appExe), "runtime", "cli", "node_modules", "ws"));

if (process.platform !== "win32") die("Windows only");
if (!process.env.CI) die("refusing to run outside CI: this replaces ~/.switchboard/config.json");

const AGENT = "ci-remote-control-" + crypto.randomBytes(8).toString("hex");
const TYPED = "hello from switchboard";
const CONFIG = path.join(os.homedir(), ".switchboard", "config.json");
const PREFS_KEY = "HKCU\\Software\\Switchboard";

function log(s) { console.log(`[remote-control] ${s}`); }
function die(s) { console.error(`[remote-control] FAIL: ${s}`); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- stand-in relay ------------------------------------------------------
let daemon = null;
let onDaemon = null;
const pending = new Map();

const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
const wss = new WebSocketServer({ server });
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://relay");
  log(`daemon connected: role=${url.searchParams.get("role")} machine=${url.searchParams.get("machine")}` +
    ` platform=${url.searchParams.get("platform")}`);
  if (url.searchParams.get("role") !== "daemon" || req.headers["x-switchboard-agent"] !== AGENT) {
    die("the daemon did not come up signed in with the test credential");
  }
  daemon = ws;
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const text = data.toString("utf8");
    if (text === "ping") { ws.send("pong"); return; } // keep the link-liveness check happy
    let m;
    try { m = JSON.parse(text); } catch { return; }
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === "exec-out") p.out.push(Buffer.from(m.data, "base64"));
    else if (m.type === "exec-err") p.err.push(Buffer.from(m.data, "base64"));
    else if (m.type === "exec-exit") {
      pending.delete(m.id);
      clearTimeout(p.timer);
      p.resolve({
        code: m.code,
        error: m.error,
        out: Buffer.concat(p.out).toString("utf8").trim(),
        err: Buffer.concat(p.err).toString("utf8").trim(),
      });
    }
  });
  ws.on("close", () => { if (daemon === ws) daemon = null; });
  if (onDaemon) onDaemon();
});

// One PowerShell script, sent the way a peer sends any command. It travels
// base64-encoded so no quoting survives or breaks on the way through
// node → powershell -Command.
function ps(script, timeoutMs = 60000) {
  const b64 = Buffer.from(script, "utf8").toString("base64");
  const cmd = `$ErrorActionPreference='Stop'; Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`;
  return new Promise((resolve, reject) => {
    if (!daemon) return reject(new Error("daemon is not connected"));
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, out: [], err: [], timer });
    daemon.send(JSON.stringify({ type: "exec", id, cmd, stdin: false, login: false }));
  });
}

async function step(name, script, timeoutMs) {
  const r = await ps(script, timeoutMs);
  if (r.code !== 0) {
    die(`${name}: exit ${r.code}${r.error ? ` (${r.error})` : ""}\n${r.out}\n${r.err}`);
  }
  return r.out;
}

// ---- the window we drive -------------------------------------------------
// A plain WinForms window: a text box, a button that reports the text and
// closes, and a loud background colour the screenshot can look for. It writes
// its controls' screen rectangles out once shown, so the clicks land on them
// whatever the desktop layout or scaling.
const TARGET = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$dir = Join-Path $env:TEMP 'switchboard-rc'
$f = New-Object Windows.Forms.Form
$f.Text = 'Switchboard remote-control target'
$f.StartPosition = 'Manual'
$f.Location = New-Object Drawing.Point 80, 80
$f.ClientSize = New-Object Drawing.Size 520, 260
$f.BackColor = [Drawing.Color]::FromArgb(255, 0, 170)
$f.TopMost = $true
$t = New-Object Windows.Forms.TextBox
$t.Location = New-Object Drawing.Point 20, 20
$t.Width = 480
$b = New-Object Windows.Forms.Button
$b.Text = 'Submit'
$b.Location = New-Object Drawing.Point 20, 70
$b.Size = New-Object Drawing.Size 160, 50
$b.BackColor = [Drawing.SystemColors]::Control
$b.Add_Click({ [IO.File]::WriteAllText((Join-Path $dir 'result.txt'), $t.Text); $f.Close() })
$f.Controls.AddRange(@($t, $b))
$f.Add_Shown({
  $f.Activate()
  $rect = { param($c, $w, $h) $p = $c.PointToScreen([Drawing.Point]::Empty); @{ x = $p.X; y = $p.Y; w = $w; h = $h } }
  $layout = @{
    text = & $rect $t $t.Width $t.Height
    button = & $rect $b $b.Width $b.Height
    form = & $rect $f $f.ClientSize.Width $f.ClientSize.Height
  }
  [IO.File]::WriteAllText((Join-Path $dir 'layout.json'), ($layout | ConvertTo-Json -Compress))
})
[Windows.Forms.Application]::Run($f)
`;

const MOUSE = `
Add-Type -AssemblyName System.Windows.Forms
if (-not ('SbMouse' -as [type])) {
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SbMouse {
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); // left down
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); // left up
  }
}
'@
}
`;

const center = (r) => [Math.round(r.x + r.w / 2), Math.round(r.y + r.h / 2)];

// ---- run -----------------------------------------------------------------
let app = null;

async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const relay = `http://127.0.0.1:${server.address().port}`;
  log(`stand-in relay on ${relay}`);

  // Sign the app in and point it at the stand-in: the same two things a user
  // does with Sign in… and Settings → Relay.
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify({
    server: relay, agentToken: AGENT, login: "ci", machineId: crypto.randomUUID(),
  }, null, 2));
  const reg = spawnSync("reg.exe", ["add", PREFS_KEY, "/v", "Server", "/t", "REG_SZ", "/d", relay, "/f"]);
  if (reg.status !== 0) die("could not write the relay preference");

  const connected = new Promise((r) => { onDaemon = r; });
  app = spawn(appExe, [], { stdio: "ignore" });
  log(`launched ${appExe} (pid ${app.pid})`);
  await Promise.race([connected, sleep(60000).then(() => die("the tray app's daemon never reached the relay"))]);

  const who = await step("session", "'{0} {1} {2}' -f [Environment]::UserInteractive, (Get-Process -Id $PID).SessionId, $env:USERNAME");
  log(`exec runs as: interactive=${who.split(" ")[0]} session=${who.split(" ")[1]} user=${who.split(" ")[2]}`);
  if (who.split(" ")[1] === "0") die("exec runs in session 0, which has no desktop to drive");

  await step("prepare", `$d = Join-Path $env:TEMP 'switchboard-rc'; Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue; New-Item -ItemType Directory $d | Out-Null`);

  const encoded = Buffer.from(TARGET, "utf16le").toString("base64");
  await step("open window", `Start-Process powershell.exe -ArgumentList '-NoProfile','-STA','-EncodedCommand','${encoded}'`);
  const layoutJson = await step("wait for window", `
$f = Join-Path $env:TEMP 'switchboard-rc\\layout.json'
for ($i = 0; $i -lt 120; $i++) { if (Test-Path $f) { Get-Content $f -Raw; exit 0 }; Start-Sleep -Milliseconds 250 }
exit 1`);
  const layout = JSON.parse(layoutJson);
  log(`window is up: client area at ${layout.form.x},${layout.form.y} (${layout.form.w}x${layout.form.h})`);

  const [tx, ty] = center(layout.text);
  await step("click + type", `${MOUSE}
[SbMouse]::Click(${tx}, ${ty})
Start-Sleep -Milliseconds 400
[Windows.Forms.SendKeys]::SendWait('${TYPED}')
Start-Sleep -Milliseconds 400`);
  log(`clicked the text box at ${tx},${ty} and typed "${TYPED}"`);

  // A spot of bare window background, well clear of the controls.
  const px = layout.form.x + layout.form.w - 40;
  const py = layout.form.y + layout.form.h - 40;
  const shot = await step("screenshot", `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$v = [Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object Drawing.Bitmap $v.Width, $v.Height
$g = [Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($v.Left, $v.Top, 0, 0, $bmp.Size)
$c = $bmp.GetPixel(${px} - $v.Left, ${py} - $v.Top)
$ms = New-Object IO.MemoryStream
$bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
'{0},{1},{2}' -f $c.R, $c.G, $c.B
[Convert]::ToBase64String($ms.ToArray())`);
  const [pixel, png] = shot.split(/\r?\n/);
  fs.mkdirSync(path.dirname(shotPath), { recursive: true });
  fs.writeFileSync(shotPath, Buffer.from(png, "base64"));
  log(`screenshot saved to ${shotPath}; pixel at ${px},${py} is rgb(${pixel})`);
  const [r, g, b] = pixel.split(",").map(Number);
  if (!(r > 200 && g < 60 && b > 120)) die(`the window is not visible in the screenshot (expected magenta, got rgb(${pixel}))`);

  const [bx, by] = center(layout.button);
  await step("click button", `${MOUSE}
[SbMouse]::Click(${bx}, ${by})`);
  const got = await step("read result", `
$f = Join-Path $env:TEMP 'switchboard-rc\\result.txt'
for ($i = 0; $i -lt 80; $i++) { if (Test-Path $f) { Get-Content $f -Raw; exit 0 }; Start-Sleep -Milliseconds 250 }
exit 1`);
  log(`clicked Submit at ${bx},${by}; the window received "${got}"`);
  if (got !== TYPED) die(`typed "${TYPED}" but the window received "${got}"`);

  // The app dies without a word: the daemon must notice and go too.
  const rec = readDaemons().find((d) => d.launcher === "app");
  if (!rec) die("no daemon on record for the tray app");
  log(`killing Switchboard.exe; its daemon is pid ${rec.pid}`);
  app.kill();
  for (let i = 0; i < 40 && alive(rec.pid); i++) await sleep(250);
  if (alive(rec.pid)) die(`daemon pid ${rec.pid} outlived the tray app by 10s`);
  log("daemon exited with the tray app");

  log("PASS");
}

function readDaemons() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".switchboard", "daemons.json"), "utf8")).daemons || []; }
  catch { return []; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function cleanup() {
  try { if (app && app.exitCode === null) app.kill(); } catch {}
  try { fs.rmSync(CONFIG, { force: true }); } catch {}
  spawnSync("reg.exe", ["delete", PREFS_KEY, "/v", "Server", "/f"]);
}

process.on("exit", cleanup);
main().then(() => process.exit(0), (e) => die(e.stack || e.message));
