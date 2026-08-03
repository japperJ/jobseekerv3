import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ROOT } from "./config.js";

const CONFIG_FILE = path.join(PROJECT_ROOT, "config", "fallback-rules.md");

function readListSection(markdown: string, heading: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (headingIndex === -1) return [];

  const values: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (/^##\s+/.test(line.trim())) break;
    const value = line.match(/^\s*-\s+(.+?)\s*$/)?.[1];
    if (value) values.push(value);
  }
  return values;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const markdown = fs.readFileSync(CONFIG_FILE, "utf8");

export const FALLBACK_KEYWORDS = readListSection(markdown, "Fallback keywords");
export const FALLBACK_ROLES = readListSection(markdown, "Supported roles");

if (FALLBACK_KEYWORDS.length === 0 || FALLBACK_ROLES.length === 0) {
  throw new Error(`Fallback configuration is incomplete: ${CONFIG_FILE}`);
}

export const FALLBACK_ROLE_PATTERN = new RegExp(
  `\\b(?:${FALLBACK_ROLES.map(escapeRegExp).join("|")})\\b`,
  "i",
);
