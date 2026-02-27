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

// Get stored PAT (if configured) for private repo fallback
let _cachedToken = undefined;
async function getStoredToken() {
  if (_cachedToken !== undefined) return _cachedToken;
  try {
    const { githubToken } = await browser.storage.local.get("githubToken");
    _cachedToken = githubToken || null;
  } catch {
    _cachedToken = null;
  }
  return _cachedToken;
}

// Fetch note content for a specific commit SHA
async function fetchNoteContent(owner, repo, noteRef, commitSha) {
  const branchName = noteRef.replace(/^refs\//, "");
  const cacheBust = `_=${Date.now()}`;

  // Build candidate paths: direct and fanout
  const paths = [
    `${branchName}/${commitSha}`,
    `${branchName}/${commitSha.slice(0, 2)}/${commitSha.slice(2)}`,
  ];

  // Strategy 1: raw.githubusercontent.com without auth (works for public repos)
  for (const path of paths) {
    try {
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/${path}?${cacheBust}`;
      const res = await fetch(url);
      if (res.ok) return await res.text();
    } catch {
      continue;
    }
  }

  // Strategy 2: raw.githubusercontent.com with PAT (needed for private repos)
  const token = await getStoredToken();
  if (token) {
    for (const path of paths) {
      try {
        const url = `https://raw.githubusercontent.com/${owner}/${repo}/${path}?${cacheBust}`;
        const res = await fetch(url, {
          headers: { Authorization: `token ${token}` },
        });
        if (res.ok) return await res.text();
      } catch {
        continue;
      }
    }
  }

  return null;
}

