const logger = require("../utils/logger").child({ module: "socketManager" });
const { Server } = require("socket.io");
const Account = require("../models/Account");

let io = null;

function init(httpServer, allowedOrigins) {
  io = new Server(httpServer, {
    cors: {
      origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        if (origin.startsWith("chrome-extension://")) return callback(null, true);
        return callback(new Error("CORS blocked: " + origin));
      },
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    logger.info(`[socket] Client connected: ${socket.id}`);

    // Dashboard joins by account_id directly
    socket.on("join:account", (accountId) => {
      if (accountId) {
        socket.join(`account:${accountId}`);
        logger.info(`[socket] ${socket.id} joined account:${accountId}`);
      }
    });

    // API-key clients join their account room
    socket.on("auth:apikey", async (payload) => {
      try {
        const apiKey = typeof payload === "string" ? payload : payload?.apiKey;
        const account = apiKey ? await Account.findOne({ api_key: apiKey }).lean() : null;
        if (!account || account.disabled || account.deleted) {
          socket.emit("auth:error", { error: "Invalid API key" });
          return;
        }
        socket.join(`account:${account._id}`);
        socket.emit("auth:ok", { account_id: account._id });
        logger.info(`[socket] ${socket.id} authed via API key → account:${account._id}`);
      } catch (err) {
        logger.error("[socket] auth:apikey error:", err);
        socket.emit("auth:error", { error: "Auth failed" });
      }
    });

    socket.on("disconnect", () => {
      logger.info(`[socket] Client disconnected: ${socket.id}`);
    });
  });

  return io;
}

function emitToAccount(accountId, event, data) {
  if (!io) return false;

  const room = `account:${accountId}`;
  const sockets = io.sockets.adapter.rooms.get(room);
  const memberCount = sockets ? sockets.size : 0;

  io.to(room).emit(event, data);

  if (memberCount === 0) {
    logger.warn(`[socket] emitToAccount: no sockets in room ${room} for event ${event}`);
    return false;
  }

  return true;
}

function getIO() {
  return io;
}

module.exports = { init, getIO, emitToAccount };
