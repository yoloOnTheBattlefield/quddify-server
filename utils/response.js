/**
 * Standardized API response helpers.
 *
 * Usage in routes/controllers:
 *   const { ok, paginated, created } = require("../utils/response");
 *   return ok(res, lead);
 *   return paginated(res, leads, { page, limit, total });
 *   return created(res, newLead);
 */

function ok(res, data) {
  return res.json({ data });
}

function created(res, data) {
  return res.status(201).json({ data });
}

function paginated(res, data, { page, limit, total }) {
  return res.json({
    data,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
}

function deleted(res) {
  return res.json({ data: { deleted: true } });
}

module.exports = { ok, created, paginated, deleted };
