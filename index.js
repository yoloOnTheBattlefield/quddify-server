require("dotenv").config();
const logger = require("./utils/logger").child({ module: "index" });

// Catch unhandled errors so the process doesn't silently die
process.on("uncaughtException", (err) => {
  logger.error("[FATAL] Uncaught Exception:", err);
});
process.on("unhandledRejection", (err) => {
  logger.error("[FATAL] Unhandled Rejection:", err);
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
const researchRoutes = require("./routes/research");
const manychatRoutes = require("./routes/manychat");
const igWebhookRoutes = require("./routes/instagram-webhook");
const igConversationRoutes = require("./routes/ig-conversations");
const igOAuthRoutes = require("./routes/instagram-oauth");
const followUpRoutes = require("./routes/follow-ups");
const eodReportRoutes = require("./routes/eod-reports");
const bookingRoutes = require("./routes/bookings");
const clientRoutes = require("./routes/clients");
const clientImageRoutes = require("./routes/client-images");
const clientLutRoutes = require("./routes/client-luts");
const transcriptRoutes = require("./routes/transcripts");
const swipeFileRoutes = require("./routes/swipe-files");
const carouselTemplateRoutes = require("./routes/carousel-templates");
const carouselStyleRoutes = require("./routes/carousel-styles");
const carouselRoutes = require("./routes/carousels");
const thumbnailRoutes = require("./routes/thumbnails");
const thumbnailTemplateRoutes = require("./routes/thumbnail-templates");
const clientImageUploadRoutes = require("./routes/client-image-upload");
const googleDriveRoutes = require("./routes/google-drive");
const reelRoutes = require("./routes/reels");
const dashboardRoutes = require("./routes/dashboard");
const notificationRoutes = require("./routes/notifications");
const authRoutes = require("./routes/auth");
const youtubeChannelRoutes = require("./routes/youtube-channels");
const youtubeAlertRoutes = require("./routes/youtube-alerts");
const youtubeTrendingRoutes = require("./routes/youtube-trending");
const youtubeScrapeRoutes = require("./routes/youtube-scrape");
const youtubeVideoRoutes = require("./routes/youtube-videos");
const advisoryClientRoutes = require("./routes/advisory-clients");
const advisorySessionRoutes = require("./routes/advisory-sessions");
const advisoryMetricRoutes = require("./routes/advisory-metrics");
const leadNoteRoutes = require("./routes/lead-notes");
const leadTaskRoutes = require("./routes/lead-tasks");
const invitationRoutes = require("./routes/invitations");
const pushSubscriptionRoutes = require("./routes/push-subscriptions");
const stripeRoutes = require("./routes/stripe");

const { auth } = require("./middleware/auth");
const requireOutbound = require("./middleware/requireOutbound");
const {
  authLimiter,
  apiLimiter,
  webhookLimiter,
} = require("./middleware/rateLimiter");
const requestId = require("./middleware/requestId");
const socketManager = require("./services/socketManager");
const jobQueue = require("./services/jobQueue");
const jobWorker = require("./services/jobWorker");
const { recoverStuckJobs } = require("./services/jobRecovery");
const campaignScheduler = require("./services/campaignScheduler");
const deepScrapeScheduler = require("./services/deepScrapeScheduler");
const youtubeScheduler = require("./services/youtubeScheduler");

const app = express();
const server = http.createServer(app);

// Instagram webhook — registered BEFORE express.json() so we can capture raw body for signature verification
app.use(
  "/instagram-webhook",
  webhookLimiter,
  cors({ origin: true, credentials: false }),
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
  igWebhookRoutes,
);

// Stripe webhook — needs raw body for signature verification
app.use(
  "/api/stripe/webhook",
  webhookLimiter,
  cors({ origin: true, credentials: false }),
  express.raw({ type: "application/json" }),
  (req, _res, next) => {
    req.rawBody = req.body;
    req.body = JSON.parse(req.body);
    next();
  },
  stripeRoutes,
);

app.use(express.json({ limit: "10mb" }));

// Serve uploaded files (images, thumbnails, exports)
const { UPLOAD_DIR } = require("./services/storageService");
app.use("/uploads", express.static(UPLOAD_DIR));

// Assign a unique request ID to every request
app.use(requestId);

// Public tracking routes — registered before global CORS so any origin can call them
app.use("/t", cors({ origin: true, credentials: false }), trackingPublicRoutes);

const allowedOrigins = [
  "http://localhost:8080",
  "http://localhost:8081",
  "http://localhost:8083",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
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
app.set("io", io);

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
  logger.info("MongoDB connected");

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
    const IgConversation = require("./models/IgConversation");
    await IgConversation.syncIndexes();
    const IgMessage = require("./models/IgMessage");
    await IgMessage.syncIndexes();
    const Lead = require("./models/Lead");
    await Lead.syncIndexes();
    const Channel = require("./models/Channel");
    await Channel.syncIndexes();
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
    logger.error("MongoDB connection error:", err);
    res.status(500).json({ error: "Database connection failed" });
  }
});

