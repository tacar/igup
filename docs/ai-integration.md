# AIツール連携（ローカルAPI）

IGUPデスクトップアプリには、Claude CodeなどのAIツールが画面を操作せずに投稿予約・自動返信ルール作成・分析取得などを行える、小さなローカルHTTP APIが組み込まれています。

## 有効にする

1. デスクトップアプリの「設定」→「ローカルAPI（AI・外部ツール連携）」を開きます。
2. 「ローカルAPIを有効にする」をオンにします（既定はオフ）。
3. 必要であればポート番号を変更します（既定 `42814`）。
4. 「表示」でトークンを確認するか、「コピー」でクリップボードへコピーします。トークンは初回アクセス時に自動生成されます。「再生成」を押すと古いトークンは無効になります。

サーバーは `127.0.0.1`（このPCの中だけ）にバインドされ、外部ネットワークからは到達できません。トークンはOSの暗号化機能でこのPCにだけ保存されます。

## 呼び出し方

すべてのリクエストに `Authorization: Bearer <トークン>` ヘッダーを付けます。ボディはJSON、上限1MBです。

```sh
curl -H "Authorization: Bearer <トークン>" http://127.0.0.1:42814/status
```

トークンが一致しない・欠けている場合は `401` を返します。

## エンドポイント一覧

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/status` | 接続状態（Instagram / Threads / LINE / ブローカー）を取得 |
| GET | `/account` | 接続中のInstagramプロアカウント情報を取得 |
| GET | `/rules` | 自動返信ルールの一覧を取得 |
| POST | `/rules` | 自動返信ルールを新規作成 |
| PUT | `/rules/:id` | 自動返信ルールを更新 |
| DELETE | `/rules/:id` | 自動返信ルールを削除 |
| GET | `/posts` | 予約投稿の一覧を取得 |
| POST | `/posts` | 予約投稿を新規作成 |
| PUT | `/posts/:id` | 予約投稿を更新 |
| DELETE | `/posts/:id` | 予約投稿を削除 |
| POST | `/posts/:id/publish` | 予約投稿を今すぐ公開 |
| POST | `/media/import` | このPC上のファイルパスからメディアを取り込み |
| GET | `/media` | 直近に取り込んだメディアの一覧を取得（`?limit=`） |
| GET | `/memos` | カレンダーメモの一覧を取得 |
| POST | `/memos` | カレンダーメモを新規作成・更新 |
| DELETE | `/memos/:id` | カレンダーメモを削除 |
| GET | `/insights` | 分析サマリー（フォロワー推移・投稿インサイト・タップ分析）を取得 |
| POST | `/insights/capture` | 分析データを今すぐ取得（日次スナップショット＋ストーリーズ） |
| GET | `/links` | 計測リンクの一覧を取得 |
| POST | `/links` | 計測リンクを新規作成 |
| DELETE | `/links/:slug` | 計測リンクを削除 |
| GET | `/seminars` | セミナーの一覧を取得 |
| POST | `/seminars` | セミナーを新規作成・更新 |
| GET | `/logs` | 送受信ログを取得（`?limit=`, `?category=`） |
| GET | `/settings` | 設定を取得 |
| PUT | `/settings` | 設定を更新 |
| POST | `/automation/run` | 自動返信・予約投稿のチェックを今すぐ1回実行 |
| GET | `/export` | ルール・予約・メモ・分析データをJSONで書き出し（秘密情報は含まれません） |

`:id` や `:slug` を含むパスはURLのパラメータとして解釈され、リクエストボディへ自動的にマージされます（例: `DELETE /rules/rule_123` は `{ id: "rule_123" }` を処理関数に渡します）。

各エンドポイントが受け付ける項目は、画面から保存できる項目と同じです（`apps/desktop/src/main/types.ts` の `Rule` / `ScheduledPost` / `CalendarMemo` / `Seminar` / `Settings` を参照）。項目名や制約（例: DM本文は1,000文字以内、公開返信は3パターンまで、時間差送信は1〜1,380分）は画面の入力欄と共通です。

## 使用例

```sh
TOKEN="<トークンをここに>"
BASE="http://127.0.0.1:42814"

# 自動返信ルールを作成（DMで「価格」を含む文言に反応）
curl -X POST "$BASE/rules" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "価格案内",
    "sources": ["dm", "comment"],
    "keywords": ["価格", "料金"],
    "matchMode": "contains",
    "message": { "text": "料金表はこちらです👇" }
  }'

# 投稿を予約
curl -X POST "$BASE/posts" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "kind": "image",
    "scheduledAt": "2026-10-01T10:00:00.000Z",
    "caption": "新商品のお知らせ",
    "media": [{ "url": "https://example.com/image.jpg" }]
  }'

# 分析サマリーを取得
curl -H "Authorization: Bearer $TOKEN" "$BASE/insights"
```
