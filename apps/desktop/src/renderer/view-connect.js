IGUP.views.connect = {
  title: "接続",
  icon: "⇄",
  async render(container) {
    const { api, h, replace, fmt, pageHead, badge, guard, field, confirmDialog, openExternal } = IGUP;
    const status = await api("connection:status");
    IGUP.state.status = status;
    const caps = status.broker.capabilities;
    const accountBox = h("div", {});
    const threadsBox = h("div", {});

    async function loadAccount() {
      if (!status.instagram.connected) return;
      try {
        const account = await api("instagram:account");
        replace(accountBox, h("dl", { class: "kv", style: { marginTop: "12px" } },
          h("dt", {}, "ユーザー名"), h("dd", {}, `@${account.username}`),
          h("dt", {}, "アカウント種別"), h("dd", {}, account.account_type ?? "不明"),
          h("dt", {}, "フォロワー"), h("dd", {}, fmt.n(account.followers_count)),
          h("dt", {}, "投稿数"), h("dd", {}, fmt.n(account.media_count)),
          h("dt", {}, "ID"), h("dd", { class: "mono" }, account.user_id ?? account.id),
        ));
      } catch (error) {
        replace(accountBox, h("p", { class: "small", style: { color: "var(--danger)" } }, IGUP.errorMessage(error)));
      }
    }
    async function loadThreads() {
      if (!status.threads.connected) return;
      try {
        const profile = await api("threads:profile");
        replace(threadsBox, h("p", { class: "muted small" }, `@${profile.username} として接続中`));
      } catch (error) {
        replace(threadsBox, h("p", { class: "small", style: { color: "var(--danger)" } }, IGUP.errorMessage(error)));
      }
    }

    const lineInput = h("input", { type: "password", placeholder: "チャネルアクセストークン（長期）", autocomplete: "off" });

    replace(container,
      pageHead("接続", "Instagram・Threads・LINE・ブローカーの接続を管理します。秘密情報はこのPCの安全な保管領域にだけ保存されます。"),
      h("div", { class: "grid cols-2" },
        h("div", { class: "card" },
          h("div", { class: "row between" }, h("h2", {}, "Instagram"), status.instagram.connected ? badge("接続済み", "ok") : badge("未接続", "danger")),
          h("p", { class: "muted small" }, status.instagram.connected ? `アクセストークン期限: ${fmt.full(status.instagram.expiresAt)}（期限10日前に自動更新）` : "Instagramプロアカウント（ビジネス / クリエイター）が必要です。ブラウザでMetaの認証画面が開きます。"),
          h("div", { class: "row" },
            h("button", { type: "button", onClick: (event) => guard(event.currentTarget, async () => { await api("connection:start", { provider: "instagram" }); IGUP.toast("ブラウザでInstagram認証を続けてください。"); }) }, status.instagram.connected ? "再接続する" : "Instagramに接続"),
            status.instagram.connected ? h("button", { class: "ghost", type: "button", onClick: async (event) => { if (await confirmDialog("Instagramとの接続を解除しますか？自動返信と予約投稿は停止します。", { danger: true, okLabel: "解除する" })) await guard(event.currentTarget, async () => { await api("connection:disconnect", { provider: "instagram" }); IGUP.rerender(); }); } }, "接続解除") : null,
          ),
          accountBox,
        ),
        h("div", { class: "card" },
          h("div", { class: "row between" }, h("h2", {}, "Threads"), status.threads.connected ? badge("接続済み", "ok") : badge("未接続")),
          h("p", { class: "muted small" }, caps?.threads === false ? "ブローカーにThreadsアプリの設定（THREADS_APP_ID など）がないため利用できません。" : "Threadsの予約投稿（ツリー投稿・カルーセル）に使います。Instagramとは別に認証が必要です。"),
          h("div", { class: "row" },
            h("button", { type: "button", disabled: caps?.threads === false, onClick: (event) => guard(event.currentTarget, async () => { await api("connection:start", { provider: "threads" }); IGUP.toast("ブラウザでThreads認証を続けてください。"); }) }, status.threads.connected ? "再接続する" : "Threadsに接続"),
            status.threads.connected ? h("button", { class: "ghost", type: "button", onClick: (event) => guard(event.currentTarget, async () => { await api("connection:disconnect", { provider: "threads" }); IGUP.rerender(); }) }, "接続解除") : null,
          ),
          threadsBox,
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
          !status.broker.reachable ? h("p", { class: "small", style: { color: "var(--danger)" } }, "ブローカーに接続できません。README の手順で META_APP_ID / META_APP_SECRET / META_REDIRECT_URI を設定して `npm run dev:broker` を起動するか、IGUP_BROKER_URL に公開URLを設定してください。") : null,
          h("div", { class: "row", style: { marginTop: "12px" } },
            h("button", { class: "secondary", type: "button", disabled: !status.instagram.connected || !caps?.webhooks, onClick: (event) => guard(event.currentTarget, async () => { await api("connection:subscribeWebhooks"); IGUP.toast("Webhook購読を登録しました。コメントやDMが即時に届きます。"); IGUP.rerender(); }) }, "Webhook購読を登録"),
            h("button", { class: "ghost", type: "button", onClick: (event) => guard(event.currentTarget, async () => { await api("connection:capabilities"); IGUP.rerender(); }) }, "再確認"),
          ),
          h("p", { class: "hint" }, "Webhookを使うには、Metaアプリのダッシュボードで Instagram > Webhooks にブローカーの /webhooks/instagram を登録し、検証トークン（META_WEBHOOK_VERIFY_TOKEN）を一致させます。未登録でもポーリング（定期確認）で動作します。"),
        ),
      ),
    );
    void loadAccount();
    void loadThreads();

    function cap(value, okLabel) {
      if (value === undefined || value === null) return badge("不明");
      return value ? badge(okLabel, "ok") : badge("未対応");
    }
  },
};
