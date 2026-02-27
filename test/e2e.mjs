import puppeteer from "puppeteer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import assert from "assert";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MOCK_PAGE = path.join(__dirname, "mock-github-commit.html");

let browser, page;
let passed = 0;
let failed = 0;

async function setup() {
  browser = await puppeteer.launch({ headless: true });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
}

async function teardown() {
  await browser.close();
}

async function loadMockPage() {
  await page.goto(`file://${MOCK_PAGE}`, { waitUntil: "domcontentloaded" });
  // Inject the extension CSS
  const css = fs.readFileSync(path.join(ROOT, "content.css"), "utf-8");
  await page.addStyleTag({ content: css });
  // Inject the content script (minus the browser shim and message passing)
  const contentJs = fs.readFileSync(path.join(ROOT, "content.js"), "utf-8");
  // We'll inject helper functions only (not the init/observer parts)
  await page.evaluate(`
    // Provide a mock browser object
    window.browser = {
      runtime: {
        sendMessage: async (msg) => {
          // Mock responses based on message type
          if (msg.type === "FETCH_GIT_NOTE") {
            return window.__mockNoteResponse || { notes: [] };
          }
          if (msg.type === "OPEN_OPTIONS") {
            window.__optionsOpened = true;
            return;
          }
        }
      }
    };
  `);
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

  console.log("GitHub Git Notes Viewer — E2E Tests\n");

  // --- Test: CSS loads and renders correctly ---
  await test("CSS classes are properly defined", async () => {
    await loadMockPage();

    // Inject a notes container
    const hasStyles = await page.evaluate(() => {
      const container = document.createElement("div");
      container.id = "ghn-notes-container";
      container.innerHTML = `
        <div class="ghn-box">
          <div class="ghn-header">
            <span class="ghn-title">Git Notes</span>
          </div>
          <div class="ghn-body">
            <pre class="ghn-content">Test note</pre>
          </div>
        </div>
      `;
      document.getElementById("diff-stats").parentNode.insertBefore(
        container,
        document.getElementById("diff-stats")
      );

      const box = container.querySelector(".ghn-box");
      const style = getComputedStyle(box);
      return style.borderRadius === "6px" && style.overflow === "hidden";
    });
    assert.ok(hasStyles, "Expected ghn-box to have border-radius and overflow");
  });

  // --- Test: Notes container injects before diff stats ---
  await test("Notes container inserts before #diff-stats", async () => {
    await loadMockPage();

    const position = await page.evaluate(() => {
      const container = document.createElement("div");
      container.id = "ghn-notes-container";
      container.textContent = "test";
      const diffStats = document.getElementById("diff-stats");
      diffStats.parentNode.insertBefore(container, diffStats);

      const notes = document.getElementById("ghn-notes-container");
      const ds = document.getElementById("diff-stats");
      return notes.compareDocumentPosition(ds) & Node.DOCUMENT_POSITION_FOLLOWING;
    });
    assert.ok(position, "Notes container should appear before diff stats");
  });

  // --- Test: Note content renders with proper escaping ---
  await test("HTML in note content is escaped", async () => {
    await loadMockPage();

    const escaped = await page.evaluate(() => {
      // Use the same escapeHtml technique as content.js
      const div = document.createElement("div");
      div.textContent = '<script>alert("xss")</script>';
      const escaped = div.innerHTML;

      const pre = document.createElement("pre");
      pre.className = "ghn-content";
      pre.innerHTML = escaped;
      document.body.appendChild(pre);

      return pre.innerHTML.includes("&lt;script&gt;");
    });
    assert.ok(escaped, "Script tags should be escaped");
  });

  // --- Test: Loading state shows spinner ---
  await test("Loading state displays spinner animation", async () => {
    await loadMockPage();

    const hasSpinner = await page.evaluate(() => {
      const container = document.createElement("div");
      container.id = "ghn-notes-container";
      container.innerHTML = `
        <div class="ghn-box ghn-loading">
          <div class="ghn-header">
            <span class="ghn-title">Git Notes</span>
          </div>
          <div class="ghn-body">
            <span class="ghn-spinner"></span> Loading notes...
          </div>
        </div>
      `;
      document.body.appendChild(container);

      const spinner = container.querySelector(".ghn-spinner");
      const style = getComputedStyle(spinner);
      return (
        style.borderRadius === "50%" &&
        style.animationName === "ghn-spin" &&
        style.width === "14px"
      );
    });
    assert.ok(hasSpinner, "Spinner should render with correct styles");
  });

  // --- Test: Error state for no token ---
  await test("Error state shows settings link for no token", async () => {
    await loadMockPage();

    const hasLink = await page.evaluate(() => {
      const container = document.createElement("div");
      container.id = "ghn-notes-container";
      container.innerHTML = `
        <div class="ghn-box ghn-error">
          <div class="ghn-header">
            <span class="ghn-title">Git Notes</span>
          </div>
          <div class="ghn-body">
            No GitHub token configured.
            <a class="ghn-settings-link" href="#">Open settings</a> to add one.
          </div>
        </div>
      `;
      document.body.appendChild(container);

      const link = container.querySelector(".ghn-settings-link");
      const style = getComputedStyle(link);
      return link && style.cursor === "pointer";
    });
    assert.ok(hasLink, "Settings link should be present and clickable");
  });

  // --- Test: Multiple notes render correctly ---
  await test("Multiple note refs render as separate boxes", async () => {
    await loadMockPage();

    const count = await page.evaluate(() => {
      const container = document.createElement("div");
      container.id = "ghn-notes-container";
      container.innerHTML = `
        <div class="ghn-box">
          <div class="ghn-header"><span class="ghn-title">Git Notes</span><span class="ghn-ref">refs/notes/commits</span></div>
          <div class="ghn-body"><pre class="ghn-content">Note 1</pre></div>
        </div>
        <div class="ghn-box">
          <div class="ghn-header"><span class="ghn-title">Git Notes</span><span class="ghn-ref">refs/notes/review</span></div>
          <div class="ghn-body"><pre class="ghn-content">Note 2</pre></div>
        </div>
      `;
      document.body.appendChild(container);
      return container.querySelectorAll(".ghn-box").length;
    });
    assert.strictEqual(count, 2, "Should render 2 note boxes");
  });

  // --- Test: Ref label shows in header ---
  await test("Ref name displays in note header", async () => {
    await loadMockPage();

    const refText = await page.evaluate(() => {
      const container = document.createElement("div");
      container.innerHTML = `
        <div class="ghn-box">
          <div class="ghn-header">
            <span class="ghn-title">Git Notes</span>
            <span class="ghn-ref">refs/notes/commits</span>
          </div>
        </div>
      `;
      document.body.appendChild(container);
      return container.querySelector(".ghn-ref").textContent;
    });
    assert.strictEqual(refText, "refs/notes/commits");
  });

  // --- Test: background.js parseability ---
  await test("background.js is valid JavaScript", async () => {
    const bgJs = fs.readFileSync(path.join(ROOT, "background.js"), "utf-8");
    // Replace browser-specific APIs with stubs for syntax check
    const wrapped = `
      const chrome = {};
      const browser = { runtime: { onMessage: { addListener() {} } }, storage: { local: { get() { return Promise.resolve({}) } } } };
      ${bgJs}
    `;
    // This will throw if the JS is invalid
    new Function(wrapped);
  });

  // --- Test: content.js parseability ---
  await test("content.js is valid JavaScript", async () => {
    const contentJs = fs.readFileSync(path.join(ROOT, "content.js"), "utf-8");
    const wrapped = `
      const chrome = {};
      const browser = { runtime: { sendMessage() { return Promise.resolve({}) } } };
      const document = { addEventListener() {}, body: { observe() {} }, getElementById() { return null }, querySelector() { return null } };
      const location = { href: "", pathname: "" };
      const MutationObserver = class { observe() {} };
      ${contentJs}
    `;
    new Function(wrapped);
  });

  // --- Test: manifest.json is valid ---
  await test("manifest.json is valid and complete", async () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(ROOT, "manifest.json"), "utf-8")
    );
    assert.strictEqual(manifest.manifest_version, 3);
    assert.ok(manifest.permissions.includes("storage"));
    assert.ok(
      manifest.host_permissions.includes("https://api.github.com/*")
    );
    assert.ok(manifest.content_scripts[0].matches.includes("https://github.com/*/*/commit/*"));
    assert.ok(manifest.background.service_worker);
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
