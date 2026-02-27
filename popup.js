if (typeof browser === "undefined") globalThis.browser = chrome;

const authStatus = document.getElementById("auth-status");
const refsInfo = document.getElementById("refs-info");
const settingsBtn = document.getElementById("open-settings");

async function init() {
  // Check auth
  const auth = await browser.runtime.sendMessage({ type: "CHECK_AUTH" });
  const dot = authStatus.querySelector(".dot");
  const label = authStatus.querySelector(".label");

  if (auth.authenticated) {
    dot.classList.add("connected");
    label.textContent = `Authenticated as ${auth.username}`;
  } else {
    dot.classList.add("disconnected");
    label.textContent = auth.error
      ? `Auth error: ${auth.error}`
      : "No token configured";
  }

  // Show note refs (use textContent to avoid XSS from stored values)
  const refs = await browser.runtime.sendMessage({ type: "GET_NOTE_REFS" });
  if (refs && refs.length > 0) {
    refsInfo.textContent = "";
    const label = document.createElement("span");
    label.className = "refs-label";
    label.textContent = "Checking refs:";
    refsInfo.appendChild(label);
    for (const r of refs) {
      const code = document.createElement("code");
      code.textContent = r;
      refsInfo.appendChild(document.createTextNode(" "));
      refsInfo.appendChild(code);
    }
  }
}

settingsBtn.addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

init();
