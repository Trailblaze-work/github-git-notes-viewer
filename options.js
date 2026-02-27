if (typeof browser === "undefined") globalThis.browser = chrome;

const tokenInput = document.getElementById("token");
const toggleBtn = document.getElementById("toggle-visibility");
const saveTokenBtn = document.getElementById("save-token");
const validateBtn = document.getElementById("validate-token");
const tokenStatus = document.getElementById("token-status");
const noteRefsInput = document.getElementById("note-refs");
const saveRefsBtn = document.getElementById("save-refs");
const refsStatus = document.getElementById("refs-status");
const clearCacheBtn = document.getElementById("clear-cache");
const cacheStatus = document.getElementById("cache-status");

// Load saved settings
browser.storage.local.get(["githubToken", "noteRefs"]).then((data) => {
  if (data.githubToken) {
    tokenInput.value = data.githubToken;
  }
  if (data.noteRefs && data.noteRefs.length > 0) {
    noteRefsInput.value = data.noteRefs.join("\n");
  }
});

// Toggle token visibility
toggleBtn.addEventListener("click", () => {
  const isPassword = tokenInput.type === "password";
  tokenInput.type = isPassword ? "text" : "password";
  toggleBtn.textContent = isPassword ? "Hide" : "Show";
});

// Save token
saveTokenBtn.addEventListener("click", async () => {
  const token = tokenInput.value.trim();
  await browser.storage.local.set({ githubToken: token || undefined });
  showStatus(tokenStatus, token ? "Token saved." : "Token cleared.", "success");
});

// Validate token
validateBtn.addEventListener("click", async () => {
  const token = tokenInput.value.trim();
  if (!token) {
    showStatus(tokenStatus, "Enter a token first.", "error");
    return;
  }
  showStatus(tokenStatus, "Validating...", "info");
  // Save before validating so background can use it
  await browser.storage.local.set({ githubToken: token });
  const result = await browser.runtime.sendMessage({ type: "CHECK_AUTH" });
  if (result.authenticated) {
    showStatus(
      tokenStatus,
      `Authenticated as ${result.username}`,
      "success"
    );
  } else {
    showStatus(
      tokenStatus,
      `Authentication failed: ${result.error || "unknown error"}`,
      "error"
    );
  }
});

// Save note refs
saveRefsBtn.addEventListener("click", async () => {
  const refs = noteRefsInput.value
    .split("\n")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  await browser.storage.local.set({ noteRefs: refs });
  showStatus(
    refsStatus,
    `Saved ${refs.length} ref${refs.length !== 1 ? "s" : ""}.`,
    "success"
  );
});

// Clear cache
clearCacheBtn.addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "CLEAR_CACHE" });
  showStatus(cacheStatus, "Cache cleared.", "success");
});

function showStatus(el, text, type) {
  el.textContent = text;
  el.className = `status ${type}`;
  el.hidden = false;
  if (type !== "info") {
    setTimeout(() => {
      el.hidden = true;
    }, 4000);
  }
}
