# mendako-weather

気象庁の予報を取得し、**毎朝 7:00 JST** に Slack へ通知する Deno Deploy アプリ。

- 実行基盤: Deno Deploy（`Deno.cron` でスケジュール）
- 言語: TypeScript（ビルド不要・`main.ts` 単一ファイル）
- データ: 気象庁 防災情報 forecast API（APIキー不要）
- 通知: Slack Incoming Webhook
- 対象地域: 東京都 / 東京地方（環境変数で変更可）

## 仕組み

```
Deno.cron(毎朝07:00 JST = 22:00 UTC)
   ├─ 気象庁 forecast JSON を取得
   ├─ 今日の天気 / 最高・最低気温 / 降水確率を抽出
   └─ Slack Incoming Webhook に POST

Deno.serve（動作確認用）
   ├─ GET /preview … 生成メッセージを確認（Slack送信なし）
   └─ GET /run     … 手動で Slack へ送信
```

## セットアップ

### 1. Deno（v2系）

```sh
deno --version          # 入っていなければ: brew install deno
deno upgrade            # 最新化
```

### 2. Slack Incoming Webhook を作成

1. https://api.slack.com/apps → **Create New App**（From scratch）
2. 通知先ワークスペースを選択
3. 左メニュー **Incoming Webhooks** を ON
4. **Add New Webhook to Workspace** → 通知したいチャンネルを選択
5. 発行された `https://hooks.slack.com/services/...` を控える

### 3. ローカルで動作確認

```sh
cp .env.example .env    # .env に Webhook URL を記入
deno task dev           # http://localhost:8000 が起動
```

- `http://localhost:8000/preview` … 生成されるメッセージを確認（Slack送信なし）
- `http://localhost:8000/run` … 実際に Slack へ送信

### 4. デプロイ（Deno Deploy）

**A. GitHub 連携（推奨・CLI不要）**

1. このリポジトリを GitHub に push
2. https://dash.deno.com → **New Project** → リポジトリと `main.ts` を選択
3. プロジェクト設定 **Environment Variables** に `SLACK_WEBHOOK_URL`・`AREA_CODE` を登録
4. push のたびに自動デプロイ。`Deno.cron` は自動で有効化される

**B. CLI（deployctl）**

```sh
deno install -gArf jsr:@deno/deployctl       # 初回のみ
deployctl deploy --project=mendako-weather --prod --entrypoint=main.ts
# 環境変数はダッシュボード、または --env / --env-file で指定
```

## カスタマイズ

| 環境変数 | 説明 | 例 |
|----------|------|----|
| `SLACK_WEBHOOK_URL` | Slack Incoming Webhook（**必須**） | `https://hooks.slack.com/services/...` |
| `AREA_CODE` | 気象庁の府県予報区コード（**必須**）。名称は `area-codes.ts` から自動解決 | `130000`, `270000`, `230000`, `400000` |
| `FORECAST_AREA_INDEX` | `timeSeries[0].areas` の何番目を使うか | 東京都は `0`（東京地方） |

通知時刻は `main.ts` の `Deno.cron(...)` の cron 式を編集（UTC 基準・JST から -9h）:

```ts
Deno.cron("morning-weather", "0 22 * * *", ...) // 22:00 UTC = 翌07:00 JST
// 例) 06:00 JST にしたい → "0 21 * * *"
```

## 開発タスク

```sh
deno task dev     # ローカル起動（.env 読み込み・watch）
deno task check   # 型チェック
deno task fmt     # フォーマット
deno task lint    # Lint
deno task deploy  # deployctl でデプロイ
```

> 注: 気象庁の forecast JSON は非公式の公開エンドポイントです。利用上の制約・出典表記は気象庁サイトの規約に従ってください。
