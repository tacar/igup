let accountFilter = null;

IGUP.views.dashboard = {
  title: "ダッシュボード",
  icon: "◎",
  async render(container) {
    const { api, h, replace, fmt, pageHead, badge, POST_KIND, POST_STATUS, switchControl, guard, navigate, accountChips, accountName, accounts } = IGUP;
    const [status, rules, posts, logs, insights] = await Promise.all([
      api("connection:status"), api("rules:list"), api("posts:list"), api("logs:list", { limit: 8 }), api("insights:summary", { ...(accountFilter ? { accountId: accountFilter } : {}) }),
    ]);
    IGUP.state.status = status;
    const scopedRules = rules.filter((rule) => !accountFilter || rule.accountId === accountFilter);
    const scopedPosts = posts.filter((post) => !accountFilter || post.accountId === accountFilter);
    const multi = accounts().length > 1;
    const totals = scopedRules.reduce((sum, rule) => ({
      matched: sum.matched + rule.stats.matched,
      dmSent: sum.dmSent + rule.stats.dmSent,
      read: sum.read + rule.stats.read,
      tapped: sum.tapped + rule.stats.buttonTapped,
    }), { matched: 0, dmSent: 0, read: 0, tapped: 0 });
    const upcoming = scopedPosts.filter((post) => post.status === "scheduled" || post.status === "publishing").slice(0, 5);
    const needsAttention = scopedPosts.filter((post) => post.status === "failed" || post.status === "missed");
    const automation = status.automation;
    const anyConnected = status.accounts.length > 0 && status.accounts.some((entry) => entry.instagram.connected);

    const toggle = switchControl(automation.enabled, (enabled) => guard(null, async () => {
      await api("automation:setEnabled", { enabled });
      IGUP.toast(enabled ? "自動返信を開始しました。" : "自動返信を停止しました。");
      await IGUP.refreshStatus();
      IGUP.rerender();
    }), automation.enabled ? "自動返信 稼働中" : "自動返信 停止中");

    replace(container,
      pageHead("ダッシュボード", "いまの状態と、これから起きることをひと目で。", toggle),
      accountChips(accountFilter, (value) => { accountFilter = value; IGUP.rerender(); }),
      !anyConnected
        ? h("div", { class: "card", style: { borderColor: "var(--warn)" } },
          h("h2", {}, "まずはInstagramを接続してください"),
          h("p", { class: "muted" }, "自動返信・予約投稿・インサイトはすべてInstagramプロアカウントの接続が必要です。"),
          h("button", { type: "button", onClick: () => navigate("connect") }, "接続画面へ"))
        : null,
      h("div", { class: "grid cols-4" },
        stat("届いた（マッチ）", totals.matched, "自動返信ルールに当たった数"),
        stat("DMを送った", totals.dmSent, `開封 ${fmt.n(totals.read)} / ボタン ${fmt.n(totals.tapped)}`),
        stat("予約中の投稿", scopedPosts.filter((post) => post.status === "scheduled").length, needsAttention.length ? `要確認 ${needsAttention.length}件` : "問題なし"),
        stat("フォロワー", insights.latest?.followers ?? null, insights.latest ? `${insights.latest.date} 時点${accountFilter ? ` · ${accountName(accountFilter)}` : ""}` : "未取得（毎日3時以降に自動取得）"),
      ),
      h("div", { class: "grid cols-2", style: { marginTop: "16px" } },
        h("div", { class: "card" },
          h("h2", {}, "接続と稼働状況"),
          h("dl", { class: "kv" },
            ...(multi ? status.accounts.flatMap((entry) => [
              h("dt", {}, accountName(entry.id)),
              h("dd", {},
                entry.instagram.connected ? badge(`Instagram接続済み${entry.instagram.expiresAt ? `・期限 ${fmt.date(entry.instagram.expiresAt)}` : ""}`, "ok") : badge("Instagram未接続", "danger"),
                " ",
                entry.threads.connected ? badge("Threads接続済み", "ok") : badge("Threads未接続"),
                entry.id === status.activeAccountId ? badge("アクティブ", "accent") : null,
              ),
            ]) : [
              h("dt", {}, "Instagram"), h("dd", {}, status.instagram.connected ? badge("接続済み", "ok") : badge("未接続", "danger"), status.instagram.expiresAt ? h("span", { class: "muted small" }, ` 期限 ${fmt.date(status.instagram.expiresAt)}`) : null),
              h("dt", {}, "Threads"), h("dd", {}, status.threads.connected ? badge("接続済み", "ok") : badge("未接続")),
            ]),
            h("dt", {}, "LINE公式"), h("dd", {}, status.line.configured ? badge("設定済み", "ok") : badge("未設定")),
            h("dt", {}, "ブローカー"), h("dd", {}, status.broker.reachable ? badge("稼働中", "ok") : badge("接続不可", "danger"), h("span", { class: "muted small" }, ` ${status.broker.url}`)),
            h("dt", {}, "受信方式"), h("dd", {}, automation.webhookMode ? badge("Webhook（即時）", "ok") : badge("ポーリング", "info"), automation.pollingActive ? h("span", { class: "muted small" }, " 定期確認あり") : null),
            h("dt", {}, "最終確認"), h("dd", {}, fmt.full(automation.lastPollAt)),
            automation.lastError ? h("dt", {}, "直近のエラー") : null, automation.lastError ? h("dd", { class: "small", style: { color: "var(--danger)" } }, automation.lastError) : null,
          ),
          h("div", { class: "row", style: { marginTop: "14px" } },
            h("button", { class: "secondary small", type: "button", onClick: (event) => guard(event.currentTarget, async () => { await api("automation:runOnce"); IGUP.toast("確認を実行しました。"); IGUP.rerender(); }) }, "いま確認する"),
            h("button", { class: "ghost small", type: "button", onClick: () => navigate("connect") }, "接続設定"),
          ),
        ),
        h("div", { class: "card" },
          h("h2", {}, "これからの投稿"),
          upcoming.length === 0 ? h("div", { class: "empty" }, "予約中の投稿はありません。") :
            h("div", { class: "list" }, upcoming.map((post) => h("div", { class: "item", style: { padding: "10px 12px" } },
              h("span", { class: "chip", style: { background: POST_KIND[post.kind].color } }, POST_KIND[post.kind].label),
              h("div", { class: "body" }, h("div", { class: "title" }, snippet(post)), h("div", { class: "meta" }, `${fmt.dateTime(post.scheduledAt)}（${fmt.relative(post.scheduledAt)}）`)),
              badge(POST_STATUS[post.status].label, POST_STATUS[post.status].cls),
            ))),
          needsAttention.length ? h("p", { class: "small", style: { color: "var(--warn)" } }, `失敗・未投稿が${needsAttention.length}件あります。投稿画面から再試行できます。`) : null,
          h("div", { class: "row", style: { marginTop: "14px" } }, h("button", { class: "secondary small", type: "button", onClick: () => navigate("posts", { create: true }) }, "投稿を予約する"), h("button", { class: "ghost small", type: "button", onClick: () => navigate("calendar") }, "カレンダー")),
        ),
      ),
      h("div", { class: "card", style: { marginTop: "16px" } },
        h("div", { class: "row between" }, h("h2", {}, "最近の出来事"), h("button", { class: "ghost small", type: "button", onClick: () => navigate("logs") }, "すべてのログ")),
        logs.length === 0 ? h("div", { class: "empty" }, "まだ記録がありません。") : logs.map((entry) => h("div", { class: `log-row ${entry.level}` },
          h("span", { class: "time" }, fmt.dateTime(entry.at)), h("span", { class: "muted small" }, CATEGORY[entry.category] ?? entry.category),
          h("div", {}, h("div", { class: "title" }, entry.title), entry.detail ? h("div", { class: "detail" }, entry.detail) : null))),
      ),
    );

    function stat(label, value, sub) {
      return h("div", { class: "stat" }, h("div", { class: "label" }, label), h("div", { class: "value" }, fmt.n(value)), h("div", { class: "sub" }, sub));
    }
    function snippet(post) {
      const text = post.kind === "threads" ? post.threads[0]?.text ?? "" : post.caption;
      return text.trim().slice(0, 40) || `${POST_KIND[post.kind].label}（本文なし）`;
    }
  },
};
const CATEGORY = { inbound: "受信", outbound: "送信", post: "投稿", system: "システム", insights: "分析", seminar: "セミナー", link: "リンク" };
IGUP.CATEGORY = CATEGORY;
