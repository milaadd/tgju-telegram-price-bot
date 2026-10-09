/**
 * TGJU Telegram Price Bot
 * Live USD & 18K Gold prices for the Iranian market
 *
 * Runtime: Cloudflare Workers
 * Repository: https://github.com/milaadd/tgju-telegram-price-bot
 * License: MIT
 *
 * ⚠️ هیچ توکن یا کلیدی داخل این فایل نیست.
 *    همه از Environment Variables خوانده می‌شود:
 *      - TELEGRAM_BOT_TOKEN  (Secret) — توکن ربات از BotFather
 *      - TELEGRAM_CHAT_ID    (Secret) — Chat ID ادمین
 *      - PRICE_KV            (KV Binding)
 *
 * ⚙️ برای پیکربندی، بخش CONFIG پایین را ببین.
 */

// ═══════════════════════════════════════════════════════════
// 🎛 CONFIG — تنظیمات قابل تغییر
// ═══════════════════════════════════════════════════════════

// چند تا سرور TGJU برای fallback (اگه یکی قطع شد، بعدی)
const TGJU_HOSTS = [
  "https://call1.tgju.org/ajax.json",
  "https://call2.tgju.org/ajax.json",
  "https://call3.tgju.org/ajax.json"
];

// آستانه هشدار نوسان (درصد) — اگه نوسان روزانه بیشتر از این مقدار بشه، ⚠️ اضافه می‌شه
const VOLATILITY_THRESHOLD = 2;

// ⚠️ Chat ID ادمین — از @userinfobot در تلگرام بگیر
// اگه می‌خوای این عدد در گیت‌هاب نباشه، می‌تونی به عنوان Secret در Cloudflare تعریف کنی
// و اینجا بنویسی: const ADMIN_CHAT_ID = parseInt(env.ADMIN_CHAT_ID);
const ADMIN_CHAT_ID = 0; // ← عدد واقعی خودت رو بذار

// ═══════════════════════════════════════════════════════════
// 🚪 نقطه ورود اصلی
// ═══════════════════════════════════════════════════════════

