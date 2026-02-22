import mongoose from "mongoose";

let connected = false;

export async function connectDB(uri) {
  if (connected) return;
  await mongoose.connect(uri);
  connected = true;
}

const schema = new mongoose.Schema({
  uid:      { type: String, required: true, index: true },
  title:    { type: String, required: true },
  priority: { type: String, enum: ["low", "medium", "high"], default: "medium" },
  dueDate:  { type: String, default: null },
  tags:     { type: [String], default: [] },
  done:     { type: Boolean, default: false },
  doneAt:   { type: String, default: null },
  createdAt:{ type: String, default: () => new Date().toISOString() },
});

export const Task = mongoose.model("Task", schema);