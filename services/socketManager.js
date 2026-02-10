const { Server } = require("socket.io");

let io = null;

function init(httpServer, allowedOrigins) {
  io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    console.log(`[socket] Client connected: ${socket.id}`);

    socket.on("join:account", (accountId) => {
      if (accountId) {
        socket.join(`account:${accountId}`);
        console.log(`[socket] ${socket.id} joined account:${accountId}`);
      }
    });

    socket.on("disconnect", () => {
      console.log(`[socket] Client disconnected: ${socket.id}`);
    });
  });

  return io;
}

function getIO() {
  return io;
}

module.exports = { init, getIO };
