const https = require("https");
const crypto = require("crypto");

const API_KEY = "5b2d03d4-0cdb-fe2b-108f-7c1414b93896";
const API_SECRET = "6c9tIFvxHhjaLrzY8X3RINw35XVD2GaUZdfS4UnR7IY=";
const API_PASSPHRASE = "f08e275c7d5f3b8ceeed4af9f981c85c0fb4f7fe686a53c2fb1a68205a0d1e18";
const MAKER = "0xe693Ef449979E387C8B4B5071Af9e27a7742E18D";

function buildHmac(secret, timestamp, method, requestPath) {
  const message = timestamp + method + requestPath;
  const keyBuf = Buffer.from(secret, "base64");
  const hmac = crypto.createHmac("sha256", keyBuf);
  hmac.update(message);
  // URL-safe base64: + -> -, / -> _
  return hmac.digest("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

module.exports = async (req, res) => {
  try {
    const ts = Math.floor(Date.now() / 1000).toString();
    const requestPath = "/data/orders";
    const sig = buildHmac(API_SECRET, ts, "GET", requestPath);

    const headers = {
      POLY_ADDRESS: MAKER,
      POLY_API_KEY: API_KEY,
      POLY_SIGNATURE: sig,
      POLY_TIMESTAMP: ts,
      POLY_PASSPHRASE: API_PASSPHRASE,
    };

    const data = await new Promise((resolve) => {
      const opts = {
        hostname: "clob.polymarket.com",
        path: requestPath,
        method: "GET",
        headers,
      };
      const r = https.request(opts, (resp) => {
        let d = "";
        resp.on("data", (c) => (d += c));
        resp.on("end", () => {
          try { resolve(JSON.parse(d)); } catch (e) { resolve({ data: [] }); }
        });
      });
      r.on("error", () => resolve({ data: [] }));
      r.end();
    });

    const raw = Array.isArray(data) ? data : (data?.data || data?.orders || []);
    const orders = raw.map((o) => ({
      id: (o.id || "").slice(0, 16) + "...",
      market: (o.market || o.asset_id || "").slice(0, 12) + "...",
      side: (o.side || "").toLowerCase(),
      price: parseFloat(o.price || 0) * 100,
      size: parseFloat(o.original_size || o.size || 0),
      filled: parseFloat(o.size_matched || 0),
      status: o.status,
      outcome: o.outcome || "—",
    }));

    res.json(orders);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
