const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const DEFAULT_TICKERS = [
  "AAPL",
  "MSFT",
  "NVDA",
  "AMZN",
  "META",
  "GOOGL",
  "TSLA",
  "JPM",
  "AMD",
  "NFLX",
  "SPY",
  "QQQ"
];

const DEFAULT_ALPHA_TOPICS = [
  "financial_markets",
  "earnings",
  "economy_monetary",
  "economy_macro",
  "technology",
  "energy_transportation"
];

const IMPORTANT_TERMS = [
  "earnings",
  "revenue",
  "profit",
  "guidance",
  "forecast",
  "fed",
  "inflation",
  "rate",
  "cpi",
  "ppi",
  "interest rate",
  "bond",
  "yield",
  "unemployment",
  "merger",
  "acquisition",
  "lawsuit",
  "sec",
  "ai",
  "chip",
  "gpu",
  "data center",
  "semiconductor",
  "openai",
  "cloud",
  "memory",
  "dram",
  "nand",
  "hbm",
  "high bandwidth memory",
  "ssd",
  "storage",
  "micron",
  "sk hynix",
  "samsung memory",
  "oil",
  "crude",
  "brent",
  "wti",
  "opec",
  "gas",
  "lng",
  "refinery",
  "drilling",
  "shale",
  "pipeline",
  "energy",
  "electricity",
  "power",
  "utility",
  "utilities",
  "grid",
  "renewable",
  "solar",
  "wind",
  "nuclear",
  "battery",
  "ev",
  "natural gas",
  "tariff",
  "jobs",
  "gdp"
];

const SOURCE_WEIGHTS = new Map([
  ["Reuters", 5],
  ["Bloomberg", 5],
  ["CNBC", 4],
  ["MarketWatch", 4],
  ["The Wall Street Journal", 4],
  ["Yahoo", 3],
  ["Seeking Alpha", 3]
]);

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

function requireAtLeastOneNewsApi() {
  if (!FINNHUB_API_KEY && !ALPHA_VANTAGE_API_KEY) {
    throw new Error("Missing news API key: set FINNHUB_API_KEY or ALPHA_VANTAGE_API_KEY");
  }
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function getBangkokDateLabel() {
  return new Intl.DateTimeFormat("th-TH", {
    dateStyle: "medium",
    timeZone: "Asia/Bangkok"
  }).format(new Date());
}

function getTickerList() {
  return (process.env.NEWS_TICKERS || DEFAULT_TICKERS.join(","))
    .split(",")
    .map((ticker) => ticker.trim().toUpperCase())
    .filter(Boolean);
}

function getAlphaTopics() {
  return (process.env.ALPHA_TOPICS || DEFAULT_ALPHA_TOPICS.join(","))
    .split(",")
    .map((topic) => topic.trim())
    .filter(Boolean);
}

function getDefaultChatIds() {
  return TELEGRAM_CHAT_ID.split(",")
    .map((chatId) => chatId.trim())
    .filter(Boolean);
}

function normalizeHeadline(headline) {
  return headline.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function parseAlphaTime(timePublished) {
  if (!timePublished || timePublished.length < 15) {
    return Math.floor(Date.now() / 1000);
  }

  const year = timePublished.slice(0, 4);
  const month = timePublished.slice(4, 6);
  const day = timePublished.slice(6, 8);
  const hour = timePublished.slice(9, 11);
  const minute = timePublished.slice(11, 13);
  const second = timePublished.slice(13, 15);
  return Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`) / 1000;
}

function scoreNews(item) {
  const headline = item.headline || "";
  const summary = item.summary || "";
  const text = `${headline} ${summary}`.toLowerCase();
  const ageHours = Math.max(0, (Date.now() / 1000 - item.datetime) / 3600);

  let score = 0;
  score += SOURCE_WEIGHTS.get(item.source) || 1;
  score += IMPORTANT_TERMS.filter((term) => text.includes(term)).length * 2;
  score += headline.length >= 40 ? 1 : 0;
  score += ageHours <= 6 ? 4 : ageHours <= 24 ? 2 : 0;
  score += item.related?.includes(item.ticker) ? 2 : 0;
  score += item.apiSource === "alpha_vantage" ? 1 : 0;

  if (item.sentimentScore) {
    score += Math.min(3, Math.abs(Number(item.sentimentScore)) * 5);
  }

  return score;
}

async function fetchFinnhubCompanyNews(ticker, from, to) {
  const url = new URL("https://finnhub.io/api/v1/company-news");
  url.searchParams.set("symbol", ticker);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  url.searchParams.set("token", FINNHUB_API_KEY);

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Finnhub failed for ${ticker}: ${response.status} ${body}`);
  }

  const data = await response.json();
  return data.map((item) => ({ ...item, ticker, apiSource: "finnhub" }));
}

