import { Server, Socket } from "socket.io";
import http from "http";
import express from "express";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";

const app = express();

const server = http.createServer(app);

const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((o) => o.trim())
  : ["http://localhost:3000", "http://localhost:3003"];

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

export const connectSocketAdapter = async () => {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL is not defined in environment variables");
  }
  const pubClient = createClient({ url });
  const subClient = pubClient.duplicate();

  pubClient.on("error", (err) => console.error("Socket pub client:", err));
  subClient.on("error", (err) => console.error("Socket sub client:", err));

  await Promise.all([pubClient.connect(), subClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));
  console.log("Socket.IO adapter connected to Redis");
};

const userIdOf = (socket: { handshake: { query: any } }): string | undefined => {
  const id = socket.handshake.query.userId;
  return typeof id === "string" && id !== "undefined" ? id : undefined;
};

export const getOnlineUsers = async (): Promise<string[]> => {
  const sockets = await io.fetchSockets();
  return [...new Set(sockets.map(userIdOf).filter(Boolean))] as string[];
};

export const isUserInChatRoom = async (
  chatId: string,
  userId: string,
): Promise<boolean> => {
  const sockets = await io.in(chatId).fetchSockets();
  return sockets.some((socket) => userIdOf(socket) === userId);
};

const broadcastPresence = async () => {
  io.emit("getOnlineUser", await getOnlineUsers());
};

io.on("connection", async (socket: Socket) => {
  const userId = userIdOf(socket);

  if (userId) {
    socket.join(userId);
  }

  await broadcastPresence();

  socket.on("typing", (data) => {
    socket.to(data.chatId).emit("userTyping", {
      chatId: data.chatId,
      userId: data.userId,
    });
  });

  socket.on("stopTyping", (data) => {
    socket.to(data.chatId).emit("userStoppedTyping", {
      chatId: data.chatId,
      userId: data.userId,
    });
  });

  socket.on("joinChat", (chatId) => {
    socket.join(chatId);
  });

  socket.on("leaveChat", (chatId) => {
    socket.leave(chatId);
  });

  socket.on("disconnect", async () => {
    await broadcastPresence();
  });
});

export { app, server, io };
