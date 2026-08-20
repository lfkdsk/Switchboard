/**
 * Sessions + GitHub identity for Switchboard.
 *
 * Browser auth reuses the shared lfkdsk-auth broker (GitHub OAuth at
 * auth.lfkdsk.org). After the broker hands the frontend a GitHub token, the
 * frontend POSTs it to /auth/session; we verify it against GitHub's /user API
 * and mint an HMAC-signed session cookie scoped to this origin.
 */

const COOKIE = "sb_session";
const SESSION_TTL = 7 * 24 * 3600; // seconds
const GITHUB_CLIENT_ID = "Ov23liCg29llKxJ7b0jv"; // public; same OAuth app as lfkdsk-auth
const AUTH_CALLBACK = "https://auth.lfkdsk.org/shell/callback";

const enc = new TextEncoder();
const dec = new TextDecoder();

export function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function b64url(bytes) {
  let s = "";
  const a = new Uint8Array(bytes);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlBytes(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret || "dev-secret"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signSession(payload, secret) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return body + "." + b64url(sig);
}
export async function verifySession(token, secret) {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), b64urlBytes(sig), enc.encode(body));
  if (!ok) return null;
  let p;
  try { p = JSON.parse(dec.decode(b64urlBytes(body))); } catch { return null; }
  if (!p.exp || p.exp < Math.floor(Date.now() / 1000)) return null;
  return p; // { id, login, exp }
}

function getCookie(request, name) {
  const h = request.headers.get("Cookie") || "";
  for (const part of h.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}
export function getSession(request, env) {
  return verifySession(getCookie(request, COOKIE), env.SESSION_SECRET);
}
function sessionCookie(token) {
  return [`${COOKIE}=${token}`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax", `Max-Age=${SESSION_TTL}`].join("; ");
}
function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function githubUser(token) {
  if (!token) return null;
  let r;
  try {
    r = await fetch("https://api.github.com/user", {
      headers: {
        authorization: "Bearer " + token,
        "user-agent": "switchboard",
        accept: "application/vnd.github+json",
      },
    });
  } catch { return null; }
  if (!r.ok) return null;
  const u = await r.json();
  if (!u || u.id == null) return null;
  return { id: String(u.id), login: u.login };
}

// GET /auth/login → bounce to GitHub authorize (via the lfkdsk-auth callback).
export function handleLogin(url) {
  const state = url.searchParams.get("state") || "";
  const auth = new URL("https://github.com/login/oauth/authorize");
  auth.searchParams.set("client_id", GITHUB_CLIENT_ID);
  auth.searchParams.set("redirect_uri", AUTH_CALLBACK);
  auth.searchParams.set("scope", "read:user");
  if (state) auth.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { Location: auth.toString() } });
}

// POST /auth/session { github_token } → verify + set cookie.
export async function handleSession(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const gh = await githubUser(body.github_token);
  if (!gh) return json({ error: "invalid github token" }, 401);
  const token = await signSession(
    { id: gh.id, login: gh.login, exp: Math.floor(Date.now() / 1000) + SESSION_TTL },
    env.SESSION_SECRET,
  );
  return json({ id: gh.id, login: gh.login }, 200, { "set-cookie": sessionCookie(token) });
}

export function handleLogout() {
  return json({ ok: true }, 200, { "set-cookie": clearCookie() });
}
