import { type NextFunction, type Request, type Response } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";
import type { Document } from "mongoose";

interface IUser extends Document {
  _id: string;
  name: string;
  email: string;
}

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
        message: "Auth error. Please login to continue",
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
