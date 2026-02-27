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
  browser = await puppeteer.launch({
    headless: true,
    args: process.env.CI ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
  });
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

async function loadMockPageWithContentScript() {
  await page.goto(`file://${MOCK_PAGE}`, { waitUntil: "domcontentloaded" });

  // Inject CSS
  const css = fs.readFileSync(path.join(ROOT, "content.css"), "utf-8");
  await page.addStyleTag({ content: css });

  // Mock browser API before loading content.js
  await page.evaluate(() => {
    window.browser = {
      storage: { local: { get: async () => ({}) } },
      runtime: { sendMessage: async () => ({}) },
    };
  });

  // Load libraries + content.js via script tags (global scope)
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
      manifest.host_permissions.includes("https://raw.githubusercontent.com/*")
    );
    assert.ok(manifest.content_scripts[0].matches.includes("https://github.com/*/*/commit/*"));
    assert.ok(manifest.background.service_worker);
  });

  // --- Integration tests using content.js functions ---
  console.log("\n  Integration (content.js functions)");

  await test("showNotes renders markdown with format badge and toggle", async () => {
    await loadMockPageWithContentScript();
    const result = await page.evaluate(() => {
      const container = document.createElement("div");
      container.id = "ghn-notes-container";
      document.querySelector(".container").appendChild(container);
      showNotes(container, [{ ref: "refs/notes/commits", content: "# Hello\n\nWorld" }]);

      const box = container.querySelector(".ghn-box");
      const badge = container.querySelector(".ghn-format-badge");
      const toggle = container.querySelector(".ghn-toggle-raw");
      const rendered = container.querySelector(".ghn-rendered");
      return {
        format: box.dataset.format,
        badgeText: badge?.textContent,
        hasToggle: !!toggle,
        hasMarkdownBody: rendered?.classList.contains("markdown-body"),
        hasH1: rendered?.innerHTML.includes("<h1>"),
      };
    });
    assert.strictEqual(result.format, "markdown");
    assert.strictEqual(result.badgeText, "markdown");
    assert.ok(result.hasToggle);
    assert.ok(result.hasMarkdownBody);
    assert.ok(result.hasH1);
  });

  await test("showNotes renders JSON with format badge", async () => {
    await loadMockPageWithContentScript();
    const result = await page.evaluate(() => {
      const container = document.createElement("div");
      container.id = "ghn-notes-container";
      document.querySelector(".container").appendChild(container);
      showNotes(container, [{ ref: "refs/notes/commits", content: '{"key": "value"}' }]);

      const box = container.querySelector(".ghn-box");
      const badge = container.querySelector(".ghn-format-badge");
      const pre = container.querySelector(".ghn-content");
      return {
        format: box.dataset.format,
        badgeText: badge?.textContent,
        hasPrettyPrint: pre?.textContent.includes("  "),
      };
    });
    assert.strictEqual(result.format, "json");
    assert.strictEqual(result.badgeText, "json");
    assert.ok(result.hasPrettyPrint);
  });

  await test("showNotes renders YAML with key highlighting", async () => {
    await loadMockPageWithContentScript();
    const result = await page.evaluate(() => {
      const container = document.createElement("div");
      container.id = "ghn-notes-container";
      document.querySelector(".container").appendChild(container);
      showNotes(container, [{ ref: "refs/notes/commits", content: "key1: value1\nkey2: value2" }]);

      const box = container.querySelector(".ghn-box");
      const badge = container.querySelector(".ghn-format-badge");
      const yamlKey = container.querySelector(".ghn-yaml-key");
      return {
        format: box.dataset.format,
        badgeText: badge?.textContent,
        hasYamlKey: !!yamlKey,
      };
    });
    assert.strictEqual(result.format, "yaml");
    assert.strictEqual(result.badgeText, "yaml");
    assert.ok(result.hasYamlKey);
  });

  await test("showNotes renders plain text without badge or toggle", async () => {
    await loadMockPageWithContentScript();
    const result = await page.evaluate(() => {
      const container = document.createElement("div");
      container.id = "ghn-notes-container";
      document.querySelector(".container").appendChild(container);
      showNotes(container, [{ ref: "refs/notes/commits", content: "just plain text" }]);

      const box = container.querySelector(".ghn-box");
      const badge = container.querySelector(".ghn-format-badge");
      const toggle = container.querySelector(".ghn-toggle-raw");
      return {
        format: box.dataset.format,
        hasBadge: !!badge,
        hasToggle: !!toggle,
      };
    });
    assert.strictEqual(result.format, "plain");
    assert.ok(!result.hasBadge);
    assert.ok(!result.hasToggle);
  });

  await test("raw/rendered toggle switches visibility and active class", async () => {
    await loadMockPageWithContentScript();
    const result = await page.evaluate(() => {
      const container = document.createElement("div");
      container.id = "ghn-notes-container";
      document.querySelector(".container").appendChild(container);
      showNotes(container, [{ ref: "refs/notes/commits", content: "# Heading" }]);

      const toggle = container.querySelector(".ghn-toggle-raw");
      const rendered = container.querySelector(".ghn-rendered");
      const raw = container.querySelector(".ghn-raw");

      const before = { renderedHidden: rendered.hidden, rawHidden: raw.hidden, active: toggle.classList.contains("ghn-active") };
      toggle.click();
      const after = { renderedHidden: rendered.hidden, rawHidden: raw.hidden, active: toggle.classList.contains("ghn-active") };
      toggle.click();
      const reverted = { renderedHidden: rendered.hidden, rawHidden: raw.hidden, active: toggle.classList.contains("ghn-active") };

      return { before, after, reverted };
    });
    assert.ok(!result.before.renderedHidden && result.before.rawHidden && !result.before.active);
    assert.ok(result.after.renderedHidden && !result.after.rawHidden && result.after.active);
    assert.ok(!result.reverted.renderedHidden && result.reverted.rawHidden && !result.reverted.active);
  });

  await test("long note gets collapsed with show-more button", async () => {
    await loadMockPageWithContentScript();
    const result = await page.evaluate(async () => {
      const container = document.createElement("div");
      container.id = "ghn-notes-container";
      document.querySelector(".container").appendChild(container);

      const longContent = "# Long Note\n\n" + "This is a line of text.\n\n".repeat(100);
      showNotes(container, [{ ref: "refs/notes/commits", content: longContent }]);

      // Wait for requestAnimationFrame to measure height
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      const box = container.querySelector(".ghn-box");
      const btn = container.querySelector(".ghn-show-more");
      return {
        isCollapsed: box.classList.contains("ghn-collapsed"),
        btnVisible: !btn.hidden,
        btnText: btn.textContent,
      };
    });
    assert.ok(result.isCollapsed);
    assert.ok(result.btnVisible);
    assert.strictEqual(result.btnText, "Show full note");
  });

  await test("show-more button expands collapsed note", async () => {
    await loadMockPageWithContentScript();
    const result = await page.evaluate(async () => {
      const container = document.createElement("div");
      container.id = "ghn-notes-container";
      document.querySelector(".container").appendChild(container);

      const longContent = "# Long Note\n\n" + "This is a line of text.\n\n".repeat(100);
      showNotes(container, [{ ref: "refs/notes/commits", content: longContent }]);

      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      const btn = container.querySelector(".ghn-show-more");
      btn.click();

      const box = container.querySelector(".ghn-box");
      return {
        isExpanded: box.classList.contains("ghn-expanded"),
        btnText: btn.textContent,
      };
    });
    assert.ok(result.isExpanded);
    assert.strictEqual(result.btnText, "Collapse note");
  });

  await test("showLoading displays spinner and text", async () => {
    await loadMockPageWithContentScript();
    const result = await page.evaluate(() => {
      const container = document.createElement("div");
      container.id = "ghn-notes-container";
      document.querySelector(".container").appendChild(container);
      showLoading(container);

      return {
        hasSpinner: !!container.querySelector(".ghn-spinner"),
        hasLoadingClass: !!container.querySelector(".ghn-loading"),
        text: container.querySelector(".ghn-body").textContent.trim(),
      };
    });
    assert.ok(result.hasSpinner);
    assert.ok(result.hasLoadingClass);
    assert.ok(result.text.includes("Loading notes"));
  });

  await test("showError displays escaped error message", async () => {
    await loadMockPageWithContentScript();
    const result = await page.evaluate(() => {
      const container = document.createElement("div");
      container.id = "ghn-notes-container";
      document.querySelector(".container").appendChild(container);
      showError(container, '<script>alert("xss")</script>');

      return {
        hasErrorClass: !!container.querySelector(".ghn-error"),
        bodyHtml: container.querySelector(".ghn-body").innerHTML,
        bodyText: container.querySelector(".ghn-body").textContent,
      };
    });
    assert.ok(result.hasErrorClass);
    assert.ok(!result.bodyHtml.includes("<script>"));
    assert.ok(result.bodyText.includes("<script>"));
  });

  await test("showTokenNeeded shows error with settings link", async () => {
    await loadMockPageWithContentScript();
    const result = await page.evaluate(() => {
      const container = document.createElement("div");
      container.id = "ghn-notes-container";
      document.querySelector(".container").appendChild(container);
      showTokenNeeded(container);

      return {
        hasErrorClass: !!container.querySelector(".ghn-error"),
        hasLink: !!container.querySelector(".ghn-settings-link"),
        bodyText: container.querySelector(".ghn-body").textContent,
      };
    });
    assert.ok(result.hasErrorClass);
    assert.ok(result.hasLink);
    assert.ok(result.bodyText.includes("configure a GitHub token"));
  });

  await test("showNotes renders multiple refs as separate boxes", async () => {
    await loadMockPageWithContentScript();
    const result = await page.evaluate(() => {
      const container = document.createElement("div");
      container.id = "ghn-notes-container";
      document.querySelector(".container").appendChild(container);
      showNotes(container, [
        { ref: "refs/notes/commits", content: "Note one" },
        { ref: "refs/notes/review", content: "Note two" },
      ]);

      const boxes = container.querySelectorAll(".ghn-box");
      const refs = [...container.querySelectorAll(".ghn-ref")].map(el => el.textContent);
      return { count: boxes.length, refs };
    });
    assert.strictEqual(result.count, 2);
    assert.deepStrictEqual(result.refs, ["refs/notes/commits", "refs/notes/review"]);
  });

  await test("showNotes with empty array removes container", async () => {
    await loadMockPageWithContentScript();
    const result = await page.evaluate(() => {
      const container = document.createElement("div");
      container.id = "ghn-notes-container";
      document.querySelector(".container").appendChild(container);
      showNotes(container, []);
      return document.getElementById("ghn-notes-container") === null;
    });
    assert.ok(result);
  });

  // --- XSS / Injection (full DOM pipeline) ---
  console.log("\n  XSS / Injection (DOM pipeline)");

  await test("markdown note with img onerror does not execute in DOM", async () => {
    await loadMockPageWithContentScript();
    const result = await page.evaluate(() => {
      const container = document.createElement("div");
      container.id = "ghn-notes-container";
      document.querySelector(".container").appendChild(container);
      showNotes(container, [{
        ref: "refs/notes/commits",
        content: '# Title\n\n<img onerror="document.title=\'pwned\'" src="x">'
      }]);
      return {
        title: document.title,
        html: container.querySelector(".ghn-rendered").innerHTML,
      };
    });
    assert.ok(!result.title.includes("pwned"));
    assert.ok(!result.html.includes("onerror"));
  });

  await test("markdown note with javascript: link is sanitized in DOM", async () => {
    await loadMockPageWithContentScript();
    const result = await page.evaluate(() => {
      const container = document.createElement("div");
      container.id = "ghn-notes-container";
      document.querySelector(".container").appendChild(container);
      // Include a heading so detectFormat picks markdown
      showNotes(container, [{
        ref: "refs/notes/commits",
        content: '# Notes\n\n[click me](javascript:alert(document.cookie))'
      }]);
      const link = container.querySelector(".ghn-rendered a");
      return {
        hasLink: !!link,
        href: link?.getAttribute("href") || "",
        html: container.querySelector(".ghn-rendered").innerHTML,
      };
    });
    // DOMPurify should strip the javascript: href — either no link or safe href
    if (result.hasLink) {
      assert.ok(!result.href.includes("javascript:"));
    }
    // No executable javascript: in rendered HTML attributes
    assert.ok(!result.html.includes('href="javascript:'));
  });

  await test("ref name with HTML is escaped in header", async () => {
    await loadMockPageWithContentScript();
    const result = await page.evaluate(() => {
      const container = document.createElement("div");
      container.id = "ghn-notes-container";
      document.querySelector(".container").appendChild(container);
      showNotes(container, [{
        ref: 'refs/notes/<img src=x onerror=alert(1)>',
        content: "safe content"
      }]);
      const refEl = container.querySelector(".ghn-ref");
      return { html: refEl.innerHTML, text: refEl.textContent };
    });
    assert.ok(!result.html.includes("<img"));
    assert.ok(result.text.includes("<img"));
  });

  await test("raw toggle view uses textContent (immune to injection)", async () => {
    await loadMockPageWithContentScript();
    const result = await page.evaluate(() => {
      const container = document.createElement("div");
      container.id = "ghn-notes-container";
      document.querySelector(".container").appendChild(container);
      showNotes(container, [{
        ref: "refs/notes/commits",
        content: '# Title\n\n<img onerror="alert(1)" src=x>'
      }]);
      // Toggle to raw view
      container.querySelector(".ghn-toggle-raw").click();
      const rawPre = container.querySelector(".ghn-raw pre");
      return { innerHTML: rawPre.innerHTML, textContent: rawPre.textContent };
    });
    // textContent is set, so innerHTML should be escaped
    assert.ok(!result.innerHTML.includes("<img"));
    assert.ok(result.textContent.includes("<img"));
  });

  await test("JSON note with HTML payload is escaped in DOM", async () => {
    await loadMockPageWithContentScript();
    const result = await page.evaluate(() => {
      const container = document.createElement("div");
      container.id = "ghn-notes-container";
      document.querySelector(".container").appendChild(container);
      showNotes(container, [{
        ref: "refs/notes/commits",
        content: '{"payload": "<script>alert(1)</script>"}'
      }]);
      const pre = container.querySelector(".ghn-content");
      return { innerHTML: pre.innerHTML, textContent: pre.textContent };
    });
    assert.ok(!result.innerHTML.includes("<script>"));
    assert.ok(result.textContent.includes("<script>"));
  });

  await test("YAML note with HTML in values is escaped in DOM", async () => {
    await loadMockPageWithContentScript();
    const result = await page.evaluate(() => {
      const container = document.createElement("div");
      container.id = "ghn-notes-container";
      document.querySelector(".container").appendChild(container);
      showNotes(container, [{
        ref: "refs/notes/commits",
        content: 'key1: <script>alert(1)</script>\nkey2: safe'
      }]);
      const pre = container.querySelector(".ghn-content");
      return pre.innerHTML;
    });
    assert.ok(!result.includes("<script>"));
    assert.ok(result.includes("&lt;script&gt;"));
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
