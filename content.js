if (typeof browser === "undefined") globalThis.browser = chrome;

const CONTAINER_ID = "ghn-notes-container";
const COMMIT_URL_RE = /^\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{5,40})$/i;
const COLLAPSE_HEIGHT = 500; // px — notes taller than this start collapsed

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
          headers: { Authorization: `Bearer ${token}` },
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
  // Strategy 1: Try fetching the note content directly
  const directContent = await fetchNoteContent(owner, repo, noteRef, commitSha);
  if (directContent !== null) return { content: directContent };

  // Strategy 2: Use the JSON tree endpoint to find the full SHA
  const entries = await fetchNotesTreeEntries(owner, repo, noteRef);
  if (!entries) return null;

  const match = entries.find(
    (e) => e.name === commitSha || e.name.startsWith(commitSha)
  );

  if (match && match.contentType === "file") {
    const content = await fetchNoteContent(owner, repo, noteRef, match.name);
    if (content !== null) return { content };
    return { content: null, needsToken: true };
  }

  // Check fanout
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
          owner, repo, noteRef, `${prefix}/${subMatch.name}`
        );
        if (content !== null) return { content };
        return { content: null, needsToken: true };
      }
    }
  }

  return null;
}

// Common note ref names to always try
const DEFAULT_NOTE_REFS = [
  "refs/notes/commits",
  "refs/notes/claude-prompt-trail",
];

// Auto-discover note refs via GitHub API (works without auth for public repos)
async function discoverNoteRefs(owner, repo) {
  try {
    const headers = { Accept: "application/vnd.github+json" };
    const token = await getStoredToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/matching-refs/notes`,
      { headers }
    );
    if (res.ok) {
      const data = await res.json();
      return data.map((r) => r.ref).filter((r) => r.startsWith("refs/notes/"));
    }
  } catch {
    // API unavailable — fall back to defaults
  }
  return [];
}

// Get note refs: auto-discovered + defaults + user-configured
async function getNoteRefs(owner, repo) {
  const refs = new Set(DEFAULT_NOTE_REFS);

  // Auto-discover from API
  const discovered = await discoverNoteRefs(owner, repo);
  for (const r of discovered) refs.add(r);

  // Add user-configured refs
  try {
    const { noteRefs } = await browser.storage.local.get("noteRefs");
    if (noteRefs && noteRefs.length > 0) {
      for (const r of noteRefs) refs.add(r);
    }
  } catch {
    // storage might not be available
  }
  return [...refs];
}

// --- Format detection ---

function detectFormat(content) {
  const trimmed = content.trim();

  if (/^[\[{]/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch { /* not valid JSON */ }
  }

  if (
    /^#{1,6}\s/m.test(trimmed) ||
    /\*\*[^*]+\*\*/m.test(trimmed) ||
    /^\|.+\|$/m.test(trimmed) ||
    /^[-*]\s/m.test(trimmed) ||
    /^\d+\.\s/m.test(trimmed) ||
    /^```/m.test(trimmed) ||
    /<!--.*-->/m.test(trimmed)
  ) {
    return "markdown";
  }

  if (
    /^[a-zA-Z_][a-zA-Z0-9_]*:\s/m.test(trimmed) &&
    (trimmed.match(/^[a-zA-Z_][a-zA-Z0-9_]*:\s/gm) || []).length >= 2
  ) {
    return "yaml";
  }

  return "plain";
}

// --- Rendering ---
// Rendered content is sanitized by DOMPurify and inserted directly into the
// page. No iframe needed — DOMPurify with a strict allowlist is the industry
// standard for safe HTML rendering (same approach GitHub uses for user markdown).

function renderContentToHtml(content, format) {
  switch (format) {
    case "markdown":
      if (typeof marked !== "undefined") {
        const rawHtml = marked.parse(content, { breaks: true, gfm: true });
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
        return cleanHtml;
      }
      return `<pre class="ghn-content">${escapeHtml(content)}</pre>`;

    case "json":
      try {
        const formatted = JSON.stringify(JSON.parse(content.trim()), null, 2);
        return `<pre class="ghn-content">${escapeHtml(formatted)}</pre>`;
      } catch {
        return `<pre class="ghn-content">${escapeHtml(content)}</pre>`;
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
      return `<pre class="ghn-content">${highlighted}</pre>`;
    }

    default:
      return `<pre class="ghn-content">${escapeHtml(content)}</pre>`;
  }
}

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

    // Rendered body — sanitized HTML injected directly (no iframe)
    const renderedBody = document.createElement("div");
    renderedBody.className = "ghn-body ghn-rendered";
    if (format === "markdown") {
      renderedBody.classList.add("markdown-body");
    }
    renderedBody.innerHTML = renderContentToHtml(note.content, format);
    box.appendChild(renderedBody);

    // Raw body (hidden by default, safe — textContent)
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

    // "Show full note" / "Collapse" — check after appending to DOM
    const showMoreBtn = document.createElement("button");
    showMoreBtn.className = "ghn-show-more";
    showMoreBtn.textContent = "Show full note";
    showMoreBtn.hidden = true;
    showMoreBtn.addEventListener("click", () => {
      const isExpanded = box.classList.toggle("ghn-expanded");
      showMoreBtn.textContent = isExpanded ? "Collapse note" : "Show full note";
    });
    box.appendChild(showMoreBtn);

    container.appendChild(box);

    // Measure after it's in the DOM
    requestAnimationFrame(() => {
      const bodyHeight = renderedBody.scrollHeight;
      if (bodyHeight > COLLAPSE_HEIGHT) {
        box.classList.add("ghn-collapsed");
        showMoreBtn.hidden = false;
      }
    });
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
  body.textContent = "Notes found but can\u2019t be read \u2014 ";
  const link = document.createElement("a");
  link.className = "ghn-settings-link";
  link.textContent = "configure a GitHub token";
  link.href = "#";
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
    const noteRefs = await getNoteRefs(commit.owner, commit.repo);
    const results = [];
    let needsToken = false;

    for (const ref of noteRefs) {
      try {
        const result = await fetchGitNote(
          commit.owner, commit.repo, ref, commit.commitSha
        );
        if (result && result.content !== null) {
          results.push({ ref, content: result.content });
        } else if (result && result.needsToken) {
          needsToken = true;
        }
      } catch {
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
