/* Month calendar: scheduled posts colored by kind, plus free-form memos. */
(() => {
  const { api, h, replace, fmt, pageHead, guard, field, openModal, toast, dateKey, POST_KIND, POST_STATUS, badge, accountChips } = IGUP;
  const MEMO_COLORS = ["#6b7280", "#2563eb", "#059669", "#d97706", "#dc2626", "#7c3aed", "#db2777"];
  let cursor = new Date();
  cursor.setDate(1);
  let accountFilter = null;

  function openMemoEditor(existing, date) {
    const memo = existing ? { ...existing } : { date, title: "", note: "", color: MEMO_COLORS[0] };
    const dateInput = h("input", { type: "date", value: memo.date });
    const title = h("input", { type: "text", placeholder: "例: キャンペーン告知の準備", value: memo.title });
    const note = h("textarea", { rows: 4, placeholder: "予定メモ・投稿ネタなど", value: memo.note });
    let color = memo.color;
    const swatches = h("div", { class: "row" }, MEMO_COLORS.map((value) => h("button", { type: "button", class: "icon-btn", title: value, style: { background: value, width: "26px", height: "26px", borderRadius: "50%", border: value === color ? "3px solid var(--ink)" : "3px solid transparent" }, onClick: (event) => { color = value; for (const button of swatches.children) button.style.border = "3px solid transparent"; event.currentTarget.style.border = "3px solid var(--ink)"; } })));
    const dialog = openModal({
      title: existing ? "メモを編集" : "メモを追加",
      body: h("div", { class: "stack" }, field("日付", dateInput), field("タイトル", title), field("メモ", note), field("色", swatches)),
      footer: [
        existing ? h("button", { class: "ghost danger", type: "button", onClick: (event) => guard(event.currentTarget, async () => { await api("memos:delete", { id: existing.id }); dialog.close(); IGUP.rerender(); }) }, "削除") : null,
        h("button", { class: "ghost", type: "button", onClick: () => dialog.close() }, "キャンセル"),
        h("button", { type: "button", onClick: (event) => guard(event.currentTarget, async () => {
          await api("memos:save", { ...(existing ? { id: existing.id } : {}), date: dateInput.value, title: title.value, note: note.value, color });
          dialog.close();
          toast("メモを保存しました。");
          IGUP.rerender();
        }) }, "保存"),
      ],
    });
  }

  function openDay(key, posts, memos) {
    const at = new Date(`${key}T10:00:00`);
    const dialog = openModal({
      title: fmt.date(at.toISOString()),
      body: h("div", { class: "stack" },
        h("h3", {}, "投稿"),
        posts.length === 0 ? h("p", { class: "muted small" }, "この日の投稿はありません。") :
          h("div", { class: "list" }, posts.map((post) => h("div", { class: "item", style: { padding: "8px 10px" } },
            h("span", { class: "chip", style: { background: POST_KIND[post.kind].color } }, POST_KIND[post.kind].label),
            h("div", { class: "body" }, h("div", { class: "title" }, snippet(post)), h("div", { class: "meta" }, fmt.time(post.scheduledAt))),
            badge(POST_STATUS[post.status].label, POST_STATUS[post.status].cls),
            post.status !== "publishing" ? h("button", { class: "ghost small", type: "button", onClick: () => { dialog.close(); IGUP.posts.openEditor(post); } }, "編集") : null,
          ))),
        h("h3", {}, "メモ"),
        memos.length === 0 ? h("p", { class: "muted small" }, "メモはありません。") :
          h("div", { class: "list" }, memos.map((memo) => h("div", { class: "item", style: { padding: "8px 10px", borderLeft: `4px solid ${memo.color}` } },
            h("div", { class: "body" }, h("div", { class: "title" }, memo.title), memo.note ? h("div", { class: "meta", style: { whiteSpace: "pre-wrap" } }, memo.note) : null),
            h("button", { class: "ghost small", type: "button", onClick: () => { dialog.close(); openMemoEditor(memo, key); } }, "編集"),
          ))),
      ),
      footer: [
        h("button", { class: "ghost", type: "button", onClick: () => { dialog.close(); openMemoEditor(null, key); } }, "＋ メモ"),
        h("button", { type: "button", onClick: () => { dialog.close(); IGUP.posts.openEditor(null, { defaults: { scheduledAt: at.toISOString(), ...(accountFilter ? { accountId: accountFilter } : {}) } }); } }, "＋ この日に投稿を予約"),
      ],
    });
  }

  function snippet(post) {
    const text = post.kind === "threads" ? post.threads[0]?.text ?? "" : post.caption;
    return text.trim().split("\n")[0].slice(0, 40) || POST_KIND[post.kind].label;
  }

  IGUP.views.calendar = {
    title: "カレンダー",
    icon: "▦",
    async render(container) {
      const [posts, memos] = await Promise.all([api("posts:list"), api("memos:list")]);
      const scoped = posts.filter((post) => !accountFilter || post.accountId === accountFilter);
      const byDay = new Map();
      for (const post of scoped) {
        if (post.status === "canceled") continue;
        const key = dateKey(new Date(post.scheduledAt));
        if (!byDay.has(key)) byDay.set(key, { posts: [], memos: [] });
        byDay.get(key).posts.push(post);
      }
      for (const memo of memos) {
        if (!byDay.has(memo.date)) byDay.set(memo.date, { posts: [], memos: [] });
        byDay.get(memo.date).memos.push(memo);
      }
      const year = cursor.getFullYear(), month = cursor.getMonth();
      const first = new Date(year, month, 1);
      const start = new Date(first); start.setDate(1 - first.getDay());
      const todayKey = dateKey(new Date());
      const cells = [];
      for (let i = 0; i < 42; i += 1) {
        const day = new Date(start); day.setDate(start.getDate() + i);
        if (i >= 35 && day.getMonth() !== month) break;
        const key = dateKey(day);
        const entry = byDay.get(key) ?? { posts: [], memos: [] };
        cells.push(h("div", { class: `day${day.getMonth() !== month ? " other" : ""}${key === todayKey ? " today" : ""}`, onClick: () => openDay(key, entry.posts, entry.memos) },
          h("span", { class: "n" }, String(day.getDate())),
          entry.posts.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)).map((post) => h("span", { class: "chip", title: `${fmt.time(post.scheduledAt)} ${snippet(post)}`, style: { background: POST_KIND[post.kind].color, opacity: post.status === "published" ? ".6" : "1", textDecoration: post.status === "failed" || post.status === "missed" ? "line-through" : "none" } }, `${fmt.time(post.scheduledAt)} ${snippet(post)}`)),
          entry.memos.map((memo) => h("span", { class: "chip memo", title: memo.note || memo.title, style: { borderLeftColor: memo.color } }, memo.title)),
        ));
      }
      replace(container,
        pageHead("カレンダー", "予約投稿とメモを月ごとに確認します。日付をクリックすると詳細と追加ができます。",
          h("button", { class: "secondary", type: "button", onClick: () => { cursor = new Date(year, month - 1, 1); IGUP.rerender(); } }, "‹ 前月"),
          h("button", { class: "secondary", type: "button", onClick: () => { cursor = new Date(); cursor.setDate(1); IGUP.rerender(); } }, "今月"),
          h("button", { class: "secondary", type: "button", onClick: () => { cursor = new Date(year, month + 1, 1); IGUP.rerender(); } }, "翌月 ›"),
          h("button", { type: "button", onClick: () => openMemoEditor(null, todayKey) }, "＋ メモ"),
        ),
        accountChips(accountFilter, (value) => { accountFilter = value; IGUP.rerender(); }),
        h("div", { class: "card" },
          h("div", { class: "row between", style: { marginBottom: "12px" } },
            h("h2", {}, `${year}年${month + 1}月`),
            h("div", { class: "legend" }, Object.values(POST_KIND).map((meta) => h("span", {}, h("span", { class: "dot", style: { background: meta.color } }), meta.label)), h("span", {}, h("span", { class: "dot", style: { background: "var(--ink-3)" } }), "メモ")),
          ),
          h("div", { class: "calendar" }, ["日", "月", "火", "水", "木", "金", "土"].map((label) => h("div", { class: "dow" }, label)), cells),
        ),
      );
    },
  };
})();
