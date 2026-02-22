import fs from "fs";
import path from "path";
import os from "os";
import bcrypt from "bcryptjs";
import readline from "readline";

const AUTH_DIR  = path.join(os.homedir(), ".mcp-todo");
const AUTH_FILE = path.join(AUTH_DIR, "auth.json");

// Ensure dir exists
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

export function getStoredHash() {
  try {
    if (!fs.existsSync(AUTH_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
    return data.hash || null;
  } catch { return null; }
}

export function saveHash(hash) {
  fs.writeFileSync(
    AUTH_FILE,
    JSON.stringify({ hash, savedAt: new Date().toISOString() }, null, 2)
  );
}

export function clearHash() {
  if (fs.existsSync(AUTH_FILE)) fs.unlinkSync(AUTH_FILE);
}

export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// Prompt user securely via stderr (doesn't interfere with MCP stdio)
export function promptUser(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    process.stderr.write(question);
    rl.question("", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}