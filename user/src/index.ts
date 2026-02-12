import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import connectToDB from "./config/db.js";
import { connectRedis } from "./config/redis.js";
import userRoutes from "./routes/user.js";
import { connectRabbitMQ } from "./config/rabbitmq.js";

dotenv.config();
const app = express();

app.use(express.json());
app.use(cors());

//routes
app.use("/api/v1", userRoutes);

await connectToDB();

await connectRabbitMQ();

await connectRedis();

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
