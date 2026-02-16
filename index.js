require("dotenv").config();
const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const cors = require("cors");

const accountRoutes = require("./routes/accounts");
const leadRoutes = require("./routes/leads");
const analyticsRoutes = require("./routes/analytics");
const calendlyRoutes = require("./routes/calendly");
const uploadRoutes = require("./routes/upload");
const outboundLeadRoutes = require("./routes/outbound-leads");
const promptRoutes = require("./routes/prompts");
const jobRoutes = require("./routes/jobs");
const taskRoutes = require("./routes/tasks");
const logRoutes = require("./routes/logs");
const healthRoutes = require("./routes/health");
const senderAccountRoutes = require("./routes/sender-accounts");
const campaignRoutes = require("./routes/campaigns");
const manualCampaignRoutes = require("./routes/manual-campaigns");
const outboundAccountRoutes = require("./routes/outbound-accounts");
const warmupRoutes = require("./routes/warmup");

const { auth } = require("./middleware/auth");
const socketManager = require("./services/socketManager");
const jobQueue = require("./services/jobQueue");
const jobWorker = require("./services/jobWorker");
const { recoverStuckJobs } = require("./services/jobRecovery");
const campaignScheduler = require("./services/campaignScheduler");

const app = express();
const server = http.createServer(app);
app.use(express.json());

const allowedOrigins = [
  "http://localhost:8080",
  "http://localhost:5173",
  "https://quddify-app.app",
  "https://www.quddify-app.app",
  "https://quddify-app.vercel.app",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true); // allow Postman / server-to-server
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (origin.startsWith("chrome-extension://")) return callback(null, true);
      return callback(new Error("CORS blocked: " + origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

app.options(/.*/, cors());

// Initialize Socket.IO
const io = socketManager.init(server, allowedOrigins);

// Initialize job worker with Socket.IO, then init queue
jobWorker.init(io);
jobQueue.init(jobWorker.processJob);

const MONGO_URI = process.env.MONGO_URI;

// Enable command buffering globally
mongoose.set("bufferCommands", true);

// Cached connection promise for serverless
let cachedConnection = null;
let indexesFixed = false;

const connectDB = async () => {
  if (cachedConnection && mongoose.connection.readyState === 1) {
    return cachedConnection;
  }

  cachedConnection = await mongoose.connect(MONGO_URI, {
    bufferCommands: true,
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });
  console.log("MongoDB connected");

  // Fix stale api_key index and clear null values once per process
  if (!indexesFixed) {
    indexesFixed = true;
    const Account = require("./models/Account");
    try {
      await Account.collection.dropIndex("api_key_1");
      console.log("[startup] Dropped old api_key_1 index");
    } catch (e) {
      // Index doesn't exist or already sparse — ignore
    }
    await Account.collection.updateMany(
      { api_key: null },
      { $unset: { api_key: "" } },
    );
    await Account.syncIndexes();

    // Fix OutboundLead: drop old indexes, migrate account_id, sync new compound index
    const OutboundLead = require("./models/OutboundLead");
    try {
      await OutboundLead.collection.dropIndex("followingKey_1");
      console.log("[startup] Dropped old followingKey_1 index");
    } catch (e) {
      // Already dropped — ignore
    }
    try {
      await OutboundLead.collection.dropIndex("username_1");
      console.log("[startup] Dropped old username_1 index");
    } catch (e) {
      // Already dropped — ignore
    }

    // Backfill account_id for legacy outbound leads that don't have one
    const leadsWithoutAccount = await OutboundLead.countDocuments({ account_id: { $exists: false } });
    if (leadsWithoutAccount > 0) {
      // Find account_id through CampaignLead → Campaign chain
      const CampaignLead = require("./models/CampaignLead");
      const Campaign = require("./models/Campaign");
      const orphanLeads = await OutboundLead.find({ account_id: { $exists: false } }, { _id: 1 }).lean();
      const orphanIds = orphanLeads.map((l) => l._id);
      const clLinks = await CampaignLead.find({ outbound_lead_id: { $in: orphanIds } }, { outbound_lead_id: 1, campaign_id: 1 }).lean();
      const campaignIds = [...new Set(clLinks.map((cl) => cl.campaign_id.toString()))];
      const campaigns = await Campaign.find({ _id: { $in: campaignIds } }, { _id: 1, account_id: 1 }).lean();
      const campaignAccountMap = {};
      for (const c of campaigns) campaignAccountMap[c._id.toString()] = c.account_id;

      const leadAccountMap = {};
      for (const cl of clLinks) {
        const acctId = campaignAccountMap[cl.campaign_id.toString()];
        if (acctId) leadAccountMap[cl.outbound_lead_id.toString()] = acctId;
      }

      let backfilled = 0;
      for (const [leadId, acctId] of Object.entries(leadAccountMap)) {
        await OutboundLead.updateOne({ _id: leadId }, { $set: { account_id: acctId } });
        backfilled++;
      }

      // Delete orphan leads that have no campaign association (can't determine account)
      const stillOrphan = await OutboundLead.countDocuments({ account_id: { $exists: false } });
      if (stillOrphan > 0) {
        const delResult = await OutboundLead.deleteMany({ account_id: { $exists: false } });
        console.log(`[startup] Removed ${delResult.deletedCount} orphan outbound lead(s) with no account`);
      }
      console.log(`[startup] Backfilled account_id on ${backfilled} outbound lead(s)`);
    }

    // Remove duplicate username+account_id combos (keep newest, delete older)
    const dupes = await OutboundLead.aggregate([
      { $group: { _id: { username: "$username", account_id: "$account_id" }, count: { $sum: 1 }, ids: { $push: "$_id" }, dates: { $push: "$createdAt" } } },
      { $match: { count: { $gt: 1 } } },
    ]);
    if (dupes.length > 0) {
      const idsToDelete = [];
      for (const dupe of dupes) {
        const pairs = dupe.ids.map((id, i) => ({ id, date: dupe.dates[i] || new Date(0) }));
        pairs.sort((a, b) => b.date - a.date);
        for (let i = 1; i < pairs.length; i++) {
          idsToDelete.push(pairs[i].id);
        }
      }
      const delResult = await OutboundLead.deleteMany({ _id: { $in: idsToDelete } });
      console.log(`[startup] Removed ${delResult.deletedCount} duplicate outbound lead(s)`);
    }

    await OutboundLead.syncIndexes();
  }

  return cachedConnection;
};

// Middleware to ensure DB connection before any route
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("MongoDB connection error:", err);
    res.status(500).json({ error: "Database connection failed" });
  }
});

