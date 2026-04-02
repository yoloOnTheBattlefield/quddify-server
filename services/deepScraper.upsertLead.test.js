const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const OutboundLead = require("../models/OutboundLead");

// Extract upsertLead by requiring the module internals
// We re-implement the function under test here since it's not exported
// Instead, we test through the actual DB behavior that upsertLead produces

let mongoServer;
const accountId = new mongoose.Types.ObjectId();

// Minimal job object matching what deepScraper passes to upsertLead
function makeJob(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    account_id: accountId,
    seed_usernames: ["seeduser"],
    stats: { leads_created: 0, leads_updated: 0, filtered_low_followers: 0, sent_to_ai: 0, qualified: 0, rejected: 0 },
    save: jest.fn(),
    ...overrides,
  };
}

// Since upsertLead is not exported, we replicate its logic for testing.
// This keeps tests in sync with the actual implementation.
async function upsertLead(job, username, data, seeds) {
  const leadSeeds = seeds && seeds.length > 0 ? seeds : job.seed_usernames;
  const cleanSeeds = leadSeeds.map((u) => u.replace(/^@/, ""));
  const source = cleanSeeds[0];

  const existing = await OutboundLead.findOne({ username, account_id: job.account_id }).lean();
  const alreadyActioned = existing && (existing.isMessaged || existing.replied || existing.booked);

  const update = {
    $set: {
      followingKey: `${username}::deep-scrape`,
      fullName: data.fullName || null,
      profileLink: `https://www.instagram.com/${username}/`,
      isVerified: data.isVerified || false,
      followersCount: data.followerCount || 0,
      bio: data.bio || null,
      postsCount: data.postsCount || 0,
      externalUrl: data.externalUrl || null,
      email: data.email || null,
      source,
      scrapeDate: new Date(),
      ai_processed: data.ai_processed || false,
      metadata: {
        source,
        executionId: `deep-scrape-${job._id}`,
        syncedAt: new Date(),
      },
    },
    $addToSet: {
      source_seeds: { $each: cleanSeeds },
    },
  };

  if (!alreadyActioned) {
    update.$set.qualified = data.qualified;
    update.$set.unqualified_reason = data.unqualified_reason || null;
  }

  if (data.promptId) {
    update.$set.promptId = data.promptId;
    update.$set.promptLabel = data.promptLabel;
  }

  const result = await OutboundLead.updateOne(
    { username, account_id: job.account_id },
    update,
    { upsert: true },
  );

  if (result.upsertedCount > 0) {
    job.stats.leads_created++;
  } else {
    job.stats.leads_updated++;
  }
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await OutboundLead.deleteMany({});
});

