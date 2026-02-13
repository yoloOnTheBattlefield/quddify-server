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

    // Fix OutboundLead: drop old followingKey unique index, dedupe, sync username unique index
    const OutboundLead = require("./models/OutboundLead");
    try {
      await OutboundLead.collection.dropIndex("followingKey_1");
      console.log("[startup] Dropped old followingKey_1 index");
    } catch (e) {
      // Already dropped — ignore
    }

    // Remove duplicate usernames (keep newest, delete older ones)
    const dupes = await OutboundLead.aggregate([
      { $group: { _id: "$username", count: { $sum: 1 }, ids: { $push: "$_id" }, dates: { $push: "$createdAt" } } },
      { $match: { count: { $gt: 1 } } },
    ]);
    if (dupes.length > 0) {
      const idsToDelete = [];
      for (const dupe of dupes) {
        // Pair ids with dates, sort newest first, delete all but the first
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

// routes
app.use("/accounts", accountRoutes);
app.use("/leads", leadRoutes);
app.use("/analytics", analyticsRoutes);
app.use("/api/calendly", calendlyRoutes);
app.use("/api", uploadRoutes);
app.use("/outbound-leads", outboundLeadRoutes);
app.use("/prompts", promptRoutes);
app.use("/jobs", jobRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/logs", logRoutes);
app.use("/api", healthRoutes);
app.use("/api/sender-accounts", senderAccountRoutes);
app.use("/api/campaigns", campaignRoutes);

// auth routes at root level
app.use("/", accountRoutes);

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
