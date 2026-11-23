// Zero-dependency server: static files + /api/config (GET public, POST needs password)
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 3000;
const PW = process.env.ADMIN_PASSWORD || "";
const PUB = path.join(__dirname, "public");
const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const FILE = path.join(DATA, "config.json");
const GH = { token: process.env.GITHUB_TOKEN, repo: process.env.GITHUB_REPO,
  branch: process.env.GITHUB_BRANCH || "main", path: "data/config.json" };
const useGH = !!(GH.token && GH.repo);
let cache = "{}", sha = null;
const MAX = 900000;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".txt": "text/plain" };

const ghUrl = () => `https://api.github.com/repos/${GH.repo}/contents/${GH.path}`;
const ghHead = () => ({ authorization: `Bearer ${GH.token}`, accept: "application/vnd.github+json",
  "user-agent": "dev-mahadi-site", "content-type": "application/json" });

async function ghLoad() {
  const r = await fetch(`${ghUrl()}?ref=${GH.branch}`, { headers: ghHead() });
  if (r.status === 404) return;
  if (!r.ok) throw new Error("GitHub read " + r.status);
  const j = await r.json(); sha = j.sha;
  cache = Buffer.from(j.content, "base64").toString("utf8");
}
async function ghSave(body, retry = true) {
  const r = await fetch(ghUrl(), { method: "PUT", headers: ghHead(), body: JSON.stringify({
    message: "update config [skip render]", branch: GH.branch,
    content: Buffer.from(body).toString("base64"), ...(sha ? { sha } : {}) }) });
  if ((r.status === 409 || r.status === 422) && retry) { await ghLoad(); return ghSave(body, false); }
  if (!r.ok) throw new Error("GitHub write " + r.status);
  sha = (await r.json()).content.sha;
}
async function load() {
  try {
    if (useGH) await ghLoad();
    else if (fs.existsSync(FILE)) cache = fs.readFileSync(FILE, "utf8");
    console.log("config loaded from", useGH ? "GitHub" : "local file");
  } catch (e) { console.error("load failed:", e.message); }
}

const fails = new Map();
function okPass(req) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const f = fails.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 600000) { f.n = 0; f.t = Date.now(); }
  if (f.n >= 10) return null; // locked for a while
  const a = Buffer.from(String(req.headers["x-admin-password"] || ""));
  const b = Buffer.from(PW);
  const ok = PW && a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) { f.n++; fails.set(ip, f); }
  return ok;
}
const send = (res, code, body, type = "application/json") =>
  { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(body); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/config") {
    if (req.method === "GET") return send(res, 200, cache);
    if (req.method === "POST") {
      if (!PW) return send(res, 500, '{"error":"ADMIN_PASSWORD set kora nai"}');
      const ok = okPass(req);
      if (ok === null) return send(res, 429, '{"error":"too many tries"}');
      if (!ok) return send(res, 401, '{"error":"wrong password"}');
      let body = "";
      for await (const c of req) { body += c; if (body.length > MAX) return send(res, 413, '{"error":"too big"}'); }
      try { if (!Array.isArray(JSON.parse(body).items)) throw 0; } catch { return send(res, 400, '{"error":"bad config"}'); }
      try {
        if (useGH) await ghSave(body);
        else { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(FILE, body); }
        cache = body;
        return send(res, 200, '{"ok":true}');
      } catch (e) { console.error(e.message); return send(res, 502, '{"error":"save failed"}'); }
    }
    return send(res, 405, "{}");
  }
  let p = decodeURIComponent(url.pathname); if (p.endsWith("/")) p += "index.html";
  const f = path.normalize(path.join(PUB, p));
  if (!f.startsWith(PUB)) return send(res, 403, "Forbidden", "text/plain");
  fs.readFile(f, (e, d) => {
    if (e) return send(res, 404, "Not found", "text/plain");
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(d);
  });
}).listen(PORT, () => { console.log("running on", PORT); load(); });
