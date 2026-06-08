import { z } from "npm:zod@^4.3.6";

// ---- Zod スキーマ: 気象庁 forecast API レスポンス ----

const AreaSchema = z.object({
  area: z.object({ name: z.string(), code: z.string() }),
  weatherCodes: z.array(z.string()).optional(),
  weathers: z.array(z.string()).optional(),
  winds: z.array(z.string()).optional(),
  waves: z.array(z.string()).optional(),
  pops: z.array(z.string()).optional(),
  temps: z.array(z.string()).optional(),
  reliabilities: z.array(z.string()).optional(),
  tempsMin: z.array(z.string()).optional(),
  tempsMinLower: z.array(z.string()).optional(),
  tempsMinUpper: z.array(z.string()).optional(),
  tempsMax: z.array(z.string()).optional(),
  tempsMaxLower: z.array(z.string()).optional(),
  tempsMaxUpper: z.array(z.string()).optional(),
});

const TimeSeriesSchema = z.object({
  timeDefines: z.array(z.string()),
  areas: z.array(AreaSchema),
});

const ForecastBlockSchema = z.object({
  reportDatetime: z.string(),
  timeSeries: z.array(TimeSeriesSchema),
});

const ForecastResponseSchema = z.array(ForecastBlockSchema).min(2);

// ---- 型エクスポート ----

export type JmaArea = z.infer<typeof AreaSchema>;
export type JmaTimeSeries = z.infer<typeof TimeSeriesSchema>;
export type JmaForecastBlock = z.infer<typeof ForecastBlockSchema>;
export type JmaForecastResponse = z.infer<typeof ForecastResponseSchema>;

// ---- API クライアント ----

const BASE_URL = "https://www.jma.go.jp/bosai/forecast/data/forecast";

export async function fetchForecast(areaCode: string): Promise<JmaForecastResponse> {
  const url = `${BASE_URL}/${areaCode}.json`;
  const response = await fetch(url, {
    headers: { "User-Agent": "mendako-weather (Deno Deploy)" },
  });
  if (!response.ok) {
    throw new Error(`気象庁API fetch failed ${response.status}: ${url}`);
  }
  const json = await response.json();
  return ForecastResponseSchema.parse(json);
}
