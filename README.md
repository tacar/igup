# IGUP

Instagram（＋Threads・LINE）の運用を1台のPCだけで回すためのデスクトップアプリです。キーワード自動返信、予約投稿、計測、LINEセミナー集客までをカバーします。すべての自動化・スケジューリングはこのPC上で動作し、外部のクラウドサービスにデータを預けません。

## できること

- **キーワード自動返信** — コメント・DM・ストーリーズ返信・ライブ配信コメントに反応し、公開返信（最大3パターンからランダム選択）とDMを自動送信
- **リンク付きボタン** — DMにWebリンクボタン、または他の自動返信ルールへつながる選択式ボタン（最大3つ）・クイックリプライ（最大13個）を添付
- **メッセージ連鎖** — ボタンやクイックリプライをタップすると、別のルールのDMが続けて送られる「会話の枝分かれ」を作成
- **時間差送信（フォローアップ）** — 最初のDMの後、指定時間後に追加メッセージを自動送信（Instagramの24時間メッセージウィンドウの範囲内）
- **予約投稿** — フィード画像・カルーセル（2〜10枚）・リール（動画＋任意の表紙画像）・ストーリーズを日時指定で自動投稿。投稿したメディアに自動返信ルールを紐づけ可能
- **Threads予約投稿** — ツリー投稿（複数投稿の連結）・カルーセル（最大20枚）に対応
- **カレンダー管理** — 予約投稿とメモを月表示。メモは色分けして予定を整理
- **画像アップロード＆切り抜き** — ドラッグ＆ドロップで取り込み、投稿種別ごとの推奨比率でクロップ・並び替え。PNGは自動でJPEGへ変換
- **タップ分析** — DMのボタン・クイックリプライについて、届いた数・見られた数・押された数を記録
- **計測リンク** — 短縮リンクを発行し、クリック数を媒体別・日別・ランキングで集計
- **投稿インサイト** — 投稿ごとの反応をTop10表示、フォロワー・リーチ推移グラフ、24時間で消えるストーリーズの数値も消滅前に保存
- **LINEセミナー連携** — 申込ページを公開し、申込者にLINEでお礼メッセージと複数回のリマインドを自動送信。日程は複数設定可、申込ページのQRコードも発行
- **送受信ログ** — 受信・送信・投稿・分析・セミナー・リンクの記録をカテゴリ別に確認
- **画面カラー変更** — テーマ（ライト／ダーク／OS設定）とアクセントカラーを変更可能
- **ローカルAPI（AIツール連携）** — Claude CodeなどのAIツールから、投稿の予約やルール作成、分析の取得を画面操作なしで行えるHTTPインターフェース（既定では無効）

より詳しい説明は [`docs/overview.html`](docs/overview.html)、画面ごとの操作方法は [`docs/usage.html`](docs/usage.html)、AIツール連携のAPI仕様は [`docs/ai-integration.md`](docs/ai-integration.md) を参照してください。

## 構成

- `apps/desktop` — Electron製デスクトップアプリ。自動返信・予約投稿・分析・セミナー管理などすべての機能はここで動作します（「頭脳」）
- `apps/broker` — 公開ホストに立てる小さな中継サーバー（「窓口」）。Meta/ThreadsのOAuthコード交換、Webhookの受信とオーナーごとのイベントキュー、画像の一時公開（動画は扱いません）、計測リンク、セミナー申込ページを担当します

ブローカーはアクセストークンを保持しません。OAuth交換結果は最大5分だけメモリに置かれ、デスクトップアプリが一度きりのコードで取り出した後に破棄されます。取り出したアクセストークンはOSの暗号化機能（Electron `safeStorage`）でこのPCにだけ保存されます。

## 必要なもの

