const { Server } = require("socket.io");
const Account = require("../models/Account");
const SenderAccount = require("../models/SenderAccount");
const OutboundAccount = require("../models/OutboundAccount");
const { computeDailyLimit } = require("../utils/computeDailyLimit");

let io = null;

// Maps socket.id → { accountId, senderId }
const senderSockets = new Map();

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
    console.log(`[socket] Client connected: ${socket.id}`);

    // Dashboard joins by account_id directly
    socket.on("join:account", (accountId) => {
      if (accountId) {
        socket.join(`account:${accountId}`);
        console.log(`[socket] ${socket.id} joined account:${accountId}`);
      }
    });

    // Extension joins by token or API key
    socket.on("auth:apikey", async (payload) => {
      try {
        const token = typeof payload === "object" ? payload.token : null;
        const browserId = typeof payload === "object" ? payload.browser_id : null;

        // --- Token-based auth (new extension) ---
        if (token && token.startsWith("oat_")) {
          const outbound = await OutboundAccount.findOne({ browser_token: token }).lean();
          if (!outbound) {
            socket.emit("auth:error", { error: "Invalid browser token" });
            return;
          }

          const account = await Account.findById(outbound.account_id).lean();
          if (!account || account.disabled) {
            socket.emit("auth:error", { error: "Account not found or disabled" });
            return;
          }

          const dailyLimit = computeDailyLimit(outbound);

          const sender = await SenderAccount.findOneAndUpdate(
            { outbound_account_id: outbound._id },
            {
              $set: {
                account_id: account._id,
                ig_username: outbound.username,
                browser_id: browserId,
                status: "online",
                last_seen: new Date(),
                socket_id: socket.id,
                daily_limit: dailyLimit,
              },
            },
            { upsert: true, new: true },
          );

          socket.join(`account:${account._id}`);

          senderSockets.set(socket.id, {
            accountId: account._id.toString(),
            senderId: sender._id.toString(),
          });

          socket.emit("auth:ok", {
            account_id: account._id,
            sender_id: sender._id,
            outbound_account: {
              _id: outbound._id,
              username: outbound.username,
              status: outbound.status,
            },
            daily_limit: dailyLimit,
          });

          emitToAccount(account._id.toString(), "sender:online", {
            sender_id: sender._id,
            ig_username: outbound.username,
          });

          console.log(
            `[socket] ${socket.id} authed via token → sender ${outbound.username} → account:${account._id}`,
          );
          return;
        }

        // --- Legacy API key auth (backwards-compatible) ---
        const apiKey = typeof payload === "string" ? payload : payload.apiKey;
        const igUsername = typeof payload === "object" ? payload.ig_username : null;

        const account = await Account.findOne({ api_key: apiKey }).lean();
        if (!account || account.disabled) {
          socket.emit("auth:error", { error: "Invalid API key" });
          return;
        }

        socket.join(`account:${account._id}`);

        // If extension sent ig_username, auto-create/update sender
        if (igUsername) {
          const sender = await SenderAccount.findOneAndUpdate(
            { account_id: account._id, ig_username: igUsername },
            {
              $set: {
                status: "online",
                last_seen: new Date(),
                socket_id: socket.id,
              },
            },
            { upsert: true, new: true },
          );

          senderSockets.set(socket.id, {
            accountId: account._id.toString(),
            senderId: sender._id.toString(),
          });

          socket.emit("auth:ok", {
            account_id: account._id,
            sender_id: sender._id,
          });

          emitToAccount(account._id.toString(), "sender:online", {
            sender_id: sender._id,
            ig_username: igUsername,
          });

          console.log(
            `[socket] ${socket.id} authed as sender ${igUsername} → account:${account._id}`,
          );
        } else {
          socket.emit("auth:ok", { account_id: account._id });
          console.log(
            `[socket] ${socket.id} authed via API key → account:${account._id}`,
          );
        }
      } catch (err) {
        console.error("[socket] auth:apikey error:", err);
        socket.emit("auth:error", { error: "Auth failed" });
      }
    });

    // Extension sends pong → broadcast to account room (dashboard sees it)
    socket.on("ext:pong", (data) => {
      const rooms = [...socket.rooms];
      const accountRoom = rooms.find((r) => r.startsWith("account:"));
      if (accountRoom) {
        io.to(accountRoom).emit("ext:pong", data);
        console.log(`[socket] ext:pong from ${socket.id} → ${accountRoom}`);
      }
    });

    socket.on("disconnect", async () => {
      console.log(`[socket] Client disconnected: ${socket.id}`);

      const senderInfo = senderSockets.get(socket.id);
      if (senderInfo) {
        senderSockets.delete(socket.id);

        try {
          await SenderAccount.findByIdAndUpdate(senderInfo.senderId, {
            $set: {
              status: "offline",
              last_seen: new Date(),
              socket_id: null,
            },
          });

          emitToAccount(senderInfo.accountId, "sender:offline", {
            sender_id: senderInfo.senderId,
          });
        } catch (err) {
          console.error("[socket] disconnect sender update error:", err);
        }
      }
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
    console.warn(`[socket] emitToAccount: no sockets in room ${room} for event ${event}`);
    return false;
  }

  return true;
}

function emitToSender(senderId, event, data) {
  if (!io) return;
  for (const [socketId, info] of senderSockets) {
    if (info.senderId === senderId.toString()) {
      io.to(socketId).emit(event, data);
      break;
    }
  }
}

function getIO() {
  return io;
}

module.exports = { init, getIO, emitToAccount, emitToSender };
