// noutgo AI admin — Telegram Business bot running 24/7 on Supabase Edge Functions.
// Answers customers in the owner's Telegram account using Claude.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ------------------------------------------------------------ settings
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-sonnet-5-5";
const PRODUCTS_SHEET_URL = Deno.env.get("PRODUCTS_SHEET_URL") ?? ""; // optional, in addition to the products table
const TAKEOVER_MINUTES = Number(Deno.env.get("TAKEOVER_MINUTES") ?? "30");
const REPLY_DELAY_MS = Number(Deno.env.get("REPLY_DELAY_SECONDS") ?? "4") * 1000;
const HISTORY_LIMIT = 30;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
function serviceKey(): string {
  const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (k) return k;
  try {
    return JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default;
  } catch {
    return "";
  }
}
const db = createClient(SUPABASE_URL, serviceKey(), { auth: { persistSession: false } });
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/telegram-bot`;

// ------------------------------------------------------------ helpers
async function webhookSecret(): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("noutgo:" + BOT_TOKEN));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

async function tg(method: string, body: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) console.error(`Telegram ${method} failed:`, j.description);
  return j;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getSetting(key: string, def = ""): Promise<string> {
  const { data } = await db.from("bot_settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? def;
}
async function setSetting(key: string, value: string) {
  await db.from("bot_settings").upsert({ key, value });
}

type Conn = { conn_id: string; owner_id: number; owner_chat: number; is_enabled: boolean; can_reply: boolean };

function connRow(c: any): Conn {
  const canReply = c.rights ? !!c.rights.can_reply : c.can_reply !== false;
  return { conn_id: c.id, owner_id: c.user.id, owner_chat: c.user_chat_id, is_enabled: !!c.is_enabled, can_reply: canReply };
}

async function getConn(connId: string): Promise<Conn | null> {
  const { data } = await db.from("bot_owners").select("*").eq("conn_id", connId).maybeSingle();
  if (data) return data as Conn;
  const r = await tg("getBusinessConnection", { business_connection_id: connId });
  if (!r.ok) return null;
  const row = connRow(r.result);
  await db.from("bot_owners").upsert(row);
  return row;
}

async function isOwner(userId: number): Promise<boolean> {
  const { data } = await db.from("bot_owners").select("owner_id").eq("owner_id", userId).limit(1);
  return !!data?.length;
}

function describe(m: any): string {
  if (m.text) return m.text;
  const cap = m.caption ? ` Caption: ${m.caption}` : "";
  if (m.photo) return `[customer sent a photo]${cap}`;
  if (m.voice || m.video_note) return "[customer sent a voice/video message — you can't listen to it; ask them to write, or hand off]";
  if (m.video) return `[customer sent a video]${cap}`;
  if (m.document) return `[customer sent a file: ${m.document.file_name ?? ""}]${cap}`;
  if (m.sticker) return `[sticker ${m.sticker.emoji ?? ""}]`;
  if (m.contact) return `[customer shared a contact: ${m.contact.phone_number}]`;
  if (m.location) return "[customer shared a location]";
  return "[unsupported message]";
}

// ------------------------------------------------------------ product list
function sheetCsvUrl(url: string): string {
  if (url.includes("output=csv") || url.includes("format=csv")) return url;
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) return url;
  const gid = url.match(/[#&?]gid=(\d+)/);
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid ? gid[1] : 0}`;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

async function productList(): Promise<string> {
  const lines: string[] = [];
  const { data } = await db.from("products").select("*").eq("status", "available").order("id").limit(400);
  for (const p of data ?? []) {
    const parts = Object.entries(p)
      .filter(([k, v]) => !["id", "created_at"].includes(k) && v !== null && String(v).trim() !== "")
      .map(([k, v]) => `${k}: ${v}`);
    if (parts.length) lines.push("- " + parts.join("; "));
  }
  if (PRODUCTS_SHEET_URL) {
    try {
      const r = await fetch(sheetCsvUrl(PRODUCTS_SHEET_URL));
      const rows = parseCsv(await r.text());
      const [header, ...body] = rows;
      for (const row of body.slice(0, 400)) {
        const parts = header.map((h, i) => (row[i]?.trim() ? `${h.trim()}: ${row[i].trim()}` : "")).filter(Boolean);
        if (parts.length) lines.push("- " + parts.join("; "));
      }
    } catch (e) {
      console.error("Sheet load failed", e);
    }
  }
  return lines.join("\n");
}

