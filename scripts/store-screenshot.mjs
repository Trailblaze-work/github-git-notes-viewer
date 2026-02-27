import puppeteer from "puppeteer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const STORE_DIR = path.join(ROOT, "store");
const MOCK_PAGE = path.join(ROOT, "test", "mock-github-commit.html");

fs.mkdirSync(STORE_DIR, { recursive: true });

// SVG icons (same as content.js)
const NOTE_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" class="ghn-octicon">
  <path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25ZM3.5 6.25a.75.75 0 0 1 .75-.75h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Zm.75 2.25a.75.75 0 0 0 0 1.5h4a.75.75 0 0 0 0-1.5Z"/>
</svg>`;

const CODE_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" class="ghn-octicon">
  <path d="m11.28 3.22 4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734L13.94 8l-3.72-3.72a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215Zm-6.56 0a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L2.06 8l3.72 3.72a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L.47 8.53a.75.75 0 0 1 0-1.06Z"/>
</svg>`;

const MARKDOWN_NOTE_HTML = `<div class="markdown-body" style="font-size:14px;line-height:1.5;">
<h2 style="margin-top:0;padding-top:0;border-top:none;">Claude Code Prompts</h2>
<!-- format:v2 -->
<p><strong>Session</strong>: f0d06f5e-5e70-4085-960f-bccb9dd11afb<br>
<strong>Slug</strong>: starry-hugging-otter<br>
<strong>Captured</strong>: 2026-02-26T14:23:05Z<br>
<strong>Branch</strong>: feature/streaming-sse<br>
<strong>Model</strong>: claude-opus-4-6<br>
<strong>Client</strong>: 2.1.59<br>
<strong>Permission</strong>: accept-edits</p>
<h3>Prompts</h3>
<p><strong>1.</strong> Add streaming support with SSE and implement backpressure handling for high-throughput channels</p>
<p><strong>2.</strong> Also add reconnection logic with exponential backoff</p>
<p><strong>3.</strong> Looks good, commit and push</p>
<h3>Stats</h3>
<table style="font-size:13px;">
<thead><tr><th>Metric</th><th>Value</th></tr></thead>
<tbody>
<tr><td>Turns</td><td>3 user, 8 assistant</td></tr>
<tr><td>Tokens in</td><td>45,230</td></tr>
<tr><td>Tokens out</td><td>12,847</td></tr>
<tr><td>Cache read</td><td>128,450</td></tr>
<tr><td>Cache write</td><td>8,200</td></tr>
</tbody></table>
<h3>Tools</h3>
<p>Edit(4) Bash(6) Read(3) Grep(2) Glob(1)</p>
</div>`;

async function main() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  // Chrome Web Store requires exactly 1280x800
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

  await page.goto(`file://${MOCK_PAGE}`, { waitUntil: "domcontentloaded" });

  // Read and inject the extension CSS
  const contentCss = fs.readFileSync(path.join(ROOT, "content.css"), "utf-8");
  await page.addStyleTag({ content: contentCss });

  // Inject the notes UI — same as the extension would render
  await page.evaluate(
    ({ NOTE_ICON, CODE_ICON, MARKDOWN_NOTE_HTML }) => {
      const diffStats = document.getElementById("diff-stats");
      const container = document.createElement("div");
      container.id = "ghn-notes-container";
      container.innerHTML = `
        <div class="ghn-box" data-format="markdown">
          <div class="ghn-header">
            <span class="ghn-icon">${NOTE_ICON}</span>
            <span class="ghn-title">Git Notes</span>
            <span class="ghn-format-badge">markdown</span>
            <span class="ghn-ref">refs/notes/claude-prompts</span>
            <button class="ghn-toggle-raw" title="Toggle raw view">${CODE_ICON}</button>
          </div>
          <div class="ghn-body ghn-rendered">
            ${MARKDOWN_NOTE_HTML}
          </div>
        </div>
      `;
      diffStats.parentNode.insertBefore(container, diffStats);
    },
    { NOTE_ICON, CODE_ICON, MARKDOWN_NOTE_HTML }
  );

  // Full-page screenshot at exactly 1280x800
  await page.screenshot({
    path: path.join(STORE_DIR, "screenshot-1280x800.png"),
  });

  console.log("Captured: store/screenshot-1280x800.png");
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
