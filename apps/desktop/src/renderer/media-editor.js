/* Image crop / convert modal. Everything happens on this PC; the result is saved as JPEG via media:saveEdited. */
(() => {
  const { h, replace, openModal, api, toast, fail } = IGUP;
  const ASPECTS = [
    { key: "1:1", label: "正方形 1:1", ratio: 1 },
    { key: "4:5", label: "縦長 4:5", ratio: 4 / 5 },
    { key: "1.91:1", label: "横長 1.91:1", ratio: 1.91 },
    { key: "9:16", label: "リール/ストーリーズ 9:16", ratio: 9 / 16 },
    { key: "free", label: "自由", ratio: null },
  ];
  const OUTPUT_LONG_EDGE = 1440;

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("画像を読み込めませんでした。"));
      image.src = src;
    });
  }

  /**
   * Opens the crop editor for an asset (needs a preview data URL) and resolves with the new MediaAsset, or null when canceled.
   */
  async function cropImage(asset, previewUrl, { defaultAspect = "1:1" } = {}) {
    const image = await loadImage(previewUrl);
    return new Promise((resolve) => {
      let done = false;
      let aspect = ASPECTS.find((item) => item.key === defaultAspect) ?? ASPECTS[0];
      const canvas = h("canvas");
      const stage = h("div", { class: "crop-stage" }, canvas);
      // crop rectangle in image pixel coordinates
      let crop = fitCrop(image.width, image.height, aspect.ratio);
      let drag = null;

      function fitCrop(width, height, ratio) {
        if (!ratio) return { x: 0, y: 0, w: width, h: height };
        let w = width, hh = width / ratio;
        if (hh > height) { hh = height; w = height * ratio; }
        return { x: (width - w) / 2, y: (height - hh) / 2, w, h: hh };
      }

      function viewTransform() {
        const rect = stage.getBoundingClientRect();
        const scale = Math.min(rect.width / image.width, rect.height / image.height);
        return { scale, ox: (rect.width - image.width * scale) / 2, oy: (rect.height - image.height * scale) / 2, width: rect.width, height: rect.height };
      }

      function draw() {
        const t = viewTransform();
        const ratio = window.devicePixelRatio || 1;
        canvas.width = t.width * ratio;
        canvas.height = t.height * ratio;
        const ctx = canvas.getContext("2d");
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.fillStyle = "#111";
        ctx.fillRect(0, 0, t.width, t.height);
        ctx.drawImage(image, t.ox, t.oy, image.width * t.scale, image.height * t.scale);
        ctx.fillStyle = "rgba(0,0,0,.55)";
        const cx = t.ox + crop.x * t.scale, cy = t.oy + crop.y * t.scale, cw = crop.w * t.scale, ch = crop.h * t.scale;
        ctx.fillRect(t.ox, t.oy, image.width * t.scale, cy - t.oy);
        ctx.fillRect(t.ox, cy + ch, image.width * t.scale, t.oy + image.height * t.scale - (cy + ch));
        ctx.fillRect(t.ox, cy, cx - t.ox, ch);
        ctx.fillRect(cx + cw, cy, t.ox + image.width * t.scale - (cx + cw), ch);
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(cx + 0.5, cy + 0.5, cw - 1, ch - 1);
        ctx.strokeStyle = "rgba(255,255,255,.35)";
        for (let i = 1; i < 3; i += 1) {
          ctx.beginPath(); ctx.moveTo(cx + (cw * i) / 3, cy); ctx.lineTo(cx + (cw * i) / 3, cy + ch); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(cx, cy + (ch * i) / 3); ctx.lineTo(cx + cw, cy + (ch * i) / 3); ctx.stroke();
        }
        ctx.fillStyle = "#fff";
        ctx.fillRect(cx + cw - 12, cy + ch - 12, 12, 12);
        sizeLabel.textContent = `${Math.round(crop.w)} × ${Math.round(crop.h)} px（元画像 ${image.width} × ${image.height}）`;
      }

      function clampCrop() {
        crop.w = Math.max(32, Math.min(crop.w, image.width));
        crop.h = Math.max(32, Math.min(crop.h, image.height));
        if (aspect.ratio) {
          if (crop.w / crop.h > aspect.ratio) crop.w = crop.h * aspect.ratio; else crop.h = crop.w / aspect.ratio;
        }
        crop.x = Math.max(0, Math.min(crop.x, image.width - crop.w));
        crop.y = Math.max(0, Math.min(crop.y, image.height - crop.h));
      }

      function pointer(event) {
        const t = viewTransform();
        const rect = stage.getBoundingClientRect();
        return { x: (event.clientX - rect.left - t.ox) / t.scale, y: (event.clientY - rect.top - t.oy) / t.scale };
      }

      stage.addEventListener("pointerdown", (event) => {
        const p = pointer(event);
        const t = viewTransform();
        const handle = Math.abs(p.x - (crop.x + crop.w)) * t.scale < 16 && Math.abs(p.y - (crop.y + crop.h)) * t.scale < 16;
        const inside = p.x >= crop.x && p.x <= crop.x + crop.w && p.y >= crop.y && p.y <= crop.y + crop.h;
        if (!handle && !inside) return;
        drag = { mode: handle ? "resize" : "move", start: p, crop: { ...crop } };
        stage.setPointerCapture(event.pointerId);
      });
      stage.addEventListener("pointermove", (event) => {
        if (!drag) return;
        const p = pointer(event);
        const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
        if (drag.mode === "move") {
          crop.x = drag.crop.x + dx; crop.y = drag.crop.y + dy;
        } else {
          crop.w = drag.crop.w + dx; crop.h = aspect.ratio ? crop.w / aspect.ratio : drag.crop.h + dy;
        }
        clampCrop();
        draw();
      });
      const endDrag = () => { drag = null; };
      stage.addEventListener("pointerup", endDrag);
      stage.addEventListener("pointercancel", endDrag);
      stage.addEventListener("wheel", (event) => {
        event.preventDefault();
        const factor = event.deltaY > 0 ? 1.05 : 0.95;
        const cx = crop.x + crop.w / 2, cy = crop.y + crop.h / 2;
        crop.w *= factor; crop.h *= factor;
        crop.x = cx - crop.w / 2; crop.y = cy - crop.h / 2;
        clampCrop();
        draw();
      }, { passive: false });

      const sizeLabel = h("span", { class: "muted small" });
      const aspectButtons = h("div", { class: "row" }, ASPECTS.map((item) => h("button", {
        type: "button", class: `small ${item.key === aspect.key ? "" : "secondary"}`, dataset: { aspect: item.key },
        onClick: () => {
          aspect = item;
          const cx = crop.x + crop.w / 2, cy = crop.y + crop.h / 2;
          const next = fitCrop(image.width, image.height, item.ratio);
          const scale = Math.min(1, Math.max(crop.w / next.w, crop.h / next.h));
          crop = { w: next.w * scale, h: next.h * scale, x: 0, y: 0 };
          crop.x = cx - crop.w / 2; crop.y = cy - crop.h / 2;
          clampCrop();
          for (const button of aspectButtons.querySelectorAll("button")) button.className = `small ${button.dataset.aspect === item.key ? "" : "secondary"}`;
          draw();
        },
      }, item.label)));
      const quality = h("input", { type: "range", min: "60", max: "95", step: "5", value: "88", style: { width: "140px" } });

      const dialog = openModal({
        title: `切り抜き: ${asset.fileName}`,
        wide: true,
        body: h("div", { class: "stack" },
          aspectButtons,
          stage,
          h("div", { class: "row between" }, sizeLabel, h("label", { class: "inline" }, "JPEG品質 ", quality)),
          h("p", { class: "hint" }, "枠をドラッグで移動、右下の白い角でサイズ変更、ホイールで拡大縮小。保存すると新しいJPEGファイルとしてこのPCに書き出されます（元ファイルは残ります）。"),
        ),
        footer: [
          h("button", { class: "ghost", type: "button", onClick: () => dialog.close() }, "キャンセル"),
          h("button", { type: "button", onClick: async (event) => {
            event.currentTarget.disabled = true;
            try {
              const dataUrl = render(Number(quality.value) / 100);
              const saved = await api("media:saveEdited", { dataUrl, fileName: asset.fileName });
              done = true;
              dialog.close();
              toast("切り抜いた画像を保存しました。");
              resolve(saved);
            } catch (error) {
              fail(error);
              event.currentTarget.disabled = false;
            }
          } }, "この範囲で保存"),
        ],
        onClose: () => { if (!done) resolve(null); },
      });

      function render(qualityValue) {
        const scale = Math.min(1, OUTPUT_LONG_EDGE / Math.max(crop.w, crop.h));
        const out = document.createElement("canvas");
        out.width = Math.round(crop.w * scale);
        out.height = Math.round(crop.h * scale);
        const ctx = out.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.drawImage(image, crop.x, crop.y, crop.w, crop.h, 0, 0, out.width, out.height);
        return out.toDataURL("image/jpeg", qualityValue);
      }

      requestAnimationFrame(() => { draw(); });
      window.addEventListener("resize", draw, { once: false });
      dialog.modal.addEventListener("igup:closed", () => window.removeEventListener("resize", draw));
    });
  }

  /** Converts a PNG asset to JPEG (Instagram accepts JPEG only). Returns the new asset. */
  async function convertToJpeg(asset, previewUrl) {
    const image = await loadImage(previewUrl);
    const out = document.createElement("canvas");
    const scale = Math.min(1, 1920 / Math.max(image.width, image.height));
    out.width = Math.round(image.width * scale);
    out.height = Math.round(image.height * scale);
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(image, 0, 0, out.width, out.height);
    return api("media:saveEdited", { dataUrl: out.toDataURL("image/jpeg", 0.9), fileName: asset.fileName });
  }

  IGUP.mediaEditor = { cropImage, convertToJpeg, ASPECTS };
})();
