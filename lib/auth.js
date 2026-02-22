import fs from "fs";
import path from "path";
import os from "os";
import bcrypt from "bcryptjs";

// Stored in user's home dir so it persists across sessions
const AUTH_DIR  = path.join(os.homedir(), ".mcp-todo");
const AUTH_FILE = path.join(AUTH_DIR, "auth.json");

// Ensure the directory exists
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

export function getStoredHash() {
  try {
    if (!fs.existsSync(AUTH_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
    return data.hash || null;
  } catch { return null; }
}

export function saveHash(hash) {
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ hash }, null, 2));
}

export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// The userId IS the hash — same password = same userId = same tasks
export function getUserId(hash) {
  return hash; // We use the stored hash as the stable userId in MongoDB
}