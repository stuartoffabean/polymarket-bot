module.exports = async (req, res) => {
  res.json([
    { id: "latency_arb", name: "Latency Arb (BTC)", enabled: true, trades: 0, win_rate: 0, pnl: 0 },
    { id: "intra_arb", name: "Intra-Market Arb", enabled: true, trades: 0, win_rate: 0, pnl: 0 }
  ]);
};