// ------------------------------------------------------------ the AI
const RULES = `You are "noutgo yordamchisi" — the AI assistant on noutgo's Telegram admin account, chatting with customers in private messages.
noutgo sells ONLY used (b/u) laptops and laptop accessories (no phones) in Tashkent, Uzbekistan. Your goal: give every customer a warm, respectful, genuinely helpful answer and move them toward buying.

LANGUAGE
- Reply in the customer's language: Uzbek Latin (default), Uzbek Cyrillic, or Russian. Follow their latest message.
- Start EVERY reply with a language tag on its own: [uz] for Uzbek Latin, [uzc] for Uzbek Cyrillic, [ru] for Russian. (The tag is removed automatically; never mention it.)

SOUND LIKE A REAL PERSON (most important)
Write the way a friendly young seller in Tashkent really texts customers on Telegram — natural everyday Uzbek, short and warm. It must NOT sound like a translation from English or Russian, and NOT like an official letter or a robot.
- RESPECT FIRST: every reply must be respectful and polite, like a well-mannered seller talking to a valued customer (or an older person). Always "Siz" (capital S is fine), "iltimos", "rahmat", "marhamat" where natural. Simple spoken words, short sentences, one idea per line.
- NEVER copy the customer's slang or familiar tone. If they write "nima gap", "qaley", "salom", "tashlavor", still answer respectfully: e.g. "Rahmat, yaxshi! Sizga qanday yordam bera olaman?". Never write "o'zingizda nima gap", "nima gap", "zo'r-ku", "brat", "aka/opa", or jokes.
- Use words people actually use: noutbuk, zaryadka, batareya, ekran, sensorli ekran, protsessor, operativka (RAM), xotira, dostavka, karta orqali, naqd, kafolat, rasmlari, holati.
- Prices the way people write them: "280$", "3 360 000 so'm".
- Natural phrases to use: "Ha, bor 👍", "Narxi 280$", "Holati yaxshi", "Qaysi biri yoqdi?", "O'qishga olyapsizmi yoki ishga?", "Byudjetingiz qancha atrofida?", "Kelib ko'rishingiz mumkin, faqat oldin qo'ng'iroq qilib qo'ying", "Lokatsiyani tashlayapman", "Hozir admin yozadi", "Bu narxga zo'r variant", "Yana savol bo'lsa yozing".
- NEVER use bookish / translated phrases like: "Sizni qiziqtiryapti", "Sizning ehtiyojlaringizga mos", "ajoyib tanlov", "men sizga tavsiya qilaman", "xatoga yo'l qo'ydim", "tasdiqlay olmayman", "albatta" more than once, "ma'lumot uchun rahmat", long apologies.
- Don't start every message with "Albatta". Don't repeat what the customer said back to them. Don't thank them for every message.
- Never promise to prepare, reserve or hold a laptop for a visit ("tayyorlab qo'yamiz", "olib qo'yamiz") — the admin decides that. For visits just say: kelishdan oldin qo'ng'iroq qilib qo'ying (main phone).
- Russian: same idea — natural chat Russian on "Вы": "Да, есть 👍", "Цена 280$", "Какой понравился?", "Можете приехать посмотреть, только позвоните заранее".

GREETING
- If the note GREETING NEEDED appears at the end of these instructions, start with a short greeting: Uzbek "Assalomu alaykum! Xush kelibsiz 😊", Uzbek Cyrillic "Ассалому алайкум! Хуш келибсиз 😊", Russian "Здравствуйте! 😊". Otherwise do NOT greet again — just continue the chat.
- If the customer writes "Assalomu alaykum", answer "Va alaykum assalom!".

ANSWER EVERY QUESTION
- The customer may send several messages or several questions at once. Find EVERY question and request and answer each one, in order. Never skip one.
- If a question can't be answered from the info below, say so honestly for that point (e.g. "Buni admin aniq aytib beradi") and use HANDOFF — but still answer all the other points.
- If the request is vague (e.g. "noutbuk bormi?"), suggest 2-3 good options AND ask one short question about purpose (study, office, design, gaming) and budget.

PRODUCTS AND PRICES
- Use ONLY facts from BUSINESS INFO and PRODUCT LIST for anything about this shop: what is in stock, prices, condition, battery, warranty, delivery, payment, address, hours. Never invent these. Blank condition/battery = say the admin will tell exactly, and HANDOFF.
- PRODUCT LIST contains ONLY laptops and accessories that are in stock right now. Offer only these. Never offer, list or promise laptops that are "on the way", "coming soon" or "arriving". If the customer asks for a model that is not in PRODUCT LIST, say politely it is not available right now, suggest the closest in-stock option, and add HANDOFF so the admin can tell them about new arrivals.
- Quote prices exactly as listed (amount stays the same; write it like "280$"). When recommending, use one short line per item, like:
  💻 Surface Laptop 4 13.5" — Ryzen 7, 16/512, sensorli ekran — 280$
- Explain WHY an item fits the customer (light, battery, big screen, 2-in-1, good for study/office/design).
- MODEL KNOWLEDGE (below) has researched specs and independent battery tests for the models we sell. Use it for precise answers (screen, weight, ports, Thunderbolt, battery Wh, test hours). Battery test hours were measured on NEW devices by reviewers — say it like "yangi holatida testlarda ~9 soat ishlagan", and add that this exact unit's battery health is in the product info or the admin will tell. Never promise exact hours for a used device.
- You MAY use general tech knowledge to explain and compare (e.g. what 16GB RAM gives, Ryzen vs Intel, OLED, what ARM/Snapdragon laptops mean, macOS vs Windows, is 8GB enough for study) — keep it simple and true, no exaggeration.
- Discounts: prices are already fair, but a small discount is possible and the admin is open to negotiation. Never promise a specific discount amount yourself — say politely that a small discount is possible and the admin will agree the final price, and HANDOFF.

URGENT, CONTACT AND LOCATION
- If the matter is urgent (customer is in a hurry, problem with a purchased device, wants to talk now, wants to call), give the phone number from BUSINESS INFO so they can call directly, and HANDOFF.
- If the customer asks where we are, for the address or location: write the address text from ADMIN-SET DETAILS in your message, remind them to call before coming, and add a separate line exactly: SEND_LOCATION — the map pin is then sent automatically after your message. Only add SEND_LOCATION if LOCATION PIN says "saved".

STYLE
- Warm and confident, like a good seller who knows laptops well. 1-2 emojis per reply at most (😊 💻 👍 ✅).
- Length: as short as possible while answering everything — usually 2-6 lines. No markdown (no **, #, tables).
- End most replies with one short question or next step (e.g. "Qaysi biri yoqdi?", "Rasmlarini admin tashlab beradi", "Kelib ko'rasizmi yoki dostavka qilaylikmi?").
- If asked whether you are a human: honestly say you are noutgo's AI assistant (yordamchi) and a human admin can join any time.

HANDOFF (call the human admin)
Add a final line exactly: HANDOFF: <short reason in English>
Use it when the customer: wants to buy, reserve, come and see, or get delivery; asks for photos/videos of the actual device; asks for a discount; wants to sell or trade in a device; has a complaint, warranty or repair question; asks something you cannot answer from the info; or asks for a human. Above it, still give a full polite reply and say the admin will write shortly, e.g. "Hozir admin yozadi ✅" / "Сейчас администратор Вам напишет ✅".

Lines HANDOFF and SEND_LOCATION may both be used in one reply.

NO REPLY
If the latest message needs no answer (just "ok", "rahmat", "спасибо", a sticker at the end of a conversation), output exactly: NO_REPLY

EXAMPLES (style only — real prices and items always come from PRODUCT LIST)
Customer: "salom macbook bormi"
You: "[uz] Assalomu alaykum! Xush kelibsiz 😊
Hozircha MacBook yo'q. Shu narxlarda Surface noutbuklarimiz bor:
💻 Surface Laptop 4 13.5" — Ryzen 7, 16/512, sensorli ekran — 280$
Nimaga kerak edi — o'qishgami, dizayngami? Yangi kelgan modellar haqida admin aytib beradi.
HANDOFF: asked for MacBook, not in stock"

Customer: "surface laptop 4 qancha? batareyasi qanaqa"
You: "[uz] Surface Laptop 4 13.5" — Ryzen 7, 16/512, sensorli ekran — 280$ 👍
Bu model batareyasi bo'yicha kuchli: yangi holatida testlarda 9-12 soatgacha ishlagan.
Aynan shu noutbukning batareya holatini admin aytib beradi, hozir yozadi.
HANDOFF: asks battery health of Surface Laptop 4"

Customer: "Здравствуйте, есть ноутбук для учебы до 250$? И есть доставка?"
You: "[ru] Здравствуйте! 😊
Для учёбы в этот бюджет хорошо подойдут:
💻 Surface Laptop Go — i5, 8GB, 12.4" сенсорный, очень лёгкий — 210$
Доставка есть по всему Узбекистану, цену и сроки сейчас уточнит администратор ✅
HANDOFF: delivery price for Surface Laptop Go"`;