- Node.js 22以上
- Instagramプロアカウント（ビジネスまたはクリエイター）
- Meta開発者アカウントとMetaアプリ（Instagram API with Instagram Loginを有効化）
- ブローカーを動かす公開HTTPSホスト（自宅サーバーやVPSなど。Meta/ThreadsのOAuthコールバックとWebhookは公開URLが必要です）
- （任意）Threadsも使う場合はThreads APIの利用設定を追加したMetaアプリ
- （任意）LINEセミナー連携を使う場合はLINE公式アカウントとMessaging APIチャネル

## セットアップ

### 1. インストール

```sh
npm install
```

### 2. Metaアプリを用意する

Meta for Developersでアプリを作成し、「Instagram API with Instagram Login」プロダクトを追加して、次の権限を申請します。

- `instagram_business_basic`
- `instagram_business_content_publish`
- `instagram_business_manage_messages`
- `instagram_business_manage_comments`
- `instagram_business_manage_insights`

Metaアプリに登録するリダイレクトURIは、ブローカーを立てる公開HTTPSホストの次のURLです。

```text
https://YOUR_BROKER_HOST/oauth/callback
```

自分のアカウントだけで使う間はテスターとして自分を追加すれば審査なしで利用できます。第三者に配布・公開する場合はMetaのアプリレビューとBusiness Verificationが必要です。プライバシーポリシーの連絡先は、デスクトップアプリの「設定」画面で入力できます。

### 3. ブローカーを起動する

ブローカーは環境変数で設定します。**秘密値（Meta App Secret など）をファイルへ保存しないでください。** シェルの環境変数や、OSのシークレット管理機能から渡してください。

必須の環境変数:

| 変数名 | 内容 |
| --- | --- |
| `META_APP_ID` | MetaアプリのApp ID |
| `META_APP_SECRET` | MetaアプリのApp Secret（このプロセスの外に出しません） |
| `META_REDIRECT_URI` | 上記で登録したコールバックURL（`https://YOUR_BROKER_HOST/oauth/callback`） |

任意の環境変数（省略時は既定値が使われます）:

| 変数名 | 既定値 | 内容 |
| --- | --- | --- |
| `META_SCOPES` | `instagram_business_basic,instagram_business_content_publish,instagram_business_manage_messages,instagram_business_manage_comments,instagram_business_manage_insights` | OAuthで要求する権限 |
| `PORT` | `8787` | ブローカーの待受ポート |
| `DESKTOP_ORIGIN` | `http://127.0.0.1:42813` | デスクトップアプリからのCORSを許可するオリジン |
| `META_GRAPH_VERSION` | `v23.0` | 使用するGraph APIのバージョン |
| `THREADS_APP_ID` / `THREADS_APP_SECRET` | なし | 両方設定するとThreads連携が有効になります（任意） |
| `THREADS_REDIRECT_URI` | `META_REDIRECT_URI`と同じ | Threads用コールバックURLを分ける場合に指定 |
| `THREADS_SCOPES` | `threads_basic,threads_content_publish` | Threads OAuthで要求する権限 |
| `META_WEBHOOK_VERIFY_TOKEN` | なし | Webhook検証トークン。設定するとコメント・DMを即時受信できます（未設定でも定期確認で動作） |
| `BROKER_DATA_DIR` | `./data` | リンク・セミナー申込・イベントキュー・一時メディアの保存先 |
| `PUBLIC_BASE_URL` | リクエストから自動判定 | 計測リンクやセミナー申込ページのURLを固定したい場合に指定（例: `https://YOUR_BROKER_HOST`） |
| `MEDIA_MAX_MB` | `100` | 一時公開する画像の最大サイズ（MB） |
| `MEDIA_TTL_HOURS` | `24` | 一時公開した画像を自動削除するまでの時間 |
| `EVENT_TTL_HOURS` | `24` | Webhookイベントキューの保持時間 |
| `BROKER_TIMEZONE` | `Asia/Tokyo` | 日別集計・カレンダー表示に使うタイムゾーン（IANA名） |
| `TRUST_PROXY` | `1` | リバースプロキシ経由で動かす場合のホップ数（`true`/`false`も可） |

