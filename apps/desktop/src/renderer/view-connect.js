IGUP.views.connect = {
  title: "接続",
  icon: "⇄",
  async render(container) {
    const { api, h, replace, fmt, pageHead, badge, guard, field, confirmDialog, openExternal, accounts } = IGUP;
    const status = await api("connection:status");
    IGUP.state.status = status;
    const caps = status.broker.capabilities;
    const accountEntries = accounts();
    const activeId = status.activeAccountId;

    function accountRow(entry) {
      const isActive = entry.id === activeId;
      const name = entry.username ? `@${entry.username}` : (entry.instagram.connected ? "確認中…" : "未接続のアカウント");
      return h("div", { class: `account-row${isActive ? " active" : ""}` },
        h("div", {},
          h("div", { class: "name" }, name, isActive ? badge("アクティブ", "accent") : null, h("span", { class: "mono", style: { marginLeft: "8px" } }, entry.id)),
          h("div", { class: "badges" },
            entry.instagram.connected
              ? badge(`Instagram 接続済み・期限 ${fmt.full(entry.instagram.expiresAt)}`, "ok")
              : badge("Instagram 未接続", "danger"),
            entry.threads.connected ? badge("Threads 接続済み", "ok") : badge("Threads 未接続"),
          ),
        ),
        h("div", { class: "actions" },
          !isActive ? h("button", { class: "ghost", type: "button", onClick: (event) => guard(event.currentTarget, async () => { await api("accounts:setActive", { accountId: entry.id }); IGUP.rerender(); }) }, "アクティブにする") : null,
          h("button", { type: "button", onClick: (event) => guard(event.currentTarget, async () => { await api("connection:start", { provider: "instagram", accountId: entry.id }); IGUP.toast("ブラウザでInstagram認証を続けてください。"); }) }, entry.instagram.connected ? "Instagram再接続" : "Instagram接続"),
          entry.instagram.connected ? h("button", { class: "ghost", type: "button", onClick: async (event) => {
            if (!(await confirmDialog(`「${name}」のInstagram接続を解除しますか？このアカウントの自動返信と予約投稿は停止します。`, { danger: true, okLabel: "解除する" }))) return;
            await guard(event.currentTarget, async () => { await api("connection:disconnect", { provider: "instagram", accountId: entry.id }); IGUP.rerender(); });
          } }, "IG解除") : null,
          h("button", { type: "button", disabled: caps?.threads === false, onClick: (event) => guard(event.currentTarget, async () => { await api("connection:start", { provider: "threads", accountId: entry.id }); IGUP.toast("ブラウザでThreads認証を続けてください。"); }) }, entry.threads.connected ? "Threads再接続" : "Threads接続"),
          entry.threads.connected ? h("button", { class: "ghost", type: "button", onClick: async (event) => {
            if (!(await confirmDialog("Threadsとの接続を解除しますか？", { danger: true, okLabel: "解除する" }))) return;
            await guard(event.currentTarget, async () => { await api("connection:disconnect", { provider: "threads", accountId: entry.id }); IGUP.rerender(); });
          } }, "Threads解除") : null,
          accountEntries.length > 1 ? h("button", { class: "danger ghost", type: "button", onClick: async (event) => {
            if (!(await confirmDialog(`「${name}」を削除しますか？このアカウントのルール・予約投稿・分析データも削除されます。`, { danger: true, okLabel: "削除する" }))) return;
            await guard(event.currentTarget, async () => { await api("accounts:remove", { accountId: entry.id }); IGUP.toast("アカウントを削除しました。"); IGUP.rerender(); });
          } }, "アカウント削除") : null,
        ),
      );
    }

    const lineInput = h("input", { type: "password", placeholder: "チャネルアクセストークン（長期）", autocomplete: "off" });

    replace(container,
      pageHead("接続", "Instagram・Threads・LINE・ブローカーの接続を管理します。秘密情報はこのPCの安全な保管領域にだけ保存されます。"),
      h("div", { class: "grid cols-2" },
        h("div", { class: "card", style: { gridColumn: "1 / -1" } },
          h("div", { class: "row between" },
            h("h2", {}, "アカウント"),
            h("button", { type: "button", onClick: (event) => guard(event.currentTarget, async () => { await api("connection:start", { provider: "instagram" }); IGUP.toast("ブラウザでInstagram認証を続けてください。新しいアカウントとして追加されます。"); }) }, "＋ 別のInstagramアカウントを追加"),
          ),
          h("p", { class: "muted small" }, "Instagramプロアカウント（ビジネス / クリエイター）を複数追加できます。「アクティブ」のアカウントが新規ルール・予約投稿の対象になります。Threadsは各アカウントに紐付けます。認証にはブラウザでMetaの画面を開きます。"),
          accountEntries.length > 0 ? h("div", { class: "account-list" }, accountEntries.map(accountRow)) : h("p", { class: "muted" }, "まだアカウントがありません。「Instagram接続」から始めてください。"),
        ),
        h("div", { class: "card" },
          h("div", { class: "row between" }, h("h2", {}, "LINE公式アカウント"), status.line.configured ? badge("設定済み", "ok") : badge("未設定")),
          h("p", { class: "muted small" }, "セミナー申込のお礼・リマインドをLINEで送るために使います。LINE Developersの Messaging API チャネルで発行した「チャネルアクセストークン（長期）」を貼り付けてください。トークンはこのPCに暗号化保存され、外部には送られません。"),
          field("チャネルアクセストークン", lineInput),
          h("div", { class: "row" },
            h("button", { type: "button", onClick: (event) => guard(event.currentTarget, async () => { const result = await api("line:save", { token: lineInput.value.trim() }); IGUP.toast(result.displayName ? `「${result.displayName}」を設定しました。` : "LINE設定を削除しました。"); lineInput.value = ""; IGUP.rerender(); }) }, "保存して確認"),
            status.line.configured ? h("button", { class: "ghost", type: "button", onClick: (event) => guard(event.currentTarget, async () => { await api("line:save", { token: "" }); IGUP.rerender(); }) }, "削除") : null,
            h("button", { class: "ghost", type: "button", onClick: () => openExternal("https://developers.line.biz/console/") }, "LINE Developers"),
          ),
        ),
        h("div", { class: "card" },
          h("div", { class: "row between" }, h("h2", {}, "ブローカー（認証・公開サーバー）"), status.broker.reachable ? badge("稼働中", "ok") : badge("接続不可", "danger")),
          h("p", { class: "muted small" }, "Meta App Secret を持つ小さなサーバーです。認証、Webhook受信、画像の一時公開、計測リンク、セミナー申込ページを担当します。動画はこのPCからInstagramへ直接アップロードされ、サーバーには保存されません。"),
          h("dl", { class: "kv" },
            h("dt", {}, "URL"), h("dd", { class: "mono" }, status.broker.url),
            h("dt", {}, "Webhook"), h("dd", {}, cap(caps?.webhooks, "即時受信")),
            h("dt", {}, "画像一時公開"), h("dd", {}, cap(caps?.media, "利用可")),
            h("dt", {}, "計測リンク"), h("dd", {}, cap(caps?.links, "利用可")),
            h("dt", {}, "セミナー申込"), h("dd", {}, cap(caps?.seminars, "利用可")),
            h("dt", {}, "Threads認証"), h("dd", {}, cap(caps?.threads, "利用可")),
          ),
          !status.broker.reachable ? h("p", { class: "small", style: { color: "var(--danger)" } }, "ブローカーに接続できません。「設定 > ブローカー接続」でURLを確認してください。") : null,
          h("div", { class: "row", style: { marginTop: "12px" } },
            h("button", { class: "secondary", type: "button", disabled: !status.instagram.connected || !caps?.webhooks, onClick: (event) => guard(event.currentTarget, async () => { await api("connection:subscribeWebhooks", { accountId: activeId }); IGUP.toast("Webhook購読を登録しました。コメントやDMが即時に届きます。"); IGUP.rerender(); }) }, "Webhook購読を登録"),
            h("button", { class: "ghost", type: "button", onClick: (event) => guard(event.currentTarget, async () => { await api("connection:capabilities"); IGUP.rerender(); }) }, "再確認"),
          ),
          h("p", { class: "hint" }, "Webhookを使うには、Metaアプリのダッシュボードで Instagram > Webhooks にブローカーの /webhooks/instagram を登録し、検証トークン（META_WEBHOOK_VERIFY_TOKEN）を一致させます。未登録でもポーリング（定期確認）で動作します。"),
        ),
      ),
    );

    function cap(value, okLabel) {
      if (value === undefined || value === null) return badge("不明");
      return value ? badge(okLabel, "ok") : badge("未対応");
    }
  },
};