const FOOTERS: Record<string, string> = {
  uz: "🤖 Ushbu xabar noutgo yordamchisi tomonidan yuborildi. Asosiy admin ham tez orada javob beradi.",
  uzc: "🤖 Ушбу хабар noutgo ёрдамчиси томонидан юборилди. Асосий админ ҳам тез орада жавоб беради.",
  ru: "🤖 Это сообщение отправил помощник noutgo. Основной администратор тоже скоро ответит.",
};

async function modelKnowledge(): Promise<string> {
  const { data } = await db.from("model_info").select("model,info").order("model");
  return (data ?? []).map((r: any) => `- ${r.model}: ${r.info}`).join("\n");
}

const GROUP_RULES = `
GROUP MODE — you are answering in the PUBLIC comments/discussion group of the noutgo Telegram channel.
- Only answer messages that are questions or requests to noutgo (price, specs, availability, battery, delivery, payment, warranty, location, how to buy). If the message is chit-chat, a reaction, people talking to each other, spam, or not for noutgo, output exactly NO_REPLY.
- The message may be a comment under a channel post; POST is the text of that post — use it to know which laptop they mean.
- Keep it short (1-4 lines). Don't greet with a long greeting; a short "Assalomu alaykum!" is fine for a first question.
- Never write the address, the emergency phone, or anything private in the group. If they ask for location/address: write in the group that we are sending the location to their private messages, and add a separate line exactly: SEND_LOCATION_DM
- For buying, reservation, discount or anything personal: invite them to write to @noutgo in private, and add HANDOFF.
- Don't start the reply with a language tag other than the required one.`;

