const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const Lead = require("../models/Lead");
const OutboundLead = require("../models/OutboundLead");
const Account = require("../models/Account");
const ghlWebhookRouter = require("./ghl-webhook");

let mongoServer;
let app;
let account;
const ghl = "ghl_test_loc";

// Mock fetch for Telegram calls
const mockFetch = jest.fn(() => Promise.resolve({ ok: true }));
global.fetch = mockFetch;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  account = await Account.create({
    ghl,
    telegram_bot_token: "enc_token",
    telegram_chat_id: "-100123",
  });

  app = express();
  app.use(express.json());
  app.use("/api/ghl", ghlWebhookRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await Lead.deleteMany({});
  await OutboundLead.deleteMany({});
  mockFetch.mockClear();
});

describe("POST /api/ghl/webhook", () => {
  it("returns 400 when contact_id is missing", async () => {
    const res = await request(app)
      .post("/api/ghl/webhook")
      .send({ location: { id: ghl } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contact_id/i);
  });

  it("returns 400 when location.id is missing", async () => {
    const res = await request(app)
      .post("/api/ghl/webhook")
      .send({ contact_id: "c1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/location/i);
  });

  it("creates a new lead when contact_id not found", async () => {
    const res = await request(app)
      .post("/api/ghl/webhook")
      .send({
        first_name: "John",
        last_name: "Doe",
        contact_id: "ghl_c1",
        date_created: "2026-03-25",
        location: { id: ghl },
      });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe("created");

    const lead = await Lead.findOne({ contact_id: "ghl_c1" });
    expect(lead).toBeTruthy();
    expect(lead.first_name).toBe("John");
    expect(lead.account_id).toBe(account._id.toString());
  });

  it("fires Telegram notification on new lead", async () => {
    await request(app)
      .post("/api/ghl/webhook")
      .send({
        first_name: "Jane",
        contact_id: "ghl_c2",
        date_created: "2026-03-25",
        location: { id: ghl },
      });

    // Telegram sendMessage should have been called
    expect(mockFetch).toHaveBeenCalled();
    const call = mockFetch.mock.calls.find((c) => c[0].includes("telegram"));
    expect(call).toBeTruthy();
  });

  it("updates existing lead with tag", async () => {
    await Lead.create({
      contact_id: "ghl_c3",
      account_id: ghl,
      first_name: "Existing",
      date_created: "2026-03-20",
    });

    const res = await request(app)
      .post("/api/ghl/webhook")
      .send({
        contact_id: "ghl_c3",
        location: { id: ghl },
        tags: "link_sent",
      });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe("updated");
    expect(res.body.field).toBe("link_sent_at");

    const lead = await Lead.findOne({ contact_id: "ghl_c3" });
    expect(lead.link_sent_at).toBeTruthy();
  });

  it("does not overwrite existing field", async () => {
    await Lead.create({
      contact_id: "ghl_c4",
      account_id: ghl,
      first_name: "Already",
      date_created: "2026-03-20",
      link_sent_at: new Date("2026-03-01"),
    });

    const res = await request(app)
      .post("/api/ghl/webhook")
      .send({
        contact_id: "ghl_c4",
        location: { id: ghl },
        tags: "link_sent",
      });

    expect(res.body.action).toBe("already_set");
  });

  it("handles comma-separated tags string", async () => {
    await Lead.create({
      contact_id: "ghl_c5",
      account_id: ghl,
      first_name: "Tags",
      date_created: "2026-03-20",
    });

    const res = await request(app)
      .post("/api/ghl/webhook")
      .send({
        contact_id: "ghl_c5",
        location: { id: ghl },
        tags: "some_tag, lead_booked",
      });

    expect(res.body.action).toBe("updated");
    expect(res.body.field).toBe("booked_at");
  });

  it("ignores untracked tags", async () => {
    await Lead.create({
      contact_id: "ghl_c6",
      account_id: ghl,
      first_name: "Unknown",
      date_created: "2026-03-20",
    });

    const res = await request(app)
      .post("/api/ghl/webhook")
      .send({
        contact_id: "ghl_c6",
        location: { id: ghl },
        tags: "random_tag",
      });

    expect(res.body.action).toBe("tag_not_tracked");
  });

  it("returns no_tags when no tags present", async () => {
    await Lead.create({
      contact_id: "ghl_c7",
      account_id: ghl,
      first_name: "NoTags",
      date_created: "2026-03-20",
    });

    const res = await request(app)
      .post("/api/ghl/webhook")
      .send({
        contact_id: "ghl_c7",
        location: { id: ghl },
      });

    expect(res.body.action).toBe("no_tags");
  });

  it("sets source to ghl on new leads", async () => {
    const res = await request(app)
      .post("/api/ghl/webhook")
      .send({
        first_name: "Source",
        contact_id: "ghl_src",
        location: { id: ghl },
      });

    expect(res.body.action).toBe("created");
    const lead = await Lead.findOne({ contact_id: "ghl_src" });
    expect(lead.source).toBe("ghl");
  });

  it("links new lead to outbound lead by full name (partial match)", async () => {
    await OutboundLead.create({
      account_id: account._id,
      username: "romolo_ig",
      fullName: "Romolo Marini | Dubai | Immobilienexperte",
      followingKey: "romolo_ig::scrape",
    });

    const res = await request(app)
      .post("/api/ghl/webhook")
      .send({
        first_name: "Romolo",
        last_name: "Marini",
        contact_id: "ghl_cross1",
        location: { id: ghl },
      });

    expect(res.body.action).toBe("created");
    expect(res.body.cross_channel).toBe(true);

    const lead = await Lead.findOne({ contact_id: "ghl_cross1" });
    expect(lead.outbound_lead_id).toBeTruthy();
  });

  it("links new lead to outbound lead by email", async () => {
    await OutboundLead.create({
      account_id: account._id,
      username: "jane_ig",
      email: "jane@example.com",
      followingKey: "jane_ig::scrape",
    });

    const res = await request(app)
      .post("/api/ghl/webhook")
      .send({
        first_name: "Jane",
        contact_id: "ghl_cross2",
        email: "jane@example.com",
        location: { id: ghl },
      });

    expect(res.body.cross_channel).toBe(true);
    const lead = await Lead.findOne({ contact_id: "ghl_cross2" });
    expect(lead.outbound_lead_id).toBeTruthy();
  });

  it("links existing lead to outbound on tag update", async () => {
    const ob = await OutboundLead.create({
      account_id: account._id,
      username: "existing_ob",
      fullName: "Already Here",
      followingKey: "existing_ob::scrape",
    });

    await Lead.create({
      contact_id: "ghl_cross3",
      account_id: ghl,
      first_name: "Already",
      last_name: "Here",
      date_created: "2026-03-20",
    });

    await request(app)
      .post("/api/ghl/webhook")
      .send({
        contact_id: "ghl_cross3",
        location: { id: ghl },
        tags: "link_sent",
      });

    const lead = await Lead.findOne({ contact_id: "ghl_cross3" });
    expect(lead.outbound_lead_id.toString()).toBe(ob._id.toString());
    expect(lead.link_sent_at).toBeTruthy();
  });

  it("links new lead by first_name matching outbound username (GHL sends IG handle as first_name)", async () => {
    await OutboundLead.create({
      account_id: account._id,
      username: "floraszivos",
      fullName: "FLORA | Manifestation & Mindset",
      followingKey: "floraszivos::scrape",
    });

    const res = await request(app)
      .post("/api/ghl/webhook")
      .send({
        first_name: "floraszivos",
        last_name: "| Manifestation & Mindset",
        contact_id: "ghl_username_match",
        location: { id: ghl },
      });

    expect(res.body.action).toBe("created");
    expect(res.body.cross_channel).toBe(true);

    const lead = await Lead.findOne({ contact_id: "ghl_username_match" });
    expect(lead.outbound_lead_id).toBeTruthy();
  });

  it("username match is case-insensitive", async () => {
    await OutboundLead.create({
      account_id: account._id,
      username: "SomeCamelCase",
      fullName: "Some User",
      followingKey: "SomeCamelCase::scrape",
    });

    const res = await request(app)
      .post("/api/ghl/webhook")
      .send({
        first_name: "somecamelcase",
        contact_id: "ghl_case_match",
        location: { id: ghl },
      });

    expect(res.body.cross_channel).toBe(true);
  });

  it("username match is exact (does not partial match)", async () => {
    await OutboundLead.create({
      account_id: account._id,
      username: "john_doe_fitness",
      fullName: "John Doe",
      followingKey: "john_doe_fitness::scrape",
    });

    // first_name "john" should NOT match username "john_doe_fitness"
    const res = await request(app)
      .post("/api/ghl/webhook")
      .send({
        first_name: "john",
        last_name: "Doe",
        contact_id: "ghl_no_partial",
        location: { id: ghl },
      });

    // Should still link via fullName partial match though
    const lead = await Lead.findOne({ contact_id: "ghl_no_partial" });
    expect(lead.outbound_lead_id).toBeTruthy(); // matches on fullName "John Doe"
  });

  it("prefers username match over name match", async () => {
    // Two outbound leads — one matches by username, one by name
    const obByUsername = await OutboundLead.create({
      account_id: account._id,
      username: "drillsthenics",
      fullName: "Drills Fitness",
      followingKey: "drillsthenics::scrape",
    });

    await OutboundLead.create({
      account_id: account._id,
      username: "other_user",
      fullName: "Drillsthenics | Learn Calisthenics",
      followingKey: "other_user::scrape",
    });

    const res = await request(app)
      .post("/api/ghl/webhook")
      .send({
        first_name: "Drillsthenics",
        last_name: "| Learn Calisthenics",
        contact_id: "ghl_prefer_username",
        location: { id: ghl },
      });

    expect(res.body.cross_channel).toBe(true);
    const lead = await Lead.findOne({ contact_id: "ghl_prefer_username" });
    // Should match the one with username "drillsthenics", not the one with matching fullName
    expect(lead.outbound_lead_id.toString()).toBe(obByUsername._id.toString());
  });
});

describe("POST /api/ghl/conversation", () => {
  it("returns 400 when contact_id is missing", async () => {
    const res = await request(app).post("/api/ghl/conversation").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing contact_id");
  });

  it("creates a new lead with chat_memory", async () => {
    const res = await request(app).post("/api/ghl/conversation").send({
      contact_id: "ghl_conv_1",
      first_name: "John",
      last_name: "Doe",
      conversation: "\nUser: Hello\nBot: Hi there!",
      location: { id: ghl },
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.action).toBe("created");

    const lead = await Lead.findOne({ contact_id: "ghl_conv_1" });
    expect(lead).not.toBeNull();
    expect(lead.chat_memory).toBe("\nUser: Hello\nBot: Hi there!");
    expect(lead.first_name).toBe("John");
    expect(lead.source).toBe("ghl");
  });

  it("updates chat_memory on existing lead", async () => {
    await Lead.create({
      contact_id: "ghl_conv_2",
      account_id: ghl,
      first_name: "Jane",
      date_created: new Date().toISOString(),
      chat_memory: "\nUser: Hi\nBot: Hello!",
    });

    const res = await request(app).post("/api/ghl/conversation").send({
      contact_id: "ghl_conv_2",
      conversation: "\nUser: Hi\nBot: Hello!\nUser: I want to book\nBot: Here is the link",
      location: { id: ghl },
    });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe("updated");

    const lead = await Lead.findOne({ contact_id: "ghl_conv_2" });
    expect(lead.chat_memory).toContain("I want to book");
  });

  it("requires location.id for new leads", async () => {
    const res = await request(app).post("/api/ghl/conversation").send({
      contact_id: "ghl_conv_3",
      conversation: "\nUser: test\nBot: test",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing location.id for new lead");
  });

  it("handles missing conversation field gracefully", async () => {
    await Lead.create({
      contact_id: "ghl_conv_4",
      account_id: ghl,
      first_name: "Empty",
      date_created: new Date().toISOString(),
    });

    const res = await request(app).post("/api/ghl/conversation").send({
      contact_id: "ghl_conv_4",
      location: { id: ghl },
    });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe("updated");
  });

  it("reads conversation from customData (real GHL payload structure)", async () => {
    const res = await request(app).post("/api/ghl/conversation").send({
      contact_id: "ghl_conv_custom",
      first_name: "Drillsthenics",
      last_name: "| Learn Calisthenics",
      location: { id: ghl },
      customData: {
        contact_id: "ghl_conv_custom",
        conversation: "\nBot: what do you sell?\nUser: coaching",
        last_user_message: "coaching",
        last_bot_reply: "what do you sell?",
        manual_reply: "",
        tags: "",
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe("created");

    const lead = await Lead.findOne({ contact_id: "ghl_conv_custom" });
    expect(lead.chat_memory).toBe("\nBot: what do you sell?\nUser: coaching");
    expect(lead.first_name).toBe("Drillsthenics");
  });

  it("falls back to top-level chat_memory if customData.conversation is missing", async () => {
    const res = await request(app).post("/api/ghl/conversation").send({
      contact_id: "ghl_conv_fallback",
      first_name: "Fallback",
      location: { id: ghl },
      chat_memory: "\nBot: hi\nUser: hello",
      customData: {
        contact_id: "ghl_conv_fallback",
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe("created");

    const lead = await Lead.findOne({ contact_id: "ghl_conv_fallback" });
    expect(lead.chat_memory).toBe("\nBot: hi\nUser: hello");
  });

  it("reads contact_id from customData when not at top level", async () => {
    const res = await request(app).post("/api/ghl/conversation").send({
      first_name: "NoTopId",
      location: { id: ghl },
      customData: {
        contact_id: "ghl_conv_nested_id",
        conversation: "\nBot: test\nUser: test",
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe("created");

    const lead = await Lead.findOne({ contact_id: "ghl_conv_nested_id" });
    expect(lead).not.toBeNull();
  });

  it("resolves GHL location ID to CRM account ObjectId on new lead", async () => {
    const res = await request(app).post("/api/ghl/conversation").send({
      contact_id: "ghl_conv_acct",
      first_name: "AccountTest",
      location: { id: ghl },
      customData: {
        conversation: "\nBot: hi\nUser: hi",
      },
    });

    expect(res.status).toBe(200);
    const lead = await Lead.findOne({ contact_id: "ghl_conv_acct" });
    expect(lead.account_id).toBe(account._id.toString());
  });
});

describe("POST /api/ghl/conversation — timestamp tracking", () => {
  it("sets first_conversation_at and last_conversation_at on new lead", async () => {
    const before = new Date();
    await request(app).post("/api/ghl/conversation").send({
      contact_id: "ghl_ts_new",
      first_name: "Timestamp",
      location: { id: ghl },
      customData: { conversation: "\nBot: hi\nUser: hello" },
    });

    const lead = await Lead.findOne({ contact_id: "ghl_ts_new" });
    expect(lead.first_conversation_at).toBeTruthy();
    expect(lead.last_conversation_at).toBeTruthy();
    expect(new Date(lead.first_conversation_at).getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(lead.conversation_count).toBe(1);
  });

  it("increments conversation_count on subsequent updates", async () => {
    await Lead.create({
      contact_id: "ghl_ts_inc",
      account_id: account._id.toString(),
      first_name: "Counter",
      date_created: new Date().toISOString(),
      first_conversation_at: new Date("2026-03-01"),
      last_conversation_at: new Date("2026-03-01"),
      conversation_count: 5,
    });

    await request(app).post("/api/ghl/conversation").send({
      contact_id: "ghl_ts_inc",
      location: { id: ghl },
      customData: { conversation: "\nBot: updated\nUser: yes" },
    });

    const lead = await Lead.findOne({ contact_id: "ghl_ts_inc" });
    expect(lead.conversation_count).toBe(6);
    expect(new Date(lead.last_conversation_at).getTime()).toBeGreaterThan(new Date("2026-03-01").getTime());
    // first_conversation_at should NOT change
    expect(new Date(lead.first_conversation_at).getTime()).toBe(new Date("2026-03-01").getTime());
  });

  it("sets first_conversation_at on existing lead if missing", async () => {
    await Lead.create({
      contact_id: "ghl_ts_missing",
      account_id: account._id.toString(),
      first_name: "NoFirst",
      date_created: new Date().toISOString(),
      conversation_count: 0,
    });

    await request(app).post("/api/ghl/conversation").send({
      contact_id: "ghl_ts_missing",
      location: { id: ghl },
      customData: { conversation: "\nBot: hello\nUser: hi" },
    });

    const lead = await Lead.findOne({ contact_id: "ghl_ts_missing" });
    expect(lead.first_conversation_at).toBeTruthy();
    expect(lead.last_conversation_at).toBeTruthy();
    expect(lead.conversation_count).toBe(1);
  });

  it("does NOT update timestamps when no conversation in payload", async () => {
    const fixedDate = new Date("2026-03-15");
    await Lead.create({
      contact_id: "ghl_ts_noconv",
      account_id: account._id.toString(),
      first_name: "NoConv",
      date_created: new Date().toISOString(),
      last_conversation_at: fixedDate,
      conversation_count: 3,
    });

    await request(app).post("/api/ghl/conversation").send({
      contact_id: "ghl_ts_noconv",
      location: { id: ghl },
    });

    const lead = await Lead.findOne({ contact_id: "ghl_ts_noconv" });
    expect(lead.conversation_count).toBe(3); // unchanged
    expect(new Date(lead.last_conversation_at).getTime()).toBe(fixedDate.getTime()); // unchanged
  });
});

describe("POST /api/ghl/webhook — account_id resolution", () => {
  it("stores CRM account ObjectId instead of GHL location ID on new lead", async () => {
    const res = await request(app)
      .post("/api/ghl/webhook")
      .send({
        first_name: "ResolveTest",
        contact_id: "ghl_resolve_1",
        location: { id: ghl },
      });

    expect(res.body.action).toBe("created");
    const lead = await Lead.findOne({ contact_id: "ghl_resolve_1" });
    expect(lead.account_id).toBe(account._id.toString());
  });

  it("falls back to GHL location ID when no matching Account exists", async () => {
    const res = await request(app)
      .post("/api/ghl/webhook")
      .send({
        first_name: "NoAccount",
        contact_id: "ghl_resolve_2",
        location: { id: "unknown_ghl_location" },
      });

    expect(res.body.action).toBe("created");
    const lead = await Lead.findOne({ contact_id: "ghl_resolve_2" });
    expect(lead.account_id).toBe("unknown_ghl_location");
  });

  it("auto-heals stale GHL account_id on existing lead", async () => {
    // Lead was created with raw GHL location ID (pre-fix)
    await Lead.create({
      contact_id: "ghl_heal_1",
      account_id: ghl, // raw GHL string
      first_name: "Stale",
      date_created: "2026-03-20",
    });

    await request(app)
      .post("/api/ghl/webhook")
      .send({
        contact_id: "ghl_heal_1",
        location: { id: ghl },
        tags: "ghosted",
      });

    const lead = await Lead.findOne({ contact_id: "ghl_heal_1" });
    expect(lead.account_id).toBe(account._id.toString());
  });

  it("syncs booked_at to outbound lead when linked", async () => {
    const ob = await OutboundLead.create({
      account_id: account._id,
      username: "sync_ob",
      fullName: "Sync Test",
      followingKey: "sync_ob::scrape",
    });

    await Lead.create({
      contact_id: "ghl_sync_1",
      account_id: account._id.toString(),
      first_name: "Sync",
      last_name: "Test",
      date_created: "2026-03-20",
      outbound_lead_id: ob._id,
    });

    await request(app)
      .post("/api/ghl/webhook")
      .send({
        contact_id: "ghl_sync_1",
        location: { id: ghl },
        tags: "lead_booked",
      });

    const updatedOb = await OutboundLead.findById(ob._id);
    expect(updatedOb.booked).toBe(true);
    expect(updatedOb.booked_at).toBeTruthy();
  });

  it("syncs link_sent_at to outbound lead when linked", async () => {
    const ob = await OutboundLead.create({
      account_id: account._id,
      username: "sync_link_ob",
      fullName: "Link Test",
      followingKey: "sync_link_ob::scrape",
    });

    await Lead.create({
      contact_id: "ghl_sync_2",
      account_id: account._id.toString(),
      first_name: "Link",
      last_name: "Test",
      date_created: "2026-03-20",
      outbound_lead_id: ob._id,
    });

    await request(app)
      .post("/api/ghl/webhook")
      .send({
        contact_id: "ghl_sync_2",
        location: { id: ghl },
        tags: "link_sent",
      });

    const updatedOb = await OutboundLead.findById(ob._id);
    expect(updatedOb.link_sent).toBe(true);
    expect(updatedOb.link_sent_at).toBeTruthy();
  });
});

describe("POST /api/ghl/match-outbound", () => {
  const recent = () => new Date(Date.now() - 60 * 60 * 1000); // 1h ago
  const old = () => new Date(Date.now() - 48 * 60 * 60 * 1000); // 48h ago

  it("returns 400 when name is missing", async () => {
    const res = await request(app).post("/api/ghl/match-outbound").send({});
    expect(res.status).toBe(400);
  });

  it("returns unique match by partial fullName (DM'd within 24h)", async () => {
    await OutboundLead.create({
      account_id: account._id,
      followingKey: "k1",
      username: "romolo_dxb",
      fullName: "Romolo Marini | Dubai | Immobilienexperte",
      bio: "Real estate in Dubai",
      dmDate: recent(),
    });

    const res = await request(app)
      .post("/api/ghl/match-outbound")
      .send({ name: "Romolo Marini" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      matched: true,
      username: "romolo_dxb",
      bio: "Real estate in Dubai",
    });
  });

  it("matches by username when only username is sent", async () => {
    await OutboundLead.create({
      account_id: account._id,
      followingKey: "k2",
      username: "jane_doe",
      fullName: "Jane Doe",
      bio: "hello",
      dmDate: recent(),
    });

    const res = await request(app)
      .post("/api/ghl/match-outbound")
      .send({ name: "jane_doe" });

    expect(res.body.matched).toBe(true);
    expect(res.body.username).toBe("jane_doe");
  });

  it("returns matched:false when more than one outbound lead matches (passes)", async () => {
    await OutboundLead.create({
      account_id: account._id,
      followingKey: "k3a",
      username: "alex_one",
      fullName: "Alex Smith",
      bio: "bio a",
      dmDate: recent(),
    });
    await OutboundLead.create({
      account_id: account._id,
      followingKey: "k3b",
      username: "alex_two",
      fullName: "Alex Johnson",
      bio: "bio b",
      dmDate: recent(),
    });

    const res = await request(app)
      .post("/api/ghl/match-outbound")
      .send({ name: "Alex" });

    expect(res.body.matched).toBe(false);
    expect(res.body.count).toBe(2);
  });

  it("excludes outbound leads DM'd more than 24h ago", async () => {
    await OutboundLead.create({
      account_id: account._id,
      followingKey: "k4",
      username: "stale_user",
      fullName: "Stale User",
      bio: "old",
      dmDate: old(),
    });

    const res = await request(app)
      .post("/api/ghl/match-outbound")
      .send({ name: "Stale User" });

    expect(res.body.matched).toBe(false);
    expect(res.body.count).toBe(0);
  });

  it("scopes to account when location.id is provided", async () => {
    const otherAccount = await Account.create({ ghl: "ghl_other_loc" });

    await OutboundLead.create({
      account_id: otherAccount._id,
      followingKey: "k5",
      username: "wrong_acct",
      fullName: "Carol King",
      bio: "wrong",
      dmDate: recent(),
    });
    await OutboundLead.create({
      account_id: account._id,
      followingKey: "k5b",
      username: "right_acct",
      fullName: "Carol King",
      bio: "right",
      dmDate: recent(),
    });

    const res = await request(app)
      .post("/api/ghl/match-outbound")
      .send({ name: "Carol King", location: { id: ghl } });

    expect(res.body.matched).toBe(true);
    expect(res.body.username).toBe("right_acct");
    expect(res.body.bio).toBe("right");

    await Account.deleteOne({ _id: otherAccount._id });
  });

  it("accepts first_name + last_name instead of name", async () => {
    await OutboundLead.create({
      account_id: account._id,
      followingKey: "k6",
      username: "split_name",
      fullName: "Split Name",
      bio: "bio",
      dmDate: recent(),
    });

    const res = await request(app)
      .post("/api/ghl/match-outbound")
      .send({ first_name: "Split", last_name: "Name" });

    expect(res.body.matched).toBe(true);
    expect(res.body.username).toBe("split_name");
  });
});
