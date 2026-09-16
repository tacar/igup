/* Scheduled posts: list + editor (feed image / carousel / reel / story / Threads). */
(() => {
  const { api, h, replace, fmt, pageHead, badge, guard, field, confirmDialog, openModal, toast, fail, toLocalInput, fromLocalInput, POST_KIND, POST_STATUS, openExternal } = IGUP;
  const previewCache = new Map();
  const FILTERS = [
    { key: "active", label: "予約中・投稿中", test: (post) => post.status === "scheduled" || post.status === "publishing" },
    { key: "attention", label: "失敗・未投稿", test: (post) => post.status === "failed" || post.status === "missed" },
    { key: "published", label: "投稿済み", test: (post) => post.status === "published" },
    { key: "all", label: "すべて", test: () => true },
  ];
  let filter = "active";

  async function preview(asset) {
    if (asset.kind === "video") return null;
    if (previewCache.has(asset.id)) return previewCache.get(asset.id);
    const url = await api("media:preview", { asset }).catch(() => null);
    previewCache.set(asset.id, url);
    return url;
  }

  function isImage(name) { return /\.(jpe?g|png)$/i.test(name); }
  function isVideo(name) { return /\.(mp4|mov|m4v)$/i.test(name); }

  /** Imports files (paths) into the app's media folder, converting PNG to JPEG for Instagram. */
  async function importPaths(paths, { accept = "media", convertPng = true } = {}) {
    const wanted = paths.filter((path) => (accept === "image" ? isImage(path) : accept === "video" ? isVideo(path) : isImage(path) || isVideo(path)));
    if (wanted.length === 0) { toast("対応していないファイルです（JPEG / PNG / MP4 / MOV）。", true); return []; }
    const assets = await api("media:import", { paths: wanted });
    const result = [];
    for (const asset of assets) {
      if (convertPng && /\.png$/i.test(asset.fileName)) {
        const url = await preview(asset);
        if (url) { result.push(await IGUP.mediaEditor.convertToJpeg(asset, url)); continue; }
      }
      result.push(asset);
    }
    return result;
  }

  /** Drag & drop + file picker. onFiles(assets[]) */
  function dropzone(label, { accept = "media", onFiles, hint }) {
    const zone = h("div", { class: "dropzone" },
      h("div", {}, label),
      hint ? h("div", { class: "small", style: { marginTop: "4px" } }, hint) : null,
      h("div", { class: "row", style: { justifyContent: "center", marginTop: "10px" } },
        h("button", { class: "secondary small", type: "button", onClick: (event) => guard(event.currentTarget, async () => {
          const paths = await api("app:pickFiles", { kind: accept });
          if (paths.length) onFiles(await importPaths(paths, { accept }));
        }) }, "ファイルを選ぶ")),
    );
    zone.addEventListener("dragover", (event) => { event.preventDefault(); zone.classList.add("over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("over"));
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      zone.classList.remove("over");
      const paths = [...event.dataTransfer.files].map((file) => window.igup.pathForFile(file)).filter(Boolean);
      guard(null, async () => { if (paths.length) onFiles(await importPaths(paths, { accept })); });
    });
    return zone;
  }

  /** Renders an editable media grid bound to `list` (array of MediaAsset). Calls onChange() after edits. */
  function mediaGrid(list, { onChange, allowCrop = true, aspect = "1:1", max = 10 }) {
    const grid = h("div", { class: "media-grid" });
    function render() {
      replace(grid, list.map((asset, index) => {
        const img = asset.kind === "video" ? h("div", { class: "video-ph" }, "▶") : h("img", { alt: asset.fileName });
        if (asset.kind !== "video") preview(asset).then((url) => { if (url) img.src = url; });
        return h("div", { class: "media-tile" },
          img,
          list.length > 1 ? h("span", { class: "order" }, String(index + 1)) : null,
          h("div", { class: "tools" },
            h("button", { class: "ghost", type: "button", disabled: index === 0, title: "前へ", onClick: () => { [list[index - 1], list[index]] = [list[index], list[index - 1]]; render(); onChange?.(); } }, "←"),
            asset.kind === "image" && allowCrop ? h("button", { class: "ghost", type: "button", onClick: (event) => guard(event.currentTarget, async () => {
              const url = await preview(asset);
              if (!url) throw new Error("プレビューを作成できません。");
              const edited = await IGUP.mediaEditor.cropImage(asset, url, { defaultAspect: aspect });
              if (edited) { list[index] = edited; render(); onChange?.(); }
            }) }, "切抜") : null,
            h("button", { class: "ghost", type: "button", onClick: () => { list.splice(index, 1); render(); onChange?.(); } }, "削除"),
            h("button", { class: "ghost", type: "button", disabled: index === list.length - 1, title: "後へ", onClick: () => { [list[index + 1], list[index]] = [list[index], list[index + 1]]; render(); onChange?.(); } }, "→"),
          ),
          h("div", { class: "name", title: asset.fileName }, `${asset.fileName}${asset.size ? ` · ${fmt.bytes(asset.size)}` : ""}`),
        );
      }));
      grid.hidden = list.length === 0;
    }
    render();
    return { el: grid, render, canAdd: () => list.length < max };
  }

  const KIND_HELP = {
    image: "JPEG画像1枚。PNGは自動でJPEGに変換されます。推奨比率は 1:1 / 4:5 / 1.91:1。",
    carousel: "画像・動画を2〜10枚。並び順はタイルの矢印で変更できます。",
    reel: "動画1本（MP4 / MOV、最長15分）。動画はこのPCからInstagramへ直接アップロードされ、サーバーには保存されません。表紙画像は任意です。",
    story: "画像または動画を1つ。ストーリーズは24時間で消えます（インサイトは消える前に自動保存されます）。",
    threads: "本文は各500文字まで。2つ目以降の項目は前の投稿への返信（ツリー投稿）として公開されます。1項目に画像・動画を2〜20枚入れるとカルーセルになります。",
  };

  async function openEditor(existing, { publishNow = false, defaults = {} } = {}) {
    const [rules, settings] = await Promise.all([api("rules:list"), api("settings:get")]);
    const post = existing ? structuredClone(existing) : { kind: "image", scheduledAt: null, caption: "", media: [], cover: null, shareToFeed: true, threads: [{ text: "", media: [] }], attachRuleId: null, ...defaults };
    if (post.threads.length === 0) post.threads.push({ text: "", media: [] });
    const kindSelect = h("select", { value: post.kind }, Object.entries(POST_KIND).map(([key, meta]) => h("option", { value: key }, meta.label)));
    const when = h("input", { type: "datetime-local", value: toLocalInput(post.scheduledAt) });
    const caption = h("textarea", { rows: 6, placeholder: "キャプション（ハッシュタグもここに）", value: post.caption });
    const captionCount = h("span", { class: "hint" });
    caption.addEventListener("input", () => { captionCount.textContent = `${caption.value.length} / 2,200文字`; });
    captionCount.textContent = `${caption.value.length} / 2,200文字`;
    const shareToFeed = h("input", { type: "checkbox", checked: post.shareToFeed });
    const attachSelect = h("select", { value: post.attachRuleId ?? "" }, h("option", { value: "" }, "紐づけない"), rules.map((rule) => h("option", { value: rule.id }, rule.name)));
    const mediaBox = h("div", { class: "stack" });
    const help = h("p", { class: "hint" });

    function renderMedia() {
      const kind = kindSelect.value;
      help.textContent = KIND_HELP[kind];
      const parts = [];
      if (kind === "threads") {
        post.threads.forEach((item, index) => {
          const text = h("textarea", { rows: 3, placeholder: index === 0 ? "最初の投稿の本文" : "返信（ツリー）の本文", value: item.text, maxlength: 500 });
          const counter = h("span", { class: "hint" }, `${item.text.length} / 500`);
          text.addEventListener("input", () => { item.text = text.value; counter.textContent = `${item.text.length} / 500`; });
          const grid = mediaGrid(item.media, { aspect: "1:1", max: 20 });
          parts.push(h("div", { class: "card", style: { padding: "12px" } },
            h("div", { class: "row between" }, h("strong", {}, index === 0 ? "投稿 1（親）" : `返信 ${index}`), post.threads.length > 1 ? h("button", { class: "ghost small", type: "button", onClick: () => { post.threads.splice(index, 1); renderMedia(); } }, "この項目を削除") : null),
            text, counter,
            grid.el,
            item.media.length < 20 ? dropzone("画像・動画をここにドロップ", { onFiles: (assets) => { item.media.push(...assets.slice(0, 20 - item.media.length)); renderMedia(); } }) : null,
          ));
        });
        parts.push(h("button", { class: "secondary small", type: "button", onClick: () => { post.threads.push({ text: "", media: [] }); renderMedia(); } }, "＋ 返信を追加（ツリー投稿）"));
      } else {
        const accept = kind === "image" ? "image" : kind === "reel" ? "video" : "media";
        const max = kind === "carousel" ? 10 : 1;
        const aspect = kind === "story" ? "9:16" : kind === "image" ? "1:1" : "4:5";
        const grid = mediaGrid(post.media, { aspect, max });
        parts.push(grid.el);
        if (post.media.length < max) parts.push(dropzone(kind === "carousel" ? "画像・動画をここにドロップ（2〜10枚）" : kind === "reel" ? "動画をここにドロップ" : "ファイルをここにドロップ", { accept, onFiles: (assets) => { post.media.push(...assets.slice(0, max - post.media.length)); renderMedia(); } }));
        if (kind === "reel") {
          const coverList = post.cover ? [post.cover] : [];
          const coverGrid = mediaGrid(coverList, { aspect: "9:16", max: 1, onChange: () => { post.cover = coverList[0] ?? null; } });
          parts.push(h("div", {}, h("label", {}, "リール表紙（任意・JPEG推奨 9:16）"), coverGrid.el, !post.cover ? dropzone("表紙画像をドロップ", { accept: "image", onFiles: (assets) => { post.cover = assets[0] ?? null; renderMedia(); } }) : null));
          parts.push(h("label", { class: "inline" }, shareToFeed, " フィードにも表示する"));
        }
        if (kind !== "story") parts.push(field("キャプション", caption), captionCount,
          settings.defaultCaption ? h("button", { class: "ghost small", type: "button", onClick: () => { caption.value = caption.value ? `${caption.value}\n\n${settings.defaultCaption}` : settings.defaultCaption; caption.dispatchEvent(new Event("input")); } }, "デフォルトキャプションを挿入") : null);
        if (kind !== "story") parts.push(field("投稿後に自動返信ルールへ紐づけ", attachSelect, "公開後、この投稿のIDを選んだルールの対象投稿に自動で追加します（「次のリールにも同じ自動返信」に便利）。"));
      }
      replace(mediaBox, parts);
    }
    kindSelect.addEventListener("change", () => { post.kind = kindSelect.value; renderMedia(); });
    renderMedia();

    function collect() {
      const scheduledAt = fromLocalInput(when.value);
      if (!scheduledAt) throw new Error("投稿日時を入力してください。");
      return {
        ...(post.id ? { id: post.id } : {}),
        kind: kindSelect.value,
        scheduledAt,
        caption: caption.value,
        media: post.media,
        cover: kindSelect.value === "reel" ? post.cover : null,
        shareToFeed: shareToFeed.checked,
        threads: kindSelect.value === "threads" ? post.threads : [],
        attachRuleId: attachSelect.value || null,
      };
    }

    const dialog = openModal({
      title: post.id ? "予約投稿を編集" : "投稿を予約",
      wide: true,
      body: h("div", { class: "stack" },
        h("div", { class: "grid cols-2" }, field("投稿の種類", kindSelect), field("投稿日時", when, "この時刻にアプリが起動していれば自動投稿します。")),
        help,
        mediaBox,
      ),
      footer: [
        h("button", { class: "ghost", type: "button", onClick: () => dialog.close() }, "キャンセル"),
        h("button", { class: "secondary", type: "button", onClick: (event) => guard(event.currentTarget, async () => {
          const saved = await api("posts:save", collect());
          await api("posts:publishNow", { id: saved.id }).catch(fail);
          dialog.close();
          toast("投稿を開始しました。");
          IGUP.rerender();
        }) }, "保存して今すぐ投稿"),
        h("button", { type: "button", onClick: (event) => guard(event.currentTarget, async () => {
          await api("posts:save", collect());
          dialog.close();
          toast("予約を保存しました。");
          IGUP.rerender();
        }) }, post.id ? "保存" : "予約する"),
      ],
    });
    if (publishNow) dialog.modal.querySelector(".secondary").focus();
  }

  function snippet(post) {
    const text = post.kind === "threads" ? post.threads[0]?.text ?? "" : post.caption;
    return text.trim().split("\n")[0].slice(0, 60) || `${POST_KIND[post.kind].label}（本文なし）`;
  }

  IGUP.views.posts = {
    title: "予約投稿",
    icon: "▤",
    async render(container, params) {
      const posts = await api("posts:list");
      const active = FILTERS.find((item) => item.key === filter) ?? FILTERS[0];
      const visible = posts.filter(active.test).sort((a, b) => (active.key === "published" ? b.scheduledAt.localeCompare(a.scheduledAt) : a.scheduledAt.localeCompare(b.scheduledAt)));
      const counts = Object.fromEntries(FILTERS.map((item) => [item.key, posts.filter(item.test).length]));

      replace(container,
        pageHead("予約投稿", "フィード・カルーセル・リール・ストーリーズ・Threadsを予約して自動投稿します。", h("button", { type: "button", onClick: () => openEditor(null) }, "＋ 投稿を予約")),
        h("div", { class: "subtabs" }, FILTERS.map((item) => h("button", { type: "button", class: item.key === filter ? "active" : "", onClick: () => { filter = item.key; IGUP.rerender(); } }, `${item.label}（${counts[item.key]}）`))),
        visible.length === 0 ? h("div", { class: "empty" }, "該当する投稿はありません。") :
          h("div", { class: "list" }, visible.map((post) => {
            const thumb = post.kind === "threads" ? null : (post.media[0] ?? post.cover);
            const img = thumb && thumb.kind === "image" ? h("img", { class: "thumb", alt: "" }) : h("div", { class: "thumb video-ph" }, post.kind === "threads" ? "T" : "▶");
            if (thumb && thumb.kind === "image") preview(thumb).then((url) => { if (url) img.src = url; });
            const editable = post.status !== "publishing";
            return h("div", { class: "item" },
              img,
              h("div", { class: "body" },
                h("div", { class: "row" }, h("span", { class: "chip", style: { background: POST_KIND[post.kind].color } }, POST_KIND[post.kind].label), h("span", { class: "title" }, snippet(post))),
                h("div", { class: "meta" }, `${fmt.dateTime(post.scheduledAt)}（${fmt.relative(post.scheduledAt)}）`, post.kind === "threads" ? ` · ${post.threads.length}項目` : ` · メディア${post.media.length}件`, post.attempts ? ` · 試行${post.attempts}回` : ""),
                post.error ? h("div", { class: "small", style: { color: "var(--danger)" } }, post.error) : null,
                post.status === "publishing" ? h("div", { class: "progress", dataset: { progress: post.id } }, "投稿中…") : null,
              ),
              badge(POST_STATUS[post.status].label, POST_STATUS[post.status].cls),
              h("div", { class: "row" },
                post.permalink ? h("button", { class: "ghost small", type: "button", onClick: () => openExternal(post.permalink) }, "開く") : null,
                editable && post.status !== "published" ? h("button", { class: "secondary small", type: "button", onClick: (event) => guard(event.currentTarget, async () => { await api("posts:publishNow", { id: post.id }); toast("投稿を開始しました。"); IGUP.rerender(); }) }, post.status === "failed" || post.status === "missed" ? "再試行" : "今すぐ投稿") : null,
                editable ? h("button", { class: "ghost small", type: "button", onClick: () => openEditor(post) }, "編集") : null,
                post.status === "scheduled" ? h("button", { class: "ghost small", type: "button", onClick: (event) => guard(event.currentTarget, async () => { await api("posts:cancel", { id: post.id }); IGUP.rerender(); }) }, "取消") : null,
                editable ? h("button", { class: "ghost small danger", type: "button", onClick: async (event) => { if (await confirmDialog("この投稿を削除しますか？", { danger: true, okLabel: "削除" })) await guard(event.currentTarget, async () => { await api("posts:delete", { id: post.id }); IGUP.rerender(); }); } }, "削除") : null,
              ),
            );
          })),
      );
      if (params.create) { IGUP.state.params = {}; void openEditor(null); }
      if (params.edit) { IGUP.state.params = {}; const post = posts.find((item) => item.id === params.edit); if (post) void openEditor(post); }
    },
  };
  IGUP.posts = { openEditor, dropzone, mediaGrid, preview };
})();
