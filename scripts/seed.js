require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const MONGO_URI = process.env.MONGO_URI;

async function seed() {
  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB");

  const db = mongoose.connection.db;

  // Clear existing data
  await db.collection("accounts").deleteMany({});
  await db.collection("users").deleteMany({});
  await db.collection("leads").deleteMany({});
  console.log("Cleared existing data");

  const hashedAdmin = await bcrypt.hash("Superfast123!", 10);
  const hashedClient = await bcrypt.hash("password123", 10);

  // 1. Admin account
  const adminAccount = await db.collection("accounts").insertOne({
    ghl: "ADMIN-GHL-001",
    calendly: null,
    calendly_token: null,
    ghl_lead_booked_webhook: null,
  });

  await db.collection("users").insertOne({
    account_id: adminAccount.insertedId,
    first_name: "Cristian",
    last_name: "Florea",
    email: "cristianfloreadev@gmail.com",
    password: hashedAdmin,
    role: 0,
  });

  console.log("Created admin: cristianfloreadev@gmail.com");

  // 2. Client accounts
  const clients = [
    { first_name: "James", last_name: "Morton", email: "james@acmefitness.com", ghl: "CLIENT-GHL-001" },
    { first_name: "Sarah", last_name: "Chen", email: "sarah@peakcoaching.com", ghl: "CLIENT-GHL-002" },
    { first_name: "David", last_name: "Wilson", email: "david@elitetraining.com", ghl: "CLIENT-GHL-003" },
  ];

  for (const client of clients) {
    const account = await db.collection("accounts").insertOne({
      ghl: client.ghl,
      calendly: null,
      calendly_token: null,
      ghl_lead_booked_webhook: null,
    });

    await db.collection("users").insertOne({
      account_id: account.insertedId,
      first_name: client.first_name,
      last_name: client.last_name,
      email: client.email,
      password: hashedClient,
      role: 1,
    });

    console.log(`Created client: ${client.email} (${client.ghl})`);
  }

  console.log("\nSeed complete!");
  console.log("Admin login: cristianfloreadev@gmail.com / Superfast123!");
  console.log("Client login: james@acmefitness.com / password123");
  console.log("\nUse POST /leads/generate to create mock leads.");

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
