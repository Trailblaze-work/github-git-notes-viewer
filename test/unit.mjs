import puppeteer from "puppeteer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import assert from "assert";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let browser, page;
let passed = 0;
let failed = 0;

async function setup() {
  browser = await puppeteer.launch({ headless: true });
  page = await browser.newPage();
}

async function teardown() {
  await browser.close();
}

async function loadContentFunctions() {
  await page.goto("about:blank", { waitUntil: "domcontentloaded" });

  // Mock browser globals before loading content.js
  await page.evaluate(() => {
    window.browser = {
      storage: { local: { get: async () => ({}) } },
      runtime: { sendMessage: async () => ({}) },
    };
  });

  // Load libraries and content.js via script tags (global scope)
  const purifyJs = fs.readFileSync(path.join(ROOT, "lib/purify.min.js"), "utf-8");
  const markedJs = fs.readFileSync(path.join(ROOT, "lib/marked.min.js"), "utf-8");
  const contentJs = fs.readFileSync(path.join(ROOT, "content.js"), "utf-8");

  await page.addScriptTag({ content: purifyJs });
  await page.addScriptTag({ content: markedJs });
  await page.addScriptTag({ content: contentJs });
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

async function run() {
  await setup();

  console.log("GitHub Git Notes Viewer — Unit Tests\n");

  // Load once — all tested functions are pure/deterministic
  await loadContentFunctions();

  // ========== COMMIT_URL_RE ==========
  console.log("  COMMIT_URL_RE");

  await test("matches standard commit URL", async () => {
    const result = await page.evaluate(() =>
      COMMIT_URL_RE.test("/owner/repo/commit/abc123def456")
    );
    assert.ok(result);
  });

  await test("captures owner, repo, and SHA", async () => {
    const result = await page.evaluate(() => {
      const m = "/owner/repo/commit/abc123def456".match(COMMIT_URL_RE);
      return m ? [m[1], m[2], m[3]] : null;
    });
    assert.deepStrictEqual(result, ["owner", "repo", "abc123def456"]);
  });

  await test("matches minimum SHA length (5 chars)", async () => {
    const result = await page.evaluate(() =>
      COMMIT_URL_RE.test("/owner/repo/commit/a1b2c")
    );
    assert.ok(result);
  });

  await test("matches full 40-char SHA", async () => {
    const result = await page.evaluate(() =>
      COMMIT_URL_RE.test("/o/r/commit/abcdef0123456789abcdef0123456789abcdef01")
    );
    assert.ok(result);
  });

  await test("rejects SHA shorter than 5 chars", async () => {
    const result = await page.evaluate(() =>
      COMMIT_URL_RE.test("/owner/repo/commit/abc1")
    );
    assert.ok(!result);
  });

  await test("rejects SHA longer than 40 chars", async () => {
    const result = await page.evaluate(() =>
      COMMIT_URL_RE.test("/o/r/commit/abcdef0123456789abcdef0123456789abcdef012")
    );
    assert.ok(!result);
  });

  await test("rejects non-commit pages", async () => {
    const result = await page.evaluate(() =>
      COMMIT_URL_RE.test("/owner/repo/tree/main")
    );
    assert.ok(!result);
  });

  await test("rejects extra path segments after SHA", async () => {
    const result = await page.evaluate(() =>
      COMMIT_URL_RE.test("/owner/repo/commit/abc123/extra")
    );
    assert.ok(!result);
  });

  await test("matches uppercase hex (case-insensitive)", async () => {
    const result = await page.evaluate(() =>
      COMMIT_URL_RE.test("/Owner/Repo/commit/ABCDEF")
    );
    assert.ok(result);
  });

  await test("rejects non-hex characters in SHA", async () => {
    const result = await page.evaluate(() =>
      COMMIT_URL_RE.test("/owner/repo/commit/ghijk")
    );
    assert.ok(!result);
  });

  // ========== detectFormat ==========
  console.log("\n  detectFormat");

  await test("detects JSON object", async () => {
    const result = await page.evaluate(() => detectFormat('{"key": "value"}'));
    assert.strictEqual(result, "json");
  });

  await test("detects JSON array", async () => {
    const result = await page.evaluate(() => detectFormat("[1, 2, 3]"));
    assert.strictEqual(result, "json");
  });

  await test("rejects invalid JSON starting with {", async () => {
    const result = await page.evaluate(() => detectFormat("{not json}"));
    assert.notStrictEqual(result, "json");
  });

  await test("detects markdown heading", async () => {
    const result = await page.evaluate(() => detectFormat("# Title\nSome text"));
    assert.strictEqual(result, "markdown");
  });

  await test("detects markdown bold", async () => {
    const result = await page.evaluate(() =>
      detectFormat("This has **bold** text")
    );
    assert.strictEqual(result, "markdown");
  });

  await test("detects markdown unordered list", async () => {
    const result = await page.evaluate(() =>
      detectFormat("- item 1\n- item 2")
    );
    assert.strictEqual(result, "markdown");
  });

  await test("detects markdown ordered list", async () => {
    const result = await page.evaluate(() =>
      detectFormat("1. first\n2. second")
    );
    assert.strictEqual(result, "markdown");
  });

  await test("detects markdown table", async () => {
    const result = await page.evaluate(() =>
      detectFormat("|col1|col2|\n|---|---|")
    );
    assert.strictEqual(result, "markdown");
  });

  await test("detects markdown code block", async () => {
    const result = await page.evaluate(() =>
      detectFormat("```js\nconst x = 1;\n```")
    );
    assert.strictEqual(result, "markdown");
  });

  await test("detects markdown HTML comment", async () => {
    const result = await page.evaluate(() =>
      detectFormat("<!-- prompt -->\nSome content")
    );
    assert.strictEqual(result, "markdown");
  });

  await test("detects YAML with multiple keys", async () => {
    const result = await page.evaluate(() =>
      detectFormat("key1: value1\nkey2: value2")
    );
    assert.strictEqual(result, "yaml");
  });

  await test("returns plain for single YAML-like line", async () => {
    const result = await page.evaluate(() => detectFormat("key: value"));
    assert.strictEqual(result, "plain");
  });

  await test("returns plain for simple text", async () => {
    const result = await page.evaluate(() =>
      detectFormat("just some plain text")
    );
    assert.strictEqual(result, "plain");
  });

  await test("returns plain for empty string", async () => {
    const result = await page.evaluate(() => detectFormat(""));
    assert.strictEqual(result, "plain");
  });

  await test("returns plain for whitespace only", async () => {
    const result = await page.evaluate(() => detectFormat("   \n  \n"));
    assert.strictEqual(result, "plain");
  });

  // ========== escapeHtml ==========
  console.log("\n  escapeHtml");

  await test("escapes script tags", async () => {
    const result = await page.evaluate(() =>
      escapeHtml('<script>alert("xss")</script>')
    );
    assert.ok(result.includes("&lt;script&gt;"));
  });

  await test("escapes ampersands", async () => {
    const result = await page.evaluate(() => escapeHtml("foo & bar"));
    assert.ok(result.includes("&amp;"));
  });

  await test("returns empty string for empty input", async () => {
    const result = await page.evaluate(() => escapeHtml(""));
    assert.strictEqual(result, "");
  });

  await test("double-escapes already-escaped entities", async () => {
    const result = await page.evaluate(() => escapeHtml("&amp;"));
    assert.ok(result.includes("&amp;amp;"));
  });

  // ========== renderContentToHtml ==========
  console.log("\n  renderContentToHtml");

  await test("renders markdown headings to HTML", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml("# Hello\n\nWorld", "markdown")
    );
    assert.ok(result.includes("<h1>"));
    assert.ok(result.includes("Hello"));
  });

  await test("sanitizes script tags in markdown", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('<script>alert(1)</script>', "markdown")
    );
    assert.ok(!result.includes("<script>"));
  });

  await test("pretty-prints JSON with indentation", async () => {
    const result = await page.evaluate(() => {
      const el = document.createElement("div");
      el.innerHTML = renderContentToHtml('{"a":1,"b":2}', "json");
      return el.querySelector("pre").textContent;
    });
    assert.ok(result.includes('"a": 1'));
    assert.ok(result.includes("\n"));
  });

  await test("handles invalid JSON gracefully", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml("{bad json}", "json")
    );
    assert.ok(result.includes("ghn-content"));
    assert.ok(result.includes("{bad json}"));
  });

  await test("highlights YAML keys", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml("key1: value1\nkey2: value2", "yaml")
    );
    assert.ok(result.includes("ghn-yaml-key"));
    assert.ok(result.includes("key1"));
  });

  await test("renders plain text in pre tag", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml("hello world", "plain")
    );
    assert.ok(result.includes("<pre"));
    assert.ok(result.includes("ghn-content"));
    assert.ok(result.includes("hello world"));
  });

  // ========== XSS / Injection ==========
  console.log("\n  XSS / Injection");

  // -- Markdown attack vectors (DOMPurify) --

  await test("strips img onerror event handler", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('<img onerror="alert(1)" src="x">', "markdown")
    );
    assert.ok(!result.includes("onerror"));
  });

  await test("strips iframe tags", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('<iframe src="javascript:alert(1)"></iframe>', "markdown")
    );
    assert.ok(!result.includes("<iframe"));
  });

  await test("strips form tags", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('<form action="https://evil.com"><input></form>', "markdown")
    );
    assert.ok(!result.includes("<form"));
    assert.ok(!result.includes("<input"));
  });

  await test("strips javascript: URLs in links", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('[click](javascript:alert(1))', "markdown")
    );
    assert.ok(!result.includes("javascript:"));
  });

  await test("strips SVG with onload handler", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('<svg onload="alert(1)"><circle r="10"/></svg>', "markdown")
    );
    assert.ok(!result.includes("onload"));
    assert.ok(!result.includes("<svg"));
  });

  await test("strips style tags in markdown", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('<style>body{display:none}</style>', "markdown")
    );
    assert.ok(!result.includes("<style"));
  });

  await test("neutralizes script in data: URL img src", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('<img src="data:text/html,<script>alert(1)</script>">', "markdown")
    );
    // DOMPurify escapes the script inside the URL; img won't execute data:text/html
    assert.ok(!result.includes("<script>"));
  });

  await test("strips event handlers on allowed tags", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('<a href="#" onclick="alert(1)">link</a>', "markdown")
    );
    assert.ok(!result.includes("onclick"));
  });

  await test("strips nested script-in-attribute attack", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('<div style="background:url(javascript:alert(1))">x</div>', "markdown")
    );
    assert.ok(!result.includes("javascript:"));
  });

  await test("strips math/annotation XSS vector", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('<math><annotation-xml encoding="text/html"><script>alert(1)</script></annotation-xml></math>', "markdown")
    );
    assert.ok(!result.includes("<script"));
  });

  // -- JSON injection --

  await test("escapes HTML in JSON string values", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('{"xss": "<img onerror=alert(1) src=x>"}', "json")
    );
    assert.ok(!result.includes("<img"));
    assert.ok(result.includes("&lt;img"));
  });

  // -- YAML injection --

  await test("escapes HTML in YAML values", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('key: <script>alert(1)</script>\nother: safe', "yaml")
    );
    assert.ok(!result.includes("<script>"));
    assert.ok(result.includes("&lt;script&gt;"));
  });

  await test("escapes HTML in YAML keys", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('<img onerror=alert(1)>: value\nkey2: val2', "yaml")
    );
    // Angle brackets must be escaped — no actual <img tag in output
    assert.ok(!result.includes("<img"));
    assert.ok(result.includes("&lt;img"));
  });

  // -- Plain text injection --

  await test("escapes all HTML in plain text", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('<div onmouseover="alert(1)">hover me</div>', "plain")
    );
    // No actual <div tag in output — only escaped entity
    assert.ok(!result.includes("<div"));
    assert.ok(result.includes("&lt;div"));
  });

  // -- escapeHtml edge cases --

  await test("escapes angle brackets in all positions", async () => {
    const result = await page.evaluate(() =>
      escapeHtml('"><img src=x onerror=alert(1)>')
    );
    assert.ok(!result.includes("<img"));
  });

  await test("escapes HTML entities in encoded payloads", async () => {
    const result = await page.evaluate(() =>
      escapeHtml("&#60;script&#62;alert(1)&#60;/script&#62;")
    );
    assert.ok(result.includes("&amp;#60;"));
  });

  // --- Summary ---
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  await teardown();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
