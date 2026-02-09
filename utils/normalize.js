function toNumber(x) {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(String(x).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function toDate(x) {
  if (!x) return null;
  const d = new Date(x);
  return isNaN(d.getTime()) ? null : d;
}

function toBoolean(x) {
  if (typeof x === "boolean") return x;
  if (x === null || x === undefined) return null;
  const s = String(x).trim().toLowerCase();
  if (s === "yes" || s === "true" || s === "y" || s === "1") return true;
  if (s === "no" || s === "false" || s === "n" || s === "0") return false;
  return null;
}

module.exports = { toNumber, toDate, toBoolean };
