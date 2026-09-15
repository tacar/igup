const elements = {
  badge: document.querySelector("#connection-badge"),
  detail: document.querySelector("#connection-detail"),
  connect: document.querySelector("#connect-button"),
  account: document.querySelector("#account-button"),
  accountDetails: document.querySelector("#account-details"),
  username: document.querySelector("#username"),
  accountType: document.querySelector("#account-type"),
  mediaCount: document.querySelector("#media-count"),
  form: document.querySelector("#publish-form"),
  caption: document.querySelector("#caption"),
  captionCount: document.querySelector("#caption-count"),
  notice: document.querySelector("#notice"),
};

async function refreshStatus() {
  try {
    const status = await window.igup.status();
    elements.badge.textContent = status.connected ? "接続済み" : "未接続";
    elements.badge.classList.toggle("connected", status.connected);
    elements.detail.textContent = status.connected
      ? `トークン期限: ${status.expiresAt ? new Date(status.expiresAt).toLocaleString("ja-JP") : "取得できません"}`
      : "Instagramプロアカウントを接続してください。";
    elements.connect.textContent = status.connected ? "再接続する" : "Instagramに接続";
  } catch (error) { showError(error); }
}

elements.connect.addEventListener("click", () => withBusy(elements.connect, async () => {
  await window.igup.connect();
  showNotice("ブラウザでInstagram認証を続けてください。");
}));

elements.account.addEventListener("click", () => withBusy(elements.account, async () => {
  const account = await window.igup.account();
  elements.username.textContent = `@${account.username}`;
  elements.accountType.textContent = account.account_type ?? "不明";
  elements.mediaCount.textContent = account.media_count?.toLocaleString("ja-JP") ?? "不明";
  elements.accountDetails.hidden = false;
  showNotice("Instagram APIへの接続を確認しました。");
}));

elements.caption.addEventListener("input", () => {
  elements.captionCount.textContent = `${elements.caption.value.length.toLocaleString("ja-JP")} / 2,200`;
});

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const submit = elements.form.querySelector("button[type=submit]");
  void withBusy(submit, async () => {
    const data = new FormData(elements.form);
    const result = await window.igup.publish({ imageUrl: String(data.get("imageUrl") ?? ""), caption: String(data.get("caption") ?? "") });
    showNotice(`投稿しました（メディアID: ${result.id}）`);
  });
});

window.igup.onConnected(() => {
  void refreshStatus();
  showNotice("Instagramと接続しました。");
});

async function withBusy(button, task) {
  button.disabled = true;
  try { await task(); } catch (error) { showError(error); } finally { button.disabled = false; }
}

function showError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  showNotice(raw.replace(/^Error invoking remote method '[^']+': Error: /, ""), true);
}

let noticeTimer;
function showNotice(message, error = false) {
  clearTimeout(noticeTimer);
  elements.notice.textContent = message;
  elements.notice.classList.toggle("error", error);
  elements.notice.classList.add("visible");
  noticeTimer = setTimeout(() => elements.notice.classList.remove("visible"), 5000);
}

void refreshStatus();
