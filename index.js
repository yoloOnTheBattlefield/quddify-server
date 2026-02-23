require("dotenv").config();

// Catch unhandled errors so the process doesn't silently die
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught Exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[FATAL] Unhandled Rejection:", err);
});

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
const trackingPublicRoutes = require("./routes/tracking-public");
const trackingRoutes = require("./routes/tracking");
const deepScrapeRoutes = require("./routes/deep-scrape");
const apifyTokenRoutes = require("./routes/apify-tokens");
const adminRoutes = require("./routes/admin");
const replyCheckRoutes = require("./routes/reply-checks");
const aiPromptRoutes = require("./routes/ai-prompts");

const { auth } = require("./middleware/auth");
const socketManager = require("./services/socketManager");
const jobQueue = require("./services/jobQueue");
const jobWorker = require("./services/jobWorker");
const { recoverStuckJobs } = require("./services/jobRecovery");
const campaignScheduler = require("./services/campaignScheduler");
const deepScrapeScheduler = require("./services/deepScrapeScheduler");

const app = express();
const server = http.createServer(app);
app.use(express.json());

// Public tracking routes — registered before global CORS so any origin can call them
app.use("/t", cors({ origin: true, credentials: false }), trackingPublicRoutes);

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

  // Sync indexes once per process
  if (!indexesFixed) {
    indexesFixed = true;
    const Account = require("./models/Account");
    await Account.syncIndexes();
    const OutboundLead = require("./models/OutboundLead");
    await OutboundLead.syncIndexes();
    const SenderAccount = require("./models/SenderAccount");
    await SenderAccount.syncIndexes();
    const OutboundAccountModel = require("./models/OutboundAccount");
    await OutboundAccountModel.syncIndexes();
  }

  return cachedConnection;
};

// Health check BEFORE DB middleware — Railway health checks must always respond fast
app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

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

// Public routes (no auth)
app.post("/login", accountRoutes);
app.post("/register", accountRoutes);
app.post("/accounts/login", accountRoutes);
app.post("/accounts/register", accountRoutes);
app.post("/accounts/select-account", accountRoutes);
app.use("/api/calendly", calendlyRoutes);
app.get("/api/health", healthRoutes);
app.get("/api/debug", healthRoutes);
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
app.use("/api/deep-scrape", deepScrapeRoutes);
app.use("/api/apify-tokens", apifyTokenRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/reply-checks", replyCheckRoutes);
app.use("/api/ai-prompts", aiPromptRoutes);
app.use("/tracking", trackingRoutes);

// Start listening IMMEDIATELY so Railway health checks pass
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on 0.0.0.0:${PORT}`);
});

// Connect to DB and run recovery in the background
// (The DB middleware on each request will also call connectDB, so requests wait for it)
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

    // Clear any senders stuck in "restricted" status (restriction mechanism removed)
    const SenderAccount = require("./models/SenderAccount");
    const restrictedResult = await SenderAccount.updateMany(
      { status: "restricted" },
      { $set: { status: "offline", restricted_until: null, restriction_reason: null } },
    );
    if (restrictedResult.modifiedCount > 0) {
      console.log(`[startup] Unrestricted ${restrictedResult.modifiedCount} sender(s)`);
    }

    // Start schedulers
    campaignScheduler.start();
    deepScrapeScheduler.start();

    console.log("Startup complete");
  })
  .catch((err) => {
    console.error("Failed to initialize:", err);
  });
