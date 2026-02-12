import express from "express";
import {
  getAllUsers,
  getUser,
  loginUser,
  myProfile,
  updateUsername,
  verifyUser,
} from "../controllers/user.js";
import { isAuthorised } from "../middleware/auth.js";

const router = express.Router();

router.post("/login", loginUser);
router.post("/verify", verifyUser);
router.get("/me", isAuthorised, myProfile);
router.get("/users/all", isAuthorised, getAllUsers);
router.get("/user/:id", getUser);
router.post("/user/update", isAuthorised, updateUsername);

export default router;
