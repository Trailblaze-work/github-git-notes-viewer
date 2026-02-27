if (typeof browser === "undefined") globalThis.browser = chrome;

const tokenInput = document.getElementById("token");
const toggleBtn = document.getElementById("toggle-visibility");
const saveTokenBtn = document.getElementById("save-token");
const validateBtn = document.getElementById("validate-token");
const tokenStatus = document.getElementById("token-status");
const clearCacheBtn = document.getElementById("clear-cache");
const cacheStatus = document.getElementById("cache-status");

// Load saved settings
browser.storage.local.get(["githubToken"]).then((data) => {
  if (data.githubToken) {
    tokenInput.value = data.githubToken;
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
