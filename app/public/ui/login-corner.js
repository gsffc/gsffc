// Shared login corner: replaces the plain 登录 link with the signed-in
// member's name (linked to their app profile). Progressive enhancement —
// any failure leaves the 登录 link untouched.
//
// PROVISIONAL session-endpoint contract (finalized by the app side in #10):
//   GET https://app.gsffc.org/api/session   (fetch with credentials: "include")
//   200 { "name": "<display name>" } when signed in; 401 otherwise.
//   The app must CORS-allow https://www.gsffc.org with credentials.
(() => {
  const corner = document.querySelector("[data-login-corner]");
  if (!corner) return;
  // Relative on the app itself (incl. local dev), absolute from www.
  const endpoint =
    location.host === "app.gsffc.org" || location.host.startsWith("localhost")
      ? "/api/session"
      : "https://app.gsffc.org/api/session";
  fetch(endpoint, { credentials: "include" })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data || typeof data.name !== "string" || !data.name) return;
      const link = document.createElement("a");
      link.href = "https://app.gsffc.org/profile";
      link.textContent = data.name;
      corner.replaceChildren(link);
    })
    .catch(() => {
      // Endpoint absent/unreachable (pre-#10, app down, CORS) — keep the link.
    });
})();