export default {
  async scheduled(event, env, ctx) {
    // Cron هر ۵ دقیقه این رو صدا می‌زنه
    ctx.waitUntil(broadcast(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // ---- تنظیم Webhook (یک بار) ----
    if (url.pathname === "/setup") {
      const wh = `https://${url.hostname}/webhook`;
      const r = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook?url=${wh}`
      );
      return new Response(await r.text(), {
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }

    // ---- تست قیمت‌ها ----
    if (url.pathname === "/test") {
      try {
        const p = await getPrices();
        return new Response(JSON.stringify(p, null, 2), {
          headers: { "content-type": "application/json; charset=utf-8" }
        });
      } catch (e) {
        return new Response("Error: " + e.message, { status: 500 });
      }
    }

    // ---- دریافت پیام‌های تلگرام ----
    if (url.pathname === "/webhook" && request.method === "POST") {
      try {
        const u = await request.json();
        await handleUpdate(u, env);
      } catch (e) {
        console.error("webhook error:", e);
      }
      return new Response("ok");
    }

    // ---- صفحه اصلی ----
    return new Response("🤖 ربات قیمت فعال است ✅", {
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }
};

// ═══════════════════════════════════════════════════════════
// 💬 متن‌ها و کیبوردها
// ═══════════════════════════════════════════════════════════

const WELCOME =
  "🤖 ربات قیمت ارز و طلا\n\n" +
  "دستورات:\n" +
  "/price  قیمت طلا و دلار\n" +
  "/dollar قیمت دلار\n" +
  "/gold قیمت طلا\n" +
  "/help راهنما";

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "💵 قیمت دلار", callback_data: "dollar" },
        { text: "🥇 قیمت طلا",  callback_data: "gold"   }
      ],
      [
        { text: "📊 قیمت کامل", callback_data: "price" }
      ]
    ]
  };
}

// ═══════════════════════════════════════════════════════════
// 🧠 پردازش پیام‌های تلگرام
// ═══════════════════════════════════════════════════════════

async function handleUpdate(update, env) {
  // ---- کلیک روی دکمه شیشه‌ای ----
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;

    // بستن اسپینر دکمه
    await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery?callback_query_id=${cb.id}`
    );

    const p = await getPrices();
    let text = "";

    if (cb.data === "dollar") {
      const a = arrow(p.dollarChange);
      const w = warn(p.dollarChange);
      text = `💵 دلار: ${p.dollar.toLocaleString("en-US")} تومان ${a} ${p.dollarChange}%${w}\n🕒 ${timeFa()}`;
    } else if (cb.data === "gold") {
      const a = arrow(p.goldChange);
      const w = warn(p.goldChange);
      text = `🥇 طلا ۱۸: ${p.gold.toLocaleString("en-US")} تومان ${a} ${p.goldChange}%${w}\n🕒 ${timeFa()}`;
    } else {
      text = formatFull(p);
    }

    await sendMessage(env, chatId, text, mainKeyboard());
    return;
  }

  // ---- پیام‌های متنی ----
  const msg = update.message || update.channel_post;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim().toLowerCase();

  // ذخیره کاربر (بهینه: فقط اگه اطلاعات تغییر کرده)
  await saveUser(env, msg);

  // ---- دستور ادمین: لیست کاربران ----
  if (chatId === ADMIN_CHAT_ID && (text === "/users" || text === "/کاربران")) {
    await sendUsersList(env, chatId);
    return;
  }

  // ---- دستورات عمومی ----
  if (["/start", "/help", "راهنما"].includes(text)) {
    await sendMessage(env, chatId, WELCOME, mainKeyboard());
    return;
  }
  if (["/price", "قیمت", "/قیمت"].includes(text)) {
    const p = await getPrices();
    await sendMessage(env, chatId, formatFull(p), mainKeyboard());
    return;
  }
  if (["/dollar", "دلار", "/دلار"].includes(text)) {
    const p = await getPrices();
    const a = arrow(p.dollarChange);
    const w = warn(p.dollarChange);
    await sendMessage(env, chatId,
      `💵 دلار: ${p.dollar.toLocaleString("en-US")} تومان ${a} ${p.dollarChange}%${w}\n🕒 ${timeFa()}`,
      mainKeyboard());
    return;
  }
  if (["/gold", "طلا", "/طلا"].includes(text)) {
    const p = await getPrices();
    const a = arrow(p.goldChange);
    const w = warn(p.goldChange);
    await sendMessage(env, chatId,
      `🥇 طلا ۱۸: ${p.gold.toLocaleString("en-US")} تومان ${a} ${p.goldChange}%${w}\n🕒 ${timeFa()}`,
      mainKeyboard());
    return;
  }

  await sendMessage(env, chatId, "دستور نامشخص. /help را بزن.", mainKeyboard());
}

// ═══════════════════════════════════════════════════════════
// 💾 ذخیره کاربر (بهینه، فقط اگه تغییر کرده)
// ═══════════════════════════════════════════════════════════

async function saveUser(env, msg) {
  const chatId = msg.chat.id;
  const userKey = `user:${chatId}`;

  const newData = {
    id: chatId,
    title: msg.chat.title || msg.chat.first_name || "",
    first_name: msg.from?.first_name || "",
    last_name: msg.from?.last_name || "",
    username: msg.from?.username || "",
    language: msg.from?.language_code || "",
    type: msg.chat.type,
    addedAt: new Date().toISOString()
  };

  const existingRaw = await env.PRICE_KV.get(userKey);
  const existing = existingRaw ? JSON.parse(existingRaw) : null;

  // اگه اطلاعات هویتی تغییر نکرده، write نکن
  const changed =
    !existing ||
    existing.first_name !== newData.first_name ||
    existing.last_name !== newData.last_name ||
    existing.username !== newData.username ||
    existing.title !== newData.title;

  if (changed) {
    // تاریخ عضویت اولیه رو حفظ کن
    if (existing?.addedAt) newData.addedAt = existing.addedAt;
    await env.PRICE_KV.put(userKey, JSON.stringify(newData));
  }
}

// ═══════════════════════════════════════════════════════════
// 👥 لیست کاربران (فقط ادمین)
// ═══════════════════════════════════════════════════════════

async function sendUsersList(env, chatId) {
  const list = await env.PRICE_KV.list({ prefix: "user:" });
  const users = [];

  for (const k of list.keys) {
    const raw = await env.PRICE_KV.get(k.name);
    if (!raw) continue;
    const u = JSON.parse(raw);

    const name = [u.first_name, u.last_name].filter(Boolean).join(" ")
              || u.title || "بدون نام";
    const typeIcon = u.type === "private" ? "💬"
                   : u.type === "group"   ? "👥"
                   : u.type === "channel" ? "📢" : "❓";

    const lines = [
      `${typeIcon} ${name}`,
      `🆔 ${u.id}`,
      u.username ? `🔗 @${u.username}` : null,
      u.language ? `🌐 ${u.language}` : null,
      `📅 ${u.addedAt
        ? new Date(u.addedAt).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })
        : "—"}`
    ].filter(Boolean);

    users.push(lines.join("\n"));
  }

  const header = `👥 تعداد کاربران: ${users.length}\n\n`;
  const fullMsg = header + users.join("\n\n");

  // تلگرام محدودیت ۴۰۹۶ کاراکتر داره → تقسیم به چند پیام
  const chunks = splitMessage(fullMsg, 4000);
  for (const chunk of chunks) {
    await sendMessage(env, chatId, chunk, mainKeyboard());
  }
}

// ═══════════════════════════════════════════════════════════
// 📤 ارسال دوره‌ای به همه کاربران (Cron هر ۵ دقیقه)
// ═══════════════════════════════════════════════════════════

async function broadcast(env) {
  const p = await getPrices();
  const lastRaw = await env.PRICE_KV.get("lastBroadcast");
  const last = lastRaw ? JSON.parse(lastRaw) : null;

  console.log("📊 قیمت جدید:", p.dollar, p.gold, "| قبلی:", last?.dollar, last?.gold);

  // اگه قیمت‌ها تغییر نکرده → هیچ پیامی نفرست (ضد اسپم)
  if (last && last.dollar === p.dollar && last.gold === p.gold) {
    console.log("بدون تغییر، skip");
    return;
  }

  // ذخیره مقادیر جدید
  await env.PRICE_KV.put("lastBroadcast", JSON.stringify(p));
  console.log("✅ قیمت تغییر کرد → ارسال به کاربران");

  // ارسال به همه کاربران
  const text = formatFull(p);
  const list = await env.PRICE_KV.list({ prefix: "user:" });
  let sent = 0;

  for (const key of list.keys) {
    const raw = await env.PRICE_KV.get(key.name);
    if (!raw) continue;
    const u = JSON.parse(raw);
    try {
      await sendMessage(env, u.id, text, mainKeyboard());
      sent++;
    } catch (e) {
      console.error("خطا در ارسال به", u.id, e);
    }
  }

  console.log("📤 ارسال شد به", sent, "کاربر");
}

// ═══════════════════════════════════════════════════════════
// 🔧 توابع کمکی — قالب‌بندی و ارسال
// ═══════════════════════════════════════════════════════════

function arrow(v) { return v > 0 ? "🟢" : v < 0 ? "🔴" : "⚪"; }

function warn(changePct) {
  return Math.abs(changePct) >= VOLATILITY_THRESHOLD ? " ⚠️" : "";
}

function timeFa() {
  return new Date().toLocaleString("fa-IR", { timeZone: "Asia/Tehran" });
}

function formatFull(p) {
  return (
    `💵 دلار: ${p.dollar.toLocaleString("en-US")} تومان ${arrow(p.dollarChange)} ${p.dollarChange}%${warn(p.dollarChange)}\n` +
    `🥇 طلا ۱۸: ${p.gold.toLocaleString("en-US")} تومان ${arrow(p.goldChange)} ${p.goldChange}%${warn(p.goldChange)}\n` +
    `🕒 ${timeFa()}`
  );
}

// تقسیم پیام‌های طولانی (محدودیت ۴۰۹۶ کاراکتر تلگرام)
function splitMessage(text, maxLen) {
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    if ((current + line + "\n").length > maxLen) {
      chunks.push(current.trimEnd());
      current = "";
    }
    current += line + "\n";
  }
  if (current.trim()) chunks.push(current.trimEnd());
  return chunks;
}

async function sendMessage(env, chatId, text, keyboard) {
  const body = { chat_id: chatId, text };
  if (keyboard) body.reply_markup = keyboard;

  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }
  );
  return await res.json();
}

