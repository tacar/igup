/* Keyword auto-reply rules: comment / DM / story reply / live comment → public reply + DM with buttons, chains and follow-ups. */
(() => {
  const { api, h, replace, fmt, pageHead, badge, guard, field, confirmDialog, openModal, toast, switchControl, SOURCE_LABELS } = IGUP;
  const DELAY_PRESETS = [[10, "10分後"], [60, "1時間後"], [180, "3時間後"], [720, "12時間後"], [1380, "23時間後"]];

  function chainTarget(payload) {
    const parts = (payload ?? "").split(":");
    return parts.length === 3 && parts[0] === "igup" ? parts[2] : null;
  }

  /** Editable DM composer: text + button prompt + up to 3 buttons + up to 13 quick replies. */
  function messageEditor(message, rules, { selfId, compact = false }) {
    const model = {
      text: message?.text ?? "",
      buttonPrompt: message?.buttonPrompt ?? "こちらからどうぞ👇",
      buttons: (message?.buttons ?? []).map((button) => button.type === "web_url" ? { type: "web_url", title: button.title, url: button.url } : { type: "postback", title: button.title, targetRuleId: chainTarget(button.payload) }),
      quickReplies: (message?.quickReplies ?? []).map((reply) => ({ title: reply.title, targetRuleId: chainTarget(reply.payload) })),
    };
    const text = h("textarea", { rows: compact ? 3 : 5, placeholder: "DM本文（1,000文字まで）。改行・絵文字OK。", value: model.text, maxlength: 1000 });
    const counter = h("span", { class: "hint" });
    const updateCounter = () => { counter.textContent = `${text.value.length} / 1,000文字`; };
    text.addEventListener("input", updateCounter); updateCounter();
    const prompt = h("input", { type: "text", placeholder: "ボタンの上に表示する文（640文字まで）", value: model.buttonPrompt });
    const buttonsBox = h("div", { class: "stack" });
    const quickBox = h("div", { class: "stack" });
    const targets = () => rules.filter((rule) => rule.id !== selfId);

    function ruleSelect(current, onChange) {
      const select = h("select", { onChange: (event) => onChange(event.target.value || null) }, h("option", { value: "" }, "次に送るルールを選択…"), targets().map((rule) => h("option", { value: rule.id }, rule.name)));
      select.value = current ?? "";
      return select;
    }
    function renderButtons() {
      replace(buttonsBox,
        model.buttons.map((button, index) => h("div", { class: "field-row" },
          h("select", { value: button.type, onChange: (event) => { button.type = event.target.value; renderButtons(); } }, h("option", { value: "web_url" }, "リンクを開く"), h("option", { value: "postback" }, "次のメッセージへ")),
          h("input", { type: "text", placeholder: "ボタン名（20文字まで）", maxlength: 20, value: button.title, onInput: (event) => { button.title = event.target.value; } }),
          button.type === "web_url"
            ? h("input", { type: "url", placeholder: "https://…", value: button.url ?? "", onInput: (event) => { button.url = event.target.value; }, style: { flex: "2" } })
            : ruleSelect(button.targetRuleId, (value) => { button.targetRuleId = value; }),
          h("button", { class: "ghost small", type: "button", onClick: () => { model.buttons.splice(index, 1); renderButtons(); } }, "✕"),
        )),
        model.buttons.length < 3 ? h("button", { class: "secondary small", type: "button", onClick: () => { model.buttons.push({ type: "web_url", title: "", url: "" }); renderButtons(); } }, "＋ ボタンを追加（最大3）") : null,
      );
    }
    function renderQuick() {
      replace(quickBox,
        model.quickReplies.map((reply, index) => h("div", { class: "field-row" },
          h("input", { type: "text", placeholder: "選択肢（20文字まで）", maxlength: 20, value: reply.title, onInput: (event) => { reply.title = event.target.value; } }),
          ruleSelect(reply.targetRuleId, (value) => { reply.targetRuleId = value; }),
          h("button", { class: "ghost small", type: "button", onClick: () => { model.quickReplies.splice(index, 1); renderQuick(); } }, "✕"),
        )),
        model.quickReplies.length < 13 ? h("button", { class: "secondary small", type: "button", onClick: () => { model.quickReplies.push({ title: "", targetRuleId: null }); renderQuick(); } }, "＋ クイックリプライを追加（最大13）") : null,
      );
    }
    renderButtons(); renderQuick();
    const el = h("div", { class: "stack" },
      h("div", {}, text, counter),
      h("div", {}, h("label", {}, "リンク付きボタン / 次へ進むボタン"), buttonsBox, h("span", { class: "hint" }, "「次のメッセージへ」を選ぶと、タップした人に別のルールのDMを続けて送ります（メッセージ連鎖）。タップ数はタップ分析に記録されます。")),
      h("div", {}, h("label", {}, "クイックリプライ（選択式の返事）"), quickBox),
      field("ボタン表示時の案内文", prompt, "本文が空でボタンだけ送るときや、クイックリプライの見出しに使います。"),
    );
    return {
      el,
      hasChain: () => model.buttons.some((button) => button.type === "postback") || model.quickReplies.length > 0,
      async collect(originRuleId) {
        const buttons = [];
        for (const button of model.buttons) {
          if (button.type === "web_url") buttons.push({ type: "web_url", title: button.title.trim(), url: (button.url ?? "").trim() });
          else {
            if (!button.targetRuleId) throw new Error(`ボタン「${button.title || "(無題)"}」の「次に送るルール」を選んでください。`);
            buttons.push({ type: "postback", title: button.title.trim(), payload: await api("rules:chainPayload", { originRuleId, targetRuleId: button.targetRuleId }) });
          }
        }
        const quickReplies = [];
        for (const reply of model.quickReplies) {
          if (!reply.targetRuleId) throw new Error(`クイックリプライ「${reply.title || "(無題)"}」の「次に送るルール」を選んでください。`);
          quickReplies.push({ title: reply.title.trim(), payload: await api("rules:chainPayload", { originRuleId, targetRuleId: reply.targetRuleId }) });
        }
        return { text: text.value, buttonPrompt: prompt.value.trim() || "こちらからどうぞ👇", buttons, quickReplies };
      },
    };
  }

  async function openEditor(existing) {
    const rules = await api("rules:list");
    const rule = existing ? structuredClone(existing) : { name: "", enabled: true, sources: ["comment"], keywords: [], matchMode: "contains", mediaIds: [], publicReplies: [], message: null, followUps: [], cooldownHours: 24 };
    const name = h("input", { type: "text", placeholder: "例: 「資料」でPDFを送る", value: rule.name });
    const sourceInputs = Object.entries(SOURCE_LABELS).map(([key, label]) => { const input = h("input", { type: "checkbox", value: key, checked: rule.sources.includes(key) }); return h("label", { class: "inline" }, input, ` ${label}`); });
    const keywords = h("textarea", { rows: 3, placeholder: "1行に1つ（例: 資料 / しりょう / 欲しい）", value: rule.keywords.join("\n") });
    const matchMode = h("select", { value: rule.matchMode }, h("option", { value: "contains" }, "含んでいれば反応"), h("option", { value: "exact" }, "完全一致のみ"));
    const cooldown = h("input", { type: "number", min: 0, max: 720, step: 1, value: String(rule.cooldownHours) });
    const publicReplies = [0, 1, 2].map((index) => h("textarea", { rows: 2, placeholder: `公開返信パターン${index + 1}（コメントへの返事。空なら使いません）`, value: rule.publicReplies[index] ?? "" }));
    const mediaBox = h("div", { class: "stack" });
    let mediaList = null;

    function renderMedia() {
      const selected = rule.mediaIds;
      replace(mediaBox,
        h("div", { class: "row" },
          selected.length === 0 ? badge("すべての投稿", "info") : selected.map((id) => badge(`${mediaList?.find((item) => item.id === id) ? snippet(mediaList.find((item) => item.id === id)) : id}`, "accent")),
          h("button", { class: "secondary small", type: "button", onClick: (event) => guard(event.currentTarget, async () => {
            if (!mediaList) mediaList = (await api("instagram:media", { limit: 30 })).data ?? [];
            renderMedia();
            replace(mediaGrid, mediaList.map((item) => {
              const on = rule.mediaIds.includes(item.id);
              return h("div", { class: "media-tile", style: { cursor: "pointer", outline: on ? "3px solid var(--accent)" : "none" }, onClick: () => { rule.mediaIds = on ? rule.mediaIds.filter((id) => id !== item.id) : [...rule.mediaIds, item.id]; renderMedia(); mediaGrid.dispatchEvent(new Event("refresh")); } },
                item.thumbnail_url || item.media_url ? h("img", { src: item.thumbnail_url || item.media_url, alt: "" }) : h("div", { class: "video-ph" }, "▶"),
                on ? h("span", { class: "order" }, "✓") : null,
                h("div", { class: "name" }, `${fmt.date(item.timestamp)} ${snippet(item)}`),
              );
            }));
            mediaGrid.hidden = false;
          }) }, mediaList ? "対象投稿を選び直す" : "対象投稿を選ぶ"),
          selected.length ? h("button", { class: "ghost small", type: "button", onClick: () => { rule.mediaIds = []; renderMedia(); } }, "すべてに戻す") : null,
        ),
      );
    }
    const mediaGrid = h("div", { class: "media-grid", hidden: true });
    mediaGrid.addEventListener("refresh", () => { for (const tile of mediaGrid.children) { const id = mediaList[[...mediaGrid.children].indexOf(tile)]?.id; tile.style.outline = rule.mediaIds.includes(id) ? "3px solid var(--accent)" : "none"; const mark = tile.querySelector(".order"); if (rule.mediaIds.includes(id) && !mark) tile.append(h("span", { class: "order" }, "✓")); if (!rule.mediaIds.includes(id) && mark) mark.remove(); } });
    renderMedia();

    const dmEditor = messageEditor(rule.message, rules, { selfId: rule.id });
    const followBox = h("div", { class: "stack" });
    const followEditors = [];
    function renderFollowUps() {
      replace(followBox,
        rule.followUps.map((followUp, index) => {
          const editor = followEditors[index] ?? (followEditors[index] = messageEditor(followUp.message, rules, { selfId: rule.id, compact: true }));
          const delay = h("input", { type: "number", min: 1, max: 1380, value: String(followUp.delayMinutes), onInput: (event) => { followUp.delayMinutes = Number(event.target.value); }, style: { width: "100px" } });
          return h("div", { class: "card", style: { padding: "12px" } },
            h("div", { class: "row between" },
              h("div", { class: "row" }, h("strong", {}, `時間差送信 ${index + 1}`), delay, h("span", { class: "muted small" }, "分後"), DELAY_PRESETS.map(([minutes, label]) => h("button", { class: "ghost small", type: "button", onClick: () => { followUp.delayMinutes = minutes; delay.value = String(minutes); } }, label))),
              h("button", { class: "ghost small", type: "button", onClick: () => { rule.followUps.splice(index, 1); followEditors.splice(index, 1); renderFollowUps(); } }, "削除"),
            ),
            editor.el,
          );
        }),
        h("button", { class: "secondary small", type: "button", onClick: () => { rule.followUps.push({ id: `fu_${Date.now()}`, delayMinutes: 60, message: null }); renderFollowUps(); } }, "＋ 時間差送信を追加"),
        h("span", { class: "hint" }, "最初のDMから最大23時間後まで（Instagramの24時間ルール）。送信予定時刻にアプリが起動している必要があります。"),
      );
    }
    renderFollowUps();

    async function save() {
      const base = {
        ...(rule.id ? { id: rule.id } : {}),
        name: name.value,
        enabled: rule.enabled,
        sources: sourceInputs.map((label) => label.querySelector("input")).filter((input) => input.checked).map((input) => input.value),
        keywords: keywords.value.split(/[\n,、]/).map((keyword) => keyword.trim()).filter(Boolean),
        matchMode: matchMode.value,
        mediaIds: rule.mediaIds,
        publicReplies: publicReplies.map((area) => area.value.trim()).filter(Boolean),
        cooldownHours: Number(cooldown.value),
      };
      const needsId = !rule.id && (dmEditor.hasChain() || followEditors.some((editor) => editor.hasChain()));
      let id = rule.id;
      if (needsId) {
        // Chains embed this rule's id in payloads; create the rule first to obtain it.
        const created = await api("rules:save", { ...base, message: { text: "（設定中）", buttons: [], quickReplies: [], buttonPrompt: "" }, followUps: [] });
        id = created.id;
      }
      const message = await dmEditor.collect(id ?? "new");
      const followUps = [];
      for (let index = 0; index < rule.followUps.length; index += 1) {
        followUps.push({ id: rule.followUps[index].id, delayMinutes: Number(rule.followUps[index].delayMinutes), message: await followEditors[index].collect(id ?? "new") });
      }
      return api("rules:save", { ...base, ...(id ? { id } : {}), message, followUps });
    }

    const dialog = openModal({
      title: rule.id ? "自動返信ルールを編集" : "自動返信ルールを作成",
      wide: true,
      body: h("div", { class: "stack" },
        h("div", { class: "grid cols-2" }, field("ルール名", name), field("同じ人への再送を控える時間（クールダウン）", cooldown, "時間。0で毎回返信します。")),
        h("div", {}, h("label", {}, "どこに来たら反応するか"), h("div", { class: "row" }, sourceInputs), h("span", { class: "hint" }, "コメントの返信（返事）には反応しません。ライブ配信コメントは設定で有効にしたときだけ確認します。")),
        h("div", { class: "grid cols-2" }, field("キーワード", keywords, "大文字小文字・全角半角・カナは区別しません。"), field("一致のしかた", matchMode)),
        h("div", {}, h("label", {}, "対象の投稿（コメント・ライブ用）"), mediaBox, mediaGrid),
        h("div", {}, h("label", {}, "公開返信（コメントへの返事・最大3パターンからランダム）"), h("div", { class: "stack" }, publicReplies), h("span", { class: "hint" }, "公開返信を書かない場合はDMだけ送ります。")),
        h("div", {}, h("h3", {}, "DM（本文・ボタン）"), dmEditor.el),
        h("div", {}, h("h3", {}, "時間差送信"), followBox),
      ),
      footer: [
        h("button", { class: "ghost", type: "button", onClick: () => dialog.close() }, "キャンセル"),
        h("button", { type: "button", onClick: (event) => guard(event.currentTarget, async () => { await save(); dialog.close(); toast("ルールを保存しました。"); IGUP.rerender(); }) }, "保存"),
      ],
    });
  }

  function snippet(item) { return (item.caption || "").split("\n")[0].slice(0, 18) || item.media_type || item.id; }

  function openTest(rule) {
    const recipient = h("input", { type: "text", placeholder: "Instagram-scoped user ID（IGSID）" });
    const dialog = openModal({
      title: `テスト送信: ${rule.name}`,
      body: h("div", { class: "stack" }, h("p", { class: "muted small" }, "このルールのDMを指定した相手に送ります。相手は24時間以内にあなたへDMを送っている必要があります（IGSIDはログの受信記録で確認できます）。"), field("送信先IGSID", recipient)),
      footer: [h("button", { class: "ghost", type: "button", onClick: () => dialog.close() }, "閉じる"), h("button", { type: "button", onClick: (event) => guard(event.currentTarget, async () => { await api("rules:test", { ruleId: rule.id, recipientId: recipient.value.trim() }); toast("テストDMを送信しました。"); dialog.close(); }) }, "送信")],
    });
  }

  IGUP.views.rules = {
    title: "自動返信",
    icon: "↩",
    async render(container, params) {
      const [rules, status] = await Promise.all([api("rules:list"), api("connection:status")]);
      replace(container,
        pageHead("キーワード自動返信", "コメント・DM・ストーリーズ返信・ライブのキーワードに、公開返信とリンク付きDMを自動で返します。", h("button", { type: "button", onClick: () => openEditor(null) }, "＋ ルールを作成")),
        !status.automation.enabled ? h("p", { class: "small", style: { color: "var(--warn)" } }, "自動返信は停止中です。ダッシュボードのスイッチで開始してください。") : null,
        rules.length === 0 ? h("div", { class: "empty" }, "ルールはまだありません。「ルールを作成」から始めましょう。") :
          h("div", { class: "list" }, rules.map((rule) => h("div", { class: `item${rule.enabled ? "" : " disabled"}` },
            switchControl(rule.enabled, (enabled) => guard(null, async () => { await api("rules:save", { id: rule.id, enabled }); })),
            h("div", { class: "body" },
              h("div", { class: "row" }, h("span", { class: "title" }, rule.name), rule.sources.map((source) => badge(SOURCE_LABELS[source], "info")), rule.mediaIds.length ? badge(`対象投稿 ${rule.mediaIds.length}件`) : null),
              h("div", { class: "meta" }, `キーワード: ${rule.keywords.join(" / ")}`, ` · ${rule.matchMode === "exact" ? "完全一致" : "部分一致"}`, ` · クールダウン ${rule.cooldownHours}時間`, rule.followUps.length ? ` · 時間差送信 ${rule.followUps.length}件` : "", rule.message?.buttons.length ? ` · ボタン ${rule.message.buttons.length}` : ""),
              h("div", { class: "meta" }, `マッチ ${fmt.n(rule.stats.matched)} · DM ${fmt.n(rule.stats.dmSent)} · 既読 ${fmt.n(rule.stats.read)} · タップ ${fmt.n(rule.stats.buttonTapped)}`, rule.stats.dmFailed ? ` · 失敗 ${fmt.n(rule.stats.dmFailed)}` : ""),
            ),
            h("div", { class: "row" },
              h("button", { class: "ghost small", type: "button", onClick: () => openEditor(rule) }, "編集"),
              h("button", { class: "ghost small", type: "button", onClick: () => openTest(rule) }, "テスト送信"),
              h("button", { class: "ghost small", type: "button", onClick: () => openEditor({ ...structuredClone(rule), id: undefined, name: `${rule.name}のコピー`, stats: undefined }) }, "複製"),
              h("button", { class: "ghost small danger", type: "button", onClick: async (event) => { if (await confirmDialog(`ルール「${rule.name}」を削除しますか？`, { danger: true, okLabel: "削除" })) await guard(event.currentTarget, async () => { await api("rules:delete", { id: rule.id }); IGUP.rerender(); }); } }, "削除"),
            ),
          ))),
      );
      if (params.create) { IGUP.state.params = {}; void openEditor(null); }
    },
  };
})();
