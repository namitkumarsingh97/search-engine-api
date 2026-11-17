import fs from "fs";
import path from "path";
// Import the inner module: pdf-parse's index.js runs a debug routine when it has no parent.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse: (buf: Buffer) => Promise<{ text: string }> = require("pdf-parse/lib/pdf-parse.js");

const MAX_TEXT_CHARS = 200_000;
const MAX_PDF_BYTES = 25 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".csv", ".json", ".xml", ".html", ".htm", ".log", ".yml", ".yaml",
  ".js", ".ts", ".tsx", ".jsx", ".py", ".java", ".c", ".cpp", ".cs", ".go", ".rs", ".sql", ".css",
]);

/** Best-effort text extraction so file contents become searchable. Never throws. */
export async function extractText(filePath: string, name: string, mimeType: string): Promise<string> {
  try {
    const ext = path.extname(name).toLowerCase();

    if (mimeType.startsWith("text/") || TEXT_EXTENSIONS.has(ext)) {
      const fd = await fs.promises.open(filePath, "r");
      try {
        const buf = Buffer.alloc(MAX_TEXT_CHARS * 2);
        const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
        return buf.subarray(0, bytesRead).toString("utf8").slice(0, MAX_TEXT_CHARS);
      } finally {
        await fd.close();
      }
    }

    if (mimeType === "application/pdf" || ext === ".pdf") {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > MAX_PDF_BYTES) return "";
      const parsed = await pdfParse(await fs.promises.readFile(filePath));
      return parsed.text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
    }
  } catch (err) {
    console.error(`[drive] text extraction failed for ${name}:`, err);
  }
  return "";
}
