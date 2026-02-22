import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getStoredHash, saveHash, hashPassword, verifyPassword, getUserId } from "./lib/auth.js";
import { connectDB, Task } from "./lib/db.js";

const MONGO_URI = process.env.MONGODB_URI;

const server = new McpServer({ name: "todo-server", version: "2.0.0" });

// ── Helper: get authenticated userId or null ──────────────────────
async function getAuthenticatedUser(password) {
  const storedHash = getStoredHash();
  if (!storedHash) return { userId: null, error: "No password set. Use setup_password first." };
  const valid = await verifyPassword(password, storedHash);
  if (!valid) return { userId: null, error: "❌ Wrong password. Your tasks are locked." };
  return { userId: getUserId(storedHash), error: null };
}

// ── TOOL 0: Setup password (first time) ──────────────────────────
server.tool(
  "setup_password",
  "Set up your password for the first time, or verify your existing password. Always call this first before any other tool.",
  { password: z.string().describe("Your chosen password (min 4 chars)") },
  async ({ password }) => {
    await connectDB(MONGO_URI);

    if (password.length < 4) {
      return { content: [{ type: "text", text: "❌ Password must be at least 4 characters." }] };
    }

    const storedHash = getStoredHash();

    // First time — no password set yet
    if (!storedHash) {
      const hash = await hashPassword(password);
      saveHash(hash);
      return {
        content: [{
          type: "text",
          text: `✅ Password set! Your identity is now linked to this password.\n⚠️  If you forget it, your tasks cannot be recovered.\n\nYou can now use: add_task, list_tasks, complete_task, delete_task`,
        }],
      };
    }

    // Returning user — verify password
    const valid = await verifyPassword(password, storedHash);
    if (!valid) {
      return { content: [{ type: "text", text: "❌ Wrong password. If you forgot it, your tasks are lost by design." }] };
    }

    const userId = getUserId(storedHash);
    const count = await Task.countDocuments({ userId });
    return {
      content: [{
        type: "text",
        text: `✅ Welcome back! Password verified.\nYou have ${count} task(s) in your list.\n\nYou can now use: add_task, list_tasks, complete_task, delete_task`,
      }],
    };
  }
);

// ── TOOL 1: Add task ──────────────────────────────────────────────
server.tool(
  "add_task",
  "Add a new task. Requires password for authentication.",
  {
    password: z.string().describe("Your password"),
    title:    z.string().describe("Task description"),
    priority: z.enum(["low", "medium", "high"]).optional(),
    dueDate:  z.string().optional().describe("YYYY-MM-DD"),
    tags:     z.array(z.string()).optional(),
  },
  async ({ password, title, priority = "medium", dueDate = null, tags = [] }) => {
    await connectDB(MONGO_URI);
    const { userId, error } = await getAuthenticatedUser(password);
    if (error) return { content: [{ type: "text", text: error }] };

    const task = await Task.create({ userId, title, priority, dueDate, tags });
    return {
      content: [{ type: "text", text: JSON.stringify({ success: true, task }, null, 2) }],
    };
  }
);

// ── TOOL 2: List tasks ────────────────────────────────────────────
server.tool(
  "list_tasks",
  "List your tasks. Requires password. Optionally filter by status, priority, or tag.",
  {
    password: z.string().describe("Your password"),
    filter:   z.enum(["all", "pending", "completed"]).optional(),
    priority: z.enum(["low", "medium", "high"]).optional(),
    tag:      z.string().optional(),
  },
  async ({ password, filter = "all", priority, tag }) => {
    await connectDB(MONGO_URI);
    const { userId, error } = await getAuthenticatedUser(password);
    if (error) return { content: [{ type: "text", text: error }] };

    const query = { userId };
    if (filter === "pending")   query.completed = false;
    if (filter === "completed") query.completed = true;
    if (priority)               query.priority = priority;
    if (tag)                    query.tags = tag;

    const tasks = await Task.find(query).sort({ completed: 1, priority: -1, createdAt: -1 });
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

// ── TOOL 3: Complete a task ───────────────────────────────────────
server.tool(
  "complete_task",
  "Mark a task as completed. Requires password.",
  {
    password: z.string().describe("Your password"),
    id:       z.string().optional().describe("Task MongoDB _id"),
    title:    z.string().optional().describe("Partial title match"),
  },
  async ({ password, id, title }) => {
    await connectDB(MONGO_URI);
    const { userId, error } = await getAuthenticatedUser(password);
    if (error) return { content: [{ type: "text", text: error }] };

    let task;
    if (id) {
      task = await Task.findOne({ _id: id, userId });
    } else if (title) {
      task = await Task.findOne({ userId, completed: false, title: { $regex: title, $options: "i" } });
    }

    if (!task) return { content: [{ type: "text", text: "❌ Task not found." }] };

    task.completed   = true;
    task.completedAt = new Date().toISOString();
    await task.save();

    return {
      content: [{ type: "text", text: JSON.stringify({ success: true, message: `✅ "${task.title}" marked complete!`, task }, null, 2) }],
    };
  }
);

// ── TOOL 4: Delete a task ─────────────────────────────────────────
server.tool(
  "delete_task",
  "Delete a task permanently. Requires password.",
  {
    password: z.string().describe("Your password"),
    id:       z.string().optional(),
    title:    z.string().optional().describe("Partial title match"),
  },
  async ({ password, id, title }) => {
    await connectDB(MONGO_URI);
    const { userId, error } = await getAuthenticatedUser(password);
    if (error) return { content: [{ type: "text", text: error }] };

    let task;
    if (id) {
      task = await Task.findOneAndDelete({ _id: id, userId });
    } else if (title) {
      task = await Task.findOneAndDelete({ userId, title: { $regex: title, $options: "i" } });
    }

    if (!task) return { content: [{ type: "text", text: "❌ Task not found." }] };
    return { content: [{ type: "text", text: `🗑️ "${task.title}" deleted.` }] };
  }
);

// ── TOOL 5: Clear completed ───────────────────────────────────────
server.tool(
  "clear_done",
  "Remove all completed tasks. Requires password.",
  { password: z.string().describe("Your password") },
  async ({ password }) => {
    await connectDB(MONGO_URI);
    const { userId, error } = await getAuthenticatedUser(password);
    if (error) return { content: [{ type: "text", text: error }] };

    const result = await Task.deleteMany({ userId, completed: true });
    return {
      content: [{ type: "text", text: `🧹 Cleared ${result.deletedCount} completed task(s).` }],
    };
  }
);

// ── Start ─────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("🚀 MCP Todo Server v2 running with MongoDB + Auth!");
