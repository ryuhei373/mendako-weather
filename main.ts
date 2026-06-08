// 気象庁の予報を取得し、毎朝 7:00 JST に Slack(Incoming Webhook) へ通知する Deno Deploy アプリ。
//
// データソース: 気象庁 防災情報 forecast API（APIキー不要・非公式の公開JSON）
//   https://www.jma.go.jp/bosai/forecast/data/forecast/{AREA_CODE}.json

import { AREA_CODES } from "./area-codes.ts";

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

// ---- 設定（環境変数から取得） ----
function requireEnv(key: string): string {
  const v = Deno.env.get(key);
  if (!v) throw new Error(`環境変数 ${key} が設定されていません`);
  return v;
}

const areaCode = requireEnv("AREA_CODE");
const areaName = AREA_CODES.get(areaCode);
if (!areaName) {
  throw new Error(
    `AREA_CODE="${areaCode}" は不明なコードです。area-codes.ts を確認してください`,
  );
}

const config = {
  areaCode,
  areaName,
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

const TZ = "Asia/Tokyo";

function jstToday(offsetDays = 0): Temporal.PlainDate {
  const today = Temporal.Now.plainDateISO(TZ);
  return offsetDays === 0 ? today : today.add({ days: offsetDays });
}

// YYYY-MM-DD（API照合用）
function jstDateStr(offsetDays = 0): string {
  return jstToday(offsetDays).toString();
}

function jstDateLabel(offsetDays = 0): string {
  const date = jstToday(offsetDays);
  const weekday = date.toLocaleString("ja-JP", { weekday: "short" });
  return `${date.month}月${date.day}日（${weekday}）`;
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
  const timeSeries = series.find((t) => t.areas[0]?.temps);
  if (!timeSeries) return out;
  const temps = timeSeries.areas[0].temps!;
  timeSeries.timeDefines.forEach((timeDefine, i) => {
    const m = timeDefine.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})/);
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

const POP_LABELS: Record<number, string> = { 6: "朝", 12: "昼", 18: "夜" };

interface PopEntry {
  label: string;
  value: number;
}

// 指定日の降水確率を時間帯別（6時間ごと）に取得する
function pickPops(series: JmaTimeSeries[], targetDate: string): PopEntry[] {
  const timeSeries = series.find((t) => t.areas[0]?.pops);
  if (!timeSeries) return [];
  const pops = timeSeries.areas[0].pops!;
  const entries: PopEntry[] = [];
  timeSeries.timeDefines.forEach((timeDefine, i) => {
    const m = timeDefine.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})/);
    if (!m || m[1] !== targetDate) return;
    const v = Number(pops[i]);
    if (Number.isNaN(v)) return;
    const label = POP_LABELS[Number(m[2])];
    if (!label) return;
    entries.push({ label, value: v });
  });
  return entries;
}

function formatPops(entries: PopEntry[]): { line: string; summary: string } {
  if (entries.length === 0) return { line: "☔ 降水確率 —", summary: "降水—" };
  const detail = entries.map((e) => `${e.label}${e.value}%`).join(" → ");
  const max = Math.max(...entries.map((e) => e.value));
  return {
    line: `☔ 降水確率 ${detail}`,
    summary: `降水(最大)${max}%`,
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { "User-Agent": "mendako-weather (Deno Deploy)" },
  });
  if (!res.ok) throw new Error(`fetch failed ${res.status}: ${url}`);
  return await res.json() as T;
}

// Slack 送信用ペイロード（Block Kit）を組み立てる。
// offsetDays=0 で今日、offsetDays=1 で明日の予報を生成する。
export async function buildMessage(offsetDays = 0): Promise<SlackPayload> {
  const data = await fetchJson<JmaForecast[]>(
    `https://www.jma.go.jp/bosai/forecast/data/forecast/${config.areaCode}.json`,
  );

  const targetDate = jstDateStr(offsetDays);
  const nextDate = jstDateStr(offsetDays + 1);
  const series = data[0].timeSeries;
  const weatherArea = series[0].areas[config.areaIndex] ?? series[0].areas[0];
  const subAreaName = (weatherArea.area?.name ?? config.areaName).replace(/地方$/, "");
  const code = weatherArea.weatherCodes?.[offsetDays] ?? "";
  const weatherText = (weatherArea.weathers?.[offsetDays] ?? "").replace(/　/g, "");
  const emoji = weatherEmoji(code, weatherText);

  const { min, max } = pickTemps(series, targetDate, nextDate);
  const popEntries = pickPops(series, targetDate);
  const { line: popLine, summary: popSummary } = formatPops(popEntries);

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
    popLine,
  ];

  const greeting = offsetDays === 0 ? "おはようございます！" : "おやすみ前にお届け！";
  const dateLabel = jstDateLabel(offsetDays);
  const header = `${greeting}${dateLabel}の天気です`;
  return {
    text: `${header}\n${subAreaName}: ${weatherText} / ${tempSummary} / ${popSummary}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: header } },
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
  // 毎朝 07:00 JST (= 22:00 UTC) に今日の天気を通知
  Deno.cron("morning-weather", "0 22 * * *", async () => {
    await postToSlack(await buildMessage(0));
    console.log("morning weather notification sent");
  });

  // 毎晩 22:00 JST (= 13:00 UTC) に明日の天気を通知
  Deno.cron("evening-weather", "0 13 * * *", async () => {
    await postToSlack(await buildMessage(1));
    console.log("evening weather notification sent");
  });

  // 動作確認用 HTTP エンドポイント
  Deno.serve(async (req) => {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/preview") {
        return Response.json(await buildMessage());
      }
      if (url.pathname === "/run") {
        const slackResponse = await postToSlack(await buildMessage());
        return new Response(`sent ✅ (slack response: ${slackResponse})\n`);
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