// health check
app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

// Public routes (no auth)
app.post("/login", accountRoutes);
app.post("/register", accountRoutes);
app.post("/accounts/login", accountRoutes);
app.post("/accounts/register", accountRoutes);
app.use("/api/calendly", calendlyRoutes);
app.get("/api/health", healthRoutes);

// Auth middleware — everything below requires JWT or API key
app.use(auth);

// Protected routes
app.use("/accounts", accountRoutes);
app.use("/leads", leadRoutes);
app.use("/analytics", analyticsRoutes);
app.use("/api", uploadRoutes);
app.use("/outbound-leads", outboundLeadRoutes);
app.use("/prompts", promptRoutes);
app.use("/jobs", jobRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/logs", logRoutes);
app.use("/api", healthRoutes);
app.use("/api/sender-accounts", senderAccountRoutes);
app.use("/api/manual-campaigns", manualCampaignRoutes);
app.use("/api/campaigns", campaignRoutes);
app.use("/api/outbound-accounts", outboundAccountRoutes);
app.use("/api/warmup", warmupRoutes);

// Connect to DB, run recovery, then start server
connectDB()
  .then(async () => {
    await recoverStuckJobs();

    // Reset abandoned in_progress tasks back to pending
    const Task = require("./models/Task");
    const stuckResult = await Task.updateMany(
      { status: "in_progress" },
      { $set: { status: "pending", startedAt: null } },
    );
    if (stuckResult.modifiedCount > 0) {
      console.log(`[taskRecovery] Reset ${stuckResult.modifiedCount} stuck task(s) to pending`);
    }

    // Start campaign scheduler
    campaignScheduler.start();

    server.listen(3000, () => {
      console.log("Server running on port 3000");
    });
  })
  .catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