async function history(chatId: number) {
  const { data } = await db
    .from("bot_messages").select("role,content")
    .eq("chat_id", chatId).order("id", { ascending: false }).limit(HISTORY_LIMIT);
  const msgs: { role: string; content: string }[] = [];
  for (const r of (data ?? []).reverse()) {
    const last = msgs[msgs.length - 1];
    if (last && last.role === r.role) last.content += "\n" + r.content;
    else msgs.push({ role: r.role, content: r.content });
  }
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  return msgs;
}

async function askClaude(chatId: number, override?: { role: string; content: string }[], group = false): Promise<string> {
  const msgs = override ?? (await history(chatId));
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return "NO_REPLY";
  const [info, products] = await Promise.all([getSetting("business_info"), productList()]);
  const { data: lastBot } = await db.from("bot_messages").select("created_at")
    .eq("chat_id", chatId).eq("role", "assistant").order("id", { ascending: false }).limit(1);
  const greet = !group && (!lastBot?.length || Date.now() - new Date(lastBot[0].created_at).getTime() > 12 * 3600_000);
  const knowledge = await modelKnowledge();
  const extraRules = await getSetting("extra_rules");
  const [pin, address, emergency] = await Promise.all([getSetting("shop_location"), getSetting("address_text"), getSetting("emergency_phone")]);
  const extra = `\nADMIN-SET DETAILS (override any "pending" placeholders above):\nAddress text: ${address || "(not set — send the pin or HANDOFF)"}\nEmergency phone: ${emergency || "(not set — HANDOFF instead)"}`;
  const system = `${RULES}${extraRules ? "\n\nADMIN EXTRA RULES (follow these too):\n" + extraRules : ""}${group ? "\n" + GROUP_RULES : ""}${greet ? "\n\nGREETING NEEDED" : ""}\n\nLOCATION PIN: ${pin ? "saved" : "not saved"}\n\n=== BUSINESS INFO ===\n${info || "(not filled in yet)"}${extra}\n\n=== PRODUCT LIST ===\n${
    products || "(no product list available — hand off price/stock questions)"
  }\n\n=== MODEL KNOWLEDGE (researched specs + independent battery tests on new units) ===\n${knowledge || "(none)"}`;
  // Provider: bot_settings.ai_provider = "gemini" | "claude" (default claude). Falls back to the other one on error.
  const provider = (await getSetting("ai_provider", "claude")).toLowerCase();
  const order = provider === "gemini" ? ["gemini", "claude"] : ["claude", "gemini"];
  let lastErr: unknown = null;
  for (const p of order) {
    try {
      if (p === "gemini" && GEMINI_API_KEY) return await callGemini(system, msgs);
      if (p === "claude" && ANTHROPIC_API_KEY) return await callClaude(system, msgs);
    } catch (e) {
      lastErr = e;
      console.error(`${p} failed, trying fallback`, String(e).slice(0, 300));
    }
  }
  throw lastErr ?? new Error("No AI provider configured");
}

async function callClaude(system: string, msgs: { role: string; content: string }[]): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1000, system, messages: msgs }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Claude error: " + JSON.stringify(j));
  return (j.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
}

