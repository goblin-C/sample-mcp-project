import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getStoredHash, saveHash, clearHash,
  hashPassword, verifyPassword, promptUser,
} from "./lib/auth.js";
import { connectDB, Task } from "./lib/db.js";

const MONGO_URI = process.env.MONGODB_URI;
const server = new McpServer({ name: "todo-server", version: "3.0.0" });

// Internal only — never exposed to Claude
function getSession() {
  return getStoredHash() || null;
}

function blockedResponse() {
  return {
    content: [{
      type: "text",
      // Generic message — no hints about storage, hashing, or file paths
      text: "⚠️ You need to activate your account first.\n\nSay: 'activate my account'",
    }],
  };
}

// ─────────────────────────────────────────────────────────────────
// TOOL 0: activate_account
// Neutral name — no mention of password, hash, or storage
// ─────────────────────────────────────────────────────────────────
server.tool(
  "activate_account",
  "Activate your account on this device. Must be done once before using any other tool.",
  {},
  async () => {
    await connectDB(MONGO_URI);
    const session = getSession();

    if (session) {
      const total   = await Task.countDocuments({ uid: session });
      const pending = await Task.countDocuments({ uid: session, done: false });

      return {
        content: [{
          type: "text",
          text: [
            "✅ Account already active on this device.",
            "",
            `📋 You have ${pending} pending task(s) out of ${total} total.`,
            "",
            "Try: 'Show my tasks' or 'Add a task: ...'",
          ].join("\n"),
        }],
      };
    }

    // Prompt user — generic language, no mention of password or hashing
    process.stderr.write("\n🔐 Account Activation\n");
    process.stderr.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    process.stderr.write("Enter your secret key to activate this device.\n");
    process.stderr.write("⚠️  This key cannot be recovered if lost.\n");
    process.stderr.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n");

    const key     = await promptUser("Secret key: ");
    if (!key || key.length < 4) {
      return { content: [{ type: "text", text: "❌ Key too short. Please try again." }] };
    }

    const confirm = await promptUser("Confirm key: ");
    if (key !== confirm) {
      return { content: [{ type: "text", text: "❌ Keys don't match. Please try again." }] };
    }

    // Check if returning user on a new device
    const allSessions = await Task.distinct("uid");
    let matched = null;
    for (const s of allSessions) {
      if (await verifyPassword(key, s)) { matched = s; break; }
    }

    if (matched) {
      saveHash(matched);
      const total   = await Task.countDocuments({ uid: matched });
      const pending = await Task.countDocuments({ uid: matched, done: false });
      return {
        content: [{
          type: "text",
          text: [
            "✅ Device activated! Your account has been restored.",
            "",
            `📋 ${total} task(s) found, ${pending} pending.`,
            "",
            "You won't need to activate again on this device.",
          ].join("\n"),
        }],
      };
    }

    // New user
    const token = await hashPassword(key);
    saveHash(token);

    return {
      content: [{
        type: "text",
        text: [
          "✅ Account activated on this device!",
          "",
          "You're all set. You won't need to do this again on this device.",
          "⚠️  Keep your secret key safe — it cannot be recovered.",
          "",
          "Try: 'Add a task: Buy groceries'",
        ].join("\n"),
      }],
    };
  }
);

// ─────────────────────────────────────────────────────────────────
// TOOL 1: add_task
// ─────────────────────────────────────────────────────────────────
server.tool(
  "add_task",
  "Add a new task to your list.",
  {
    title:    z.string().describe("What needs to be done"),
    priority: z.enum(["low", "medium", "high"]).optional(),
    dueDate:  z.string().optional().describe("YYYY-MM-DD"),
    tags:     z.array(z.string()).optional(),
  },
  async ({ title, priority = "medium", dueDate = null, tags = [] }) => {
    const uid = getSession();
    if (!uid) return blockedResponse();

    await connectDB(MONGO_URI);
    const task = await Task.create({ uid, title, priority, dueDate, tags });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ success: true, task }, null, 2),
      }],
    };
  }
);

