/* Send / receive log with category filter. */
(() => {
  const { api, h, replace, fmt, pageHead, guard, confirmDialog } = IGUP;
  const CATEGORIES = [["", "すべて"], ["inbound", "受信"], ["outbound", "送信"], ["post", "投稿"], ["insights", "分析"], ["seminar", "セミナー"], ["link", "リンク"], ["system", "システム"]];
  let category = "";

  IGUP.views.logs = {
    title: "ログ",
    icon: "≡",
    async render(container) {
      const logs = await api("logs:list", { limit: 300, category });
      replace(container,
        pageHead("送受信ログ", "受信したコメント・DM、送った返信、投稿、分析の記録です（最新300件）。",
          h("button", { class: "ghost", type: "button", onClick: async (event) => { if (await confirmDialog("ログをすべて削除しますか？", { danger: true, okLabel: "削除" })) await guard(event.currentTarget, async () => { await api("logs:clear"); IGUP.rerender(); }); } }, "ログを消去")),
        h("div", { class: "subtabs" }, CATEGORIES.map(([key, label]) => h("button", { type: "button", class: key === category ? "active" : "", onClick: () => { category = key; IGUP.rerender(); } }, label))),
        h("div", { class: "card" },
          logs.length === 0 ? h("div", { class: "empty" }, "記録はまだありません。") :
            logs.map((entry) => h("div", { class: `log-row ${entry.level}` },
              h("span", { class: "time" }, fmt.full(entry.at)),
              h("span", { class: "muted small" }, IGUP.CATEGORY[entry.category] ?? entry.category),
              h("div", {}, h("div", { class: "title" }, entry.title), entry.detail ? h("div", { class: "detail" }, entry.detail) : null),
            )),
        ),
      );
    },
  };
})();
