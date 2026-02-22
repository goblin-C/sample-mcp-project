const tasks = new Map();
let nextId = 1;

function seed() {
  if (tasks.size === 0) {
    const add = (title, priority, tags) => {
      const id = String(nextId++);
      tasks.set(id, { id, title, priority, tags, completed: false, createdAt: new Date().toISOString(), completedAt: null, dueDate: null });
    };
    add("Set up MCP server", "high", ["dev"]);
    add("Test with MCP Inspector", "medium", ["dev"]);
    add("Deploy to Vercel", "high", ["dev", "deployment"]);
  }
}

export default function handler(req, res) {
  seed();
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // GET /api/tasks
  if (req.method === "GET") {
    const { filter = "all", priority, tag } = req.query;
    let results = Array.from(tasks.values());
    if (filter === "pending")   results = results.filter(t => !t.completed);
    if (filter === "completed") results = results.filter(t => t.completed);
    if (priority)               results = results.filter(t => t.priority === priority);
    if (tag)                    results = results.filter(t => t.tags.includes(tag));

    const order = { high: 0, medium: 1, low: 2 };
    results.sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      return order[a.priority] - order[b.priority];
    });

    return res.status(200).json({
      summary: {
        total: tasks.size,
        pending: Array.from(tasks.values()).filter(t => !t.completed).length,
        completed: Array.from(tasks.values()).filter(t => t.completed).length,
      },
      tasks: results,
    });
  }

  // POST /api/tasks
  if (req.method === "POST") {
    const { title, priority = "medium", dueDate = null, tags = [] } = req.body;
    if (!title) return res.status(400).json({ error: "title is required" });

    const id = String(nextId++);
    const task = { id, title, priority, dueDate, tags, completed: false, createdAt: new Date().toISOString(), completedAt: null };
    tasks.set(id, task);
    return res.status(201).json({ success: true, task });
  }

  // DELETE /api/tasks?done=true
  if (req.method === "DELETE" && req.query.done === "true") {
    const done = Array.from(tasks.values()).filter(t => t.completed);
    done.forEach(t => tasks.delete(t.id));
    return res.status(200).json({ success: true, message: `Cleared ${done.length} task(s)`, removed: done.map(t => t.title) });
  }

  return res.status(405).json({ error: "Method not allowed" });
}