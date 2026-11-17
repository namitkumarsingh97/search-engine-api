import { DOC_TYPES, DocType } from "../types";
import { tokenize } from "./tokenizer";

export interface ParsedQuery {
  raw: string;
  /** Words to match and rank by (includes the words inside quoted phrases). */
  terms: string[];
  /** Quoted phrases: every word must appear, next to each other, in order. */
  phrases: string[][];
  /** Words after a "-": documents containing them are dropped. */
  excluded: string[];
  /** site:example.com restricts web results to that domain (and subdomains). */
  site?: string;
  /** type:video etc. restricts to one kind of content. */
  type?: DocType;
}

/**
 * Understands a small, familiar syntax on top of plain words:
 *   "exact phrase"   -unwanted   site:example.com   type:video|file|mail|event|web
 */
export function parseQuery(raw: string): ParsedQuery {
  const phrases: string[][] = [];
  const excluded: string[] = [];
  let site: string | undefined;
  let type: DocType | undefined;

  // Pull out "quoted phrases" first.
  let rest = raw.replace(/"([^"]+)"/g, (_m, phrase: string) => {
    const tokens = tokenize(phrase);
    if (tokens.length > 0) phrases.push(tokens);
    return " ";
  });

  const words: string[] = [];
  for (const piece of rest.split(/\s+/).filter(Boolean)) {
    const siteMatch = /^site:(\S+)$/i.exec(piece);
    const typeMatch = /^type:(\w+)$/i.exec(piece);

    if (siteMatch) {
      site = siteMatch[1].toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    } else if (typeMatch && DOC_TYPES.includes(typeMatch[1].toLowerCase() as DocType)) {
      type = typeMatch[1].toLowerCase() as DocType;
    } else if (piece.length > 1 && piece.startsWith("-")) {
      excluded.push(...tokenize(piece.slice(1)));
    } else {
      words.push(piece);
    }
  }

  const terms = [...new Set([...tokenize(words.join(" ")), ...phrases.flat()])];
  return { raw, terms, phrases, excluded, site, type };
}

/** The query as plain words again, used when building "did you mean" text. */
export function rebuildQuery(parsed: ParsedQuery, replacements: Map<string, string>): string {
  const swap = (w: string) => replacements.get(w) ?? w;
  const parts: string[] = [];
  const bare = tokenize(
    parsed.raw
      .replace(/"[^"]*"/g, " ")
      .split(/\s+/)
      .filter((p) => p && !/^(site:|type:|-)/i.test(p))
      .join(" "),
  );
  parts.push(...bare.map(swap));
  for (const phrase of parsed.phrases) parts.push(`"${phrase.map(swap).join(" ")}"`);
  for (const ex of parsed.excluded) parts.push(`-${ex}`);
  if (parsed.site) parts.push(`site:${parsed.site}`);
  if (parsed.type) parts.push(`type:${parsed.type}`);
  return parts.join(" ");
}
