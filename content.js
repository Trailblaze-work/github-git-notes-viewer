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
  // Try multiple selectors in order of preference (GitHub's DOM changes frequently)
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

function createContainer() {
  const container = document.createElement("div");
  container.id = CONTAINER_ID;
  return container;
}

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

function showError(container, error) {
  let body;
  if (error === "no_token") {
    body = `
      No GitHub token configured.
      <a class="ghn-settings-link" href="#">Open settings</a> to add one.
    `;
  } else if (error === "auth_error") {
    body = `
      Authentication failed. Your token may be invalid or expired.
      <a class="ghn-settings-link" href="#">Update settings</a>
    `;
  } else if (error === "rate_limit") {
    body = `GitHub API rate limit exceeded. Please wait and try again.`;
  } else {
    body = `Error loading notes: ${escapeHtml(error)}`;
  }

  container.innerHTML = `
    <div class="ghn-box ghn-error">
      <div class="ghn-header">
        <span class="ghn-icon">${noteIcon()}</span>
        <span class="ghn-title">Git Notes</span>
      </div>
      <div class="ghn-body">${body}</div>
    </div>
  `;

  // Attach settings link handler
  container.querySelectorAll(".ghn-settings-link").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      browser.runtime.sendMessage({ type: "OPEN_OPTIONS" });
    });
  });
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

function injectContainer(injection) {
  const container = createContainer();
  if (injection.mode === "prepend") {
    injection.el.prepend(container);
  } else {
    injection.el.parentNode.insertBefore(container, injection.el);
  }
  return container;
}

// Wait for the injection point to appear (GitHub loads diff content async via Turbo)
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

  // Check we haven't navigated away while waiting
  if (location.href !== url) return;

  const container = injectContainer(injection);
  showLoading(container);

  try {
    const result = await browser.runtime.sendMessage({
      type: "FETCH_GIT_NOTE",
      owner: commit.owner,
      repo: commit.repo,
      commitSha: commit.commitSha,
    });

    if (result.error) {
      showError(container, result.error);
    } else {
      showNotes(container, result.notes);
    }
  } catch (err) {
    showError(container, err.message || "Connection error");
  }
}

function init() {
  processCommitPage();
}

// 1. Handle initial page load
init();

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