// Fetch git note, resolving the full commit SHA if needed.
// Returns { content, needsToken } or null.
async function fetchGitNote(owner, repo, noteRef, commitSha) {
  // Strategy 1: Try fetching the note content directly (works even when
  // the tree endpoint doesn't handle the ref). Tries the commit SHA as-is,
  // then with fanout (ab/cdef...) layout.
  const directContent = await fetchNoteContent(owner, repo, noteRef, commitSha);
  if (directContent !== null) return { content: directContent };

  // Strategy 2: Use the JSON tree endpoint to find the full SHA (handles
  // abbreviated commit SHAs in the URL) and fanout directories.
  const entries = await fetchNotesTreeEntries(owner, repo, noteRef);
  if (!entries) return null;

  // The commit SHA in the URL might be abbreviated — find the matching entry
  const match = entries.find(
    (e) => e.name === commitSha || e.name.startsWith(commitSha)
  );

  if (match && match.contentType === "file") {
    const content = await fetchNoteContent(owner, repo, noteRef, match.name);
    if (content !== null) return { content };
    // Tree shows a note exists but we can't fetch content — likely a private repo
    // without a PAT configured.
    return { content: null, needsToken: true };
  }

  // Check fanout: entry might be a directory named with first 2 chars of our SHA
  const prefix = commitSha.slice(0, 2);
  const fanoutDir = entries.find(
    (e) => e.name === prefix && e.contentType === "directory"
  );
  if (fanoutDir) {
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
        const content = await fetchNoteContent(
          owner,
          repo,
          noteRef,
          `${prefix}/${subMatch.name}`
        );
        if (content !== null) return { content };
        return { content: null, needsToken: true };
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
// Rendered content goes into a sandboxed iframe to prevent XSS.
// sandbox="allow-scripts" WITHOUT allow-same-origin gives the iframe a
// unique opaque origin — it cannot access github.com cookies or DOM.

function getComputedCssVars() {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const vars = {
    fgDefault: style.getPropertyValue("--fgColor-default").trim() || "#e6edf3",
    fgMuted: style.getPropertyValue("--fgColor-muted").trim() || "#8b949e",
    fgAccent: style.getPropertyValue("--fgColor-accent").trim() || "#58a6ff",
    bgDefault: style.getPropertyValue("--bgColor-default").trim() || "#0d1117",
    bgMuted: style.getPropertyValue("--bgColor-muted").trim() || "#161b22",
    borderDefault:
      style.getPropertyValue("--borderColor-default").trim() || "#30363d",
  };
  return vars;
}

function buildSandboxedHtml(bodyHtml) {
  // Resolve CSS variables from the parent page and inline them so the
  // sandboxed iframe (opaque origin) doesn't need external stylesheets.
  const v = getComputedCssVars();
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
body {
  margin: 0;
  padding: 0;
  background: transparent !important;
  color: ${v.fgDefault};
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans",
    Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
  font-size: 14px;
  line-height: 1.5;
}
/* Markdown body styles (inline, no external GitHub stylesheets) */
.markdown-body { font-size: 14px; line-height: 1.6; color: ${v.fgDefault}; }
.markdown-body h1, .markdown-body h2, .markdown-body h3,
.markdown-body h4, .markdown-body h5, .markdown-body h6 {
  margin-top: 24px; margin-bottom: 16px; font-weight: 600; line-height: 1.25;
}
.markdown-body h1 { font-size: 2em; padding-bottom: .3em; border-bottom: 1px solid ${v.borderDefault}; }
.markdown-body h2 { font-size: 1.5em; padding-bottom: .3em; border-bottom: 1px solid ${v.borderDefault}; }
.markdown-body h3 { font-size: 1.25em; }
.markdown-body h2:first-child, .markdown-body h3:first-child {
  margin-top: 0; padding-top: 0; border-top: none;
}
.markdown-body p { margin-top: 0; margin-bottom: 16px; }
.markdown-body a { color: ${v.fgAccent}; text-decoration: none; }
.markdown-body a:hover { text-decoration: underline; }
.markdown-body strong { font-weight: 600; }
.markdown-body ul, .markdown-body ol { padding-left: 2em; margin-top: 0; margin-bottom: 16px; }
.markdown-body li + li { margin-top: .25em; }
.markdown-body code {
  padding: .2em .4em; margin: 0; font-size: 85%; white-space: break-spaces;
  background: ${v.bgMuted}; border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}
.markdown-body pre { padding: 16px; overflow: auto; font-size: 85%; line-height: 1.45;
  background: ${v.bgMuted}; border-radius: 6px; margin-bottom: 16px; }
.markdown-body pre code { padding: 0; background: transparent; border-radius: 0; font-size: 100%; }
.markdown-body blockquote { margin: 0 0 16px 0; padding: 0 1em;
  color: ${v.fgMuted}; border-left: .25em solid ${v.borderDefault}; }
.markdown-body hr { height: .25em; padding: 0; margin: 24px 0;
  background: ${v.borderDefault}; border: 0; }
.markdown-body table { border-spacing: 0; border-collapse: collapse; margin-bottom: 16px;
  width: max-content; max-width: 100%; overflow: auto; font-size: 13px; }
.markdown-body th, .markdown-body td { padding: 6px 13px;
  border: 1px solid ${v.borderDefault}; }
.markdown-body th { font-weight: 600; background: ${v.bgMuted}; }
.markdown-body tr:nth-child(2n) { background: ${v.bgMuted}; }
.markdown-body img { max-width: 100%; }

pre.ghn-plain {
  margin: 0; white-space: pre-wrap; word-wrap: break-word;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 13px; line-height: 1.5; color: ${v.fgDefault};
}
.ghn-yaml-key { color: ${v.fgAccent}; }
</style>
</head>
<body>${bodyHtml}</body>
<script>
// Report height to parent for auto-sizing (runs in unique origin, no access to github.com)
function reportHeight() {
  var h = document.documentElement.scrollHeight;
  window.parent.postMessage({ type: 'ghn-resize', height: h }, '*');
}
new ResizeObserver(reportHeight).observe(document.body);
window.addEventListener('load', reportHeight);
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
    const container = document.getElementById(CONTAINER_ID);
    if (!container) return;
    for (const iframe of container.querySelectorAll("iframe")) {
      if (iframe.contentWindow === e.source) {
        iframe.style.height = e.data.height + "px";
        // Trigger truncation check on the wrapper
        const wrapper = iframe.closest(".ghn-body-wrapper");
        if (wrapper?._ghnCheckTruncation) {
          wrapper._ghnCheckTruncation();
        }
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

const COLLAPSE_HEIGHT = 300; // px — notes taller than this get collapsed

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

    // Collapsible body wrapper
    const wrapper = document.createElement("div");
    wrapper.className = "ghn-body-wrapper";

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
    wrapper.appendChild(renderedBody);

    // Raw body (always safe — textContent escaping)
    if (format !== "plain") {
      const rawBody = document.createElement("div");
      rawBody.className = "ghn-body ghn-raw";
      rawBody.hidden = true;
      const pre = document.createElement("pre");
      pre.className = "ghn-content";
      pre.textContent = note.content;
      rawBody.appendChild(pre);
      wrapper.appendChild(rawBody);

      // Toggle handler
      const btn = header.querySelector(".ghn-toggle-raw");
      btn.addEventListener("click", () => {
        const showingRaw = !rawBody.hidden;
        renderedBody.hidden = !showingRaw;
        rawBody.hidden = showingRaw;
        btn.classList.toggle("ghn-active", !showingRaw);
      });
    }

    box.appendChild(wrapper);

    // "Show more" button — added after the wrapper, shown if content overflows
    const showMoreBtn = document.createElement("button");
    showMoreBtn.className = "ghn-show-more";
    showMoreBtn.textContent = "Show full note";
    showMoreBtn.hidden = true;
    showMoreBtn.addEventListener("click", () => {
      const expanded = wrapper.classList.toggle("ghn-expanded");
      wrapper.classList.toggle("ghn-truncated", !expanded);
      showMoreBtn.textContent = expanded
        ? "Collapse note"
        : "Show full note";
    });
    box.appendChild(showMoreBtn);

    // Check whether truncation is needed after iframe height is known
    const checkTruncation = () => {
      const contentHeight = wrapper.scrollHeight;
      if (contentHeight > COLLAPSE_HEIGHT) {
        wrapper.classList.add("ghn-truncated");
        showMoreBtn.hidden = false;
      }
    };
    // For iframes, defer until the height message arrives; for plain, check immediately
    if (format !== "plain") {
      // Will be called via postMessage handler after iframe reports height
      wrapper.dataset.ghnPendingTruncationCheck = "1";
    } else {
      requestAnimationFrame(checkTruncation);
    }
    // Store the checker so the postMessage handler can invoke it
    wrapper._ghnCheckTruncation = checkTruncation;

    container.appendChild(box);
  }
}

function showTokenNeeded(container) {
  container.innerHTML = "";
  const box = document.createElement("div");
  box.className = "ghn-box ghn-error";

  const header = document.createElement("div");
  header.className = "ghn-header";
  header.innerHTML = `
    <span class="ghn-icon">${noteIcon()}</span>
    <span class="ghn-title">Git Notes</span>
  `;
  box.appendChild(header);

  const body = document.createElement("div");
  body.className = "ghn-body";
  body.textContent = "Notes found but can't be read — ";
  const link = document.createElement("a");
  link.className = "ghn-settings-link";
  link.textContent = "configure a GitHub token";
  link.addEventListener("click", (e) => {
    e.preventDefault();
    browser.runtime.sendMessage({ type: "OPEN_OPTIONS" });
  });
  body.appendChild(link);
  body.appendChild(document.createTextNode(" for private repo support."));
  box.appendChild(body);

  container.appendChild(box);
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
    let needsToken = false;

    for (const ref of noteRefs) {
      try {
        const result = await fetchGitNote(
          commit.owner,
          commit.repo,
          ref,
          commit.commitSha
        );
        if (result && result.content !== null) {
          results.push({ ref, content: result.content });
        } else if (result && result.needsToken) {
          needsToken = true;
        }
      } catch {
        // Skip refs that error (e.g., ref doesn't exist)
        continue;
      }
    }

    if (results.length > 0) {
      showNotes(container, results);
    } else if (needsToken) {
      showTokenNeeded(container);
    } else {
      removeExisting();
    }
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
