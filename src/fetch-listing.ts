import { chromium } from "playwright";

/**
 * Fetches a job listing URL and extracts readable text.
 * Uses headless Chromium to handle JavaScript-heavy job boards (LinkedIn,
 * Jobindex, etc.), then strips navigation clutter and returns main body text.
 */
export async function fetchListingText(url: string): Promise<string> {
  try {
    return await fetchWithBrowser(url);
  } catch (err) {
    console.warn(`⚠️ Browser fetch failed (${err instanceof Error ? err.message : String(err)}); trying plain HTTP…`);
    return await fetchWithHttp(url);
  }
}

async function fetchWithBrowser(url: string): Promise<string> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    // Give client-rendered content a moment to appear.
    await page.waitForTimeout(3000);
    const text = await page.evaluate(() => {
      const clone = document.body.cloneNode(true) as HTMLElement;
      clone
        .querySelectorAll(
          "script,style,noscript,nav,header,footer,aside,iframe,svg,.cookie-banner,.cookie-consent,[aria-hidden='true']",
        )
        .forEach((el) => el.remove());
      return (clone.innerText ?? "").trim();
    });
    if (text.length < 50) throw new Error("Empty page text");
    return text.slice(0, 80_000);
  } finally {
    await browser.close();
  }
}

async function fetchWithHttp(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  // Rough HTML → text extraction.
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length < 50) throw new Error("No readable content");
  return stripped.slice(0, 80_000);
}
