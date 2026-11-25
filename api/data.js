// ACE shared live data.
//
// GET  /api/data  -> { url, at } for the newest data an admin synced (or { url: null }).
// POST /api/data  -> an admin's Live Sync / upload saves the gzipped dashboard data here.
//                    Only admin sign-ins are accepted (header x-ace-admin = the admin
//                    password that signed in; checked against the same hashes as the page).
//
// Every page that opens the site loads the newest copy, so a sync on one computer
// reaches everyone who signs in on any computer.
//
// Vercel setup (once): Storage -> create a Blob store -> connect it to this project
// (that adds BLOB_READ_WRITE_TOKEN). Nothing else to set.

const crypto = require("crypto");
const PREFIX = "ace-shared/data-";
// sha256("ace-admin|" + lower-case admin password) — the same list as in the dashboard page.
const ADMIN_HASHES = [
  "7ad26e0eca017fc82cdb462f384f3c5952a4cdef24f6b6d7f6217817c188c0c7",
  "157ce237f9dd8d658cb5f2ff8754d0d93ed3b86354ce1d9d56070bca35438563",
  "85bae39ee60efea570ba83e18a74f63d0456b2070186902e557a2469b319bef7",
];
function isAdmin(pw) {
  pw = String(pw || "").trim().toLowerCase();
  if (!pw) return false;
  const h = crypto.createHash("sha256").update("ace-admin|" + pw, "utf8").digest("hex");
  return ADMIN_HASHES.includes(h);
}
const MAX_BYTES = 4400000; // Vercel request body limit is 4.5 MB (the gzipped data is far smaller)

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-ace-admin");
  res.setHeader("Cache-Control", "no-store");
}

async function newest(blob) {
  let cursor, all = [];
  do {
    const page = await blob.list({ prefix: PREFIX, cursor, limit: 1000 });
    all = all.concat(page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  all.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  return all;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  const blob = await import("@vercel/blob");

  if (req.method === "GET") {
    try {
      const all = await newest(blob);
      if (!all.length) return res.status(200).json({ url: null });
      return res.status(200).json({ url: all[0].url, at: new Date(all[0].uploadedAt).toISOString() });
    } catch (e) {
      return res.status(200).json({ url: null, error: "storage not set up" });
    }
  }

  if (req.method === "POST") {
    if (!isAdmin(req.headers["x-ace-admin"])) return res.status(401).json({ error: "admin sign-in required" });
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BYTES) return res.status(413).json({ error: "data too large" });
      chunks.push(c);
    }
    const body = Buffer.concat(chunks);
    if (body.length < 20 || body[0] !== 0x1f || body[1] !== 0x8b) return res.status(400).json({ error: "expected gzipped data" });
    try {
      const at = new Date().toISOString();
      const r = await blob.put(PREFIX + at.replace(/[:.]/g, "-") + ".json.gz", body, {
        access: "public", addRandomSuffix: true, contentType: "application/octet-stream",
      });
      // Keep the five newest copies (older ones are only a safety net).
      try {
        const all = await newest(blob);
        const old = all.slice(5).map((b) => b.url);
        if (old.length) await blob.del(old);
      } catch (e) {}
      return res.status(200).json({ ok: true, url: r.url, at });
    } catch (e) {
      return res.status(500).json({ error: "could not store the data: " + (e && e.message || e) });
    }
  }

  return res.status(405).json({ error: "method not allowed" });
};
