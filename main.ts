// 気象庁の予報を取得し、毎朝 7:00 JST に Slack(Incoming Webhook) へ通知する Deno Deploy アプリ。
//
// データソース: 気象庁 防災情報 forecast API（APIキー不要・非公式の公開JSON）
//   https://www.jma.go.jp/bosai/forecast/data/forecast/{AREA_CODE}.json

// ---- 気象庁レスポンスの型（必要部分のみ） ----
interface JmaArea {
  area: { name: string; code: string };
  weatherCodes?: string[];
  weathers?: string[];
  pops?: string[];
  temps?: string[];
}
interface JmaTimeSeries {
  timeDefines: string[];
  areas: JmaArea[];
}
interface JmaForecast {
  reportDatetime: string;
  timeSeries: JmaTimeSeries[];
}

interface SlackPayload {
  text: string;
  blocks: unknown[];
}

// ---- 設定（環境変数。未設定なら東京都） ----
const config = {
  areaCode: Deno.env.get("AREA_CODE") ?? "130000",
  areaName: Deno.env.get("AREA_NAME") ?? "東京都",
  areaIndex: Number(Deno.env.get("FORECAST_AREA_INDEX") ?? "0"),
};

// 見出しの絵文字は公式 weatherCode を優先（先頭1桁: 1=晴 2=曇 3=雨 4=雪）。
// コード不明時のみテキストから推定する。
function weatherEmoji(code = "", text = ""): string {
  switch (code[0]) {
    case "4":
      return "❄️";
    case "3":
      return "🌧️";
    case "2":
      return "☁️";
    case "1":
      return "☀️";
  }
  if (/雪/.test(text)) return "❄️";
  if (/雨/.test(text)) return "🌧️";
  if (/晴/.test(text)) return "☀️";
  if (/くもり|曇/.test(text)) return "☁️";
  return "🌤️";
}

// JST の日付を YYYY-MM-DD で返す（Deno Deploy は UTC 動作なので +9h して切り出す）。
// offsetDays=1 で翌日。
function jstDateStr(offsetDays = 0): string {
  return new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400 * 1000)
    .toISOString()
    .slice(0, 10);
}

// 気温を timeDefines の日付・時刻で判定して取得する。
//   最高 = 今日09:00（今日の最高気温）
//   最低 = 明日00:00（今夜〜明朝にかけての最低気温）
// 当日の最低(今日00:00)は発表時点で既に経過し、最高気温と同値の縮退データになることがある。
// 一方 明日00:00 は常に未来の予報値なので縮退せず、朝の通知では「今夜の冷え込み」を表す。
function pickTemps(
  series: JmaTimeSeries[],
  today: string,
  tomorrow: string,
): { min: string | null; max: string | null } {
  const out: { min: string | null; max: string | null } = { min: null, max: null };
  const ts = series.find((t) => t.areas[0]?.temps);
  if (!ts) return out;
  const temps = ts.areas[0].temps!;
  ts.timeDefines.forEach((td, i) => {
    const m = td.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})/);
    if (!m) return;
    const date = m[1];
    const hour = Number(m[2]);
    const v = temps[i];
    if (!v) return;
    if (date === today && hour >= 9) out.max = v; // 今日の最高気温
    else if (date === tomorrow && hour <= 6) out.min = v; // 今夜〜明朝の最低気温
  });
  return out;
}

// 当日の降水確率の最大値（%）
function pickTodayMaxPop(series: JmaTimeSeries[], today: string): number | null {
  const ts = series.find((t) => t.areas[0]?.pops);
  if (!ts) return null;
  const pops = ts.areas[0].pops!;
  let max: number | null = null;
  ts.timeDefines.forEach((td, i) => {
    if (!td.startsWith(today)) return;
    const v = Number(pops[i]);
    if (Number.isNaN(v)) return;
    if (max === null || v > max) max = v;
  });
  return max;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { "User-Agent": "mendako-weather (Deno Deploy)" },
  });
  if (!res.ok) throw new Error(`fetch failed ${res.status}: ${url}`);
  return await res.json() as T;
}

// Slack 送信用ペイロード（Block Kit）を組み立てる
export async function buildMessage(): Promise<SlackPayload> {
  const data = await fetchJson<JmaForecast[]>(
    `https://www.jma.go.jp/bosai/forecast/data/forecast/${config.areaCode}.json`,
  );

  const today = jstDateStr(0);
  const tomorrow = jstDateStr(1);
  const series = data[0].timeSeries;
  const wArea = series[0].areas[config.areaIndex] ?? series[0].areas[0];
  const subAreaName = (wArea.area?.name ?? config.areaName).replace(/地方$/, "");
  const code = wArea.weatherCodes?.[0] ?? "";
  const weatherText = (wArea.weathers?.[0] ?? "").replace(/　/g, "");
  const emoji = weatherEmoji(code, weatherText);

  const { min, max } = pickTemps(series, today, tomorrow);
  const maxPop = pickTodayMaxPop(series, today);

  const reportLabel = (data[0].reportDatetime ?? "").replace(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}).*$/,
    "$2/$3 $4:$5",
  );

  const tempLine = max !== null && min !== null
    ? `🌡️ 最高 ${max}℃ / 最低 ${min}℃`
    : max !== null
    ? `🌡️ 最高 ${max}℃`
    : "🌡️ 気温 —";
  const tempSummary = max !== null && min !== null
    ? `最高${max}℃ 最低${min}℃`
    : max !== null
    ? `最高${max}℃`
    : "気温—";

  const lines = [
    `${emoji} *${subAreaName}* の天気`,
    "```",
    weatherText,
    "```",
    tempLine,
    `☔ 降水確率(最大) ${maxPop ?? "—"}%`,
  ];

  const header = `おはようございます！今日（${today}）の天気です`;
  return {
    text: `${header}\n${subAreaName}: ${weatherText} / ${tempSummary} / 降水${maxPop ?? "—"}%`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: `🌤️ ${header}`, emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `気象庁 ${reportLabel} 発表` }],
      },
    ],
  };
}

async function postToSlack(payload: SlackPayload): Promise<string> {
  const webhook = Deno.env.get("SLACK_WEBHOOK_URL");
  if (!webhook) throw new Error("SLACK_WEBHOOK_URL is not set");
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Slack POST failed ${res.status}: ${body}`);
  return body;
}

// エントリポイントとして実行された時だけ cron / HTTP を起動する。
// （import 経由のテストでは副作用を起こさない）
if (import.meta.main) {
  // 毎朝 07:00 JST (= 22:00 UTC) に実行
  Deno.cron("morning-weather", "0 22 * * *", async () => {
    await postToSlack(await buildMessage());
    console.log("weather notification sent");
  });

  // 動作確認用 HTTP エンドポイント
  Deno.serve(async (req) => {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/preview") {
        return Response.json(await buildMessage());
      }
      if (url.pathname === "/run") {
        const slackResp = await postToSlack(await buildMessage());
        return new Response(`sent ✅ (slack response: ${slackResp})\n`);
      }
    } catch (e) {
      return new Response(`error: ${(e as Error).message}\n`, { status: 500 });
    }
    return new Response(
      [
        "mendako-weather (Deno Deploy)",
        "  GET /preview  -> 生成メッセージを確認（Slack送信なし）",
        "  GET /run      -> 手動で Slack へ送信",
        "  cron          -> 毎朝 07:00 JST に自動送信",
        "",
      ].join("\n"),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  });
}
