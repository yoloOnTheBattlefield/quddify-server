const express = require("express");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");

const app = express();
app.use(express.json());

const MONGO_URI =
  "mongodb+srv://cristianfloreadev_db_user:SyQG2Lk0qsJYks18@cluster0.jumreey.mongodb.net/CRM?appName=Cluster0";

// connect
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error(err));

// EXACT schema based on your DB
const LeadSchema = new mongoose.Schema(
  {
    first_name: { type: String, default: null },
    last_name: { type: String, default: null },
    contact_id: { type: String, default: null },
    date_created: { type: Date, default: null },
    account_id: { type: String, default: null },
  },
  {
    collection: "leads",
    versionKey: false,
  },
);

const AccountSchema = new mongoose.Schema(
  {
    ghl: String,
    first_name: String,
    last_name: String,
    email: String,
    password: String,
  },
  { collection: "accounts", versionKey: false },
);

const Account = mongoose.model("Account", AccountSchema);

const Lead = mongoose.model("Lead", LeadSchema);

// health check
app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

const bcrypt = require("bcrypt");

app.post("/register", async (req, res) => {
  console.log(req.body);
  const { email, password, first_name, last_name, ghl } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Missing credentials" });
  }

  const exists = await Account.findOne({ email });
  if (exists) {
    return res.status(400).json({ error: "Account already exists" });
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const account = await Account.create({
    email,
    password: hashedPassword,
    first_name: first_name || null,
    last_name: last_name || null,
    ghl: ghl || null,
  });

  res.json({ success: true });
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const account = await Account.findOne({ email });
  if (!account) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const ok = await bcrypt.compare(password, account.password);
  if (!ok) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  res.json(account);
});

// get all leads
app.get("/leads", async (req, res) => {
  const leads = await Lead.find().lean();
  res.json(leads);
});

// get lead by id
app.get("/leads/:id", async (req, res) => {
  const lead = await Lead.findById(req.params.id).lean();
  if (!lead) return res.status(404).json({ error: "Not found" });
  res.json(lead);
});

// create lead
app.post("/leads", async (req, res) => {
  const lead = await Lead.create(req.body);
  res.status(201).json(lead);
});

// update lead
app.patch("/leads/:id", async (req, res) => {
  const lead = await Lead.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  }).lean();

  if (!lead) return res.status(404).json({ error: "Not found" });
  res.json(lead);
});

// delete lead
app.delete("/leads/:id", async (req, res) => {
  await Lead.findByIdAndDelete(req.params.id);
  res.json({ deleted: true });
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
