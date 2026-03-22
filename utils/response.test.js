const { ok, created, paginated, deleted } = require("./response");

describe("response helpers", () => {
  let res;

  beforeEach(() => {
    res = {
      json: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
    };
  });

  it("ok() wraps data in { data } envelope", () => {
    ok(res, { id: 1, name: "Test" });
    expect(res.json).toHaveBeenCalledWith({ data: { id: 1, name: "Test" } });
  });

  it("created() sends 201 with data envelope", () => {
    created(res, { id: 2 });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ data: { id: 2 } });
  });

  it("paginated() includes data and meta", () => {
    paginated(res, [1, 2, 3], { page: 1, limit: 10, total: 25 });
    expect(res.json).toHaveBeenCalledWith({
      data: [1, 2, 3],
      meta: { page: 1, limit: 10, total: 25, totalPages: 3 },
    });
  });

  it("deleted() sends standard deletion response", () => {
    deleted(res);
    expect(res.json).toHaveBeenCalledWith({ data: { deleted: true } });
  });
});