```sh
META_APP_ID=YOUR_APP_ID \
META_APP_SECRET=YOUR_APP_SECRET \
META_REDIRECT_URI=https://YOUR_BROKER_HOST/oauth/callback \
npm run dev:broker
```

本番運用では `npm run build -w @igup/broker && npm run start -w @igup/broker` でビルド済みのものを起動してください。

### 4. Webhookを登録する（推奨・任意）

`META_WEBHOOK_VERIFY_TOKEN` を設定した状態でブローカーを起動し、Metaアプリのダッシュボードで Instagram > Webhooks に次のURLを登録します。

```text
https://YOUR_BROKER_HOST/webhooks/instagram
```

検証トークンには `META_WEBHOOK_VERIFY_TOKEN` と同じ値を使います。登録するとコメント・DMを即時受信できます。未登録でもデスクトップアプリが定期的にAPIを確認するポーリング方式で動作します（設定画面で間隔を調整可能）。

### 5. デスクトップアプリを起動する

```sh
IGUP_BROKER_URL=https://YOUR_BROKER_HOST npm run dev:desktop
```

ローカルのブローカーで試す場合は既定値（`http://127.0.0.1:8787`）のまま起動できますが、実際にInstagram/ThreadsのOAuthとWebhookを通すには、ブローカーが公開HTTPSで到達できる必要があります（開発用トンネルなどを利用してください）。

起動後、「接続」画面からInstagramに接続します。プロアカウントの認可が完了するとバッジが「接続済み」に変わり、以降の自動返信・予約投稿・分析取得が行えるようになります。

### 6. Threadsを使う場合（任意）

ブローカーに `THREADS_APP_ID` / `THREADS_APP_SECRET` を設定して再起動すると、「接続」画面のThreadsカードから接続できるようになります。未設定のままだとThreadsカードのボタンは無効表示のままです。

### 7. LINEセミナー連携を使う場合（任意）

LINE Developersコンソールで Messaging API チャネルを作成し、発行した「チャネルアクセストークン（長期）」をデスクトップアプリの「接続」画面に貼り付けます。ブローカー側の設定は不要です。トークンはこのPCに暗号化保存され、外部には送信されません（LINEのAPIへ直接送る場合を除く）。

## AIツールから操作する

デスクトップアプリの「設定」画面でローカルAPIを有効にすると、このPC上（`127.0.0.1`）だけで待ち受けるHTTP APIが起動し、Claude CodeなどのAIツールから画面操作なしで投稿予約・ルール作成・分析取得などができます。既定では無効です。トークンと全エンドポイントの一覧は [`docs/ai-integration.md`](docs/ai-integration.md) を参照してください。

## セキュリティ

- Meta/ThreadsのApp Secretはブローカーの環境変数にのみ置かれ、デスクトップアプリやファイルには一切保存されません。
- ブローカーはアクセストークンを保持しません。OAuth交換結果は最大5分だけメモリに置かれ、一度きりのコードで引き渡した後に破棄されます。
- アクセストークン・LINEチャネルトークン・ローカルAPIのトークンは、いずれもOSの暗号化機能（Electron `safeStorage`）でこのPCにだけ保存されます。
- ローカルAPIは `127.0.0.1` にのみバインドし、外部ネットワークからは到達できません。
- 動画はこのPCからInstagramへ直接アップロードされ、ブローカーには保存されません。画像はブローカーに一時公開されますが、既定24時間で自動削除されます。
- IGUPはこのPCでだけ動くアプリで、独自のログインIDやパスワードを持ちません。2段階認証はInstagram / Threads / LINE それぞれのサービス側の設定がそのまま適用されます。

## 開発

```sh
npm run typecheck
npm test
npm run build
```

各ワークスペースを個別に実行する場合は `npm run <script> -w @igup/desktop` / `-w @igup/broker` を使います。
