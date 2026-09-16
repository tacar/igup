import type { PublicSeminar } from "./seminars.js";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/\n/g, "&#10;");
}

function formatDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 20px 64px; background: #f7f7f2; color: #1c1b17; font-family: "Zen Kaku Gothic New", "BIZ UDPGothic", sans-serif; line-height: 1.7; }
  main { max-width: 480px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p.desc { white-space: pre-wrap; color: #4a483f; margin: 0 0 24px; }
  fieldset { border: 1px solid #dcdbd0; border-radius: 12px; padding: 16px; margin: 0 0 16px; }
  legend { padding: 0 6px; font-weight: 700; font-size: 13px; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 12px 0 4px; }
  label:first-child { margin-top: 0; }
  select, input { width: 100%; padding: 10px 12px; border: 1px solid #c9c7ba; border-radius: 8px; font-size: 15px; background: #fff; color: #1c1b17; }
  button { width: 100%; padding: 14px; margin-top: 20px; border: none; border-radius: 999px; background: #b23d1c; color: #fff; font-size: 16px; font-weight: 700; cursor: pointer; }
  button:disabled { opacity: 0.5; }
  .msg { margin-top: 14px; font-size: 14px; }
  .msg.error { color: #b23d1c; }
  .msg.ok { color: #3f6b4f; }
  .done { text-align: center; padding: 40px 0; }
  .done h1 { font-size: 20px; }
`;

export function renderNotFoundPage(message: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IGUP セミナー</title><style>${STYLE}</style></head><body><main><div class="done"><h1>${escapeHtml(message)}</h1></div></main></body></html>`;
}

export function renderSeminarPage(seminar: PublicSeminar, nonce: string, timeZone: string): string {
  const options = seminar.dates
    .map((date) => `<option value="${escapeAttr(date.id)}">${escapeHtml(formatDate(date.startsAt, timeZone))}${date.capacity !== null ? `（定員${date.capacity}名）` : ""}</option>`)
    .join("");
  const liffScript = seminar.liffId
    ? `<script src="https://static.line-scdn.net/liff/edge/2/sdk.js" nonce="${nonce}"></script>`
    : "";

  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(seminar.title)} | お申し込み</title><style>${STYLE}</style></head><body>
<main>
  <div id="form-view">
    <h1>${escapeHtml(seminar.title)}</h1>
    ${seminar.description ? `<p class="desc">${escapeHtml(seminar.description)}</p>` : ""}
    <form id="apply-form">
      <fieldset>
        <legend>日程</legend>
        <label for="dateId">参加希望日</label>
        <select id="dateId" name="dateId" required>${options}</select>
      </fieldset>
      <fieldset>
        <legend>お申し込み情報</legend>
        <label for="name">お名前</label>
        <input id="name" name="name" required maxlength="100" autocomplete="name">
        <label for="email">メールアドレス（任意）</label>
        <input id="email" name="email" type="email" maxlength="200" autocomplete="email">
      </fieldset>
      <button type="submit" id="submit-btn">申し込む</button>
      <p class="msg" id="msg" hidden></p>
    </form>
  </div>
  <div id="done-view" class="done" hidden>
    <h1>お申し込みありがとうございました</h1>
    <p class="desc" id="done-note"></p>
  </div>
</main>
${liffScript}
<script nonce="${nonce}">
(function () {
  var liffId = ${JSON.stringify(seminar.liffId)};
  var lineUserId = null;
  var ready = liffId && window.liff
    ? liff.init({ liffId: liffId }).then(function () {
        if (!liff.isLoggedIn()) { liff.login(); return new Promise(function () {}); }
        return liff.getProfile().then(function (profile) { lineUserId = profile.userId; });
      }).catch(function () {})
    : Promise.resolve();

  var form = document.getElementById("apply-form");
  var msg = document.getElementById("msg");
  var button = document.getElementById("submit-btn");

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    button.disabled = true;
    msg.hidden = true;
    ready.then(function () {
      return fetch(location.pathname + "/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          dateId: document.getElementById("dateId").value,
          name: document.getElementById("name").value,
          email: document.getElementById("email").value,
          lineUserId: lineUserId,
        }),
      });
    }).then(function (response) {
      return response.json().then(function (body) { return { ok: response.ok, body: body }; });
    }).then(function (result) {
      if (!result.ok) throw new Error(result.body && result.body.error ? result.body.error : "送信に失敗しました。");
      document.getElementById("form-view").hidden = true;
      var done = document.getElementById("done-view");
      done.hidden = false;
      document.getElementById("done-note").textContent = lineUserId ? "LINEにお礼メッセージをお送りしました。" : "";
    }).catch(function (error) {
      msg.textContent = error && error.message ? error.message : "送信に失敗しました。";
      msg.className = "msg error";
      msg.hidden = false;
      button.disabled = false;
    });
  });
})();
</script>
</body></html>`;
}
