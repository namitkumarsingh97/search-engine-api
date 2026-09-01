import mongoose from "mongoose";

export async function connectDatabase(): Promise<void> {
  const uri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/mini-search";

  mongoose.connection.on("connected", () => {
    console.log(`[db] connected to ${uri}`);
  });

  mongoose.connection.on("error", (err) => {
    console.error("[db] connection error:", err);
  });

  await mongoose.connect(uri);
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}
