# ブローカー デプロイ手順(販売者向け)

IGUP 本体は購入者のPCで動きますが、OAuthの窓口とWebhookの受け口になる **ブローカー** だけは公開HTTPSホストで動かす必要があります。販売者は1台のサーバーを運用し、全購入者がそのURLを設定画面に入力する形になります。

## 構成

```
購入者のPC(IGUP) ─ HTTPS ─ ブローカー(VPS + Docker) ─ HTTPS ─ Meta / LINE
                     ↑ Caddy で TLS 終端
```

## 1. サーバーを用意する

- VPS 1台(最小構成で可。メモリ512MB〜)。OS は何でも良いが、以下は Ubuntu を想定。
- DNS で `broker.example.com`(例)をサーバーのIPに向ける。
- Docker をインストール:

```bash
curl -fsSL https://get.docker.com | sh
```

## 2. コードを置いて .env を書く

リポジトリをサーバーに置き、`apps/broker/` へ移動して `.env` を作成します。

```bash
cd apps/broker
cp /dev/null .env && chmod 600 .env
```

`.env` の内容(必須3つ + 公開URL):

```dotenv
META_APP_ID=1234567890
META_APP_SECRET=xxxxxxxx
META_REDIRECT_URI=https://broker.example.com/oauth/callback
PUBLIC_BASE_URL=https://broker.example.com
# Webhookを使う場合
META_WEBHOOK_VERIFY_TOKEN=好きな文字列
```

各環境変数の詳細はリポジトリ直下の `README.md` の環境変数の表を参照してください。`DESKTOP_ORIGIN` は購入者PC内のコールバック先(デフォルト `http://127.0.0.1:42813`)なので、**変更しないでください**。

## 3. 起動する

```bash
docker compose up -d --build
curl -s http://127.0.0.1:8787/health   # {"status":"ok"} などが返れば起動済み
```

## 4. HTTPS(Caddy)

`/etc/caddy/Caddyfile`:

```
broker.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

```bash
sudo systemctl reload caddy
```

証明書の発行・更新は Caddy が自動で行います(nginx + certbot の場合も、80/443 を 127.0.0.1:8787 にプロキシするだけでOK。`TRUST_PROXY=1` はデフォルトで有効です)。

## 5. Metaアプリ側の設定

[Meta for Developers](https://developers.facebook.com/) のアプリダッシュボードで:

- **Instagram > 認証** にリダイレクトURI: `https://broker.example.com/oauth/callback`
- **Instagram > Webhooks**(使う場合): `https://broker.example.com/webhooks/instagram`、Verifyトークンは `.env` の `META_WEBHOOK_VERIFY_TOKEN`

## 6. 動作確認

```bash
curl -s https://broker.example.com/capabilities
# {"webhooks":true,"threads":...,"publicBaseUrl":"https://broker.example.com",...}
```

このURLを購入者に案内し、IGUPの **設定 > ブローカー接続** に入力してもらいます。

## 運用

- **データ**: アプリ申請・計測リンク・メディアキャッシュは `broker-data` ボリューム(`/data`)に保存されます。バックアップは `docker run --rm -v igup_broker-data:/data -v $PWD:/backup alpine tar czf /backup/broker-data.tgz -C /data .`
- **アップデート**: コードを差し替えて `docker compose up -d --build`(ボリューム内のデータは保持されます)
- **ログ**: `docker compose logs -f`
- シークレット(`META_APP_SECRET` 等)は `.env` のみに置き、リポジトリにコミットしないでください。
