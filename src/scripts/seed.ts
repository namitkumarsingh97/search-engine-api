import "dotenv/config";
import fs from "fs";
import path from "path";
import { connectDatabase, disconnectDatabase } from "../database/connection";
import { Page } from "../database/models/Page";
import { Document } from "../types";

function loadSampleDocuments(): Document[] {
  const filePath = path.join(__dirname, "..", "..", "data", "documents.json");
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as Document[];
}

async function seed() {
  await connectDatabase();

  const documents = loadSampleDocuments();
  console.log(`[seed] loaded ${documents.length} documents from data/documents.json`);

  let upserted = 0;

  for (const doc of documents) {
    const domain = new URL(doc.url).hostname;

    await Page.findOneAndUpdate(
      { url: doc.url },
      {
        url: doc.url,
        title: doc.title,
        description: doc.content.slice(0, 200),
        content: doc.content,
        headings: doc.headings ?? "",
        domain,
        crawledAt: new Date(),
      },
      { upsert: true, new: true }
    );

    upserted++;
    console.log(`[seed] upserted: ${doc.title}`);
  }

  console.log(`[seed] done — ${upserted} pages written to MongoDB`);

  await disconnectDatabase();
  process.exit(0);
}

seed().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
