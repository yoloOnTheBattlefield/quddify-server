const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.mock("../services/socketManager", () => ({ emitToAccount: jest.fn(), init: jest.fn() }));
jest.mock("../services/pushNotifications", () => ({ sendPushToAccount: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../services/commentAutomation", () => ({ handleCommentChange: jest.fn() }));

const Account = require("../models/Account");
const Lead = require("../models/Lead");
const IgConversation = require("../models/IgConversation");
const IgMessage = require("../models/IgMessage");
const { processWebhookEvent } = require("./instagram-webhook");

const OWNER_IG = "28171862109129402";
let mongoServer;
let accountId;

function dm({ from, text = "hi", mid, conversationId }) {
  return {
    object: "instagram",
    entry: [
      {
        id: OWNER_IG,
        messaging: [
          {
            sender: { id: from },
            recipient: { id: OWNER_IG },
            timestamp: Date.now(),
            message: { mid, text },
            ...(conversationId ? { zernio_conversation_id: conversationId } : {}),
          },
        ],
      },
    ],
  };
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  const account = await Account.create({ name: "Me", zernio: { ig_user_id: OWNER_IG } });
  accountId = String(account._id);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await Promise.all([Lead.deleteMany({}), IgConversation.deleteMany({}), IgMessage.deleteMany({})]);
});

describe("inbound DM contact bookkeeping", () => {
  it("creates a contact for a new DM sender and links the conversation", async () => {
    await processWebhookEvent(dm({ from: "555", mid: "m1", conversationId: "6af8aa11bb22cc33dd44ee0f" }));

    const lead = await Lead.findOne({ ig_user_id: "555" });
    expect(lead).toBeTruthy();
    expect(lead.account_id).toBe(accountId);
    expect(lead.source).toBe("ig_dm");
    expect(lead.stage).toBe("new");
    expect(lead.last_inbound_at).toBeTruthy();
    expect(lead.zernio_conversation_id).toBe("6af8aa11bb22cc33dd44ee0f");

    const conv = await IgConversation.findOne({ participant_ids: "555" });
    expect(String(conv.lead_id)).toBe(String(lead._id));
    expect(conv.zernio_conversation_id).toBe("6af8aa11bb22cc33dd44ee0f");

    const msg = await IgMessage.findOne({ message_id: "m1" });
    expect(msg.sent_by).toBe("lead");
  });

  it("does not create a second contact on the next message", async () => {
    await processWebhookEvent(dm({ from: "555", mid: "m1" }));
    await processWebhookEvent(dm({ from: "555", mid: "m2" }));
    await processWebhookEvent(dm({ from: "555", mid: "m2" })); // redelivery
    expect(await Lead.countDocuments({ ig_user_id: "555" })).toBe(1);
    expect(await IgMessage.countDocuments({})).toBe(2);
  });

  it("reuses an existing contact found by IG user id", async () => {
    const existing = await Lead.create({ account_id: accountId, ig_username: "known", ig_user_id: "556", stage: "pitched" });
    await processWebhookEvent(dm({ from: "556", mid: "m3" }));
    expect(await Lead.countDocuments({})).toBe(1);
    const lead = await Lead.findById(existing._id);
    expect(lead.stage).toBe("pitched");
    expect(lead.last_inbound_at).toBeTruthy();
  });
});
