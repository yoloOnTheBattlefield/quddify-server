const { ZodError } = require("zod");

function validate(schema) {
  return (req, res, next) => {
    try {
      schema.parse({
        body: req.body,
        query: req.query,
        params: req.params,
      });
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