async function callGemini(system: string, msgs: { role: string; content: string }[]): Promise<string> {
  const main = await getSetting("gemini_model", "gemini-3.1-flash-lite");
  const models = [main, main, main === "gemini-3.5-flash-lite" ? "gemini-3.6-flash" : "gemini-3.5-flash-lite"];
  let lastErr: unknown = null;
  for (let i = 0; i < models.length; i++) {
    try {
      return await callGeminiModel(models[i], system, msgs);
    } catch (e) {
      lastErr = e;
      console.error(`gemini ${models[i]} attempt ${i + 1} failed`, String(e).slice(0, 200));
      await sleep(1500);
    }
  }
  throw lastErr;
}

async function callGeminiModel(model: string, system: string, msgs: { role: string; content: string }[]): Promise<string> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": GEMINI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: msgs.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: 2048, temperature: 0.6 },
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Gemini error: " + JSON.stringify(j));
  const text = (j.candidates?.[0]?.content?.parts ?? []).filter((p: any) => p.text && !p.thought).map((p: any) => p.text).join("").trim();
  if (!text) throw new Error("Gemini empty answer: " + JSON.stringify(j).slice(0, 300));
  return text;
}

// ------------------------------------------------------------ business chats
async function chatPaused(chatId: number): Promise<boolean> {
  const { data } = await db.from("bot_chats").select("paused_until").eq("chat_id", chatId).maybeSingle();
  return !!data?.paused_until && new Date(data.paused_until).getTime() > Date.now();
}

async function latestUserMsgId(chatId: number): Promise<number> {
  const { data } = await db.from("bot_messages").select("id")
    .eq("chat_id", chatId).eq("role", "user").order("id", { ascending: false }).limit(1);
  return data?.[0]?.id ?? 0;
}

function parseAnswer(raw: string) {
  let answer = raw;
  const hm = answer.match(/^\s*HANDOFF:\s*(.+)$/m);
  answer = answer.replace(/^\s*HANDOFF:.*$/gm, "").trim();
  const wantsLocationDm = /^\s*SEND_LOCATION_DM\s*$/m.test(answer);
  answer = answer.replace(/^\s*SEND_LOCATION_DM\s*$/gm, "").trim();
  const wantsLocation = /^\s*SEND_LOCATION\s*$/m.test(answer);
  answer = answer.replace(/^\s*SEND_LOCATION\s*$/gm, "").trim();
  const tag = answer.match(/^\s*\[(uz|uzc|ru)\]\s*/i);
  const lang = tag ? tag[1].toLowerCase() : /[а-яё]/i.test(answer) ? "ru" : "uz";
  if (tag) answer = answer.slice(tag[0].length).trim();
  if (answer.toUpperCase().includes("NO_REPLY") && answer.length < 20) answer = "NO_REPLY";
  return { answer, lang, handoff: hm ? hm[1].trim() : null, wantsLocation, wantsLocationDm };
}

async function footerFor(lang: string) {
  return (await getSetting(`footer_${lang}`)) || FOOTERS[lang] || FOOTERS.uz;
}

async function anyOwner(): Promise<Conn | null> {
  const { data } = await db.from("bot_owners").select("*").limit(1);
  return (data?.[0] as Conn) ?? null;
}

async function notifyOwner(ownerChat: number, who: string, reason: string, last: string, url?: string) {
  await tg("sendMessage", {
    chat_id: ownerChat,
    text: `🔔 Customer needs you: ${who}\nReason: ${reason}\nLast message: ${last.slice(0, 500)}`,
    reply_markup: url ? { inline_keyboard: [[{ text: "Open", url }]] } : undefined,
  });
}

// Customer conversation — either inside the owner's account (connId set) or directly with the bot (connId null)
async function handleCustomer(m: any, connId: string | null, ownerChat: number | null) {
  const chatId = m.chat.id;
  const via = connId ? { business_connection_id: connId } : {};
  const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ");
  await db.from("bot_chats").upsert({ chat_id: chatId, customer_name: name, username: m.from?.username ?? null, updated_at: new Date().toISOString() });
  const { data: ins } = await db.from("bot_messages")
    .insert({ chat_id: chatId, role: "user", content: describe(m) }).select("id").single();
  const myId = ins?.id;

  // Wait so the customer can finish typing; only the newest message's task answers.
  await sleep(REPLY_DELAY_MS);
  if ((await latestUserMsgId(chatId)) !== myId) return;
  if ((await getSetting("ai_enabled", "1")) !== "1" || (await chatPaused(chatId))) return;

  await tg("sendChatAction", { chat_id: chatId, action: "typing", ...via });
  const r = parseAnswer(await askClaude(chatId));

  if ((await latestUserMsgId(chatId)) !== myId || (await chatPaused(chatId))) return; // newer message or owner took over
  if (r.answer && r.answer !== "NO_REPLY") {
    await tg("sendMessage", { chat_id: chatId, text: `${r.answer}\n\n${await footerFor(r.lang)}`, ...via });
    await db.from("bot_messages").insert({ chat_id: chatId, role: "assistant", content: r.answer });
  }
  if (r.wantsLocation || r.wantsLocationDm) await sendShopLocation(chatId, connId);
  if (r.handoff && ownerChat) {
    const who = name + (m.from?.username ? ` (@${m.from.username})` : "");
    await notifyOwner(ownerChat, who, r.handoff, describe(m), m.from?.username ? `https://t.me/${m.from.username}` : undefined);
  }
}

