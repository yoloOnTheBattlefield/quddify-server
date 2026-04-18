/**
 * Separate Mongoose connection for the carousel-app database.
 *
 * Auth models (Account, User, AccountUser) stay on the default CRM connection.
 * All carousel-related models are registered on this connection so carousel
 * data lives in its own database.
 */
const mongoose = require("mongoose");
const logger = require("../utils/logger").child({ module: "carouselDb" });

const CAROUSEL_DB = process.env.CAROUSEL_DB;

if (!CAROUSEL_DB) {
  logger.warn("CAROUSEL_DB env var not set — carousel models will use the default CRM connection");
}

// Create a dedicated connection (or fall back to default if env var missing)
const carouselConn = CAROUSEL_DB
  ? mongoose.createConnection(CAROUSEL_DB, {
      bufferCommands: true,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    })
  : mongoose.connection; // fallback: same DB (backwards-compatible)

if (CAROUSEL_DB) {
  carouselConn.on("connected", () => logger.info("Carousel DB connected"));
  carouselConn.on("error", (err) => logger.error("Carousel DB error:", err));
}

// ---------------------------------------------------------------------------
// Re-register every carousel-related schema on the carousel connection.
// We import the *default-connection* model just to grab its .schema, then
// register a fresh model on carouselConn.
// ---------------------------------------------------------------------------

function registerModel(name, modelPath) {
  // Require the original model file — this also registers it on the default
  // connection (harmless; CRM routes still need some of these models there).
  const original = require(modelPath);
  if (carouselConn === mongoose.connection) return original; // fallback mode
  return carouselConn.model(name, original.schema);
}

const Client = registerModel("Client", "../models/Client");
const ClientImage = registerModel("ClientImage", "../models/ClientImage");
const ClientLut = registerModel("ClientLut", "../models/ClientLut");
const Carousel = registerModel("Carousel", "../models/Carousel");
const CarouselJob = registerModel("CarouselJob", "../models/CarouselJob");
const CarouselTemplate = registerModel("CarouselTemplate", "../models/CarouselTemplate");
const CarouselStyle = registerModel("CarouselStyle", "../models/CarouselStyle");
const Transcript = registerModel("Transcript", "../models/Transcript");
const SwipeFile = registerModel("SwipeFile", "../models/SwipeFile");
const ProspectProfile = registerModel("ProspectProfile", "../models/ProspectProfile");
const ThumbnailJob = registerModel("ThumbnailJob", "../models/ThumbnailJob");
const ThumbnailTemplate = registerModel("ThumbnailTemplate", "../models/ThumbnailTemplate");
const Notification = registerModel("Notification", "../models/Notification");

module.exports = {
  carouselConn,
  Client,
  ClientImage,
  ClientLut,
  Carousel,
  CarouselJob,
  CarouselTemplate,
  CarouselStyle,
  Transcript,
  SwipeFile,
  ProspectProfile,
  ThumbnailJob,
  ThumbnailTemplate,
  Notification,
};
