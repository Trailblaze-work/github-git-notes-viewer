if (typeof browser === "undefined") globalThis.browser = chrome;

const CONTAINER_ID = "ghn-notes-container";
const COMMIT_URL_RE = /^\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{5,40})$/i;

let lastProcessedUrl = null;

function parseCommitUrl() {
  const match = location.pathname.match(COMMIT_URL_RE);
  if (!match) return null;
  return { owner: match[1], repo: match[2], commitSha: match[3] };
}

function removeExisting() {
  const el = document.getElementById(CONTAINER_ID);
  if (el) el.remove();
}

function findInjectionPoint() {
  const selectors = [
    "#diff-content-parent",
    "#diff-stats",
    ".js-diff-progressive-container",
    "#files",
    '[data-target="diff-layout.mainContainer"]',
    ".commit.full-commit",
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return { el, mode: sel === "#diff-content-parent" ? "prepend" : "before" };
  }
  return null;
}

function injectContainer(injection) {
  const container = document.createElement("div");
  container.id = CONTAINER_ID;
  if (injection.mode === "prepend") {
    injection.el.prepend(container);
  } else {
    injection.el.parentNode.insertBefore(container, injection.el);
  }
  return container;
}

function waitForInjectionPoint(timeout = 5000) {
  return new Promise((resolve) => {
    const injection = findInjectionPoint();
    if (injection) return resolve(injection);

    const obs = new MutationObserver(() => {
      const injection = findInjectionPoint();
      if (injection) {
        obs.disconnect();
        resolve(injection);
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      obs.disconnect();
      resolve(null);
    }, timeout);
  });
}

// --- Note fetching (cookie-based, same-origin on github.com) ---

// Fetch the notes tree from GitHub's JSON endpoint (same-origin, session cookie included)
async function fetchNotesTreeEntries(owner, repo, noteRef) {
  // Convert refs/notes/commits → notes/commits (branch name without refs/ prefix)
  const branchName = noteRef.replace(/^refs\//, "");

  const res = await fetch(`/${owner}/${repo}/tree/${branchName}`, {
    headers: {
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
    credentials: "same-origin",
  });

  if (!res.ok) return null;

  const data = await res.json();
  // data.payload.tree.items = [{ name: "<commit-sha>", path: "<commit-sha>", contentType: "file"|"directory" }]
  return data?.payload?.tree?.items || null;
}

// Fetch note content for a specific commit SHA
async function fetchNoteContent(owner, repo, noteRef, commitSha) {
  const branchName = noteRef.replace(/^refs\//, "");

  // Fetch raw note content. Try github.com/raw first (private repo support via
  // signed redirect), then raw.githubusercontent.com with cache-bust param.
  const cacheBust = `_=${Date.now()}`;
  const urls = [
    `/${owner}/${repo}/raw/${branchName}/${commitSha}`,
    `https://raw.githubusercontent.com/${owner}/${repo}/${branchName}/${commitSha}?${cacheBust}`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        credentials: "same-origin",
        redirect: "follow",
      });
      if (res.ok) {
        return await res.text();
      }
    } catch {
      continue;
    }
  }

  // Handle fanout: first 2 chars of SHA as directory, remaining 38 as filename
  const prefix = commitSha.slice(0, 2);
  const suffix = commitSha.slice(2);
  const fanoutUrls = [
    `/${owner}/${repo}/raw/${branchName}/${prefix}/${suffix}`,
    `https://raw.githubusercontent.com/${owner}/${repo}/${branchName}/${prefix}/${suffix}?${cacheBust}`,
  ];

  for (const url of fanoutUrls) {
    try {
      const res = await fetch(url, {
        credentials: "same-origin",
        redirect: "follow",
      });
      if (res.ok) {
        return await res.text();
      }
    } catch {
      continue;
    }
  }

  return null;
}

// Fetch git note, resolving the full commit SHA if needed
async function fetchGitNote(owner, repo, noteRef, commitSha) {
  // First, check if the notes ref exists by fetching the tree
  const entries = await fetchNotesTreeEntries(owner, repo, noteRef);
  if (!entries) return null;

  // The commit SHA in the URL might be abbreviated — find the matching entry
  const match = entries.find(
    (e) => e.name === commitSha || e.name.startsWith(commitSha)
  );

  if (match && match.contentType === "file") {
    // Direct match — fetch the note content using the full SHA from the tree
    return await fetchNoteContent(owner, repo, noteRef, match.name);
  }

  // Check fanout: entry might be a directory named with first 2 chars of our SHA
  const prefix = commitSha.slice(0, 2);
  const fanoutDir = entries.find(
    (e) => e.name === prefix && e.contentType === "directory"
  );
  if (fanoutDir) {
    // Fetch the fanout subtree
    const branchName = noteRef.replace(/^refs\//, "");
    const subRes = await fetch(`/${owner}/${repo}/tree/${branchName}/${prefix}`, {
      headers: {
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
      credentials: "same-origin",
    });
    if (subRes.ok) {
      const subData = await subRes.json();
      const subEntries = subData?.payload?.tree?.items || [];
      const suffix = commitSha.slice(2);
      const subMatch = subEntries.find(
        (e) => e.name === suffix || e.name.startsWith(suffix)
      );
      if (subMatch) {
        return await fetchNoteContent(
          owner,
          repo,
          noteRef,
          `${prefix}/${subMatch.name}`
        );
      }
    }
  }

  return null;
}

// Get configured note refs
async function getNoteRefs() {
  try {
    const { noteRefs } = await browser.storage.local.get("noteRefs");
    if (noteRefs && noteRefs.length > 0) return noteRefs;
  } catch {
    // storage might not be available
  }
  return ["refs/notes/commits"];
}

// --- Format detection ---

function detectFormat(content) {
  const trimmed = content.trim();

  // JSON: starts with { or [
  if (/^[\[{]/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // not valid JSON
    }
  }

  // Markdown: contains common markdown patterns
  if (
    /^#{1,6}\s/m.test(trimmed) ||       // headers
    /\*\*[^*]+\*\*/m.test(trimmed) ||    // bold
    /^\|.+\|$/m.test(trimmed) ||         // tables
    /^[-*]\s/m.test(trimmed) ||          // unordered lists
    /^\d+\.\s/m.test(trimmed) ||         // ordered lists
    /^```/m.test(trimmed) ||             // code blocks
    /<!--.*-->/m.test(trimmed)           // HTML comments
  ) {
    return "markdown";
  }

  // YAML: key: value patterns on multiple lines, no JSON-like start
  if (
    /^[a-zA-Z_][a-zA-Z0-9_]*:\s/m.test(trimmed) &&
    (trimmed.match(/^[a-zA-Z_][a-zA-Z0-9_]*:\s/gm) || []).length >= 2
  ) {
    return "yaml";
  }

  return "plain";
}

// --- Sandboxed rendering ---
// All rendered content goes into a sandboxed iframe to prevent XSS.
// sandbox="allow-same-origin" means NO scripts execute, but parent can
// access the iframe DOM for height auto-sizing.

function getGitHubStylesheetLinks() {
  return [...document.querySelectorAll('link[rel="stylesheet"]')]
    .map((link) => link.href)
    .filter((href) => href.includes("github"))
    .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`)
    .join("\n");
}

function getThemeAttributes() {
  const root = document.documentElement;
  return [
    "data-color-mode",
    "data-light-theme",
    "data-dark-theme",
  ]
    .map((attr) => {
      const val = root.getAttribute(attr);
      return val ? `${attr}="${escapeHtml(val)}"` : "";
    })
    .filter(Boolean)
    .join(" ");
}

function buildSandboxedHtml(bodyHtml) {
  const styleLinks = getGitHubStylesheetLinks();
  const themeAttrs = getThemeAttributes();
  return `<!doctype html>
<html ${themeAttrs}>
<head>
<meta charset="utf-8">
${styleLinks}
<style>
body {
  margin: 0;
  padding: 0;
  background: transparent !important;
  overflow: hidden;
}
.markdown-body {
  font-size: 14px;
  line-height: 1.5;
}
.markdown-body h2:first-child,
.markdown-body h3:first-child {
  margin-top: 0;
  padding-top: 0;
  border-top: none;
}
.markdown-body table { font-size: 13px; }
pre.ghn-plain {
  margin: 0;
  white-space: pre-wrap;
  word-wrap: break-word;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 13px;
  line-height: 1.5;
  color: var(--fgColor-default, #e6edf3);
}
.ghn-yaml-key { color: var(--fgColor-accent, #58a6ff); }
</style>
</head>
<body>${bodyHtml}</body>
<script>
// Report height to parent for auto-sizing (runs in unique origin, no access to github.com)
function reportHeight() {
  window.parent.postMessage({ type: 'ghn-resize', height: document.body.scrollHeight }, '*');
}
new ResizeObserver(reportHeight).observe(document.body);
reportHeight();
</script>
</html>`;
}

function renderContentToHtml(content, format) {
  switch (format) {
    case "markdown":
      if (typeof marked !== "undefined") {
        const rawHtml = marked.parse(content, { breaks: true, gfm: true });
        // Sanitize to prevent CSS injection, phishing forms, and other HTML abuse
        const cleanHtml =
          typeof DOMPurify !== "undefined"
            ? DOMPurify.sanitize(rawHtml, {
                ALLOWED_TAGS: [
                  "h1","h2","h3","h4","h5","h6","p","br","strong","em","del",
                  "ul","ol","li","a","code","pre","blockquote","table","thead",
                  "tbody","tr","th","td","img","hr","div","span","sup","sub",
                ],
                ALLOWED_ATTR: ["href","src","alt","title","class","id","align"],
                ALLOW_DATA_ATTR: false,
              })
            : escapeHtml(rawHtml);
        return `<div class="markdown-body">${cleanHtml}</div>`;
      }
      return `<pre class="ghn-plain">${escapeHtml(content)}</pre>`;

    case "json":
      try {
        const formatted = JSON.stringify(JSON.parse(content.trim()), null, 2);
        return `<pre class="ghn-plain">${escapeHtml(formatted)}</pre>`;
      } catch {
        return `<pre class="ghn-plain">${escapeHtml(content)}</pre>`;
      }

    case "yaml": {
      const lines = escapeHtml(content).split("\n");
      const highlighted = lines
        .map((line) => {
          const m = line.match(/^(\s*)([\w.-]+)(:)(\s.*)?$/);
          if (m) {
            return `${m[1]}<span class="ghn-yaml-key">${m[2]}</span>${m[3]}${m[4] || ""}`;
          }
          return line;
        })
        .join("\n");
      return `<pre class="ghn-plain">${highlighted}</pre>`;
    }

    default:
      return `<pre class="ghn-plain">${escapeHtml(content)}</pre>`;
  }
}

function createSandboxedIframe(content, format) {
  const bodyHtml = renderContentToHtml(content, format);
  const srcdoc = buildSandboxedHtml(bodyHtml);

  const iframe = document.createElement("iframe");
  // allow-scripts for the height-reporting postMessage script only.
  // WITHOUT allow-same-origin, the iframe gets a unique opaque origin —
  // it cannot access github.com cookies, storage, or DOM even if the
  // content somehow runs unexpected code.
  iframe.sandbox = "allow-scripts";
  iframe.srcdoc = srcdoc;
  iframe.style.cssText =
    "width:100%;border:none;overflow:hidden;display:block;min-height:40px;";
  iframe.title = "Git note content";

  return iframe;
}

// Listen for height reports from sandboxed iframes
window.addEventListener("message", (e) => {
  if (e.data?.type === "ghn-resize" && typeof e.data.height === "number") {
    // Find the iframe that sent this message
    const container = document.getElementById(CONTAINER_ID);
    if (!container) return;
    for (const iframe of container.querySelectorAll("iframe")) {
      if (iframe.contentWindow === e.source) {
        iframe.style.height = e.data.height + "px";
        break;
      }
    }
  }
});

// --- UI rendering ---

function showLoading(container) {
  container.innerHTML = `
    <div class="ghn-box ghn-loading">
      <div class="ghn-header">
        <span class="ghn-icon">${noteIcon()}</span>
        <span class="ghn-title">Git Notes</span>
      </div>
      <div class="ghn-body">
        <span class="ghn-spinner"></span> Loading notes...
      </div>
    </div>
  `;
}

function showNotes(container, notes) {
  if (!notes || notes.length === 0) {
    removeExisting();
    return;
  }

  container.innerHTML = "";

  for (const note of notes) {
    const format = detectFormat(note.content);
    const formatLabel = format !== "plain" ? format : "";

    const box = document.createElement("div");
    box.className = "ghn-box";
    box.dataset.format = format;

    // Header
    const header = document.createElement("div");
    header.className = "ghn-header";
    header.innerHTML = `
      <span class="ghn-icon">${noteIcon()}</span>
      <span class="ghn-title">Git Notes</span>
      ${formatLabel ? `<span class="ghn-format-badge">${formatLabel}</span>` : ""}
      <span class="ghn-ref">${escapeHtml(note.ref)}</span>
      ${format !== "plain" ? `<button class="ghn-toggle-raw" title="Toggle raw view">${codeIcon()}</button>` : ""}
    `;
    box.appendChild(header);

    // Rendered body (sandboxed iframe for non-plain, direct pre for plain)
    const renderedBody = document.createElement("div");
    renderedBody.className = "ghn-body ghn-rendered";
    if (format !== "plain") {
      const iframe = createSandboxedIframe(note.content, format);
      renderedBody.appendChild(iframe);
    } else {
      const pre = document.createElement("pre");
      pre.className = "ghn-content";
      pre.textContent = note.content;
      renderedBody.appendChild(pre);
    }
    box.appendChild(renderedBody);

    // Raw body (always safe — textContent escaping)
    if (format !== "plain") {
      const rawBody = document.createElement("div");
      rawBody.className = "ghn-body ghn-raw";
      rawBody.hidden = true;
      const pre = document.createElement("pre");
      pre.className = "ghn-content";
      pre.textContent = note.content;
      rawBody.appendChild(pre);
      box.appendChild(rawBody);

      // Toggle handler
      const btn = header.querySelector(".ghn-toggle-raw");
      btn.addEventListener("click", () => {
        const showingRaw = !rawBody.hidden;
        renderedBody.hidden = !showingRaw;
        rawBody.hidden = showingRaw;
        btn.classList.toggle("ghn-active", !showingRaw);
      });
    }

    container.appendChild(box);
  }
}

function showError(container, message) {
  container.innerHTML = `
    <div class="ghn-box ghn-error">
      <div class="ghn-header">
        <span class="ghn-icon">${noteIcon()}</span>
        <span class="ghn-title">Git Notes</span>
      </div>
      <div class="ghn-body">${escapeHtml(message)}</div>
    </div>
  `;
}

function noteIcon() {
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" class="ghn-octicon">
    <path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25ZM3.5 6.25a.75.75 0 0 1 .75-.75h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Zm.75 2.25a.75.75 0 0 0 0 1.5h4a.75.75 0 0 0 0-1.5Z"/>
  </svg>`;
}

function codeIcon() {
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" class="ghn-octicon">
    <path d="m11.28 3.22 4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734L13.94 8l-3.72-3.72a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215Zm-6.56 0a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L2.06 8l3.72 3.72a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L.47 8.53a.75.75 0 0 1 0-1.06Z"/>
  </svg>`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// --- Main flow ---

async function processCommitPage() {
  const url = location.href;
  if (url === lastProcessedUrl) return;
  lastProcessedUrl = url;

  const commit = parseCommitUrl();
  if (!commit) {
    removeExisting();
    return;
  }

  removeExisting();

  const injection = await waitForInjectionPoint();
  if (!injection) return;
  if (location.href !== url) return;

  const container = injectContainer(injection);
  showLoading(container);

  try {
    const noteRefs = await getNoteRefs();
    const results = [];

    for (const ref of noteRefs) {
      try {
        const content = await fetchGitNote(
          commit.owner,
          commit.repo,
          ref,
          commit.commitSha
        );
        if (content !== null) {
          results.push({ ref, content });
        }
      } catch {
        // Skip refs that error (e.g., ref doesn't exist)
        continue;
      }
    }

    showNotes(container, results);
  } catch (err) {
    showError(container, err.message || "Error loading notes");
  }
}

// 1. Handle initial page load
processCommitPage();

// 2. Handle GitHub's Turbo Drive SPA navigation
document.addEventListener("turbo:load", () => {
  lastProcessedUrl = null;
  processCommitPage();
});

// 3. MutationObserver fallback for URL changes
let currentUrl = location.href;
const observer = new MutationObserver(() => {
  if (location.href !== currentUrl) {
    currentUrl = location.href;
    lastProcessedUrl = null;
    processCommitPage();
  }
});
observer.observe(document.body, { childList: true, subtree: true });
