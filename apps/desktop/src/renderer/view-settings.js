/* Settings: appearance, automation timing, posting, insights, local API for AI tools, backup. */
(() => {
  const { api, h, replace, fmt, pageHead, guard, field, confirmDialog, toast, switchControl, copyText } = IGUP;
  const ACCENTS = ["#7c3aed", "#2563eb", "#0891b2", "#059669", "#d97706", "#dc2626", "#db2777", "#1f2937"];

  IGUP.views.settings = {
    title: "設定",
    icon: "⚙",
    async render(container) {
      const [settings, info] = await Promise.all([api("settings:get"), api("app:info")]);
      const draft = { ...settings };
      const theme = h("select", { value: settings.theme, onChange: (event) => { draft.theme = event.target.value; IGUP.applyTheme(draft); } }, h("option", { value: "system" }, "OSに合わせる"), h("option", { value: "light" }, "ライト"), h("option", { value: "dark" }, "ダーク"));
      const accentInput = h("input", { type: "color", value: settings.accent, onInput: (event) => { draft.accent = event.target.value; IGUP.applyTheme(draft); } });
      const swatches = h("div", { class: "row" }, ACCENTS.map((color) => h("button", { type: "button", class: "icon-btn", title: color, style: { background: color, width: "26px", height: "26px", borderRadius: "50%" }, onClick: () => { draft.accent = color; accentInput.value = color; IGUP.applyTheme(draft); } })), accentInput);
      const num = (key, min, max) => h("input", { type: "number", min, max, value: String(settings[key]), onInput: (event) => { draft[key] = Number(event.target.value); } });
      const pollingMode = h("select", { value: settings.pollingMode, onChange: (event) => { draft.pollingMode = event.target.value; } }, h("option", { value: "auto" }, "自動（Webhookが使えるときは止める）"), h("option", { value: "always" }, "常に定期確認する"), h("option", { value: "never" }, "定期確認しない（Webhookのみ）"));
      const defaultCaption = h("textarea", { rows: 4, placeholder: "投稿画面で「デフォルトキャプションを挿入」で入る文（ハッシュタグなど）", value: settings.defaultCaption, onInput: (event) => { draft.defaultCaption = event.target.value; } });
      const privacyContact = h("input", { type: "text", placeholder: "例: support@example.com", value: settings.privacyContact, onInput: (event) => { draft.privacyContact = event.target.value; } });
      const tokenBox = h("code", {}, "••••••••••••••••");
      let tokenValue = null;
      const usage = h("pre", {});
      const renderUsage = () => { usage.textContent = `curl -H "Authorization: Bearer ${tokenValue ?? "<トークン>"}" http://127.0.0.1:${draft.localApiPort}/status`; };
      renderUsage();
      const portInput = num("localApiPort", 1024, 65535);
      portInput.addEventListener("input", renderUsage);
      const brokerInput = h("input", { type: "text", placeholder: "https://broker.example.com", value: settings.brokerUrl ?? "", onInput: (event) => { draft.brokerUrl = event.target.value; } });
      const brokerTest = h("p", { class: "hint" }, `現在: ${info.brokerUrl}`);

      async function save(patch) {
        await api("settings:save", patch ?? draft);
        toast("設定を保存しました。");
      }

      replace(container,
        pageHead("設定", "動作の細かい調整。変更は「保存」で反映されます。", h("button", { type: "button", onClick: (event) => guard(event.currentTarget, () => save()) }, "すべて保存")),
        h("div", { class: "grid cols-2" },
          h("div", { class: "card" },
            h("h2", {}, "ブローカー接続"),
            h("p", { class: "muted small" }, "購入時に発行されたサーバーURLを入力します。OAuthの窓口となるサーバーで、ここで接続テストが通れば他の設定は不要です。"),
            field("ブローカーURL", brokerInput, "例: https://broker.example.com"),
            h("div", { class: "row" },
              h("button", { class: "secondary", type: "button", onClick: (event) => guard(event.currentTarget, async () => {
                await api("settings:save", { brokerUrl: draft.brokerUrl ?? "" });
                const caps = await api("connection:capabilities");
                brokerTest.textContent = caps
                  ? `接続OK（${caps.webhooks ? "Webhook利用可" : "Webhookなし・定期確認モード"}${caps.threads ? "・Threads可" : ""}）`
                  : "接続できませんでした。URLとサーバーの起動を確認してください。";
              }) }, "接続テスト"),
            ),
            brokerTest,
          ),
          h("div", { class: "card" },
            h("h2", {}, "画面"),
            field("テーマ", theme),
            field("アクセントカラー", swatches, "ボタンや強調色に使われます。"),
          ),
          h("div", { class: "card" },
            h("h2", {}, "自動返信の動作"),
            h("div", { class: "grid cols-2" },
              field("Instagram確認間隔（秒）", num("pollIntervalSec", 20, 3600), "Webhookが使えないときにコメント・DMを確認する間隔。短いほど早く返せますがAPI上限に注意（20秒以上）。"),
              field("ブローカー確認間隔（秒）", num("brokerEventIntervalSec", 5, 600), "Webhookで届いたイベントを取りに行く間隔。"),
              field("確認する投稿数", num("recentMediaCount", 1, 50), "コメント確認の対象にする最近の投稿数。"),
              field("定期確認の方式", pollingMode),
            ),
            switchControl(settings.liveCommentsEnabled, (value) => { draft.liveCommentsEnabled = value; }, "ライブ配信中のコメントにも自動DMする（配信中のみ確認）"),
          ),
          h("div", { class: "card" },
            h("h2", {}, "予約投稿"),
            field("未投稿とみなすまでの猶予（分）", num("missedGraceMinutes", 1, 1440), "PCが起動していなかった等で予定時刻を過ぎた投稿は、この時間内なら起動時に自動投稿し、過ぎていれば「未投稿」として止めます。"),
            field("デフォルトキャプション", defaultCaption),
          ),
          h("div", { class: "card" },
            h("h2", {}, "インサイト"),
            switchControl(settings.insightsEnabled, (value) => { draft.insightsEnabled = value; }, "毎日インサイトを自動取得する（3時以降）"),
            field("ストーリーズの記録間隔（分）", num("storySnapshotIntervalMin", 15, 1440), "公開中のストーリーズの数値を定期的に保存し、消えたあとも見られるようにします。"),
          ),
          h("div", { class: "card" },
            h("h2", {}, "ローカルAPI（AI・外部ツール連携）"),
            h("p", { class: "muted small" }, "このPCの中だけ（127.0.0.1）で使えるHTTP APIです。Claude Codeなどから投稿の予約・ルール作成・分析の取得ができます。トークンを知っているプロセスだけがアクセスできます。"),
            switchControl(settings.localApiEnabled, (value) => { draft.localApiEnabled = value; }, "ローカルAPIを有効にする"),
            field("ポート", portInput),
            h("div", { class: "row" }, tokenBox,
              h("button", { class: "ghost small", type: "button", onClick: (event) => guard(event.currentTarget, async () => { tokenValue = await api("localApi:token", { regenerate: false }); tokenBox.textContent = tokenValue; renderUsage(); }) }, "表示"),
              h("button", { class: "ghost small", type: "button", onClick: (event) => guard(event.currentTarget, async () => { const token = tokenValue ?? await api("localApi:token", { regenerate: false }); await copyText(token); }) }, "コピー"),
              h("button", { class: "ghost small danger", type: "button", onClick: async (event) => { if (await confirmDialog("トークンを再生成しますか？古いトークンは使えなくなります。", { danger: true, okLabel: "再生成" })) await guard(event.currentTarget, async () => { tokenValue = await api("localApi:token", { regenerate: true }); tokenBox.textContent = tokenValue; renderUsage(); }); } }, "再生成")),
            usage,
            h("p", { class: "hint" }, "使い方は docs/ai-integration.md を参照。GET /status /rules /posts /insights、POST /posts /rules など。"),
          ),
          h("div", { class: "card" },
            h("h2", {}, "バックアップ"),
            h("p", { class: "muted small" }, "ルール・予約・メモ・分析データをJSONで書き出し／読み込みします。アクセストークンなどの秘密情報は含まれません。"),
            h("div", { class: "row" },
              h("button", { class: "secondary", type: "button", onClick: (event) => guard(event.currentTarget, async () => { const content = await api("data:export"); const result = await api("app:saveFile", { defaultName: `igup-backup-${IGUP.dateKey(new Date())}.json`, content }); if (result.saved) toast(`保存しました: ${result.path}`); }) }, "書き出す"),
              h("button", { class: "secondary", type: "button", onClick: async (event) => {
                const [path] = await api("app:pickFiles", { kind: "json" });
                if (!path) return;
                if (!await confirmDialog("現在のデータをバックアップの内容で置き換えます。よろしいですか？", { danger: true, okLabel: "読み込む" })) return;
                await guard(event.currentTarget, async () => { const json = await api("app:readFile", { path }); await api("data:import", { json }); toast("読み込みました。"); IGUP.rerender(); });
              } }, "読み込む"),
            ),
          ),
          h("div", { class: "card" },
            h("h2", {}, "プライバシー・アプリ情報"),
            field("問い合わせ先（プライバシーポリシー用）", privacyContact, "Metaアプリ審査で求められるプライバシーポリシーに記載する連絡先。"),
            h("dl", { class: "kv", style: { marginTop: "12px" } },
              h("dt", {}, "バージョン"), h("dd", {}, info.version),
              h("dt", {}, "データ保存先"), h("dd", { class: "mono small" }, info.dataPath),
              h("dt", {}, "メディア保存先"), h("dd", { class: "mono small" }, info.mediaDir),
              h("dt", {}, "ブローカー"), h("dd", { class: "mono small" }, info.brokerUrl),
              h("dt", {}, "2段階認証"), h("dd", { class: "small" }, "IGUPはこのPCでだけ動くアプリで、ログインIDもパスワードも持ちません。Instagram / Threads / LINE の認証は各サービス側の2段階認証がそのまま適用されます。"),
            ),
          ),
        ),
      );
    },
  };
})();