async function fetchFinnhubNews() {
  if (!FINNHUB_API_KEY) return [];

  const to = new Date();
  const from = new Date(to);
  from.setDate(to.getDate() - 1);

  const jobs = getTickerList().map((ticker) =>
    fetchFinnhubCompanyNews(ticker, formatDate(from), formatDate(to))
  );

  const results = await Promise.allSettled(jobs);
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length) {
    console.warn(`Skipped ${failed.length} Finnhub ticker request(s).`);
    for (const result of failed) console.warn(result.reason.message);
  }

  return results
    .filter((result) => result.status === "fulfilled")
    .flatMap((result) => result.value);
}

async function fetchAlphaVantageNews() {
  if (!ALPHA_VANTAGE_API_KEY) return [];

  const url = new URL("https://www.alphavantage.co/query");
  url.searchParams.set("function", "NEWS_SENTIMENT");
  url.searchParams.set("tickers", getTickerList().join(","));
  url.searchParams.set("topics", getAlphaTopics().join(","));
  url.searchParams.set("sort", "LATEST");
  url.searchParams.set("limit", String(Number(process.env.ALPHA_NEWS_LIMIT || 50)));
  url.searchParams.set("apikey", ALPHA_VANTAGE_API_KEY);

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Alpha Vantage failed: ${response.status} ${body}`);
  }

  const data = await response.json();
  if (data.Note || data.Information) {
    console.warn(`Alpha Vantage notice: ${data.Note || data.Information}`);
    return [];
  }

  return (data.feed || []).map((item) => {
    const relatedTickers = (item.ticker_sentiment || [])
      .map((tickerItem) => tickerItem.ticker)
      .filter(Boolean);

    return {
      headline: item.title,
      summary: item.summary,
      url: item.url,
      source: item.source,
      datetime: parseAlphaTime(item.time_published),
      ticker: relatedTickers[0] || "MARKET",
      related: relatedTickers.join(","),
      sentimentScore: item.overall_sentiment_score,
      sentimentLabel: item.overall_sentiment_label,
      apiSource: "alpha_vantage"
    };
  });
}

async function fetchAllNews() {
  requireAtLeastOneNewsApi();

  const results = await Promise.allSettled([fetchFinnhubNews(), fetchAlphaVantageNews()]);
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length) {
    console.warn(`Skipped ${failed.length} news source(s).`);
    for (const result of failed) console.warn(result.reason.message);
  }

  return results
    .filter((result) => result.status === "fulfilled")
    .flatMap((result) => result.value);
}

function pickTopNews(items) {
  const seen = new Set();
  const scored = [];

  for (const item of items) {
    if (!item.headline || !item.url) continue;

    const key = item.url || normalizeHeadline(item.headline);
    const headlineKey = normalizeHeadline(item.headline);
    if (seen.has(key) || seen.has(headlineKey)) continue;

    seen.add(key);
    seen.add(headlineKey);
    scored.push({ ...item, score: scoreNews(item) });
  }

  const limit = Number(process.env.NEWS_LIMIT || 7);
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

function buildTelegramMessage(newsItems) {
  const dateLabel = getBangkokDateLabel();
  if (!newsItems.length) {
    return `สรุปข่าวตลาดหุ้นเช้านี้ (${dateLabel})\n\nยังไม่พบข่าวเด่นในรอบล่าสุด`;
  }

  const lines = [
    `สรุปข่าวตลาดหุ้นเช้านี้ (${dateLabel})`,
    "",
    ...newsItems.flatMap((item, index) => [
      `${index + 1}. ${item.ticker}: ${item.headline}`,
      [
        `แหล่งข่าว: ${item.source || "ไม่ระบุ"}`,
        `API: ${item.apiSource || "unknown"}`,
        item.sentimentLabel ? `Sentiment: ${item.sentimentLabel}` : null,
        `คะแนน: ${Math.round(item.score * 10) / 10}`
      ]
        .filter(Boolean)
        .join(" | "),
      item.url,
      ""
    ])
  ];

  return lines.join("\n").trim();
}

function buildHelpMessage() {
  return [
    "คำสั่งที่ใช้ได้",
    "",
    "/news - ดึงข่าวล่าสุดทันที",
    "/tickers - ดูรายชื่อหุ้นที่กำลังติดตาม",
    "/test - ทดสอบว่า bot ตอบกลับได้",
    "/help - ดูคำสั่งทั้งหมด"
  ].join("\n");
}

async function buildLatestNewsMessage() {
  const news = await fetchAllNews();
  const topNews = pickTopNews(news);
  return buildTelegramMessage(topNews);
}

async function sendTelegramMessageToChat(text, chatId) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram failed: ${response.status} ${body}`);
  }
}

