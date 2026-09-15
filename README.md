# IGUP

InstagramプロアカウントのOAuth接続、アカウント情報取得、画像のテスト投稿を行う買い切り型デスクトップツールの初期版です。Metaアプリのシークレットは認証サーバーだけが保持し、購入者へ配布しません。

## 構成

- `apps/desktop`: 購入者PCで動くElectronアプリ
- `apps/broker`: Meta OAuthのコード交換を行う最小認証サーバー

認証サーバーは認証結果をメモリに最大5分だけ保持します。デスクトップアプリは一度だけ交換できるIDで結果を取得し、OSの暗号化機能を使ってアクセストークンを保存します。

## Metaアプリ設定

Instagram API with Instagram Loginを有効化し、次の権限を設定します。

- `instagram_business_basic`
- `instagram_business_content_publish`

Metaアプリに登録するリダイレクトURIは、公開HTTPS環境の次のURLです。

```text
https://YOUR_BROKER_HOST/oauth/callback
```

Instagramのプロアカウント（ビジネスまたはクリエイター）が必要です。一般公開して販売する際は、MetaのアプリレビューとBusiness Verificationを完了してください。

## 使い方

アプリの画面は「1 Instagram接続」「2 アカウント確認」「3 画像をテスト投稿」の3ステップで構成されています。

1. **Instagram接続**: 「Instagramに接続」を押すと既定のブラウザでMetaの認可画面が開きます。許可すると自動でアプリに戻り、バッジが「接続済み」に変わります。アクセストークンはOSの暗号化機能でローカルに保存され、トークンの有効期限も画面に表示されます。
2. **アカウント確認**: 「アカウント情報を取得」を押すと、接続したプロアカウントのユーザー名・アカウント種別・投稿数が表示されます。
3. **画像をテスト投稿**: 「公開画像URL」にInstagram側から直接取得できる公開HTTPS画像URLを、「キャプション」に投稿文（最大2,200文字）を入力し、「投稿する」を押すと投稿されます。成功すると投稿したメディアIDが通知に表示されます。

手順1が未完了のまま手順2・3を行うとエラーになります。認証・取得・投稿のいずれかでエラーが起きた場合は、画面下部に理由が表示されます。

## 開発環境

Node.js 22以上を使います。

```sh
npm install
```

認証サーバーは実行環境に以下の設定値を登録して起動します。秘密値をファイルへ保存しないでください。

```sh
META_APP_ID=YOUR_APP_ID \
META_APP_SECRET=YOUR_APP_SECRET \
META_REDIRECT_URI=https://YOUR_BROKER_HOST/oauth/callback \
npm run dev:broker
```

別のターミナルでデスクトップアプリを起動します。

```sh
IGUP_BROKER_URL=http://127.0.0.1:8787 npm run dev:desktop
```

ローカルで実際のOAuthを試す場合も、Metaに登録した公開HTTPSのコールバックからローカルアプリへ戻れる構成が必要です。開発用トンネルを使う場合は、そのHTTPS URLをMetaと認証サーバーの両方へ同じ値で設定します。

## 確認コマンド

```sh
npm run typecheck
npm test
npm run build
```

画像投稿では、Instagram側から直接取得できる公開HTTPS画像URLを指定します。ローカルファイルのアップロードは初期版の対象外です。