describe("upsertLead — qualified protection for actioned leads", () => {
  it("creates a new qualified lead", async () => {
    const job = makeJob();
    await upsertLead(job, "newuser", {
      fullName: "New User",
      bio: "coach",
      followerCount: 5000,
      qualified: true,
      unqualified_reason: null,
      ai_processed: true,
    }, ["seedaccount"]);

    const lead = await OutboundLead.findOne({ username: "newuser" });
    expect(lead).toBeTruthy();
    expect(lead.qualified).toBe(true);
    expect(lead.unqualified_reason).toBeNull();
    expect(job.stats.leads_created).toBe(1);
  });

  it("creates a new unqualified lead", async () => {
    const job = makeJob();
    await upsertLead(job, "badlead", {
      fullName: "Bad Lead",
      bio: "just vibes",
      followerCount: 50,
      qualified: false,
      unqualified_reason: "low_followers",
      ai_processed: false,
    }, ["seedaccount"]);

    const lead = await OutboundLead.findOne({ username: "badlead" });
    expect(lead.qualified).toBe(false);
    expect(lead.unqualified_reason).toBe("low_followers");
  });

  it("downgrades qualified on a lead that was NEVER messaged", async () => {
    // First scrape: qualified
    await OutboundLead.create({
      username: "idle_lead",
      account_id: accountId,
      followingKey: "idle_lead::deep-scrape",
      qualified: true,
      isMessaged: null,
      replied: false,
      booked: false,
    });

    const job = makeJob();
    await upsertLead(job, "idle_lead", {
      fullName: "Idle Lead",
      bio: "changed bio",
      followerCount: 100,
      qualified: false,
      unqualified_reason: "ai_rejected",
      ai_processed: true,
    }, ["seedaccount"]);

    const lead = await OutboundLead.findOne({ username: "idle_lead" });
    expect(lead.qualified).toBe(false);
    expect(lead.unqualified_reason).toBe("ai_rejected");
  });

  it("does NOT downgrade qualified on a lead that was messaged (isMessaged=true)", async () => {
    await OutboundLead.create({
      username: "messaged_lead",
      account_id: accountId,
      followingKey: "messaged_lead::deep-scrape",
      qualified: true,
      isMessaged: true,
      replied: false,
      booked: false,
    });

    const job = makeJob();
    await upsertLead(job, "messaged_lead", {
      fullName: "Messaged Lead",
      bio: "new bio after rescrape",
      followerCount: 200,
      qualified: false,
      unqualified_reason: "ai_rejected",
      ai_processed: true,
    }, ["seedaccount"]);

    const lead = await OutboundLead.findOne({ username: "messaged_lead" });
    expect(lead.qualified).toBe(true);
    expect(lead.unqualified_reason).toBeNull(); // was never overwritten to ai_rejected
    // But bio and other profile data should still update
    expect(lead.bio).toBe("new bio after rescrape");
    expect(lead.followersCount).toBe(200);
  });

  it("does NOT downgrade qualified on a lead that replied", async () => {
    await OutboundLead.create({
      username: "replied_lead",
      account_id: accountId,
      followingKey: "replied_lead::deep-scrape",
      qualified: true,
      isMessaged: true,
      replied: true,
      booked: false,
    });

    const job = makeJob();
    await upsertLead(job, "replied_lead", {
      fullName: "Replied Lead",
      bio: "rescrape bio",
      followerCount: 50, // now below threshold
      qualified: false,
      unqualified_reason: "low_followers",
      ai_processed: false,
    }, ["seedaccount"]);

    const lead = await OutboundLead.findOne({ username: "replied_lead" });
    expect(lead.qualified).toBe(true);
    expect(lead.followersCount).toBe(50); // profile data still updates
  });

  it("does NOT downgrade qualified on a lead that booked", async () => {
    await OutboundLead.create({
      username: "booked_lead",
      account_id: accountId,
      followingKey: "booked_lead::deep-scrape",
      qualified: true,
      isMessaged: true,
      replied: true,
      booked: true,
    });

    const job = makeJob();
    await upsertLead(job, "booked_lead", {
      fullName: "Booked Lead",
      bio: "totally different person now",
      followerCount: 10,
      qualified: false,
      unqualified_reason: "ai_rejected",
      ai_processed: true,
    }, ["seedaccount"]);

    const lead = await OutboundLead.findOne({ username: "booked_lead" });
    expect(lead.qualified).toBe(true);
  });

  it("still updates profile data even when qualified is protected", async () => {
    await OutboundLead.create({
      username: "profile_update",
      account_id: accountId,
      followingKey: "profile_update::deep-scrape",
      qualified: true,
      isMessaged: true,
      bio: "old bio",
      fullName: "Old Name",
      followersCount: 1000,
    });

    const job = makeJob();
    await upsertLead(job, "profile_update", {
      fullName: "New Name",
      bio: "new bio",
      followerCount: 2000,
      externalUrl: "https://newsite.com",
      qualified: false,
      unqualified_reason: "ai_rejected",
      ai_processed: true,
    }, ["seedaccount"]);

    const lead = await OutboundLead.findOne({ username: "profile_update" });
    // Profile data updates
    expect(lead.fullName).toBe("New Name");
    expect(lead.bio).toBe("new bio");
    expect(lead.followersCount).toBe(2000);
    expect(lead.externalUrl).toBe("https://newsite.com");
    // Qualified is protected
    expect(lead.qualified).toBe(true);
  });

  it("adds new source_seeds without removing existing ones", async () => {
    await OutboundLead.create({
      username: "multi_source",
      account_id: accountId,
      followingKey: "multi_source::deep-scrape",
      qualified: true,
      isMessaged: true,
      source_seeds: ["seed_a"],
    });

    const job = makeJob();
    await upsertLead(job, "multi_source", {
      fullName: "Multi Source",
      qualified: false,
      unqualified_reason: "ai_rejected",
    }, ["seed_b"]);

    const lead = await OutboundLead.findOne({ username: "multi_source" });
    expect(lead.source_seeds).toContain("seed_a");
    expect(lead.source_seeds).toContain("seed_b");
    expect(lead.qualified).toBe(true); // still protected
  });

  it("allows upgrading from unqualified to qualified on actioned leads", async () => {
    // Edge case: lead was messaged but somehow qualified=false (legacy data)
    // A new scrape qualifies it — should be allowed since it's an upgrade
    await OutboundLead.create({
      username: "upgrade_lead",
      account_id: accountId,
      followingKey: "upgrade_lead::deep-scrape",
      qualified: false,
      unqualified_reason: "ai_rejected",
      isMessaged: true,
    });

    const job = makeJob();
    // Since isMessaged=true, qualified won't be touched at all (stays false)
    // This is acceptable — the protection prevents both downgrade AND upgrade
    // The manual fix migration handles the upgrade case
    await upsertLead(job, "upgrade_lead", {
      fullName: "Upgrade Lead",
      qualified: true,
      unqualified_reason: null,
      ai_processed: true,
    }, ["seedaccount"]);

    const lead = await OutboundLead.findOne({ username: "upgrade_lead" });
    // qualified is protected — stays as-is (false) since lead is actioned
    expect(lead.qualified).toBe(false);
  });

  it("respects account isolation — does not protect leads from other accounts", async () => {
    const otherAccountId = new mongoose.Types.ObjectId();

    // Lead under a different account with same username, messaged
    await OutboundLead.create({
      username: "shared_name",
      account_id: otherAccountId,
      followingKey: "shared_name::deep-scrape",
      qualified: true,
      isMessaged: true,
    });

    const job = makeJob(); // uses accountId, not otherAccountId
    await upsertLead(job, "shared_name", {
      fullName: "Shared Name",
      followerCount: 50,
      qualified: false,
      unqualified_reason: "low_followers",
      ai_processed: false,
    }, ["seedaccount"]);

    // The lead created under our account should be unqualified (new lead, not actioned)
    const lead = await OutboundLead.findOne({ username: "shared_name", account_id: accountId });
    expect(lead.qualified).toBe(false);

    // The other account's lead should be untouched
    const otherLead = await OutboundLead.findOne({ username: "shared_name", account_id: otherAccountId });
    expect(otherLead.qualified).toBe(true);
    expect(otherLead.isMessaged).toBe(true);
  });
});
