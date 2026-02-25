function requireOutbound(req, res, next) {
  if (!req.account?.has_outbound) {
    return res.status(403).json({ error: "Outbound is not enabled for this account" });
  }
  next();
}

module.exports = requireOutbound;
