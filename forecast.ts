import { AREA_CODES } from "./area-codes.ts";
import { fetchForecast, type JmaForecastResponse, type JmaTimeSeries } from "./jma-client.ts";

// ---- 設定 ----

function requireEnv(key: string): string {
  const v = Deno.env.get(key);
  if (!v) throw new Error(`環境変数 ${key} が設定されていません`);
  return v;
}

const areaCode = requireEnv("AREA_CODE");
const areaName = AREA_CODES.get(areaCode);
if (!areaName) {
  throw new Error(`AREA_CODE="${areaCode}" は不明なコードです。area-codes.ts を確認してください`);
}

const config = {
  areaCode,
  areaName,
  areaIndex: Number(Deno.env.get("FORECAST_AREA_INDEX") ?? "0"),
};

// ---- 日付ユーティリティ ----

const TZ = "Asia/Tokyo";

function jstToday(offsetDays = 0): Temporal.PlainDate {
  const today = Temporal.Now.plainDateISO(TZ);
  return offsetDays === 0 ? today : today.add({ days: offsetDays });
}

function jstDateStr(offsetDays = 0): string {
  return jstToday(offsetDays).toString();
}

function jstDateLabel(offsetDays = 0): string {
  const date = jstToday(offsetDays);
  const weekday = date.toLocaleString("ja-JP", { weekday: "short" });
  return `${date.month}月${date.day}日（${weekday}）`;
}

// ---- 天気コード → 絵文字 ----

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

// ---- 気温抽出 ----

function pickTempsFromShort(
  series: JmaTimeSeries[],
  targetDate: string,
  nextDate: string,
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
    if (date === targetDate && hour >= 9) out.max = v;
    if (date === nextDate && hour <= 6) out.min = v;
  });
  if (out.min !== null && out.min === out.max) out.min = null;
  return out;
}

function pickMinTempFromWeekly(
  series: JmaTimeSeries[],
  targetDate: string,
): string | null {
  const timeSeries = series.find((t) => t.areas[0]?.tempsMin);
  if (!timeSeries) return null;
  const tempsMin = timeSeries.areas[0].tempsMin!;
  const idx = timeSeries.timeDefines.findIndex((td) => td.startsWith(targetDate));
  if (idx === -1) return null;
  const v = tempsMin[idx];
  return v || null;
}

// ---- 降水確率抽出 ----

const POP_LABELS: Record<number, string> = { 6: "朝", 12: "昼", 18: "夜" };

interface PopEntry {
  label: string;
  value: number;
}

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

// ---- メッセージ組み立て ----

export interface SlackPayload {
  text: string;
  blocks: unknown[];
}

export async function buildMessage(offsetDays = 0): Promise<SlackPayload> {
  const data: JmaForecastResponse = await fetchForecast(config.areaCode);

  const targetDate = jstDateStr(offsetDays);
  const nextDate = jstDateStr(offsetDays + 1);
  const series = data[0].timeSeries;
  const weatherArea = series[0].areas[config.areaIndex] ?? series[0].areas[0];
  const subAreaName = (weatherArea.area?.name ?? config.areaName).replace(/地方$/, "");
  const code = weatherArea.weatherCodes?.[offsetDays] ?? "";
  const weatherText = (weatherArea.weathers?.[offsetDays] ?? "").replace(/　/g, "");
  const emoji = weatherEmoji(code, weatherText);

  let min: string | null;
  let max: string | null;
  if (offsetDays === 0) {
    ({ min, max } = pickTempsFromShort(series, targetDate, nextDate));
  } else {
    ({ max } = pickTempsFromShort(series, targetDate, nextDate));
    const dayAfter = jstDateStr(offsetDays + 1);
    min = pickMinTempFromWeekly(data[1].timeSeries, dayAfter);
  }
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
