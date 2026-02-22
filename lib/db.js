import mongoose from "mongoose";

let connected = false;

export async function connectDB(uri) {
  if (connected) return;
  await mongoose.connect(uri);
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

export const Task = mongoose.model("Task", taskSchema);