async function onBusinessMessage(m: any) {
  if (m.sender_business_bot) return; // our own reply echoing back
  const chatId = m.chat.id;
  const conn = await getConn(m.business_connection_id);
  if (!conn) return;

  if (m.from?.id === conn.owner_id) {
    // Owner replied manually: remember it, AI stays quiet in this chat for a while.
    await db.from("bot_messages").insert({ chat_id: chatId, role: "assistant", content: describe(m) });
    await db.from("bot_chats").upsert({
      chat_id: chatId,
      paused_until: new Date(Date.now() + TAKEOVER_MINUTES * 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    });
    return;
  }
  if (!conn.is_enabled || !conn.can_reply) return;
  await handleCustomer(m, conn.conn_id, conn.owner_chat);
}

// ------------------------------------------------------------ channel discussion group
let botUsername = "";
async function getBotUsername() {
  if (!botUsername) botUsername = (await tg("getMe", {})).result?.username ?? "";
  return botUsername;
}

async function sendLocationDm(userId: number): Promise<boolean> {
  const raw = await getSetting("shop_location");
  if (!raw) return false;
  const loc = JSON.parse(raw);
  const address = await getSetting("address_text");
  const r = await tg("sendLocation", { chat_id: userId, latitude: loc.latitude, longitude: loc.longitude });
  if (!r.ok) return false;
  await tg("sendMessage", {
    chat_id: userId,
    text: `📍 noutgo manzili${address ? `: ${address}` : ""}\nKelishdan oldin qo'ng'iroq qilib qo'ying: +998 50 570 55 79\nSavollar bo'lsa shu yerga yoki @noutgo ga yozing 😊`,
  });
  return true;
}

async function onGroupMessage(m: any) {
  console.log("group message", JSON.stringify({ chat: m.chat?.id, from: m.from?.id, sender_chat: m.sender_chat?.id, auto: !!m.is_automatic_forward, hasText: !!(m.text ?? m.caption) }));
  if (m.is_automatic_forward || m.sender_chat || m.from?.is_bot) return; // channel posts, anonymous admins, bots
  const text = m.text ?? m.caption;
  if (!text || text.startsWith("/")) return;
  const owner = await anyOwner();
  if (owner && m.from?.id === owner.owner_id) return; // the admin writing himself
  if ((await getSetting("ai_enabled", "1")) !== "1") return;

  const post = m.reply_to_message?.text ?? m.reply_to_message?.caption ?? "";
  const content = (post ? `POST: ${post.slice(0, 1500)}\n\n` : "") + `COMMENT from ${m.from?.first_name ?? "user"}: ${text}`;
  const r = parseAnswer(await askClaude(m.chat.id, [{ role: "user", content }], true));
  console.log("group answer", JSON.stringify({ noReply: r.answer === "NO_REPLY", handoff: r.handoff, loc: r.wantsLocationDm }));

  let extra = "";
  let button: any = undefined;
  if (r.wantsLocationDm) {
    const ok = await sendLocationDm(m.from.id);
    if (!ok) {
      // The bot can only write first to people who started it — give them a one-tap button
      const u = await getBotUsername();
      extra = r.lang === "ru" ? "Нажмите кнопку ниже — бот сразу пришлёт локацию 👇" : "Pastdagi tugmani bosing — bot lokatsiyani darhol yuboradi 👇";
      button = { inline_keyboard: [[{ text: "📍 Lokatsiya / Локация", url: `https://t.me/${u}?start=location` }]] };
    }
  }
  if (r.answer && r.answer !== "NO_REPLY") {
    await tg("sendMessage", {
      chat_id: m.chat.id,
      text: `${r.answer}${extra ? "\n" + extra : ""}\n\n${await footerFor(r.lang)}`,
      reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true },
      reply_markup: button,
    });
  }
  if (r.handoff && owner) {
    const who = (m.from?.first_name ?? "") + (m.from?.username ? ` (@${m.from.username})` : "") + " — in channel comments";
    const url = m.chat.username ? `https://t.me/${m.chat.username}/${m.message_id}` : undefined;
    await notifyOwner(owner.owner_chat, who, r.handoff, text, url);
  }
}

