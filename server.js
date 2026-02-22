/**
 * 🚀 MCP Todo Server
 * ==================
 * A simple Model Context Protocol (MCP) server that gives Claude
 * the ability to manage your tasks using natural language.
 *
 * WHAT IS MCP?
 * MCP (Model Context Protocol) is an open standard that lets AI models
 * like Claude connect to external tools and data sources. Think of it
 * like USB-C for AI — a universal connector.
 *
 * HOW THIS WORKS:
 * 1. This server exposes "tools" that Claude can call
 * 2. Claude decides when to use each tool based on your conversation
 * 3. Claude gets the results and responds to you naturally
 *
 * TOOLS PROVIDED:
 * - add_task      → Add a new task
 * - list_tasks    → List all tasks (with optional filters)
 * - complete_task → Mark a task as done
 * - delete_task   → Remove a task
 * - clear_done    → Remove all completed tasks
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ─── In-Memory Storage ───────────────────────────────────────────────────────
// In a real app, replace this with a database (e.g., Vercel KV, Supabase, etc.)
const tasks = new Map();
let nextId = 1;

function createTask(title, priority = "medium", dueDate = null, tags = []) {
  const id = String(nextId++);
  const task = {
    id,
    title,
    priority,      // low | medium | high
    dueDate,       // ISO date string or null
    tags,          // array of strings e.g. ["work", "urgent"]
    completed: false,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
  tasks.set(id, task);
  return task;
}

// ─── Seed with example tasks so it's not empty on first run ──────────────────
createTask("Set up MCP server", "high", null, ["dev", "setup"]);
createTask("Read MCP documentation", "medium", null, ["learning"]);
createTask("Deploy to Vercel", "high", null, ["dev", "deployment"]);

// ─── Create the MCP Server ───────────────────────────────────────────────────
const server = new McpServer({
  name: "todo-server",        // Name shown in MCP client
  version: "1.0.0",          // Your server version
});

// ─── TOOL 1: Add a Task ──────────────────────────────────────────────────────
server.tool(
  "add_task",
  "Add a new task to the todo list. Use this when the user wants to create, add, or remember something.",
  {
    // Zod schema defines what Claude must pass in
    title:    z.string().describe("The task description"),
    priority: z.enum(["low", "medium", "high"]).optional().describe("Task priority level"),
    dueDate:  z.string().optional().describe("Due date in YYYY-MM-DD format"),
    tags:     z.array(z.string()).optional().describe("Labels like 'work', 'personal', 'urgent'"),
  },
  async ({ title, priority = "medium", dueDate = null, tags = [] }) => {
    const task = createTask(title, priority, dueDate, tags);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `✅ Task added successfully!`,
            task,
          }, null, 2),
        },
      ],
    };
  }
);

// ─── TOOL 2: List Tasks ───────────────────────────────────────────────────────
server.tool(
  "list_tasks",
  "List tasks from the todo list. Can filter by status, priority, or tag. Use this when the user asks to see, show, or list their tasks.",
  {
    filter:   z.enum(["all", "pending", "completed"]).optional().describe("Filter by status"),
    priority: z.enum(["low", "medium", "high"]).optional().describe("Filter by priority"),
    tag:      z.string().optional().describe("Filter by a specific tag"),
  },
  async ({ filter = "all", priority, tag }) => {
    let results = Array.from(tasks.values());

    // Apply filters
    if (filter === "pending")   results = results.filter(t => !t.completed);
    if (filter === "completed") results = results.filter(t => t.completed);
    if (priority)               results = results.filter(t => t.priority === priority);
    if (tag)                    results = results.filter(t => t.tags.includes(tag));

    // Sort: high priority first, then by creation date
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    results.sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });

    const summary = {
      total: tasks.size,
      pending: Array.from(tasks.values()).filter(t => !t.completed).length,
      completed: Array.from(tasks.values()).filter(t => t.completed).length,
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            summary,
            tasks: results,
            filtered: results.length,
          }, null, 2),
        },
      ],
    };
  }
);

// ─── TOOL 3: Complete a Task ─────────────────────────────────────────────────
server.tool(
  "complete_task",
  "Mark a task as completed/done. Use when the user says they finished, completed, or did a task.",
  {
    id:    z.string().optional().describe("The task ID to complete"),
    title: z.string().optional().describe("Search by task title (partial match OK)"),
  },
  async ({ id, title }) => {
    let task;

    if (id) {
      task = tasks.get(id);
    } else if (title) {
      // Find by partial title match (case-insensitive)
      task = Array.from(tasks.values()).find(t =>
        t.title.toLowerCase().includes(title.toLowerCase()) && !t.completed
      );
    }

    if (!task) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: false, message: "Task not found" }),
        }],
      };
    }

    task.completed = true;
    task.completedAt = new Date().toISOString();

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          message: `🎉 Task "${task.title}" marked as complete!`,
          task,
        }, null, 2),
      }],
    };
  }
);

// ─── TOOL 4: Delete a Task ───────────────────────────────────────────────────
server.tool(
  "delete_task",
  "Permanently delete a task. Use when user wants to remove or delete a task entirely.",
  {
    id:    z.string().optional().describe("The task ID to delete"),
    title: z.string().optional().describe("Search by task title to delete"),
  },
  async ({ id, title }) => {
    let taskId = id;

    if (!taskId && title) {
      const found = Array.from(tasks.values()).find(t =>
        t.title.toLowerCase().includes(title.toLowerCase())
      );
      taskId = found?.id;
    }

    if (!taskId || !tasks.has(taskId)) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: false, message: "Task not found" }),
        }],
      };
    }

    const task = tasks.get(taskId);
    tasks.delete(taskId);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          message: `🗑️ Task "${task.title}" deleted.`,
        }),
      }],
    };
  }
);

// ─── TOOL 5: Clear Completed Tasks ───────────────────────────────────────────
server.tool(
  "clear_done",
  "Remove all completed tasks at once. Use when user wants to clear, clean up, or archive finished tasks.",
  {},  // No inputs needed
  async () => {
    const completed = Array.from(tasks.values()).filter(t => t.completed);
    completed.forEach(t => tasks.delete(t.id));

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          message: `🧹 Cleared ${completed.length} completed task(s).`,
          removed: completed.map(t => t.title),
        }, null, 2),
      }],
    };
  }
);

// ─── Start the Server ─────────────────────────────────────────────────────────
// StdioServerTransport = communicate via standard input/output
// This is the standard way to run MCP servers locally or in Claude Desktop
const transport = new StdioServerTransport();
await server.connect(transport);

console.error("🚀 MCP Todo Server is running!");
console.error("📋 Tools available: add_task, list_tasks, complete_task, delete_task, clear_done");