import mongoose from "mongoose";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  let dbStatus = "disconnected";
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    dbStatus = "connected";
  } catch (e) {
    dbStatus = "error: " + e.message;
  }

  return res.status(200).json({
    status: "ok",
    server: "MCP Todo Server",
    version: "2.0.0",
    timestamp: new Date().toISOString(),
    tools: ["setup_password", "add_task", "list_tasks", "complete_task", "delete_task", "clear_done"],
  });
}