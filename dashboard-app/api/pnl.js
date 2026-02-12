module.exports = async (req, res) => {
  // PnL history will be populated as we trade
  // For now return starting point
  const now = new Date().toISOString();
  res.json({
    points: [
      { time: now, value: 0 }
    ]
  });
};
