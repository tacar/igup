/* Insights: post ranking + follower trend + story snapshots, tracked links, tap analytics. */
(() => {
  const { api, h, replace, fmt, pageHead, badge, guard, field, confirmDialog, toast, copyText, openExternal, drawLineChart, drawBars, accountChips, accountName, accounts } = IGUP;
  const TABS = [["posts", "投稿インサイト"], ["links", "計測リンク"], ["taps", "タップ分析"]];
  const SOURCES = [["instagram_story", "ストーリーズ"], ["instagram_dm", "DM"], ["instagram_profile", "プロフィール"], ["instagram_comment", "コメント"], ["threads", "Threads"], ["line", "LINE"], ["other", "その他"]];
  let tab = "posts";
  let accountFilter = null;
  const METRIC_LABELS = { views: "再生/表示", reach: "リーチ", likes: "いいね", comments: "コメント", saved: "保存", shares: "シェア", total_interactions: "反応合計", replies: "返信", navigation: "操作", follows: "フォロー" };

  function metricCell(snapshot, key) { return h("td", { class: "num" }, snapshot.metrics[key] === undefined ? "—" : fmt.n(snapshot.metrics[key])); }

  async function renderPosts(box) {
    const summary = await api("insights:summary", { ...(accountFilter ? { accountId: accountFilter } : {}) });
    const latest = summary.latest;
    const chart = h("canvas", { class: "chart" });
    const reachChart = h("canvas", { class: "chart" });
    replace(box,
      accountChips(accountFilter, (value) => { accountFilter = value; IGUP.rerender(); }),
      h("div", { class: "row between", style: { marginBottom: "12px" } },
        h("p", { class: "muted small" }, `最終取得: ${summary.lastInsightsDate ?? "未取得"}（毎日3時以降に自動取得） / ストーリーズ: ${summary.lastStorySnapshotAt ? fmt.dateTime(summary.lastStorySnapshotAt) : "未取得"}`),
        h("button", { class: "secondary small", type: "button", onClick: (event) => guard(event.currentTarget, async () => { await api("insights:capture"); toast("インサイトを取得しました。"); IGUP.rerender(); }) }, "いま取得する"),
      ),
      h("div", { class: "grid cols-4" },
        stat("フォロワー", latest?.followers, latest ? `${latest.date} 時点` : "未取得"),
        stat("リーチ（前日）", latest?.reach, "ユニークアカウント数"),
        stat("プロフィール表示", latest?.profileViews, "前日"),
        stat("反応したアカウント", latest?.accountsEngaged, "前日"),
      ),
      h("div", { class: "grid cols-2", style: { marginTop: "16px" } },
        h("div", { class: "card" }, h("h3", {}, "フォロワー推移"), chart),
        h("div", { class: "card" }, h("h3", {}, "日別リーチ"), reachChart),
      ),
      h("div", { class: "card", style: { marginTop: "16px" } },
        h("h3", {}, "反応の多い投稿 Top10"),
        summary.topMedia.length === 0 ? h("div", { class: "empty" }, "まだデータがありません。「いま取得する」を押すと取得します。") :
          h("div", { class: "table-wrap" }, h("table", {},
            h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", {}, "投稿"), h("th", {}, "種類"), ...["views", "reach", "likes", "comments", "saved", "shares", "total_interactions"].map((key) => h("th", { class: "num" }, METRIC_LABELS[key])), h("th", {}, ""))),
            h("tbody", {}, summary.topMedia.map((item, index) => h("tr", {},
              h("td", {}, String(index + 1)),
              h("td", {}, h("div", { class: "row" }, item.thumbnailUrl ? h("img", { src: item.thumbnailUrl, alt: "", style: { width: "40px", height: "40px", objectFit: "cover", borderRadius: "6px" } }) : null, h("span", { class: "small" }, (item.caption || "（キャプションなし）").split("\n")[0].slice(0, 40)))),
              h("td", {}, item.productType || item.mediaType),
              ...["views", "reach", "likes", "comments", "saved", "shares", "total_interactions"].map((key) => metricCell(item, key)),
              h("td", {}, item.permalink ? h("button", { class: "ghost small", type: "button", onClick: () => openExternal(item.permalink) }, "開く") : null),
            ))),
          )),
      ),
      h("div", { class: "card", style: { marginTop: "16px" } },
        h("h3", {}, "ストーリーズ（消える前のスナップショット）"),
        summary.stories.length === 0 ? h("div", { class: "empty" }, "ストーリーズの記録はまだありません。") :
          h("div", { class: "table-wrap" }, h("table", {},
            h("thead", {}, h("tr", {}, h("th", {}, "投稿日時"), h("th", {}, "記録"), ...["views", "reach", "replies", "shares", "navigation", "follows"].map((key) => h("th", { class: "num" }, METRIC_LABELS[key])))),
            h("tbody", {}, summary.stories.map((story) => h("tr", {},
              h("td", {}, h("div", { class: "row" }, story.mediaUrl && story.mediaType === "IMAGE" ? h("img", { src: story.mediaUrl, alt: "", style: { width: "32px", height: "32px", objectFit: "cover", borderRadius: "6px" } }) : null, fmt.dateTime(story.timestamp))),
              h("td", { class: "small" }, fmt.dateTime(story.capturedAt)),
              ...["views", "reach", "replies", "shares", "navigation", "follows"].map((key) => metricCell(story, key)),
            ))),
          )),
      ),
    );
    requestAnimationFrame(() => {
      const labels = summary.followerSeries.map((point) => point.date.slice(5).replace("-", "/"));
      drawLineChart(chart, summary.followerSeries.map((point) => point.followers), { labels });
      drawLineChart(reachChart, summary.followerSeries.map((point) => point.reach), { labels, color: "#0891b2" });
    });
  }

  async function renderLinks(box) {
    let links;
    let offline = false;
    try {
      links = await api("links:list");
    } catch (error) {
      links = await api("links:cached");
      offline = IGUP.errorMessage(error);
    }
    const label = h("input", { type: "text", placeholder: "例: LINE登録（ストーリーズ）" });
    const url = h("input", { type: "url", placeholder: "https://…（リンク先）" });
    const source = h("select", {}, SOURCES.map(([key, name]) => h("option", { value: key }, name)));
    const slug = h("input", { type: "text", placeholder: "任意（例: line-story）" });
    const ranked = [...links].sort((a, b) => b.total - a.total);
    const today = IGUP.dateKey(new Date());
    replace(box,
      offline ? h("p", { class: "small", style: { color: "var(--warn)" } }, `ブローカーから最新の計測値を取得できませんでした（${offline}）。保存済みの値を表示しています。`) : null,
      h("div", { class: "card" },
        h("h3", {}, "計測リンクを作る"),
        h("p", { class: "muted small" }, "短いリンクを経由させてタップ数を数えます。ストーリーズ・DM・プロフィールなど「どこに貼ったか」を分けて作ると媒体別に比較できます。"),
        h("div", { class: "grid cols-4" }, field("名前", label), field("リンク先URL", url), field("貼る場所", source), field("スラッグ", slug)),
        h("div", { class: "row", style: { marginTop: "10px" } }, h("button", { type: "button", onClick: (event) => guard(event.currentTarget, async () => {
          const link = await api("links:create", { url: url.value.trim(), label: label.value.trim() || url.value.trim(), source: source.value, ...(slug.value.trim() ? { slug: slug.value.trim() } : {}) });
          toast(`作成しました: ${link.trackedUrl}`);
          IGUP.rerender();
        }) }, "作成")),
      ),
      h("div", { class: "card", style: { marginTop: "16px" } },
        h("h3", {}, "ランキング"),
        ranked.length === 0 ? h("div", { class: "empty" }, "計測リンクはまだありません。") :
          h("div", { class: "list" }, ranked.map((link, index) => {
            const canvas = h("canvas", { class: "chart", style: { height: "120px" } });
            const days = [];
            for (let i = 13; i >= 0; i -= 1) { const date = new Date(); date.setDate(date.getDate() - i); const key = IGUP.dateKey(date); days.push({ label: key.slice(5).replace("-", "/"), value: link.daily?.[key] ?? 0 }); }
            requestAnimationFrame(() => drawBars(canvas, days));
            return h("div", { class: "item", style: { flexDirection: "column", alignItems: "stretch" } },
              h("div", { class: "row between" },
                h("div", { class: "row" }, h("strong", {}, `${index + 1}.`), h("span", { class: "title" }, link.label), badge(SOURCES.find(([key]) => key === link.source)?.[1] ?? link.source, "info")),
                h("div", { class: "row" },
                  h("span", { class: "stat", style: { padding: "4px 10px" } }, h("span", { class: "value", style: { fontSize: "20px" } }, fmt.n(link.total)), h("span", { class: "label" }, " 合計")),
                  h("span", { class: "muted small" }, `今日 ${fmt.n(link.daily?.[today] ?? 0)}`),
                ),
              ),
              h("div", { class: "row" }, h("code", {}, link.trackedUrl), h("button", { class: "ghost small", type: "button", onClick: () => copyText(link.trackedUrl) }, "コピー"), h("span", { class: "muted small" }, `→ ${link.url}`)),
              Object.keys(link.sources ?? {}).length ? h("div", { class: "row" }, Object.entries(link.sources).sort((a, b) => b[1] - a[1]).map(([key, count]) => badge(`${SOURCES.find(([id]) => id === key)?.[1] ?? key}: ${fmt.n(count)}`))) : null,
              canvas,
              h("div", { class: "row between" }, h("span", { class: "hint" }, `作成 ${fmt.date(link.createdAt)}。同じリンクをURL末尾に ?s=story のように付けて貼り分けると媒体別に集計されます。`),
                h("button", { class: "ghost small danger", type: "button", onClick: async (event) => { if (await confirmDialog("この計測リンクを削除しますか？貼った先からはアクセスできなくなります。", { danger: true, okLabel: "削除" })) await guard(event.currentTarget, async () => { await api("links:delete", { slug: link.slug }); IGUP.rerender(); }); } }, "削除")),
            );
          })),
      ),
    );
  }

  async function renderTaps(box) {
    const rules = await api("rules:list");
    const scoped = rules.filter((rule) => !accountFilter || rule.accountId === accountFilter);
    const multi = accounts().length > 1;
    replace(box,
      accountChips(accountFilter, (value) => { accountFilter = value; IGUP.rerender(); }),
      h("p", { class: "muted small" }, "自動返信ごとに「届いた → DMを送った → 見られた → ボタンが押された」を数えます。開封はInstagramの既読通知（Webhook利用時）、タップはリンクボタンではなく次のメッセージへ進むボタン・クイックリプライで計測します。"),
      scoped.length === 0 ? h("div", { class: "empty" }, rules.length === 0 ? "自動返信ルールがまだありません。" : "該当するルールはありません。") :
        h("div", { class: "grid cols-2" }, scoped.map((rule) => {
          const steps = [["届いた（マッチ）", rule.stats.matched], ["DMを送った", rule.stats.dmSent], ["見られた（既読）", rule.stats.read], ["押された", rule.stats.buttonTapped]];
          const max = Math.max(1, rule.stats.matched);
          return h("div", { class: "card" },
            h("div", { class: "row between" }, h("h3", {}, rule.name, multi && rule.accountId ? h("span", { class: "muted small", style: { marginLeft: "6px" } }, accountName(rule.accountId)) : null), rule.enabled ? badge("有効", "ok") : badge("停止")),
            h("div", { class: "funnel" }, steps.map(([label, value]) => h("div", { class: "bar" }, h("span", {}, label), h("div", { class: "track" }, h("div", { class: "fill", style: { width: `${Math.min(100, (value / max) * 100)}%` } })), h("span", { class: "n" }, fmt.n(value))))),
            h("p", { class: "hint" }, `公開返信 ${fmt.n(rule.stats.publicReplied)} / 時間差送信 ${fmt.n(rule.stats.followUpSent)} / 送信失敗 ${fmt.n(rule.stats.dmFailed)}`),
          );
        })),
    );
  }

  function stat(label, value, sub) {
    return h("div", { class: "stat" }, h("div", { class: "label" }, label), h("div", { class: "value" }, fmt.n(value)), h("div", { class: "sub" }, sub));
  }

  IGUP.views.insights = {
    title: "分析",
    icon: "◔",
    async render(container, params) {
      if (params.tab) { tab = params.tab; IGUP.state.params = {}; }
      const box = h("div", {});
      replace(container,
        pageHead("分析", "投稿インサイト・計測リンク・タップ分析。数字はこのPCに保存され、ストーリーズが消えたあとも残ります。"),
        h("div", { class: "subtabs" }, TABS.map(([key, label]) => h("button", { type: "button", class: key === tab ? "active" : "", onClick: () => { tab = key; IGUP.rerender(); } }, label))),
        box,
      );
      if (tab === "posts") await renderPosts(box);
      else if (tab === "links") await renderLinks(box);
      else await renderTaps(box);
    },
  };
})();
