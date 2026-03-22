const { ZodError } = require("zod");

function validate(schema) {
  return (req, res, next) => {
    try {
      const parsed = schema.parse({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      // Replace with parsed values so .strip() actually removes unknown keys
      req.body = parsed.body;
      req.query = parsed.query;
      req.params = parsed.params;
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({
          error: "Validation failed",
          details: err.issues.map((e) => ({
            path: e.path.join("."),
            message: e.message,
          })),
        });
      }
      next(err);
    }
  };
}

module.exports = validate;
