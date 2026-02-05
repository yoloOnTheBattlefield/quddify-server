const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const accountRoutes = require("./routes/accounts");
const leadRoutes = require("./routes/leads");
const analyticsRoutes = require("./routes/analytics");
const calendlyRoutes = require("./routes/calendly");

const app = express();
app.use(express.json());

app.use(
  cors({
    origin: [
      "http://localhost:8080",
      "http://localhost:5173",
      "https://dm-setting-mrcristianflorea.app",
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);

const MONGO_URI =
  "mongodb+srv://cristianfloreadev_db_user:SyQG2Lk0qsJYks18@cluster0.jumreey.mongodb.net/CRM?appName=Cluster0";

// Enable command buffering globally
mongoose.set("bufferCommands", true);

// Cached connection promise for serverless
let cachedConnection = null;

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

// auth routes at root level
app.use("/", accountRoutes);

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
