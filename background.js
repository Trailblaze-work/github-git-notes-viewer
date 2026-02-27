if (typeof browser === "undefined") globalThis.browser = chrome;

// In-memory cache: key = "owner/repo:ref" → { tree: Map<commitSha, blobSha>, ts: number }
const treeCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function isCacheValid(entry) {
  return entry && Date.now() - entry.ts < CACHE_TTL;
}

async function githubApi(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (res.status === 401) {
    throw { status: 401, message: "Invalid or expired token" };
  }
  if (res.status === 403) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining === "0") {
      const reset = res.headers.get("x-ratelimit-reset");
      const resetDate = reset ? new Date(Number(reset) * 1000) : null;
      throw {
        status: 403,
        message: `Rate limit exceeded${resetDate ? `. Resets at ${resetDate.toLocaleTimeString()}` : ""}`,
      };
    }
    throw { status: 403, message: "Forbidden" };
  }
  if (res.status === 404) {
    throw { status: 404, message: "Not found" };
  }
  if (!res.ok) {
    throw { status: res.status, message: `GitHub API error: ${res.status}` };
  }

  return res.json();
}

// Fetch the notes tree for a given repo and ref, with caching
async function fetchNotesTree(owner, repo, noteRef, token) {
  const cacheKey = `${owner}/${repo}:${noteRef}`;
  const cached = treeCache.get(cacheKey);
  if (isCacheValid(cached)) {
    return cached.tree;
  }

  // 1. Get the notes ref
  const encodedRef = noteRef.replace(/\//g, "%2F");
  const refData = await githubApi(
    `/repos/${owner}/${repo}/git/ref/${encodedRef}`,
    token
  );
  const commitSha = refData.object.sha;

  // 2. Get the commit to find the tree
  const commitData = await githubApi(
    `/repos/${owner}/${repo}/git/commits/${commitSha}`,
    token
  );
  const treeSha = commitData.tree.sha;

  // 3. Get the tree entries
  const treeData = await githubApi(
    `/repos/${owner}/${repo}/git/trees/${treeSha}`,
    token
  );

  // Build the lookup: commit SHA → { blobSha } or { subtreeSha, prefix }
  const tree = new Map();
  for (const entry of treeData.tree) {
    if (entry.type === "blob") {
      // Direct mapping: entry.path is the full commit SHA
      tree.set(entry.path, { type: "blob", sha: entry.sha });
    } else if (entry.type === "tree") {
      // Fanout: entry.path is first 2 chars of commit SHA
      tree.set(entry.path, { type: "tree", sha: entry.sha });
    }
  }

  treeCache.set(cacheKey, { tree, ts: Date.now() });
  return tree;
}

// Resolve a commit SHA to its note blob SHA, handling fanout
async function resolveNoteBlob(owner, repo, noteRef, commitSha, token) {
  const tree = await fetchNotesTree(owner, repo, noteRef, token);

  // Try direct lookup first (no fanout)
  const direct = tree.get(commitSha);
  if (direct && direct.type === "blob") {
    return direct.sha;
  }

  // Try fanout: first 2 chars → subtree, remaining 38 chars → blob
  const prefix = commitSha.slice(0, 2);
  const suffix = commitSha.slice(2);
  const subtreeEntry = tree.get(prefix);
  if (!subtreeEntry || subtreeEntry.type !== "tree") {
    return null; // No note for this commit
  }

  // Fetch the subtree
  const subtreeData = await githubApi(
    `/repos/${owner}/${repo}/git/trees/${subtreeEntry.sha}`,
    token
  );
  for (const entry of subtreeData.tree) {
    if (entry.path === suffix && entry.type === "blob") {
      return entry.sha;
    }
  }

  return null;
}

// Fetch and decode a blob's content
async function fetchBlobContent(owner, repo, blobSha, token) {
  const blobData = await githubApi(
    `/repos/${owner}/${repo}/git/blobs/${blobSha}`,
    token
  );
  if (blobData.encoding === "base64") {
    return atob(blobData.content.replace(/\n/g, ""));
  }
  return blobData.content;
}

// Main handler: fetch git note for a specific commit
async function fetchGitNote(owner, repo, commitSha, noteRef, token) {
  const blobSha = await resolveNoteBlob(
    owner,
    repo,
    noteRef,
    commitSha,
    token
  );
  if (!blobSha) {
    return null;
  }
  const content = await fetchBlobContent(owner, repo, blobSha, token);
  return content;
}

// Get configured note refs, or default
async function getNoteRefs() {
  const { noteRefs } = await browser.storage.local.get("noteRefs");
  if (noteRefs && noteRefs.length > 0) {
    return noteRefs;
  }
  return ["refs/notes/commits"];
}

// Message handler
browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "FETCH_GIT_NOTE") {
    handleFetchGitNote(message).then(sendResponse);
    return true; // async response
  }

  if (message.type === "CHECK_AUTH") {
    handleCheckAuth().then(sendResponse);
    return true;
  }

  if (message.type === "CLEAR_CACHE") {
    treeCache.clear();
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "GET_NOTE_REFS") {
    getNoteRefs().then(sendResponse);
    return true;
  }
});

async function handleFetchGitNote({ owner, repo, commitSha }) {
  const { githubToken } = await browser.storage.local.get("githubToken");
  if (!githubToken) {
    return { error: "no_token", message: "No GitHub token configured" };
  }

  const noteRefs = await getNoteRefs();
  const results = [];

  for (const ref of noteRefs) {
    try {
      const content = await fetchGitNote(
        owner,
        repo,
        commitSha,
        ref,
        githubToken
      );
      if (content !== null) {
        results.push({ ref, content });
      }
    } catch (err) {
      if (err.status === 404) {
        // No notes ref in this repo — skip silently
        continue;
      }
      if (err.status === 401) {
        return { error: "auth_error", message: err.message };
      }
      if (err.status === 403) {
        return { error: "rate_limit", message: err.message };
      }
      return { error: "api_error", message: err.message };
    }
  }

  return { notes: results };
}

async function handleCheckAuth() {
  const { githubToken } = await browser.storage.local.get("githubToken");
  if (!githubToken) {
    return { authenticated: false };
  }
  try {
    const user = await githubApi("/user", githubToken);
    return { authenticated: true, username: user.login };
  } catch (err) {
    return { authenticated: false, error: err.message };
  }
}
