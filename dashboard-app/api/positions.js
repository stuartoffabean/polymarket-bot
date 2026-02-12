const https = require("https");
const WALLET = "0xe693Ef449979E387C8B4B5071Af9e27a7742E18D";

module.exports = async (req, res) => {
  try {
    const data = await new Promise((resolve) => {
      https.get(`https://data-api.polymarket.com/positions?user=${WALLET}`, r => {
        let d = ""; r.on("data", c => d += c);
        r.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { resolve([]); } });
      }).on("error", () => resolve([]));
    });
    
    const positions = (data || []).map(p => ({
      market: p.title || p.question || "—",
      side: p.outcome?.toLowerCase() || "—",
      size: p.size,
      entry_price: parseFloat(p.avgPrice || 0) * 100,
      current_price: parseFloat(p.curPrice || 0) * 100,
      unrealized_pnl: p.size ? ((parseFloat(p.curPrice || 0) - parseFloat(p.avgPrice || 0)) * p.size) : 0
    }));
    
    res.json(positions);
  } catch(e) { res.json([]); }
};
