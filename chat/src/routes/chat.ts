import express from "express";
import {
  createNewChat,
  getAllChats,
  getMessagesByChat,
  sendMessage,
} from "../controllers/chat.js";
import { isAuthorised } from "../middlewares/auth.js";
import { upload } from "../middlewares/multer.js";

const router = express.Router();

router.post("/chat/new", isAuthorised, createNewChat);

router.get("/chat/all", isAuthorised, getAllChats);

router.post("/message", isAuthorised, upload.single("image"), sendMessage);

router.get("/message/:chatId", isAuthorised, getMessagesByChat);

export default router;
