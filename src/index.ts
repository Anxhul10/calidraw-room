import debug from "debug";
import express from "express";
import http from "http";
import { Server as SocketIO } from "socket.io";
import invoiceRoutes from "./routes/invoiceRoutes";
import { createNegotiationRoutes } from "./routes/negotiationRoutes";
import { setupNegotiationSocketHandlers } from "./socket/negotiationSocket";

type UserToFollow = {
  socketId: string;
  username: string;
};
type OnUserFollowedPayload = {
  userToFollow: UserToFollow;
  action: "FOLLOW" | "UNFOLLOW";
};

const serverDebug = debug("server");
const ioDebug = debug("io");
const socketDebug = debug("socket");

require("dotenv").config(
  process.env.NODE_ENV !== "development"
    ? { path: ".env.production" }
    : { path: ".env.development" },
);

const app = express();
const rawPort = parseInt(process.env.PORT || "", 10);
const port = !isNaN(rawPort) && rawPort > 0 ? rawPort : 3002;
const configuredOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const corsOrigin =
  configuredOrigins.length > 1
    ? configuredOrigins
    : configuredOrigins[0] || "*";

// Enable CORS for API routes
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-user-id",
  );
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// JSON & body parsing with 50mb limit for canvas images
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use(express.static("public"));

app.get("/", (req, res) => {
  res.send("Excalidraw collaboration server is up :)");
});

// Mount Invoice API
app.use("/api/invoices", invoiceRoutes);

const server = http.createServer(app);

let io: SocketIO;
try {
  io = new SocketIO(server, {
    transports: ["websocket", "polling"],
    cors: {
      allowedHeaders: ["Content-Type", "Authorization", "x-user-id"],
      origin: corsOrigin,
      credentials: true,
    },
    allowEIO3: true,
  });

  // Mount Negotiation & PayPal routes
  app.use("/api/negotiation", createNegotiationRoutes(io));
  app.use("/api/paypal", createNegotiationRoutes(io));

  server.listen(port, () => {
    console.log(`Calidraw server listening on port: ${port}`);
    serverDebug(`listening on port: ${port}`);
  });

  io.on("connection", (socket) => {
    ioDebug("connection established!");
    io.to(`${socket.id}`).emit("init-room");

    // Attach negotiation socket handlers
    setupNegotiationSocketHandlers(io, socket);

    socket.on("join-room", async (roomID) => {
      socketDebug(`${socket.id} has joined ${roomID}`);
      await socket.join(roomID);
      const sockets = await io.in(roomID).fetchSockets();
      if (sockets.length <= 1) {
        io.to(`${socket.id}`).emit("first-in-room");
      } else {
        socketDebug(`${socket.id} new-user emitted to room ${roomID}`);
        socket.broadcast.to(roomID).emit("new-user", socket.id);
      }

      io.in(roomID).emit(
        "room-user-change",
        sockets.map((socket) => socket.id),
      );
    });

    socket.on(
      "server-broadcast",
      (roomID: string, encryptedData: ArrayBuffer, iv: Uint8Array) => {
        socketDebug(`${socket.id} sends update to ${roomID}`);
        socket.broadcast.to(roomID).emit("client-broadcast", encryptedData, iv);
      },
    );

    socket.on(
      "server-volatile-broadcast",
      (roomID: string, encryptedData: ArrayBuffer, iv: Uint8Array) => {
        socketDebug(`${socket.id} sends volatile update to ${roomID}`);
        socket.volatile.broadcast
          .to(roomID)
          .emit("client-broadcast", encryptedData, iv);
      },
    );

    socket.on("user-follow", async (payload: OnUserFollowedPayload) => {
      const roomID = `follow@${payload.userToFollow.socketId}`;

      switch (payload.action) {
        case "FOLLOW": {
          await socket.join(roomID);

          const sockets = await io.in(roomID).fetchSockets();
          const followedBy = sockets.map((socket) => socket.id);

          io.to(payload.userToFollow.socketId).emit(
            "user-follow-room-change",
            followedBy,
          );

          break;
        }
        case "UNFOLLOW": {
          await socket.leave(roomID);

          const sockets = await io.in(roomID).fetchSockets();
          const followedBy = sockets.map((socket) => socket.id);

          io.to(payload.userToFollow.socketId).emit(
            "user-follow-room-change",
            followedBy,
          );

          break;
        }
      }
    });

    socket.on("disconnecting", async () => {
      socketDebug(`${socket.id} has disconnected`);
      for (const roomID of Array.from(socket.rooms)) {
        const otherClients = (await io.in(roomID).fetchSockets()).filter(
          (_socket) => _socket.id !== socket.id,
        );

        const isFollowRoom = roomID.startsWith("follow@");

        if (!isFollowRoom && otherClients.length > 0) {
          socket.broadcast.to(roomID).emit(
            "room-user-change",
            otherClients.map((socket) => socket.id),
          );
        }

        if (isFollowRoom && otherClients.length === 0) {
          const socketId = roomID.replace("follow@", "");
          io.to(socketId).emit("broadcast-unfollow");
        }
      }
    });

    socket.on("disconnect", () => {
      socket.removeAllListeners();
      socket.disconnect();
    });
  });
} catch (error) {
  console.error(error);
}
