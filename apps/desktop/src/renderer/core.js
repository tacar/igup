/* Shared helpers for every view. Loaded first. */
window.IGUP = (() => {
  const views = {};
  const state = { settings: null, status: null, view: "dashboard", modalOpen: false };

  const api = (channel, payload) => window.igup.invoke(channel, payload);

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    let deferredValue;
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") el.className = value;
      else if (key === "dataset") Object.assign(el.dataset, value);
      else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
      else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === "value") deferredValue = value;
      else if (key === "html") el.textContent = value; // never inject markup
      else if (key in el && key !== "list" && key !== "form") {
        try { el[key] = value === true ? true : value; } catch { el.setAttribute(key, value); }
      } else el.setAttribute(key, value === true ? "" : value);
    }
    append(el, children);
    if (deferredValue !== undefined) el.value = deferredValue;
    return el;
  }

  function append(el, children) {
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }

  function replace(el, ...children) {
    clear(el);
    return append(el, children);
  }

  // ---------------------------------------------------------------- toast / modal

  let toastTimer;
  function toast(message, error = false, ms = error ? 7000 : 4000) {
    const el = document.getElementById("toast");
    clearTimeout(toastTimer);
    el.textContent = message;
    el.classList.toggle("error", error);
    el.classList.add("visible");
    toastTimer = setTimeout(() => el.classList.remove("visible"), ms);
  }

  function errorMessage(error) {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, "");
  }

  function fail(error) {
    console.error(error);
    toast(errorMessage(error), true);
  }

  async function guard(button, task) {
    if (button) button.disabled = true;
    try {
      return await task();
    } catch (error) {
      fail(error);
      return undefined;
    } finally {
      if (button) button.disabled = false;
    }
  }

  function openModal({ title, body, footer, wide = false, onClose }) {
    const root = document.getElementById("modal-root");
    const close = () => {
      root.hidden = true;
      clear(root);
      state.modalOpen = false;
      document.removeEventListener("keydown", onKey);
      onClose?.();
    };
    const onKey = (event) => { if (event.key === "Escape") close(); };
    const modal = h("div", { class: `modal${wide ? " wide" : ""}`, role: "dialog", "aria-modal": "true" },
      h("div", { class: "modal-head" }, h("h2", {}, title), h("button", { class: "icon-btn", type: "button", onClick: close, "aria-label": "閉じる" }, "✕")),
      body,
      footer ? h("div", { class: "modal-foot" }, footer) : null,
    );
    replace(root, modal);
    root.hidden = false;
    state.modalOpen = true;
    document.addEventListener("keydown", onKey);
    return { close, modal };
  }

  function confirmDialog(message, { danger = false, okLabel = "OK" } = {}) {
    return new Promise((resolve) => {
      const dialog = openModal({
        title: "確認",
        body: h("p", {}, message),
        footer: [
          h("button", { class: "ghost", type: "button", onClick: () => { dialog.close(); resolve(false); } }, "キャンセル"),
          h("button", { class: danger ? "danger" : "", type: "button", onClick: () => { dialog.close(); resolve(true); } }, okLabel),
        ],
        onClose: () => resolve(false),
      });
    });
  }

  // ---------------------------------------------------------------- formatting

  const fmt = {
    n: (value) => (value === null || value === undefined ? "—" : Number(value).toLocaleString("ja-JP")),
    date: (iso) => (iso ? new Date(iso).toLocaleDateString("ja-JP", { year: "numeric", month: "numeric", day: "numeric", weekday: "short" }) : "—"),
    time: (iso) => (iso ? new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "—"),
    dateTime: (iso) => (iso ? new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }) : "—"),
    full: (iso) => (iso ? new Date(iso).toLocaleString("ja-JP") : "—"),
    relative: (iso) => {
      if (!iso) return "—";
      const diff = Date.parse(iso) - Date.now();
      const abs = Math.abs(diff);
      const unit = abs < 3_600_000 ? [Math.round(abs / 60_000), "分"] : abs < 86_400_000 ? [Math.round(abs / 3_600_000), "時間"] : [Math.round(abs / 86_400_000), "日"];
      return diff >= 0 ? `${unit[0]}${unit[1]}後` : `${unit[0]}${unit[1]}前`;
    },
    bytes: (size) => (size === null || size === undefined ? "" : size > 1_048_576 ? `${(size / 1_048_576).toFixed(1)} MB` : `${Math.round(size / 1024)} KB`),
  };

  function toLocalInput(iso) {
    const date = iso ? new Date(iso) : new Date(Date.now() + 3_600_000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function fromLocalInput(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function dateKey(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  const POST_KIND = {
    image: { label: "フィード画像", color: "#2563eb" },
    carousel: { label: "カルーセル", color: "#0891b2" },
    reel: { label: "リール", color: "#db2777" },
    story: { label: "ストーリーズ", color: "#ea580c" },
    threads: { label: "Threads", color: "#111827" },
  };
  const POST_STATUS = {
    scheduled: { label: "予約中", cls: "info" },
    publishing: { label: "投稿中", cls: "accent" },
    published: { label: "投稿済み", cls: "ok" },
    failed: { label: "失敗", cls: "danger" },
    missed: { label: "未投稿", cls: "warn" },
    canceled: { label: "取り消し", cls: "" },
  };
  const SOURCE_LABELS = { comment: "コメント", dm: "DM", story: "ストーリーズ返信", live: "ライブ配信コメント" };

  function pageHead(title, description, ...actions) {
    return h("div", { class: "page-head" },
      h("div", {}, h("h1", {}, title), description ? h("p", {}, description) : null),
      actions.length ? h("div", { class: "actions" }, actions) : null,
    );
  }

  function field(labelText, control, hint) {
    return h("div", {}, h("label", {}, labelText), control, hint ? h("span", { class: "hint" }, hint) : null);
  }

  function switchControl(checked, onChange, labelText) {
    const input = h("input", { type: "checkbox", checked, onChange: (event) => onChange(event.target.checked) });
    return h("label", { class: "switch" }, input, h("span", { class: "track" }), labelText ? h("span", {}, labelText) : null);
  }

  function badge(text, cls = "") {
    return h("span", { class: `badge ${cls}` }, text);
  }

  function copyText(text) {
    return navigator.clipboard.writeText(text).then(() => toast("コピーしました")).catch(() => toast("コピーできませんでした", true));
  }

  function openExternal(url) {
    return api("app:openExternal", { url }).catch(fail);
  }

  function drawLineChart(canvas, series, { color = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#7c3aed", labels = [] } = {}) {
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 600;
    const height = canvas.clientHeight || 200;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const ctx = canvas.getContext("2d");
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, height);
    const values = series.filter((value) => value !== null && value !== undefined);
    const ink = getComputedStyle(document.documentElement).getPropertyValue("--ink-3").trim() || "#888";
    if (values.length === 0) {
      ctx.fillStyle = ink;
      ctx.font = "12px sans-serif";
      ctx.fillText("データがまだありません", 12, 24);
      return;
    }
    const pad = { l: 44, r: 12, t: 12, b: 24 };
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const x = (index) => pad.l + (index / Math.max(1, series.length - 1)) * (width - pad.l - pad.r);
    const y = (value) => pad.t + (1 - (value - min) / range) * (height - pad.t - pad.b);
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--line").trim() || "#ddd";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i += 1) {
      const gy = pad.t + (i / 3) * (height - pad.t - pad.b);
      ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(width - pad.r, gy); ctx.stroke();
      ctx.fillStyle = ink; ctx.font = "11px sans-serif"; ctx.textAlign = "right";
      ctx.fillText(Math.round(max - (i / 3) * range).toLocaleString("ja-JP"), pad.l - 6, gy + 4);
    }
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    let started = false;
    series.forEach((value, index) => {
      if (value === null || value === undefined) return;
      if (!started) { ctx.moveTo(x(index), y(value)); started = true; } else ctx.lineTo(x(index), y(value));
    });
    ctx.stroke();
    ctx.fillStyle = color;
    series.forEach((value, index) => {
      if (value === null || value === undefined) return;
      ctx.beginPath(); ctx.arc(x(index), y(value), 2.5, 0, Math.PI * 2); ctx.fill();
    });
    ctx.fillStyle = ink; ctx.font = "11px sans-serif"; ctx.textAlign = "center";
    const step = Math.max(1, Math.ceil(labels.length / 6));
    labels.forEach((label, index) => { if (index % step === 0 || index === labels.length - 1) ctx.fillText(label, x(index), height - 6); });
  }

  function drawBars(canvas, entries, { color } = {}) {
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 600;
    const height = canvas.clientHeight || 160;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const ctx = canvas.getContext("2d");
    ctx.scale(ratio, ratio);
    const ink = getComputedStyle(document.documentElement).getPropertyValue("--ink-3").trim() || "#888";
    const accent = color || getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#7c3aed";
    const max = Math.max(1, ...entries.map((entry) => entry.value));
    const pad = { l: 8, r: 8, t: 10, b: 22 };
    const slot = (width - pad.l - pad.r) / Math.max(1, entries.length);
    entries.forEach((entry, index) => {
      const barHeight = ((height - pad.t - pad.b) * entry.value) / max;
      const x = pad.l + index * slot + slot * 0.15;
      ctx.fillStyle = accent;
      ctx.fillRect(x, height - pad.b - barHeight, slot * 0.7, barHeight);
      ctx.fillStyle = ink; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
      if (entries.length <= 16 || index % Math.ceil(entries.length / 8) === 0) ctx.fillText(entry.label, x + slot * 0.35, height - 6);
      if (entry.value > 0 && entries.length <= 16) ctx.fillText(String(entry.value), x + slot * 0.35, height - pad.b - barHeight - 3);
    });
  }

  return { views, state, api, h, append, clear, replace, toast, fail, guard, errorMessage, openModal, confirmDialog, fmt, toLocalInput, fromLocalInput, dateKey, POST_KIND, POST_STATUS, SOURCE_LABELS, pageHead, field, switchControl, badge, copyText, openExternal, drawLineChart, drawBars };
})();