async function sendShopLocation(chatId: number, connId: string | null) {
  const raw = await getSetting("shop_location");
  if (!raw) return;
  const loc = JSON.parse(raw);
  if (loc.title) {
    await tg("sendVenue", {
      chat_id: chatId, ...(connId ? { business_connection_id: connId } : {}),
      latitude: loc.latitude, longitude: loc.longitude, title: loc.title, address: loc.address ?? "",
    });
  } else {
    await tg("sendLocation", { chat_id: chatId, ...(connId ? { business_connection_id: connId } : {}), latitude: loc.latitude, longitude: loc.longitude });
  }
}

async function onBusinessConnection(c: any) {
  const row = connRow(c);
  await db.from("bot_owners").upsert(row);
  const state = row.is_enabled ? "connected ✅" : "disconnected ❌";
  await tg("sendMessage", {
    chat_id: row.owner_chat,
    text: `AI admin ${state}.\nReply permission: ${row.can_reply ? "yes" : "NO — turn on “Reply to messages” in Telegram Business → Chatbots"}`,
  });
}

// ------------------------------------------------------------ owner control panel (private chat with the bot)
async function onPrivateMessage(m: any) {
  const text: string = m.text ?? "";
  const reply = (t: string) => tg("sendMessage", { chat_id: m.chat.id, text: t });
  const [cmd] = text.split(/\s+/);
  const arg = text.slice(cmd.length).trim();

  const owner = await isOwner(m.from.id);
  if (cmd === "/start" && arg === "location") {
    if (!(await sendLocationDm(m.from.id))) await reply("Lokatsiya hozircha kiritilmagan, @noutgo ga yozing 🙏");
    return;
  }
  if (!owner) {
    if (cmd.startsWith("/") && cmd !== "/start") {
      return reply(`⚠️ Bu buyruqlar faqat admin uchun. (Your ID ${m.from.id} is not the connected business account.)`);
    }
    if (cmd === "/start") {
      return reply("Assalomu alaykum! Men noutgo yordamchisiman 😊\nNoutbuklar, narxlar, batareya, dostavka — xohlagan savolingizni yozing.\nKanal: @noutgo_uz · Admin: @noutgo");
    }
    const o = await anyOwner();
    return handleCustomer(m, null, o?.owner_chat ?? null);
  }
  if (cmd === "/start") {
    return reply(
      "noutgo AI admin 🤖\n\nConnect me: Telegram Settings → Telegram Business → Chatbots → add this bot, turn on “Reply to messages”.\n\n" +
        "Owner commands:\n/on — AI answers customers\n/off — AI stops answering\n/status — current state\n" +
        "/info — show shop info the AI uses\n/info <text> — replace shop info\n📍 Send a location — set the pin the AI sends to customers\n/location — show the saved pin\n/address <text> — set address\n/emergency <number> — set emergency phone",
    );
  }
  if (m.location || m.venue) {
    const v = m.venue;
    const loc = v
      ? { latitude: v.location.latitude, longitude: v.location.longitude, title: v.title, address: v.address }
      : { latitude: m.location.latitude, longitude: m.location.longitude };
    await setSetting("shop_location", JSON.stringify(loc));
    return reply("📍 Shop location saved. The AI will send this pin to customers who ask where you are.");
  }
  if (cmd === "/location") {
    const raw = await getSetting("shop_location");
    if (!raw) return reply("No location saved yet — send me your shop location (📎 → Location).");
    const loc = JSON.parse(raw);
    return tg("sendLocation", { chat_id: m.chat.id, latitude: loc.latitude, longitude: loc.longitude });
  }
  if (cmd === "/address") {
    if (!arg) return reply(`Current address: ${(await getSetting("address_text")) || "(not set)"}\nTo set: /address <full address and landmark>`);
    await setSetting("address_text", arg);
    return reply("✅ Address saved.");
  }
  if (cmd === "/emergency") {
    if (!arg) return reply(`Current emergency number: ${(await getSetting("emergency_phone")) || "(not set)"}\nTo set: /emergency <phone number>`);
    await setSetting("emergency_phone", arg);
    return reply("✅ Emergency number saved. The AI gives it only if a customer has arrived and can't reach you, or says nobody answers the main number.");
  }
  if (cmd === "/on") { await setSetting("ai_enabled", "1"); return reply("✅ AI is ON"); }
  if (cmd === "/off") { await setSetting("ai_enabled", "0"); return reply("⏸ AI is OFF — customers won't get automatic replies"); }
  if (cmd === "/info") {
    if (arg) { await setSetting("business_info", arg); return reply("✅ Shop info updated. The AI uses it from the next message."); }
    return reply((await getSetting("business_info")) || "(empty) — send /info followed by your shop info");
  }
  if (cmd === "/status") {
    const products = await productList();
    const { count } = await db.from("bot_chats").select("*", { count: "exact", head: true });
    const { count: paused } = await db.from("bot_chats").select("*", { count: "exact", head: true })
      .gt("paused_until", new Date().toISOString());
    return reply(
      `AI: ${(await getSetting("ai_enabled", "1")) === "1" ? "ON ✅" : "OFF ⏸"}\nProvider: ${await getSetting("ai_provider", "claude")} (${(await getSetting("ai_provider", "claude")) === "gemini" ? await getSetting("gemini_model", "gemini-3.1-flash-lite") : MODEL})\nGemini key: ${GEMINI_API_KEY ? "yes" : "no"} · Claude key: ${ANTHROPIC_API_KEY ? "yes" : "no"}\n` +
        `Products: ${products ? products.split("\n").length : 0}\nCustomer chats: ${count ?? 0}\nChats you took over: ${paused ?? 0}\n` +
        `Location pin: ${(await getSetting("shop_location")) ? "saved ✅" : "not set"}\nAddress: ${(await getSetting("address_text")) || "not set"}\n` +
        `Emergency number: ${(await getSetting("emergency_phone")) || "not set"}`,
    );
  }
  return reply(
    "I didn't understand that. Commands:\n📍 send a Location (📎 → Location) — shop pin\n/address <text> — address\n/emergency <number> — emergency phone\n" +
      "/info — shop info\n/status — check everything\n/on, /off — AI replies",
  );
}

