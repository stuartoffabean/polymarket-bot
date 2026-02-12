const https = require("https");
const WALLET = "0xe693Ef449979E387C8B4B5071Af9e27a7742E18D";

function rpc(method, params) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 });
    const req = https.request("https://1rpc.io/matic", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": data.length } }, (res) => {
      let body = ""; res.on("data", c => body += c);
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch(e) { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.write(data); req.end();
  });
}

module.exports = async (req, res) => {
  const usdceCall = await rpc("eth_call", [{ to: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", data: "0x70a08231000000000000000000000000" + WALLET.slice(2).toLowerCase() }, "latest"]);
  const usdce = parseInt(usdceCall?.result || "0", 16) / 1e6;
  const polCall = await rpc("eth_getBalance", [WALLET, "latest"]);
  const pol = parseInt(polCall?.result || "0", 16) / 1e18;
  res.json({ usdce, pol });
};
