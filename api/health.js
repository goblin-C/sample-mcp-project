export default function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json({
      status: "ok",
      server: "MCP Todo Server",
      version: "1.0.0",
      timestamp: new Date().toISOString(),
      tools: ["add_task", "list_tasks", "complete_task", "delete_task", "clear_done"],
    });
  }