import jwt, { type SignOptions } from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET as string;

const expiresIn: NonNullable<SignOptions["expiresIn"]> =
  (process.env.JWT_EXPIRES_IN as SignOptions["expiresIn"]) ?? "7d";

export const generateToken = (user: any) => {
  return jwt.sign({ user }, JWT_SECRET, { expiresIn });
};
