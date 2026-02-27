import puppeteer from "puppeteer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SCREENSHOTS_DIR = path.join(ROOT, "screenshots");
const MOCK_PAGE = path.join(__dirname, "mock-github-commit.html");

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

async function main() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });

  // Load the mock GitHub commit page
  await page.goto(`file://${MOCK_PAGE}`, { waitUntil: "domcontentloaded" });

  // Read content.css to inject
  const contentCss = fs.readFileSync(
    path.join(ROOT, "content.css"),
    "utf-8"
  );

  // Inject the extension's CSS
  await page.addStyleTag({ content: contentCss });

  // --- Screenshot 1: Notes displayed ---
  await page.evaluate(() => {
    const diffStats = document.getElementById("diff-stats");
    const container = document.createElement("div");
    container.id = "ghn-notes-container";
    container.innerHTML = `
      <div class="ghn-box">
        <div class="ghn-header">
          <span class="ghn-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" class="ghn-octicon">
            <path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25ZM3.5 6.25a.75.75 0 0 1 .75-.75h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Zm.75 2.25a.75.75 0 0 0 0 1.5h4a.75.75 0 0 0 0-1.5Z"/>
          </svg></span>
          <span class="ghn-title">Git Notes</span>
          <span class="ghn-ref">refs/notes/commits</span>
        </div>
        <div class="ghn-body">
          <pre class="ghn-content">Reviewed-by: Alice Chen &lt;alice@example.com&gt;
Tested-by: CI Pipeline #4821 (passed)
Deployment: rolled out to staging on 2026-02-25

Performance impact: p99 latency reduced from 340ms to 120ms
after switching to streaming SSE from polling.</pre>
        </div>
      </div>
    `;
    diffStats.parentNode.insertBefore(container, diffStats);
  });

  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "notes-displayed.png"),
    clip: await getContentClip(page),
  });
  console.log("Captured: notes-displayed.png");

  // --- Screenshot 2: Multiple note refs ---
  await page.evaluate(() => {
    const container = document.getElementById("ghn-notes-container");
    container.innerHTML = `
      <div class="ghn-box">
        <div class="ghn-header">
          <span class="ghn-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" class="ghn-octicon">
            <path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25ZM3.5 6.25a.75.75 0 0 1 .75-.75h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Zm.75 2.25a.75.75 0 0 0 0 1.5h4a.75.75 0 0 0 0-1.5Z"/>
          </svg></span>
          <span class="ghn-title">Git Notes</span>
          <span class="ghn-ref">refs/notes/commits</span>
        </div>
        <div class="ghn-body">
          <pre class="ghn-content">Reviewed-by: Alice Chen &lt;alice@example.com&gt;
Tested-by: CI Pipeline #4821 (passed)</pre>
        </div>
      </div>
      <div class="ghn-box">
        <div class="ghn-header">
          <span class="ghn-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" class="ghn-octicon">
            <path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25ZM3.5 6.25a.75.75 0 0 1 .75-.75h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Zm.75 2.25a.75.75 0 0 0 0 1.5h4a.75.75 0 0 0 0-1.5Z"/>
          </svg></span>
          <span class="ghn-title">Git Notes</span>
          <span class="ghn-ref">refs/notes/claude-prompts</span>
        </div>
        <div class="ghn-body">
          <pre class="ghn-content">Prompt: "Add streaming support with SSE and implement
backpressure handling for high-throughput channels"</pre>
        </div>
      </div>
    `;
  });

  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "multiple-refs.png"),
    clip: await getContentClip(page),
  });
  console.log("Captured: multiple-refs.png");

  await browser.close();
  console.log(`\nScreenshots saved to ${SCREENSHOTS_DIR}/`);
}

async function getContentClip(page) {
  return page.evaluate(() => {
    const container = document.querySelector(".container");
    const rect = container.getBoundingClientRect();
    return {
      x: Math.max(0, rect.x - 16),
      y: 0,
      width: Math.min(rect.width + 32, window.innerWidth),
      height: Math.min(rect.bottom + 40, document.body.scrollHeight),
    };
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
