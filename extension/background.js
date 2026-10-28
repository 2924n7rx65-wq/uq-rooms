// Only ever sends the token to the local UQ Rooms server.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "bookit-token") return;
  fetch("http://localhost:5173/api/bookit-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: msg.token }),
  }).catch(() => { /* UQ Rooms not running */ });
});
