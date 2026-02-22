import mongoose from "mongoose";
import bcrypt from "bcryptjs";

// ── DB Setup ──────────────────────────────────────────────────────
let connected = false;
async function connectDB() {
  if (connected) return;
  await mongoose.connect(process.env.MONGODB_URI);
  connected = true;
}

const taskSchema = new mongoose.Schema({
  userId:      { type: String, required: true, index: true },
  title:       { type: String, required: true },
  priority:    { type: String, enum: ["low", "medium", "high"], default: "medium" },
  dueDate:     { type: String, default: null },
  tags:        { type: [String], default: [] },
  completed:   { type: Boolean, default: false },
  completedAt: { type: String, default: null },
  createdAt:   { type: String, default: () => new Date().toISOString() },
});

const Task = mongoose.models.Task || mongoose.model("Task", taskSchema);

// ── Auth Helper ───────────────────────────────────────────────────
async function resolveUserId(password) {
  if (!password) return null;
  const allHashes = await Task.distinct("userId");
  for (const hash of allHashes) {
    if (await bcrypt.compare(password, hash)) return hash;
  }
  // New user — create a stable userId from their password
  return bcrypt.hash(password, 12);
}

// ── Tool Definitions (what Cursor sees) ───────────────────────────
const TOOLS = [
  {
    name: "setup_password",
    description: "Verify your password and see your task summary. Call this first.",
    inputSchema: {
      type: "object",
      properties: {
        password: { type: "string", description: "Your password" },
      },
      required: ["password"],
    },
  },
  {
    name: "add_task",
    description: "Add a new task to your personal todo list.",
    inputSchema: {
      type: "object",
      properties: {
        password: { type: "string", description: "Your password" },
        title:    { type: "string", description: "Task description" },
        priority: { type: "string", enum: ["low", "medium", "high"] },
        dueDate:  { type: "string", description: "Due date YYYY-MM-DD" },
        tags:     { type: "array", items: { type: "string" } },
      },
      required: ["password", "title"],
    },
  },
  {
    name: "list_tasks",
    description: "List your tasks. Optionally filter by status, priority, or tag.",
    inputSchema: {
      type: "object",
      properties: {
        password: { type: "string", description: "Your password" },
        filter:   { type: "string", enum: ["all", "pending", "completed"] },
        priority: { type: "string", enum: ["low", "medium", "high"] },
        tag:      { type: "string" },
      },
      required: ["password"],
    },
  },
  {
    name: "complete_task",
    description: "Mark a task as completed by partial title match.",
    inputSchema: {
      type: "object",
      properties: {
        password: { type: "string", description: "Your password" },
        title:    { type: "string", description: "Partial title to search" },
      },
      required: ["password", "title"],
    },
  },
  {
    name: "delete_task",
    description: "Permanently delete a task by partial title match.",
    inputSchema: {
      type: "object",
      properties: {
        password: { type: "string", description: "Your password" },
        title:    { type: "string", description: "Partial title to search" },
      },
      required: ["password", "title"],
    },
  },
  {
    name: "clear_done",
    description: "Remove all completed tasks at once.",
    inputSchema: {
      type: "object",
      properties: {
        password: { type: "string", description: "Your password" },
      },
      required: ["password"],
    },
  },
];

// ── Tool Execution ────────────────────────────────────────────────
async function executeTool(name, args) {
  const { password, ...rest } = args;
  const userId = await resolveUserId(password);

  if (!userId) {
    return { error: "❌ Could not authenticate. Check your password." };
  }

  switch (name) {

    case "setup_password": {
      const total     = await Task.countDocuments({ userId });
      const pending   = await Task.countDocuments({ userId, completed: false });
      const completed = await Task.countDocuments({ userId, completed: true });

      if (total === 0) {
        return { message: "✅ Password accepted! No tasks yet — use add_task to get started." };
      }
      return {
        message: `✅ Welcome back! Password verified.`,
        summary: { total, pending, completed },
      };
    }

    case "add_task": {
      const { title, priority = "medium", dueDate = null, tags = [] } = rest;
      const task = await Task.create({ userId, title, priority, dueDate, tags });
      return { success: true, task };
    }

    case "list_tasks": {
      const { filter = "all", priority, tag } = rest;
      const query = { userId };
      if (filter === "pending")   query.completed = false;
      if (filter === "completed") query.completed = true;
      if (priority)               query.priority = priority;
      if (tag)                    query.tags = tag;

      const tasks     = await Task.find(query).sort({ completed: 1, createdAt: -1 });
      const total     = await Task.countDocuments({ userId });
      const pending   = await Task.countDocuments({ userId, completed: false });
      const completed = await Task.countDocuments({ userId, completed: true });

      return { summary: { total, pending, completed }, tasks };
    }

    case "complete_task": {
      const { title } = rest;
      const task = await Task.findOneAndUpdate(
        { userId, completed: false, title: { $regex: title, $options: "i" } },
        { completed: true, completedAt: new Date().toISOString() },
        { new: true }
      );
      if (!task) return { error: `❌ No pending task matching "${title}"` };
      return { success: true, message: `✅ "${task.title}" marked complete!`, task };
    }

    case "delete_task": {
      const { title } = rest;
      const task = await Task.findOneAndDelete({
        userId,
        title: { $regex: title, $options: "i" },
      });
      if (!task) return { error: `❌ No task matching "${title}"` };
      return { success: true, message: `🗑️ "${task.title}" deleted.` };
    }

    case "clear_done": {
      const result = await Task.deleteMany({ userId, completed: true });
      return { success: true, message: `🧹 Cleared ${result.deletedCount} completed task(s).` };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── Main MCP Handler ──────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { jsonrpc, id, method, params } = req.body;

  try {
    await connectDB();

    // ── 1. initialize ─────────────────────────────────────────────
    if (method === "initialize") {
      return res.status(200).json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "todo-server", version: "2.0.0" },
        },
      });
    }

    // ── 2. notifications/initialized (no response needed) ─────────
    if (method === "notifications/initialized") {
      return res.status(200).end();
    }

    // ── 3. tools/list ─────────────────────────────────────────────
    if (method === "tools/list") {
      return res.status(200).json({
        jsonrpc: "2.0",
        id,
        result: { tools: TOOLS },
      });
    }

    // ── 4. tools/call ─────────────────────────────────────────────
    if (method === "tools/call") {
      const { name, arguments: args } = params;
      const result = await executeTool(name, args);

      return res.status(200).json({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: !!result.error,
        },
      });
    }

    // ── Unknown method ────────────────────────────────────────────
    return res.status(200).json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });

  } catch (err) {
    console.error("MCP Error:", err);
    return res.status(200).json({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: "Internal error", data: err.message },
    });
  }
}