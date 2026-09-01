import fs from "fs";
import path from "path";
import { SearchIndex } from "../search/indexer";
import { runSearch } from "../search/search";
import { Document } from "../types";

function loadSampleDocuments(): Document[] {
  const filePath = path.join(__dirname, "..", "..", "data", "documents.json");
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as Document[];
}

function main() {
  const query = process.argv.slice(2).join(" ");

  if (!query) {
    console.log('Usage: npm run search "python web"');
    process.exit(1);
  }

  const index = new SearchIndex();
  index.addDocuments(loadSampleDocuments());

  const response = runSearch(index, query);

  console.log(`\nSearch results for: ${response.query}`);
  console.log(`(${response.total} results, ${response.tookMs}ms)\n`);

  response.results.forEach((result, i) => {
    console.log(`${i + 1}. ${result.title}`);
    console.log(`   ${result.url}`);
    console.log(`   score: ${result.score}`);
    console.log(`   ${result.snippet}\n`);
  });
}

main();
