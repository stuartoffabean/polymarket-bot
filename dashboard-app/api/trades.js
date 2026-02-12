const https = require("https");
const WALLET = "0xe693Ef449979E387C8B4B5071Af9e27a7742E18D";

module.exports = async (req, res) => {
  try {
    const data = await new Promise((resolve) => {
      https.get(`https://data-api.polymarket.com/activity?user=${WALLET}&limit=50`, r => {
        let d = ""; r.on("data", c => d += c);
        r.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { resolve([]); } });
      }).on("error", () => resolve([]));
    });
    
    const trades = (data || []).map(t => ({
      time: t.timestamp,
      market: t.title || t.question || "—",
      side: t.side || t.type || "—",
      price: t.price,
      size: t.size || t.amount,
      pnl: null
    }));
    
    res.json(trades);
  } catch(e) { res.json([]); }
};
