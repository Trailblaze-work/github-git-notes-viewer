if (typeof browser === "undefined") globalThis.browser = chrome;

const authStatus = document.getElementById("auth-status");
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

}

settingsBtn.addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

init();
