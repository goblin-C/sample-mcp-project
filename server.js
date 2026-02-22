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

// ── Core: get userId from local hash (no password arg needed) ─────
function getLocalUserId() {
  const hash = getStoredHash();
  if (!hash) return null;
  return hash; // hash IS the userId in MongoDB
}

// ── Guard used by every tool except setup_password ────────────────
function notSetupResponse() {
  return {
    content: [{
      type: "text",
      text: [
        "🔐 No password found on this machine.",
        "",
        "Please set up your password first by saying:",
        "  'setup my password'",
        "",
        "This only needs to be done once on this machine.",
        "⚠️  Your password is your identity — if forgotten, tasks cannot be recovered.",
      ].join("\n"),
    }],
  };
}

// ─────────────────────────────────────────────────────────────────
// TOOL 0: setup_password
// Only tool that interacts with user directly
// ─────────────────────────────────────────────────────────────────
server.tool(
  "setup_password",
  "Set up your password for the first time on this machine. Prompts user securely. Must be called before any other tool.",
  {},
  async () => {
    await connectDB(MONGO_URI);
    const existingHash = getStoredHash();

    // ── Already set up on this machine ───────────────────────────
    if (existingHash) {
      const total     = await Task.countDocuments({ userId: existingHash });
      const pending   = await Task.countDocuments({ userId: existingHash, completed: false });
      const completed = await Task.countDocuments({ userId: existingHash, completed: true });

      return {
        content: [{
          type: "text",
          text: [
            "✅ Password already saved on this machine!",
            "",
            `📋 Your tasks: ${total} total, ${pending} pending, ${completed} completed`,
            "",
            "You're all set. Try:",
            "  → 'Show my pending tasks'",
            "  → 'Add a task: ...'",
            "  → 'Mark ... as done'",
          ].join("\n"),
        }],
      };
    }

    // ── First time on this machine — prompt user ──────────────────
    process.stderr.write("\n");
    process.stderr.write("🔐 MCP Todo — First Time Setup\n");
    process.stderr.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    process.stderr.write("Your password is your identity across all machines.\n");
    process.stderr.write("⚠️  If you forget it, your tasks CANNOT be recovered.\n");
    process.stderr.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n");

    const password = await promptUser("Enter a password (min 4 chars): ");

    if (!password || password.length < 4) {
      return {
        content: [{ type: "text", text: "❌ Password too short. Please try again." }],
      };
    }

    const confirm = await promptUser("Confirm your password: ");

    if (password !== confirm) {
      return {
        content: [{ type: "text", text: "❌ Passwords don't match. Please try again." }],
      };
    }

    // Check if this password matches an existing user in MongoDB
    process.stderr.write("\n⏳ Verifying with database...\n");
    const allHashes = await Task.distinct("userId");
    let matchedHash = null;

    for (const hash of allHashes) {
      if (await verifyPassword(password, hash)) {
        matchedHash = hash;
        break;
      }
    }

    if (matchedHash) {
      // Returning user on a new machine — restore their hash
      saveHash(matchedHash);
      const total   = await Task.countDocuments({ userId: matchedHash });
      const pending = await Task.countDocuments({ userId: matchedHash, completed: false });

      return {
        content: [{
          type: "text",
          text: [
            "✅ Welcome back! Password verified & saved to this machine.",
            "",
            `📋 Your tasks restored: ${total} total, ${pending} pending`,
            "",
            "You won't need to enter your password again on this machine.",
          ].join("\n"),
        }],
      };
    }

    // Brand new user — create and save hash
    process.stderr.write("✨ Creating new account...\n");
    const newHash = await hashPassword(password);
    saveHash(newHash);

    return {
      content: [{
        type: "text",
        text: [
          "✅ Password set & saved to this machine!",
          "",
          "🎉 Your account is ready. You won't need to enter",
          "   your password again on this machine.",
          "",
          "⚠️  Remember your password — it cannot be recovered.",
          "",
          "Try: 'Add a task: Buy groceries, high priority'",
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
  "Add a new task to your todo list. Password is auto-read from this machine.",
  {
    title:    z.string().describe("Task description"),
    priority: z.enum(["low", "medium", "high"]).optional(),
    dueDate:  z.string().optional().describe("Due date YYYY-MM-DD"),
    tags:     z.array(z.string()).optional(),
  },
  async ({ title, priority = "medium", dueDate = null, tags = [] }) => {
    const userId = getLocalUserId();
    if (!userId) return notSetupResponse();

    await connectDB(MONGO_URI);
    const task = await Task.create({ userId, title, priority, dueDate, tags });

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
  "List your tasks. Filter by status, priority, or tag. Password is auto-read from this machine.",
  {
    filter:   z.enum(["all", "pending", "completed"]).optional(),
    priority: z.enum(["low", "medium", "high"]).optional(),
    tag:      z.string().optional(),
  },
  async ({ filter = "all", priority, tag }) => {
    const userId = getLocalUserId();
    if (!userId) return notSetupResponse();

    await connectDB(MONGO_URI);

    const query = { userId };
    if (filter === "pending")   query.completed = false;
    if (filter === "completed") query.completed = true;
    if (priority)               query.priority  = priority;
    if (tag)                    query.tags      = tag;

    const tasks     = await Task.find(query).sort({ completed: 1, createdAt: -1 });
    const total     = await Task.countDocuments({ userId });
    const pending   = await Task.countDocuments({ userId, completed: false });
    const completed = await Task.countDocuments({ userId, completed: true });

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
  "Mark a task as completed by partial title match. Password is auto-read from this machine.",
  {
    title: z.string().describe("Partial title of the task to complete"),
  },
  async ({ title }) => {
    const userId = getLocalUserId();
    if (!userId) return notSetupResponse();

    await connectDB(MONGO_URI);
    const task = await Task.findOneAndUpdate(
      { userId, completed: false, title: { $regex: title, $options: "i" } },
      { completed: true, completedAt: new Date().toISOString() },
      { new: true }
    );

    if (!task) {
      return {
        content: [{ type: "text", text: `❌ No pending task matching "${title}"` }],
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          message: `✅ "${task.title}" marked as complete!`,
          task,
        }, null, 2),
      }],
    };
  }
);

// ─────────────────────────────────────────────────────────────────
// TOOL 4: delete_task
// ─────────────────────────────────────────────────────────────────
server.tool(
  "delete_task",
  "Permanently delete a task by partial title match. Password is auto-read from this machine.",
  {
    title: z.string().describe("Partial title of the task to delete"),
  },
  async ({ title }) => {
    const userId = getLocalUserId();
    if (!userId) return notSetupResponse();

    await connectDB(MONGO_URI);
    const task = await Task.findOneAndDelete({
      userId,
      title: { $regex: title, $options: "i" },
    });

    if (!task) {
      return {
        content: [{ type: "text", text: `❌ No task matching "${title}"` }],
      };
    }

    return {
      content: [{ type: "text", text: `🗑️ "${task.title}" deleted successfully.` }],
    };
  }
);

// ─────────────────────────────────────────────────────────────────
// TOOL 5: clear_done
// ─────────────────────────────────────────────────────────────────
server.tool(
  "clear_done",
  "Remove all your completed tasks at once. Password is auto-read from this machine.",
  {},
  async () => {
    const userId = getLocalUserId();
    if (!userId) return notSetupResponse();

    await connectDB(MONGO_URI);
    const result = await Task.deleteMany({ userId, completed: true });

    return {
      content: [{
        type: "text",
        text: `🧹 Cleared ${result.deletedCount} completed task(s).`,
      }],
    };
  }
);

// ─────────────────────────────────────────────────────────────────
// TOOL 6: reset_password
// ─────────────────────────────────────────────────────────────────
server.tool(
  "reset_password",
  "Clear the saved password from this machine. You will need to re-enter it next time.",
  {},
  async () => {
    const hash = getStoredHash();
    if (!hash) {
      return {
        content: [{ type: "text", text: "ℹ️ No password is currently saved on this machine." }],
      };
    }

    clearHash();
    return {
      content: [{
        type: "text",
        text: [
          "✅ Password cleared from this machine.",
          "",
          "Your tasks are safe in MongoDB — they're identified by your password.",
          "Run setup_password again to reconnect to your tasks.",
        ].join("\n"),
      }],
    };
  }
);

// ── Start Server ──────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("🚀 MCP Todo Server v3 — password auto-managed!");