// ═══════════════════════════════════════════════════════════
// 📡 دریافت قیمت از TGJU (با fallback و cache-buster)
// ═══════════════════════════════════════════════════════════

async function fetchTgju() {
  let lastErr;

  for (const url of TGJU_HOSTS) {
    try {
      // cache-buster: یه پارامتر تصادفی به URL اضافه کن تا Cloudflare از کش نخونه
      const cacheBuster = Date.now() + "-" + Math.random();
      const sep = url.includes("?") ? "&" : "?";
      const finalUrl = url + sep + "_=" + cacheBuster;

      const r = await fetch(finalUrl, {
        cf: { cacheTtl: 0, cacheEverything: false },
        headers: {
          "cache-control": "no-cache, no-store, must-revalidate",
          "pragma": "no-cache"
        }
      });

      if (!r.ok) throw new Error("HTTP " + r.status);

      const j = await r.json();
      if (j?.current?.price_dollar_rl) {
        console.log("✅ TGJU OK | دلار:", j.current.price_dollar_rl.p, "| طلا:", j.current.geram18.p);
        return j;
      }
      throw new Error("ساختار غیرمنتظره");
    } catch (e) {
      console.log("❌ خطا در", url, ":", e.message);
      lastErr = e;
    }
  }

  throw new Error("TGJU در دسترس نیست: " + (lastErr?.message || "نامشخص"));
}

function parseRial(str) {
  return parseInt(String(str).replace(/,/g, ""), 10);
}

async function getPrices() {
  const j = await fetchTgju();
  const cur = j.current;

  return {
    dollar: Math.round(parseRial(cur.price_dollar_rl.p) / 10), // تومان
    gold: Math.round(parseRial(cur.geram18.p) / 10),           // تومان (هر گرم ۱۸ عیار)
    dollarChange: cur.price_dollar_rl.dp,
    goldChange: cur.geram18.dp,
    tgjuTime: cur.price_dollar_rl.ts
  };
  }
