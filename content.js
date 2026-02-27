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

  container.innerHTML = notes
    .map(
      (note) => `
    <div class="ghn-box">
      <div class="ghn-header">
        <span class="ghn-icon">${noteIcon()}</span>
        <span class="ghn-title">Git Notes</span>
        <span class="ghn-ref">${escapeHtml(note.ref)}</span>
      </div>
      <div class="ghn-body">
        <pre class="ghn-content">${escapeHtml(note.content)}</pre>
      </div>
    </div>
  `
    )
    .join("");
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
