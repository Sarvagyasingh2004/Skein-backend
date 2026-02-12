import express from "express";
import dotenv from "dotenv";
dotenv.config();
import cors from "cors";
import connectToDB from "./config/db.js";
import chatRoutes from "./routes/chat.js";
import { app, server } from "./config/socket.js";

connectToDB();

const PORT = process.env.PORT || 3002;

app.use(express.json());
app.use(cors());

app.use("/api/v1", chatRoutes);

server.listen(PORT, () => {
  console.log(`Server is running on port : ${PORT}`);
});
