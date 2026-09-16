/* Router, navigation, theme and live updates. Loaded last. */
(() => {
  const { views, state, api, h, replace, fail, toast } = IGUP;
  const order = ["dashboard", "connect", "posts", "calendar", "rules", "insights", "seminars", "logs", "settings"];
  const main = document.getElementById("main");
  const nav = document.getElementById("nav");
  let renderToken = 0;

  function applyTheme(settings) {
    const root = document.documentElement;
    if (settings.theme === "light" || settings.theme === "dark") root.dataset.theme = settings.theme;
    else delete root.dataset.theme;
    root.style.setProperty("--accent", settings.accent || "#7c3aed");
    root.style.setProperty("--accent-ink", readableInk(settings.accent || "#7c3aed"));
  }

  function readableInk(hex) {
    const value = parseInt(hex.slice(1), 16);
    const r = (value >> 16) & 255, g = (value >> 8) & 255, b = value & 255;
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.62 ? "#1f1d1a" : "#ffffff";
  }

  function renderNav() {
    replace(nav, order.map((key) => {
      const view = views[key];
      return h("button", { type: "button", class: state.view === key ? "active" : "", onClick: () => navigate(key) }, h("span", { class: "icon" }, view.icon), view.title);
    }));
  }

  async function navigate(key, params = {}) {
    if (!views[key]) return;
    state.view = key;
    state.params = params;
    renderNav();
    await render();
  }

  async function render() {
    const token = ++renderToken;
    const view = views[state.view];
    const container = h("div", { class: "view" });
    try {
      await view.render(container, state.params || {});
    } catch (error) {
      fail(error);
      replace(container, h("div", { class: "empty" }, "画面を表示できませんでした: ", IGUP.errorMessage(error)));
    }
    if (token === renderToken) replace(main, container);
  }

  async function refreshStatus() {
    try {
      state.status = await api("connection:status");
    } catch (error) {
      state.status = null;
    }
    if (state.status?.activeAccountId) state.activeAccountId = state.status.activeAccountId;
    renderAccountSwitch();
    const auto = document.getElementById("automation-pill");
    const conn = document.getElementById("connection-pill");
    const status = state.status;
    const enabled = status?.automation?.enabled;
    auto.textContent = enabled ? `自動返信: 稼働中${status.automation.webhookMode ? "（Webhook）" : "（ポーリング）"}` : "自動返信: 停止中";
    auto.className = `pill ${enabled ? "on" : "off"}`;
    conn.textContent = status?.instagram?.connected ? "Instagram: 接続済み" : "Instagram: 未接続";
    conn.className = `pill ${status?.instagram?.connected ? "on" : "bad"}`;
  }

  function renderAccountSwitch() {
    const box = document.getElementById("account-switch");
    const list = state.status?.accounts ?? [];
    if (list.length === 0) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const { h, replace, accountName } = IGUP;
    replace(box,
      h("select", {
        "aria-label": "アカウント",
        onChange: (event) => {
          void IGUP.api("accounts:setActive", { accountId: event.target.value }).then(() => refreshStatus()).catch(IGUP.fail);
        },
      }, list.map((account) => h("option", {
        value: account.id,
        selected: account.id === (state.activeAccountId ?? state.status?.activeAccountId),
      }, `${accountName(account.id)}${account.instagram.connected ? "" : "（未接続）"}`))),
      h("button", { class: "ghost", type: "button", title: "アカウントを追加", onClick: () => void navigate("connect") }, "＋"),
    );
  }

  let rerenderTimer;
  function scheduleRerender() {
    clearTimeout(rerenderTimer);
    rerenderTimer = setTimeout(() => { if (!state.modalOpen) void render(); }, 300);
  }

  window.igup.on((message) => {
    const { type, payload } = message;
    if (type === "connection:changed") {
      toast(payload?.provider === "threads" ? "Threadsと接続しました。" : "接続情報が更新されました。");
      void refreshStatus().then(scheduleRerender);
      return;
    }
    if (type === "automation:status") { void refreshStatus(); return; }
    if (type === "data:settings:changed") {
      void api("settings:get").then((settings) => { state.settings = settings; applyTheme(settings); refreshStatus(); });
      return;
    }
    if (type === "data:log") {
      if (payload?.level === "error") toast(payload.title, true);
      if (state.view === "logs" || state.view === "dashboard") scheduleRerender();
      return;
    }
    if (type === "posts:progress") {
      const el = document.querySelector(`[data-progress="${payload?.postId}"]`);
      if (el) el.textContent = payload.text;
      return;
    }
    if (type.startsWith("data:") || type.endsWith(":changed")) scheduleRerender();
  });

  IGUP.navigate = navigate;
  IGUP.refreshStatus = refreshStatus;
  IGUP.applyTheme = applyTheme;
  IGUP.rerender = () => void render();

  (async () => {
    try {
      state.settings = await api("settings:get");
      applyTheme(state.settings);
    } catch (error) {
      fail(error);
    }
    await refreshStatus();
    setInterval(refreshStatus, 30_000);
    renderNav();
    await navigate("dashboard");
  })();
})();