// ─────────────────────────────────────────────────────────────────
// TOOL 2: list_tasks
// ─────────────────────────────────────────────────────────────────
server.tool(
  "list_tasks",
  "Show your tasks. Optionally filter by status, priority, or tag.",
  {
    filter:   z.enum(["all", "pending", "completed"]).optional(),
    priority: z.enum(["low", "medium", "high"]).optional(),
    tag:      z.string().optional(),
  },
  async ({ filter = "all", priority, tag }) => {
    const uid = getSession();
    if (!uid) return blockedResponse();

    await connectDB(MONGO_URI);

    const q = { uid };
    if (filter === "pending")   q.done = false;
    if (filter === "completed") q.done = true;
    if (priority)               q.priority = priority;
    if (tag)                    q.tags = tag;

    const tasks = await Task.find(q).sort({ done: 1, createdAt: -1 });
    const total = await Task.countDocuments({ uid });
    const pending = await Task.countDocuments({ uid, done: false });
    const completed = await Task.countDocuments({ uid, done: true });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ summary: { total, pending, completed }, tasks }, null, 2),
      }],
    };
  }
);

// ─────────────────────────────────────────────────────────────────
// TOOL 3: complete_task
// ─────────────────────────────────────────────────────────────────
server.tool(
  "complete_task",
  "Mark a task as done by partial title match.",
  { title: z.string().describe("Part of the task title") },
  async ({ title }) => {
    const uid = getSession();
    if (!uid) return blockedResponse();

    await connectDB(MONGO_URI);
    const task = await Task.findOneAndUpdate(
      { uid, done: false, title: { $regex: title, $options: "i" } },
      { done: true, doneAt: new Date().toISOString() },
      { new: true }
    );

    if (!task) {
      return { content: [{ type: "text", text: `❌ No pending task matching "${title}"` }] };
    }

    return {
      content: [{
        type: "text",
        text: `✅ "${task.title}" marked as done!`,
      }],
    };
  }
);

// ─────────────────────────────────────────────────────────────────
// TOOL 4: delete_task
// ─────────────────────────────────────────────────────────────────
server.tool(
  "delete_task",
  "Permanently remove a task by partial title match.",
  { title: z.string().describe("Part of the task title") },
  async ({ title }) => {
    const uid = getSession();
    if (!uid) return blockedResponse();

    await connectDB(MONGO_URI);
    const task = await Task.findOneAndDelete({
      uid,
      title: { $regex: title, $options: "i" },
    });

    if (!task) {
      return { content: [{ type: "text", text: `❌ No task matching "${title}"` }] };
    }

    return { content: [{ type: "text", text: `🗑️ "${task.title}" removed.` }] };
  }
);

// ─────────────────────────────────────────────────────────────────
// TOOL 5: clear_done
// ─────────────────────────────────────────────────────────────────
server.tool(
  "clear_done",
  "Remove all completed tasks.",
  {},
  async () => {
    const uid = getSession();
    if (!uid) return blockedResponse();

    await connectDB(MONGO_URI);
    const result = await Task.deleteMany({ uid, done: true });

    return {
      content: [{ type: "text", text: `🧹 Removed ${result.deletedCount} completed task(s).` }],
    };
  }
);

// ─────────────────────────────────────────────────────────────────
// TOOL 6: deactivate_device
// Neutral name — no mention of clearing password or hash
// ─────────────────────────────────────────────────────────────────
server.tool(
  "deactivate_device",
  "Deactivate your account on this device only. Your tasks remain safe.",
  {},
  async () => {
    const session = getSession();
    if (!session) {
      return { content: [{ type: "text", text: "ℹ️ No active account on this device." }] };
    }

    clearHash();
    return {
      content: [{
        type: "text",
        text: [
          "✅ This device has been deactivated.",
          "",
          "Your tasks are safe. Activate again anytime with: 'activate my account'",
        ].join("\n"),
      }],
    };
  }
);

// ── Start ─────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("🚀 Todo Server v3 ready.");