async function sendTelegramMessage(text, chatId) {
  const chatIds = chatId ? [chatId] : getDefaultChatIds();
  const results = await Promise.allSettled(
    chatIds.map((targetChatId) => sendTelegramMessageToChat(text, targetChatId))
  );
  const failed = results.filter((result) => result.status === "rejected");

  if (failed.length) {
    throw new Error(
      `Telegram failed for ${failed.length}/${chatIds.length} chat(s): ${failed
        .map((result) => result.reason.message)
        .join("; ")}`
    );
  }
}

async function getTelegramUpdates(offset) {
  const url = new URL(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`);
  url.searchParams.set("timeout", "25");
  url.searchParams.set("allowed_updates", JSON.stringify(["message"]));
  if (offset) url.searchParams.set("offset", String(offset));

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram getUpdates failed: ${response.status} ${body}`);
  }

  const data = await response.json();
  return data.result || [];
}

async function handleTelegramCommand(message) {
  const chatId = message.chat?.id;
  const text = (message.text || "").trim();
  if (!chatId || !text.startsWith("/")) return;

  const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();

  if (command === "/news") {
    await sendTelegramMessage("กำลังดึงข่าวล่าสุดให้ครับ...", chatId);
    await sendTelegramMessage(await buildLatestNewsMessage(), chatId);
    return;
  }

  if (command === "/tickers") {
    await sendTelegramMessage(`หุ้นที่ติดตามอยู่:\n${getTickerList().join(", ")}`, chatId);
    return;
  }

  if (command === "/test") {
    await sendTelegramMessage("bot ตอบกลับได้ปกติครับ", chatId);
    return;
  }

  if (command === "/start" || command === "/help") {
    await sendTelegramMessage(buildHelpMessage(), chatId);
    return;
  }

  await sendTelegramMessage("ยังไม่รู้จักคำสั่งนี้ครับ ลอง /help ได้เลย", chatId);
}

async function runTelegramBot() {
  console.log("Telegram command bot is running. Press Ctrl+C to stop.");
  let offset;

  while (true) {
    try {
      const updates = await getTelegramUpdates(offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) {
          await handleTelegramCommand(update.message);
        }
      }
    } catch (error) {
      console.error(error.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

async function main() {
  requireEnv("TELEGRAM_BOT_TOKEN", TELEGRAM_BOT_TOKEN);
  requireEnv("TELEGRAM_CHAT_ID", TELEGRAM_CHAT_ID);

  if (process.argv.includes("--test-telegram")) {
    await sendTelegramMessage("ทดสอบส่งข้อความจาก stock news worker สำเร็จ");
    console.log("Telegram test message sent.");
    return;
  }

  if (process.argv.includes("--bot")) {
    await runTelegramBot();
    return;
  }

  const message = await buildLatestNewsMessage();
  const topNewsCount = message.match(/^\d+\./gm)?.length || 0;
  await sendTelegramMessage(message);
  console.log(`Sent ${topNewsCount} news item(s) to Telegram.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
