import type { NextFunction, Request, Response } from "express";
import type { IUser } from "../models/User.js";
import jwt, { type JwtPayload } from "jsonwebtoken";

export interface AuthenticatedRequest extends Request {
  user?: IUser | null;
}

export const isAuthorised = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader?.startsWith("Bearer ")) {
      res.status(401).json({
        message: "Auth error. Please Login to continue",
      });
      return;
    }
    const token = authHeader.split(" ")[1] as string;
    const JWT_SECRET = process.env.JWT_SECRET as string;
    const decodedToken = jwt.verify(token, JWT_SECRET) as JwtPayload;

    if (!decodedToken || !decodedToken.user) {
      res.status(401).json({
        success: false,
        message: "Invalid token",
      });
      return;
    }
    req.user = decodedToken.user;
    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      message: "JWT error. Please login to continue",
    });
  }
};
