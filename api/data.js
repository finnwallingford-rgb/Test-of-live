// ACE shared live data.
//
// GET  /api/data  -> { url, at } for the newest data an admin saved (or { url: null }).
// POST /api/data  -> an admin's Live Sync / upload saves the gzipped dashboard data here.
//                    Only admin sign-ins are accepted (header x-ace-admin = the admin
//                    password that signed in; checked against the same hashes as the page).
//
// Every page that opens the site loads the newest copy, so an upload on one computer
// reaches everyone who signs in on any computer.
//
// Vercel setup (once): Storage -> create a Blob store (Public) -> connect it to this
// project (that adds BLOB_READ_WRITE_TOKEN). Nothing else to set.
//
// Talks to Vercel Blob with plain HTTPS requests (no npm packages to install or break).

const crypto = require("crypto");

const BLOB_API = "https://blob.vercel-storage.com";
const BLOB_API_VERSION = "9";
const PREFIX = "ace-shared/data-";
const MAX_BYTES = 4400000; // Vercel request body limit is 4.5 MB (the gzipped data is far smaller)

// sha256("ace-admin|" + admin password, exact capitalisation) — the same list as in the dashboard page.
const ADMIN_HASHES = [
  "c5bbed28d6406d0efba843a1765910f781da12c52a53d021af0701dc44c7fa89",
  "ce0b8f1c30cba7cc7550b611759f263d5554fb648a9660822d75e60ea55d737a",
  "9ad8a9ed06a37d5315a5a589f9348c0afdad2836ac7515fb92918e03be3ff8d5",
];
function isAdmin(pw) {
  pw = String(pw || "").trim();
  if (!pw) return false;
  const h = crypto.createHash("sha256").update("ace-admin|" + pw, "utf8").digest("hex");
  return ADMIN_HASHES.includes(h);
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-ace-admin");
  res.setHeader("Cache-Control", "no-store");
}

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

// The storage connection Vercel adds when a Blob store is connected. It's usually called
// BLOB_READ_WRITE_TOKEN, but Vercel lets the name have another prefix (e.g.
// ACE_READ_WRITE_TOKEN), so accept any variable holding a Blob read-write token.
function blobToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string" && v.startsWith("vercel_blob_rw_")) return v;
    if (/READ_WRITE_TOKEN$/.test(k) && v) return v;
  }
  return "";
}

async function blobApi(path, init) {
  const token = blobToken();
  const r = await fetch(BLOB_API + path, {
    ...init,
    headers: {
      authorization: "Bearer " + token,
      "x-api-version": BLOB_API_VERSION,
      ...(init && init.headers),
    },
    signal: AbortSignal.timeout(25000),
  });
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text.slice(0, 300) }; }
  if (!r.ok) {
    const msg = (data && data.error && (data.error.message || data.error.code)) || data.raw || ("status " + r.status);
    throw new Error("storage said: " + msg);
  }
  return data;
}

async function listAll() {
  let cursor = "", all = [];
  for (let i = 0; i < 20; i++) {
    const q = new URLSearchParams({ prefix: PREFIX, limit: "1000" });
    if (cursor) q.set("cursor", cursor);
    const page = await blobApi("?" + q.toString(), { method: "GET" });
    all = all.concat(page.blobs || []);
    if (!page.hasMore || !page.cursor) break;
    cursor = page.cursor;
  }
  all.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  return all;
}

async function readBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;          // already read by the platform
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BYTES) throw Object.assign(new Error("data too large"), { code: 413 });
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

  if (!blobToken()) {
    const seen = Object.keys(process.env).filter((k) => /BLOB|STORAGE|READ_WRITE/i.test(k));
    const noStore = "storage not connected to this deployment: in Vercel open Storage -> your Blob store -> Projects -> connect it to this project (Production ticked), then Deployments -> newest -> Redeploy"
      + (seen.length ? " (storage-related settings found: " + seen.join(", ") + ")" : " (no storage settings found at all)");
    return send(res, req.method === "GET" ? 200 : 500, { url: null, error: noStore });
  }

  if (req.method === "GET") {
    const all = await listAll();
    if (!all.length) return send(res, 200, { url: null });
    return send(res, 200, { url: all[0].url, at: new Date(all[0].uploadedAt).toISOString() });
  }

  if (req.method === "POST") {
    if (!isAdmin(req.headers["x-ace-admin"])) return send(res, 401, { error: "admin sign-in required" });
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, e.code || 400, { error: e.message }); }
    if (body.length > MAX_BYTES) return send(res, 413, { error: "data too large" });
    if (body.length < 20 || body[0] !== 0x1f || body[1] !== 0x8b) return send(res, 400, { error: "expected gzipped data" });
    const at = new Date().toISOString();
    const pathname = PREFIX + at.replace(/[:.]/g, "-") + ".json.gz";
    const put = await blobApi("/?" + new URLSearchParams({ pathname }).toString(), {
      method: "PUT",
      body,
      headers: { "x-content-type": "application/octet-stream", "x-add-random-suffix": "1" },
    });
    // Keep the five newest copies (older ones are only a safety net).
    try {
      const old = (await listAll()).slice(5).map((b) => b.url);
      if (old.length) {
        await blobApi("/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ urls: old }) });
      }
    } catch (e) {}
    return send(res, 200, { ok: true, url: put.url, at });
  }

  return send(res, 405, { error: "method not allowed" });
}

// Never crash without saying why (Vercel only shows FUNCTION_INVOCATION_FAILED).
module.exports = async function (req, res) {
  try {
    await handler(req, res);
  } catch (e) {
    try { cors(res); } catch (x) {}
    if (!res.headersSent) send(res, 500, { url: null, error: String((e && e.message) || e) });
  }
};
