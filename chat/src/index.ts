import express from "express";
import dotenv from "dotenv";
dotenv.config();
import cors from "cors";
import connectToDB from "./config/db.js";
import chatRoutes from "./routes/chat.js";
import { app, server, connectSocketAdapter } from "./config/socket.js";

await connectToDB();
await connectSocketAdapter();

const PORT = process.env.PORT || 3002;

const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((o) => o.trim())
  : ["http://localhost:3000", "http://localhost:3003"];

app.use(express.json());
app.use(cors({ origin: allowedOrigins, credentials: true }));

app.use("/api/v1", chatRoutes);

server.listen(PORT, () => {
  console.log(`Server is running on port : ${PORT}`);
});