// ------------------------------------------------------------ HTTP entry
addEventListener("unhandledrejection", (ev: any) => { console.error("unhandled", ev.reason); ev.preventDefault(); });

Deno.serve(async (req) => {
  if (!BOT_TOKEN || (!ANTHROPIC_API_KEY && !GEMINI_API_KEY)) return new Response("Missing TELEGRAM_BOT_TOKEN or an AI key (GEMINI_API_KEY / ANTHROPIC_API_KEY)", { status: 500 });
  const url = new URL(req.url);
  const secret = await webhookSecret();

  // One-time setup: open  .../functions/v1/telegram-bot?setup=1  in a browser.
  // Security: the webhook is owned by noutgo-hub, which forwards updates here. This public setup link used to
  // re-point the webhook without any password, which would cut off the shop and channel automation. Disabled.
  if (req.method === "GET" && url.searchParams.get("setup")) return new Response("disabled — webhook is managed by noutgo-hub", { status: 410 });
  if (false) {
    const r = await tg("setWebhook", {
      url: FUNCTION_URL,
      secret_token: secret,
      allowed_updates: ["message", "business_message", "business_connection"],
      drop_pending_updates: true,
    });
    await tg("setMyCommands", {
      commands: [
        { command: "status", description: "AI status" },
        { command: "on", description: "Turn AI replies on" },
        { command: "off", description: "Turn AI replies off" },
        { command: "info", description: "Show / update shop info" },
        { command: "address", description: "Set address text" },
        { command: "emergency", description: "Set emergency phone" },
        { command: "location", description: "Show saved location pin" },
      ],
    });
    const me = await tg("getMe", {});
    return new Response(
      r.ok ? `✅ Webhook set for @${me.result?.username}. Now open the bot in Telegram and press Start.` : `❌ ${r.description}`,
      { headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  if (req.method !== "POST") return new Response("ok");
  if (req.headers.get("x-telegram-bot-api-secret-token") !== secret) return new Response("forbidden", { status: 403 });

  const update = await req.json();
  console.log("update", Object.keys(update).filter((k) => k !== "update_id").join(","), update.message?.chat?.type ?? "");
  const task = (async () => {
    try {
      if (update.business_message) await onBusinessMessage(update.business_message);
      else if (update.business_connection) await onBusinessConnection(update.business_connection);
      else if (update.message?.chat?.type === "private") await onPrivateMessage(update.message);
      else if (["group", "supergroup"].includes(update.message?.chat?.type)) await onGroupMessage(update.message);    } catch (e) {
      console.error("handler error", e);
    }
  })();
  EdgeRuntime.waitUntil(task);
  return new Response("ok"); // answer Telegram immediately; work continues in background
});
