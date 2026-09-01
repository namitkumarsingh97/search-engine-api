import * as cheerio from "cheerio";

export interface ParsedPage {
  title: string;
  headings: string;
  content: string;
  links: string[];
}

/** Turns raw HTML + its own URL into structured data for indexing. */
export function parseHtml(html: string, pageUrl: string): ParsedPage {
  const $ = cheerio.load(html);

  // Drop elements that aren't real page content.
  $("script, style, noscript, nav, footer").remove();

  const title = $("title").text().trim();
  const headings = $("h1, h2, h3").map((_, el) => $(el).text().trim()).get().join(" ");
  const content = $("body").text().replace(/\s+/g, " ").trim();

  const links = $("a[href]")
    .map((_, el) => $(el).attr("href"))
    .get()
    .map((href) => resolveUrl(href, pageUrl))
    .filter((href): href is string => href !== null);

  return { title, headings, content, links };
}

/** Resolves a possibly-relative href against the page it was found on,
 * and filters out anything that isn't a normal http(s) page link. */
function resolveUrl(href: string, baseUrl: string): string | null {
  try {
    const resolved = new URL(href, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    resolved.hash = ""; // strip #fragments so we don't treat them as separate pages
    return resolved.toString();
  } catch {
    return null;
  }
}