// Public routes (no auth) — rate-limit login/register to prevent brute force
app.post("/login", authLimiter, accountRoutes);
app.post("/register", authLimiter, accountRoutes);
app.post("/accounts/login", authLimiter, accountRoutes);
app.post("/accounts/register", authLimiter, accountRoutes);
app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/calendly", webhookLimiter, calendlyRoutes);
app.get("/api/health", healthRoutes);
app.get("/api/debug", healthRoutes);
app.use("/api/invitations", invitationRoutes);
// Auth middleware — everything below requires JWT or API key
app.use(auth);
// General rate limit for all authenticated routes
app.use(apiLimiter);

// Protected routes
app.use("/accounts", accountRoutes);
app.use("/leads", leadRoutes);
app.use("/api/lead-notes", leadNoteRoutes);
app.use("/api/lead-tasks", leadTaskRoutes);
app.use("/analytics", analyticsRoutes);
app.use("/api", uploadRoutes);
app.use("/outbound-leads", requireOutbound, outboundLeadRoutes);
app.use("/prompts", promptRoutes);
app.use("/jobs", jobRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/logs", logRoutes);
app.use("/api", healthRoutes);
app.use("/api/sender-accounts", requireOutbound, senderAccountRoutes);
app.use("/api/manual-campaigns", requireOutbound, manualCampaignRoutes);
app.use("/api/campaigns", requireOutbound, campaignRoutes);
app.use("/api/outbound-accounts", requireOutbound, outboundAccountRoutes);
app.use("/api/warmup", requireOutbound, warmupRoutes);
app.use("/api/deep-scrape", deepScrapeRoutes);
app.use("/api/apify-tokens", apifyTokenRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/reply-checks", requireOutbound, replyCheckRoutes);
app.use("/api/ai-prompts", aiPromptRoutes);
app.use("/api/research", researchRoutes);
app.use("/api/manychat", webhookLimiter, manychatRoutes);
app.use("/api/ig-conversations", igConversationRoutes);
app.use("/api/instagram", igOAuthRoutes);
app.use("/api/follow-ups", requireOutbound, followUpRoutes);
app.use("/api/eod-reports", eodReportRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/stripe", stripeRoutes);
app.use("/tracking", trackingRoutes);

// Carousel feature routes
app.use("/api/clients", clientRoutes);
app.use("/api/client-images", clientImageRoutes);
app.use("/api/client-luts", clientLutRoutes);
app.use("/api/transcripts", transcriptRoutes);
app.use("/api/swipe-files", swipeFileRoutes);
app.use("/api/carousel-templates", carouselTemplateRoutes);
app.use("/api/carousel-styles", carouselStyleRoutes);
app.use("/api/carousels", carouselRoutes);
app.use("/api/thumbnails", thumbnailRoutes);
app.use("/api/thumbnail-templates", thumbnailTemplateRoutes);
app.use("/api/client-images", clientImageUploadRoutes);
app.use("/api/google-drive", googleDriveRoutes);
app.use("/api/reels", reelRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/push-subscriptions", pushSubscriptionRoutes);

// YouTube trend detection routes
app.use("/api/youtube/channels", youtubeChannelRoutes);
app.use("/api/youtube/alerts", youtubeAlertRoutes);
app.use("/api/youtube/trending", youtubeTrendingRoutes);
app.use("/api/youtube/scrape", youtubeScrapeRoutes);
app.use("/api/youtube/videos", youtubeVideoRoutes);

// Advisory module routes
app.use("/api/advisory/clients", advisoryClientRoutes);
app.use("/api/advisory/sessions", advisorySessionRoutes);
app.use("/api/advisory/metrics", advisoryMetricRoutes);

// Start listening IMMEDIATELY so Railway health checks pass
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  logger.info(`Server running on 0.0.0.0:${PORT}`);
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
      logger.info(
        `[taskRecovery] Reset ${stuckResult.modifiedCount} stuck task(s) to pending`,
      );
    }

    // Clear any senders stuck in "restricted" status (restriction mechanism removed)
    const SenderAccount = require("./models/SenderAccount");
    const restrictedResult = await SenderAccount.updateMany(
      { status: "restricted" },
      {
        $set: {
          status: "offline",
          restricted_until: null,
          restriction_reason: null,
        },
      },
    );
    if (restrictedResult.modifiedCount > 0) {
      logger.info(
        `[startup] Unrestricted ${restrictedResult.modifiedCount} sender(s)`,
      );
    }

    // Start schedulers
    campaignScheduler.start();
    deepScrapeScheduler.start();
    youtubeScheduler.start();

    logger.info("Startup complete");
  })
  .catch((err) => {
    logger.error("Failed to initialize:", err);
  });
