import mongoose from "mongoose";

const connectToDB = async () => {
  const url = process.env.MONGO_URI;
  if (!url) {
    throw new Error("MONGO_URI is not defined in environment variables ");
  }
  try {
    await mongoose.connect(url, {
      dbName: "microservices-chat-app",
    });
    console.log("Connected to MongoDB");
  } catch (error) {
    console.log("Failed to connect to MongoDB");
    process.exit(1);
  }
};

export default connectToDB;
