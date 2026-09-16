/* LINE seminar sign-up: public sign-up page on the broker, thanks + reminders over LINE from this PC. */
(() => {
  const { api, h, replace, fmt, pageHead, badge, guard, field, confirmDialog, openModal, toast, switchControl, copyText, openExternal, toLocalInput, fromLocalInput, accountName, accounts } = IGUP;

  function openEditor(existing) {
    const seminar = existing ? structuredClone(existing) : { id: "", title: "", description: "", dates: [], liffId: null, thanksMessage: "{name}さん、「{title}」へのお申し込みありがとうございます。\n開催日時: {date}\n当日お会いできるのを楽しみにしています！", reminders: [{ id: `rm_${Date.now()}`, hoursBefore: 24, text: "{name}さん、明日「{title}」の開催です。\n{date} にお待ちしています！" }], applications: [], enabled: true, publicUrl: null, createdAt: "", updatedAt: "" };
    if (seminar.dates.length === 0) seminar.dates.push({ id: `d_${Date.now()}`, startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), capacity: null });
    const title = h("input", { type: "text", placeholder: "例: Instagram集客セミナー", value: seminar.title });
    const description = h("textarea", { rows: 4, placeholder: "申込ページに表示する説明", value: seminar.description });
    const liffId = h("input", { type: "text", placeholder: "LIFF ID（例: 1234567890-AbcdEfgh）", value: seminar.liffId ?? "" });
    const thanks = h("textarea", { rows: 4, value: seminar.thanksMessage });
    const datesBox = h("div", { class: "stack" });
    const remindersBox = h("div", { class: "stack" });
    let enabled = seminar.enabled;

    function renderDates() {
      replace(datesBox,
        seminar.dates.map((date, index) => h("div", { class: "field-row" },
          h("input", { type: "datetime-local", value: toLocalInput(date.startsAt), onChange: (event) => { date.startsAt = fromLocalInput(event.target.value) ?? date.startsAt; } }),
          h("input", { type: "number", min: 1, placeholder: "定員（空欄で無制限）", value: date.capacity ?? "", onInput: (event) => { date.capacity = event.target.value ? Number(event.target.value) : null; }, style: { width: "160px" } }),
          h("span", { class: "muted small" }, `申込 ${seminar.applications.filter((application) => application.dateId === date.id).length}`),
          seminar.dates.length > 1 ? h("button", { class: "ghost small", type: "button", onClick: () => { seminar.dates.splice(index, 1); renderDates(); } }, "✕") : null,
        )),
        h("button", { class: "secondary small", type: "button", onClick: () => { seminar.dates.push({ id: `d_${Date.now()}`, startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), capacity: null }); renderDates(); } }, "＋ 日程を追加"),
      );
    }
    function renderReminders() {
      replace(remindersBox,
        seminar.reminders.map((reminder, index) => h("div", { class: "card", style: { padding: "12px" } },
          h("div", { class: "row between" },
            h("div", { class: "row" }, h("span", {}, "開始の"), h("input", { type: "number", min: 1, max: 720, value: String(reminder.hoursBefore), onInput: (event) => { reminder.hoursBefore = Number(event.target.value); }, style: { width: "90px" } }), h("span", {}, "時間前に送る")),
            h("button", { class: "ghost small", type: "button", onClick: () => { seminar.reminders.splice(index, 1); renderReminders(); } }, "削除"),
          ),
          h("textarea", { rows: 3, value: reminder.text, onInput: (event) => { reminder.text = event.target.value; } }),
        )),
        h("button", { class: "secondary small", type: "button", onClick: () => { seminar.reminders.push({ id: `rm_${Date.now()}`, hoursBefore: 1, text: "{name}さん、まもなく「{title}」が始まります。" }); renderReminders(); } }, "＋ リマインドを追加"),
      );
    }
    renderDates(); renderReminders();

    const dialog = openModal({
      title: seminar.id ? "セミナーを編集" : "セミナーを作成",
      wide: true,
      body: h("div", { class: "stack" },
        h("div", { class: "grid cols-2" }, field("セミナー名", title), h("div", {}, h("label", {}, "受付"), switchControl(enabled, (value) => { enabled = value; }, "申込を受け付ける"))),
        field("説明", description),
        h("div", {}, h("label", {}, "日程（複数可）"), datesBox),
        field("LIFF ID（任意）", liffId, "LINE Developers で作成した LIFF アプリのIDを入れると、申込ページがLINE内で開き、申込者のLINEにお礼とリマインドを自動送信できます。空欄の場合はメール申込のみ受け付けます。"),
        field("お礼メッセージ（LINE）", thanks, "{name} {title} {date} が申込者の名前・セミナー名・日時に置き換わります。"),
        h("div", {}, h("label", {}, "リマインド（LINE）"), remindersBox),
      ),
      footer: [
        h("button", { class: "ghost", type: "button", onClick: () => dialog.close() }, "キャンセル"),
        h("button", { type: "button", onClick: (event) => guard(event.currentTarget, async () => {
          await api("seminars:save", { ...seminar, title: title.value, description: description.value, liffId: liffId.value.trim() || null, thanksMessage: thanks.value, enabled });
          dialog.close();
          toast("セミナーを保存しました。");
          IGUP.rerender();
        }) }, "保存"),
      ],
    });
  }

  async function openQr(seminar) {
    const dataUrl = await api("seminars:qr", { text: seminar.publicUrl });
    const dialog = openModal({
      title: "申込ページのQRコード",
      body: h("div", { class: "stack", style: { alignItems: "center" } },
        h("img", { class: "qr", src: dataUrl, alt: "QRコード" }),
        h("code", {}, seminar.publicUrl),
        h("p", { class: "hint" }, "画像を右クリックで保存するか、URLをコピーしてストーリーズ・プロフィール・チラシに貼ってください。"),
      ),
      footer: [h("button", { class: "secondary", type: "button", onClick: () => copyText(seminar.publicUrl) }, "URLをコピー"), h("button", { type: "button", onClick: () => dialog.close() }, "閉じる")],
    });
  }

  function openApplications(seminar) {
    const dateOf = (id) => seminar.dates.find((date) => date.id === id);
    const dialog = openModal({
      title: `申込一覧: ${seminar.title}`,
      wide: true,
      body: seminar.applications.length === 0 ? h("div", { class: "empty" }, "申込はまだありません。") :
        h("div", { class: "table-wrap" }, h("table", {},
          h("thead", {}, h("tr", {}, h("th", {}, "日程"), h("th", {}, "名前"), h("th", {}, "メール"), h("th", {}, "LINE"), h("th", {}, "申込日時"), h("th", {}, "お礼"), h("th", {}, "リマインド"))),
          h("tbody", {}, [...seminar.applications].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((application) => h("tr", {},
            h("td", {}, fmt.dateTime(dateOf(application.dateId)?.startsAt)),
            h("td", {}, application.name),
            h("td", {}, application.email ?? "—"),
            h("td", {}, application.lineUserId ? badge("連携済み", "ok") : badge("なし")),
            h("td", {}, fmt.dateTime(application.createdAt)),
            h("td", {}, application.thanksSentAt ? badge("送信済み", "ok") : application.lineUserId ? badge("未送信", "warn") : "—"),
            h("td", {}, `${application.remindersSent.length} / ${seminar.reminders.length}`),
          ))),
        )),
      footer: [h("button", { type: "button", onClick: () => dialog.close() }, "閉じる")],
    });
  }

  IGUP.views.seminars = {
    title: "セミナー",
    icon: "◫",
    async render(container) {
      const [seminars, status] = await Promise.all([api("seminars:list"), api("connection:status")]);
      const caps = status.broker.capabilities;
      replace(container,
        pageHead("LINEセミナー連携", "申込ページを公開し、申込があったらLINEでお礼を送り、開始前にリマインドします。",
          h("button", { class: "secondary", type: "button", onClick: (event) => guard(event.currentTarget, async () => { await api("seminars:sync"); toast("申込状況を取得しました。"); IGUP.rerender(); }) }, "申込を同期"),
          h("button", { type: "button", onClick: () => openEditor(null) }, "＋ セミナーを作成")),
        !status.line.configured ? h("p", { class: "small", style: { color: "var(--warn)" } }, "LINE公式アカウントが未設定です。接続画面でチャネルアクセストークンを設定すると、お礼・リマインドを自動送信できます。") : null,
        caps && !caps.seminars ? h("p", { class: "small", style: { color: "var(--warn)" } }, "ブローカーに公開URL（PUBLIC_BASE_URL）が設定されていないため、申込ページを公開できません。") : null,
        seminars.length === 0 ? h("div", { class: "empty" }, "セミナーはまだありません。") :
          h("div", { class: "list" }, seminars.map((seminar) => h("div", { class: `item${seminar.enabled ? "" : " disabled"}` },
            h("div", { class: "body" },
              h("div", { class: "row" }, h("span", { class: "title" }, seminar.title), accounts().length > 1 && seminar.accountId ? badge(accountName(seminar.accountId), "accent") : null, seminar.enabled ? badge("受付中", "ok") : badge("停止中"), badge(`申込 ${seminar.applications.length}`, "info")),
              h("div", { class: "meta" }, seminar.dates.map((date) => `${fmt.dateTime(date.startsAt)}${date.capacity ? `（定員${date.capacity}）` : ""}`).join(" / ")),
              seminar.publicUrl ? h("div", { class: "row" }, h("code", {}, seminar.publicUrl), h("button", { class: "ghost small", type: "button", onClick: () => copyText(seminar.publicUrl) }, "コピー"), h("button", { class: "ghost small", type: "button", onClick: () => openExternal(seminar.publicUrl) }, "開く"), h("button", { class: "ghost small", type: "button", onClick: (event) => guard(event.currentTarget, () => openQr(seminar)) }, "QR")) : h("div", { class: "meta" }, "申込ページは未公開です（保存時にブローカーへ公開されます）。"),
            ),
            h("div", { class: "row" },
              h("button", { class: "ghost small", type: "button", onClick: () => openApplications(seminar) }, "申込一覧"),
              h("button", { class: "ghost small", type: "button", onClick: () => openEditor(seminar) }, "編集"),
              h("button", { class: "ghost small danger", type: "button", onClick: async (event) => { if (await confirmDialog(`「${seminar.title}」を削除しますか？申込ページも公開停止になります。`, { danger: true, okLabel: "削除" })) await guard(event.currentTarget, async () => { await api("seminars:delete", { id: seminar.id }); IGUP.rerender(); }); } }, "削除"),
            ),
          ))),
      );
    },
  };
})();
