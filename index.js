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
    origin: ["http://localhost:8080", "http://localhost:5173"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);

const MONGO_URI =
  "mongodb+srv://cristianfloreadev_db_user:SyQG2Lk0qsJYks18@cluster0.jumreey.mongodb.net/CRM?appName=Cluster0";

// Cached connection for serverless
let isConnected = false;

const connectDB = async () => {
  if (isConnected) return;

  try {
    await mongoose.connect(MONGO_URI, {
      bufferCommands: false,
    });
    isConnected = true;
    console.log("MongoDB connected");
  } catch (err) {
    console.error("MongoDB connection error:", err);
    throw err;
  }
};

// Connect on startup
connectDB();

// Middleware to ensure DB connection
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
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
