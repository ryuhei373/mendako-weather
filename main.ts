import { buildMessage, type SlackPayload } from "./forecast.ts";

async function postToSlack(payload: SlackPayload): Promise<string> {
  const webhook = Deno.env.get("SLACK_WEBHOOK_URL");
  if (!webhook) throw new Error("SLACK_WEBHOOK_URL is not set");
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Slack POST failed ${response.status}: ${body}`);
  return body;
}

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
        "  cron          -> 毎朝 07:00 JST / 22:00 JST に自動送信",
        "",
      ].join("\n"),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  });
}
