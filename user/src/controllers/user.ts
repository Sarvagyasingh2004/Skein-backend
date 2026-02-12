import type { Response } from "express";
import { generateToken } from "../config/generateToken.js";
import { publishToQueue } from "../config/rabbitmq.js";
import { redisClient } from "../config/redis.js";
import TryCatch from "../config/try-catch.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import User from "../models/User.js";

export const loginUser = TryCatch(async (req, res) => {
  const { email } = req.body;
  const rateLimitKey = `otp:ratelimit:${email}`;
  const rateLimit = await redisClient.get(rateLimitKey);
  if (rateLimit) {
    res.status(429).json({
      success: false,
      message: "Too many requests. Please wait before requesting new otp",
    });
    return;
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const otpKey = `otp:${email}`;
  await redisClient.set(otpKey, otp, {
    EX: 300, //5 Min
  });
  await redisClient.set(rateLimitKey, "true", {
    EX: 60, //1 Min
  });

  const message = {
    to: email,
    subject: "Your otp code",
    body: `Your otp is ${otp}. It is valid for 5 minutes`,
  };

  await publishToQueue("send-otp", message);
  res.status(200).json({
    success: true,
    message: "OTP sent to your email",
  });
});

export const verifyUser = TryCatch(async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({
      success: false,
      message: "Please provide email and otp",
    });
  }

  const otpKey = `otp:${email}`;
  const storedOtp = await redisClient.get(otpKey);
  if (!storedOtp || storedOtp !== otp) {
    return res.status(400).json({
      success: false,
      message: "Invalid or expired otp",
    });
  }

  let user = await User.findOne({ email });

  if (!user) {
    const name = email.slice(0, 8);
    user = await User.create({
      name,
      email,
    });
  }

  const token = generateToken(user);
  return res.status(200).json({
    success: true,
    message: "User verified",
    user,
    token,
  });
});

export const myProfile = TryCatch(
  async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user;
    res.json(user);
  }
);

export const updateUsername = TryCatch(
  async (req: AuthenticatedRequest, res: Response) => {
    const user = await User.findById(req.user?._id);
    if (!user) {
      res.status(404).json({
        success: false,
        message: "Please login",
      });
      return;
    }
    user.name = req.body.name;
    await user.save();
    const token = generateToken(user);
    res.json({
      success: true,
      message: "User updated",
      user,
      token,
    });
  }
);

export const getAllUsers = TryCatch(
  async (req: AuthenticatedRequest, res: Response) => {
    const users = await User.find({});
    res.json(users);
  }
);

export const getUser = TryCatch(
  async (req: AuthenticatedRequest, res: Response) => {
    const user = await User.findById(req.params.id);
    res.json(user);
  }
);
