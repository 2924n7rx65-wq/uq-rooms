// Runs on uqbookit.uq.edu.au. Book It keeps its 1-hour session token in
// localStorage and refreshes it while the tab is open; pass each new one on.
let last = null;
function check() {
  try {
    const raw = localStorage.getItem("scientia-session-authorization");
    const token = raw && JSON.parse(raw).access_token;
    if (token && token !== last) {
      last = token;
      chrome.runtime.sendMessage({ type: "bookit-token", token });
    }
  } catch (e) { /* not logged in yet */ }
}
check();
setInterval(check, 15000);
