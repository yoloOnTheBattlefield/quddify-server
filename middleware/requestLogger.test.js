const { EventEmitter } = require("events");
const requestLogger = require("./requestLogger");

describe("requestLogger middleware", () => {
  it("logs on response finish", (done) => {
    const res = new EventEmitter();
    res.statusCode = 200;
    const req = { id: "req-1", method: "GET", originalUrl: "/api/test" };

    requestLogger(req, res, () => {
      // Simulate response finishing
      res.emit("finish");
      done();
    });
  });

  it("calls next immediately", () => {
    const res = new EventEmitter();
    res.statusCode = 200;
    const req = { id: "req-1", method: "GET", originalUrl: "/" };
    const next = jest.fn();

    requestLogger(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
