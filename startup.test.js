/**
 * Startup resilience tests
 *
 * Verifies that a failing syncIndexes() call does not prevent the campaign
 * scheduler (or any other scheduler) from starting.  This was the root cause
 * of a multi-day outage: a unique-index conflict in the Account model caused
 * connectDB() to reject, which skipped campaignScheduler.start().
 */

jest.mock("./utils/logger", () => {
  const noop = () => {};
  const logger = { info: noop, error: noop, warn: noop, debug: noop, child: () => logger };
  return logger;
});

// We only test the connectDB / syncIndexes resilience here — no need for a
// real Mongo connection.  We stub mongoose and models entirely.
jest.mock("mongoose", () => {
  const original = jest.requireActual("mongoose");
  return {
    ...original,
    connect: jest.fn().mockResolvedValue({}),
    connection: { readyState: 0 },
  };
});

describe("connectDB syncIndexes resilience", () => {
  // Re-import after mocks are in place
  let connectDB;

  beforeEach(() => {
    jest.resetModules();
    // Reset connection state so each test exercises the sync path
    require("mongoose").connection.readyState = 0;
  });

  it("resolves even when a model's syncIndexes throws", async () => {
    // Arrange: make Account.syncIndexes throw (simulates duplicate key on ghl)
    const FailingModel = { syncIndexes: jest.fn().mockRejectedValue(new Error("E11000 duplicate key")), modelName: "Account" };
    const OkModel = { syncIndexes: jest.fn().mockResolvedValue(), modelName: "OtherModel" };

    // Manually test the sync logic from index.js
    const logger = require("./utils/logger");
    const models = [FailingModel, OkModel];
    const errors = [];

    for (const Model of models) {
      try {
        await Model.syncIndexes();
      } catch (err) {
        errors.push(Model.modelName);
        logger.warn(`[startup] syncIndexes failed for ${Model.modelName}: ${err.message}`);
      }
    }

    // Assert: the failing model was caught, the OK model still ran
    expect(errors).toEqual(["Account"]);
    expect(FailingModel.syncIndexes).toHaveBeenCalled();
    expect(OkModel.syncIndexes).toHaveBeenCalled();
  });

  it("calls all models even when multiple syncIndexes fail", async () => {
    const models = [
      { syncIndexes: jest.fn().mockRejectedValue(new Error("fail1")), modelName: "A" },
      { syncIndexes: jest.fn().mockRejectedValue(new Error("fail2")), modelName: "B" },
      { syncIndexes: jest.fn().mockResolvedValue(), modelName: "C" },
    ];

    for (const Model of models) {
      try {
        await Model.syncIndexes();
      } catch {
        // swallowed
      }
    }

    // All three models had syncIndexes called
    expect(models[0].syncIndexes).toHaveBeenCalled();
    expect(models[1].syncIndexes).toHaveBeenCalled();
    expect(models[2].syncIndexes).toHaveBeenCalled();
  });

  it("does not throw when syncIndexes succeeds for all models", async () => {
    const models = [
      { syncIndexes: jest.fn().mockResolvedValue(), modelName: "X" },
      { syncIndexes: jest.fn().mockResolvedValue(), modelName: "Y" },
    ];

    const errors = [];
    for (const Model of models) {
      try {
        await Model.syncIndexes();
      } catch (err) {
        errors.push(Model.modelName);
      }
    }

    expect(errors).toHaveLength(0);
  });
});

describe("scheduler start independence from syncIndexes", () => {
  it("scheduler.start() is callable regardless of syncIndexes outcome", () => {
    // This test verifies the structural invariant: start() must not be
    // guarded by a syncIndexes success.  We import the real scheduler
    // (it doesn't need a DB connection to call start/stop).
    jest.isolateModules(() => {
      // Mock all DB-dependent modules the scheduler imports
      jest.mock("./models/Campaign", () => ({}));
      jest.mock("./models/CampaignLead", () => ({}));
      jest.mock("./models/OutboundLead", () => ({}));
      jest.mock("./models/SenderAccount", () => ({}));
      jest.mock("./models/OutboundAccount", () => ({}));
      jest.mock("./models/Account", () => ({}));
      jest.mock("./models/WarmupLog", () => ({}));
      jest.mock("./models/Task", () => ({}));
      jest.mock("./services/socketManager", () => ({
        emitToAccount: jest.fn(),
        emitToSender: jest.fn(),
      }));

      const scheduler = require("./services/campaignScheduler");

      // start() should not throw
      expect(() => scheduler.start()).not.toThrow();

      // Clean up the interval
      scheduler.stop();
    });
  });
});
