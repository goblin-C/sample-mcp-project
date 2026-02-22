import mongoose from "mongoose";
import bcrypt from "bcryptjs";

// ── DB Connection ─────────────────────────────────────────────────
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

// ── Handler ───────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-password");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    await connectDB();

    // Password comes in via header: x-password
    const password = req.headers["x-password"];
    if (!password) {
      return res.status(401).json({ error: "Missing x-password header" });
    }

    // Find user by checking password against all stored hashes
    // We query MongoDB for a userId that matches the bcrypt hash
    // Since userId IS the hash, we need to find it by comparing
    const allUserIds = await Task.distinct("userId");
    let userId = null;

    for (const hash of allUserIds) {
      const match = await bcrypt.compare(password, hash);
      if (match) { userId = hash; break; }
    }

    // New user — hash their password and use as userId
    if (!userId) {
      userId = await bcrypt.hash(password, 12);
    }

    // ── GET /api/tasks ──────────────────────────────────────────
    if (req.method === "GET") {
      const { filter = "all", priority, tag } = req.query;

      const query = { userId };
      if (filter === "pending")   query.completed = false;
      if (filter === "completed") query.completed = true;
      if (priority)               query.priority = priority;
      if (tag)                    query.tags = tag;

      const tasks     = await Task.find(query).sort({ completed: 1, createdAt: -1 });
      const total     = await Task.countDocuments({ userId });
      const pending   = await Task.countDocuments({ userId, completed: false });
      const completed = await Task.countDocuments({ userId, completed: true });

      return res.status(200).json({
        summary: { total, pending, completed },
        tasks,
      });
    }

    // ── POST /api/tasks ─────────────────────────────────────────
    if (req.method === "POST") {
      const { title, priority = "medium", dueDate = null, tags = [] } = req.body;
      if (!title) return res.status(400).json({ error: "title is required" });

      const task = await Task.create({ userId, title, priority, dueDate, tags });
      return res.status(201).json({ success: true, task });
    }

    // ── DELETE /api/tasks?done=true ─────────────────────────────
    if (req.method === "DELETE" && req.query.done === "true") {
      const result = await Task.deleteMany({ userId, completed: true });
      return res.status(200).json({
        success: true,
        message: `Cleared ${result.deletedCount} completed task(s)`,
      });
    }

    return res.status(405).json({ error: "Method not allowed" });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
}