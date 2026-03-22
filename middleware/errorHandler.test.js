const errorHandler = require("./errorHandler");

describe("errorHandler middleware", () => {
  let req, res, next;

  beforeEach(() => {
    req = { id: "req-1", method: "GET", originalUrl: "/test" };
    res = {
      headersSent: false,
      statusCode: 200,
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
  });

  it("sends 500 with generic message for unknown errors", () => {
    const err = new Error("DB connection lost");
    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
  });

  it("sends custom status when error has status property", () => {
    const err = new Error("Not found");
    err.status = 404;
    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "Not found" });
  });

  it("sends custom status when error has statusCode property", () => {
    const err = new Error("Bad input");
    err.statusCode = 400;
    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Bad input" });
  });

  it("delegates to Express when headers already sent", () => {
    res.headersSent = true;
    const err = new Error("Oops");
    errorHandler(err, req, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("hides internal error message for 5xx errors", () => {
    const err = new Error("Sensitive DB details");
    errorHandler(err, req, res, next);

    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
  });
});
