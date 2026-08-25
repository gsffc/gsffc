// www's login corner: replaces the plain 登录 link with the signed-in
// member's name (linked to their app profile). Progressive enhancement —
// any failure leaves the 登录 link untouched. The app renders its corner
// server-side (ui/slots/app-login.ejs) and doesn't use this script.
//
// PROVISIONAL session-endpoint contract (finalized by the app side in #10):
//   GET https://app.gsffc.org/api/session   (fetch with credentials: "include")
//   200 { "name": "<display name>" } when signed in; 401 otherwise.
//   The app must CORS-allow https://www.gsffc.org with credentials.
(() => {
  const corner = document.querySelector("[data-login-corner]");
  if (!corner) return;
  fetch("https://app.gsffc.org/api/session", { credentials: "include" })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data || typeof data.name !== "string" || !data.name) return;
      // Signed in: name with a hover menu holding 登出 (mirrors the app's
      // server-rendered corner, ui/slots/app-login.ejs).
      const link = document.createElement("a");
      link.href = "https://app.gsffc.org/profile";
      link.textContent = `${data.name} ▾`;
      const menu = document.createElement("div");
      menu.className = "gsf-dropdown-content";
      const logout = document.createElement("a");
      logout.href = "https://app.gsffc.org/logout";
      logout.textContent = "登出";
      menu.appendChild(logout);
      corner.classList.add("gsf-dropdown");
      corner.replaceChildren(link, menu);
    })
    .catch(() => {
      // Endpoint absent/unreachable (pre-#10, app down, CORS) — keep the link.
    });
})();
