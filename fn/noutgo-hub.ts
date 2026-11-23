// noutgo-hub v2 — the single Telegram webhook for @noutgo_robot.
//  • Business chats, the discussion group and every non-tester private chat go unchanged to `telegram-bot` (live AI admin).
//  • Testers get the new shop: catalog, photo cards, offers, orders (pickup with 3 payment options, BTS by office),
//    card payment + receipt check, tracking with photo, receipt confirmation + feedback, money-only referrals.
//  • Channel: deletes "photo updated" notices; logs posts / joins / leaves / reactions / comments.
//  While shop_live = 0 every order is a test order: real stock and the channel are never touched.
import { createClient } from "npm:@supabase/supabase-js@2";

const BOT = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const GEMINI = Deno.env.get("GEMINI_API_KEY") ?? "";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default;
const db = createClient(SUPA, KEY, { auth: { persistSession: false } });
const OLD_URL = `${SUPA}/functions/v1/telegram-bot`;
const HUB_URL = `${SUPA}/functions/v1/noutgo-hub`;
const ADMIN = 7420108945;
const CHANNEL = -1002274386795;
const GROUP = -1004390038893;
const PHONE = "+998 50 570 55 79";
const REGIONS = ["Toshkent sh.", "Toshkent vil.", "Samarqand", "Buxoro", "Farg'ona", "Andijon", "Namangan", "Qashqadaryo", "Surxondaryo", "Xorazm", "Navoiy", "Jizzax", "Sirdaryo", "Qoraqalpog'iston"];
const MENU = ["💻 Katalog", "🔎 Byudjet bo'yicha", "📦 Buyurtmalarim", "🎁 Do'stni taklif qilish", "💬 Admin bilan bog'lanish", "🛠 Admin panel"];
const LEGACY = ["/on", "/off", "/status", "/info", "/address", "/emergency", "/location", "/help"];
const ACTIVE = ["await_pay", "checking", "reserved", "paid", "ready", "shipped"];
const INFO_POST = "https://t.me/noutgo_uz/1669";
const PAGES = "https://nizomjonumaraliyev.github.io/github-slideshow";
const FX = { party: "5046509860389126442", fire: "5104841245755180586", like: "5107584321108051014", heart: "5159385139981059251" };
const ST: Record<string, string> = { await_pay: "⏳ to'lov kutilmoqda", checking: "🔎 chek tekshirilmoqda", reserved: "🔒 band qilingan", paid: "✅ to'landi", ready: "📦 olib ketishga tayyor", shipped: "🚚 yo'lda", delivered: "📬 yetkazildi", received: "🎉 qabul qilindi", cancelled: "❌ bekor qilingan", expired: "⌛ muddati o'tgan", rejected: "⚠️ to'lov topilmadi" };

// ------------------------------------------------------------------ helpers
async function sha(s: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}
async function tg(method: string, body: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${BOT}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) console.error("tg", method, j.description);
  return j;
}
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const som = (n: number) => Math.round(Number(n) || 0).toLocaleString("ru-RU").replace(/[  ,]/g, " ");
async function setting(k: string, d = "") { const { data } = await db.from("bot_settings").select("value").eq("key", k).maybeSingle(); return data?.value ?? d; }
async function setSetting(k: string, v: string) { await db.from("bot_settings").upsert({ key: k, value: v }); }
async function num(k: string, d: number) { return Number(await setting(k, String(d))) || d; }
async function live() { return (await setting("shop_live", "0")) === "1"; }
async function appUrl() { return await setting("miniapp_url", ""); }
async function log(source: string, kind: string, user_id?: number | null, product_id?: number | null, data?: unknown) {
  await db.from("events").insert({ source, kind, user_id: user_id ?? null, product_id: product_id ?? null, data: data ?? null });
}
async function forward(update: unknown) {
  const r = await fetch(OLD_URL, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": await sha("noutgo:" + BOT) }, body: JSON.stringify(update) });
  if (!r.ok) console.error("forward failed", r.status);
}
async function send(chat: number, text: string, extra: Record<string, unknown> = {}) {
  return tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });
}
async function rich(chat: number, html: string, fallback: string, markup?: unknown, effect?: string) {
  const fx = effect ? { message_effect_id: effect } : {};
  const r = await tg("sendRichMessage", { chat_id: chat, rich_message: { html }, ...fx, ...(markup ? { reply_markup: markup } : {}) });
  if (r.ok) return r;
  return send(chat, fallback, { ...fx, ...(markup ? { reply_markup: markup } : {}) });
}
// Animated emoji stickers from Telegram's official set, cached in settings.
async function sticker(chat: number, emoji: string) {
  try {
    let map = JSON.parse((await setting("anim_stickers")) || "{}");
    if (!Object.keys(map).length) {
      const s = await tg("getStickerSet", { name: "AnimatedEmojies" });
      for (const x of s.result?.stickers ?? []) if (x.emoji && !map[x.emoji]) map[x.emoji] = x.file_id;
      if (Object.keys(map).length) await setSetting("anim_stickers", JSON.stringify(map));
    }
    const id = map[emoji] ?? map[emoji.replace("\ufe0f", "")] ?? map["🎉"];
    if (id) await tg("sendSticker", { chat_id: chat, sticker: id });
  } catch (e) { console.error("sticker", e); }
}
const due = (o: any) => Math.max(0, Number(o.total_uzs) - Number(o.paid_uzs ?? 0));
const who = (c: any) => `${esc(c?.first_name ?? c?.name ?? "")}${c?.username ? " @" + esc(c.username) : ""}`;

// ------------------------------------------------------------------ testers & customers
type Tester = { user_id: number; role: "admin" | "tester" };
async function tester(from: any): Promise<Tester | null> {
  if (!from) return null;
  let { data } = await db.from("bot_testers").select("user_id,username,role").eq("user_id", from.id).maybeSingle();
  if (!data && from.username) {
    const r = await db.from("bot_testers").select("id,user_id,username,role").ilike("username", from.username).maybeSingle();
    if (r.data) { await db.from("bot_testers").update({ user_id: from.id }).eq("id", (r.data as any).id); data = { ...r.data, user_id: from.id } as any; }
  }
  return data ? { user_id: from.id, role: (data as any).role } : null;
}
async function customer(from: any): Promise<{ row: any; isNew: boolean }> {
  const { data } = await db.from("customers").select("*").eq("user_id", from.id).maybeSingle();
  if (data) { await db.from("customers").update({ last_seen: new Date().toISOString(), first_name: from.first_name, username: from.username ?? null }).eq("user_id", from.id); return { row: data, isNew: false }; }
  const row = { user_id: from.id, first_name: from.first_name, username: from.username ?? null, lang: from.language_code ?? null };
  await db.from("customers").insert(row);
  return { row: { ...row, session: null, ref_code: null }, isNew: true };
}
async function session(uid: number) { const { data } = await db.from("customers").select("session").eq("user_id", uid).maybeSingle(); return (data?.session ?? {}) as any; }
async function setSession(uid: number, s: unknown) { await db.from("customers").update({ session: s }).eq("user_id", uid); }

// ------------------------------------------------------------------ referrals (money only)
async function refCode(from: any) {
  const { data } = await db.from("customers").select("ref_code").eq("user_id", from.id).maybeSingle();
  if (data?.ref_code) return data.ref_code;
  const code = (String(from.first_name || "NG").replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 6) || "NG") + (100 + Math.floor(Math.random() * 899));
  await db.from("customers").update({ ref_code: code }).eq("user_id", from.id);
  return code;
}
async function applyReferral(from: any, code: string, isNew: boolean) {
  const { data: ref } = await db.from("customers").select("user_id,first_name,username").eq("ref_code", code).maybeSingle();
  if (!ref || ref.user_id === from.id) return;
  if (!isNew) { await send(from.id, "ℹ️ Taklif havolasi faqat botga birinchi marta kirayotgan yangi mijozlar uchun amal qiladi."); return; }
  const ins = await db.from("referrals").insert({ code, referrer_id: ref.user_id, friend_id: from.id, state: "joined", notified: true });
  if (ins.error) return;
  await db.from("customers").update({ referred_by: ref.user_id, source: "ref_" + code }).eq("user_id", from.id);
  const bonus = await num("ref_friend_uzs", 100000), reward = await num("ref_reward_uzs", 150000);
  await log("bot", "referral", from.id, null, { referrer: ref.user_id, code });
  await sticker(from.id, "🎁");
  await send(from.id, `🎁 Sizni <b>${who(ref)}</b> taklif qildi!\nBirinchi noutbukingizga <b>${som(bonus)} so'm</b> chegirma beriladi — u buyurtmada avtomatik hisoblanadi.`);
  await send(ref.user_id, `🎉 Do'stingiz <b>${who(from)}</b> sizning havolangiz orqali botga qo'shildi!\nU noutbuk sotib olib, 14 kun ichida qaytarmasa, sizga <b>${som(reward)} so'm</b> beriladi.`, { message_effect_id: FX.party });
  await send(ADMIN, `👥 <b>Yangi taklif</b>\n${who(from)} (ID ${from.id})\n← taklif qilgan: ${who(ref)} (ID ${ref.user_id}, kod ${esc(code)})`);
}
async function friendDiscount(uid: number) {
  const { data: r } = await db.from("referrals").select("id").eq("friend_id", uid).eq("state", "joined").maybeSingle();
  if (!r) return 0;
  const { count } = await db.from("orders").select("*", { count: "exact", head: true }).eq("user_id", uid).in("state", ["paid", "ready", "shipped", "delivered", "received", "reserved"]);
  return (count ?? 0) ? 0 : await num("ref_friend_uzs", 100000);
}

// ------------------------------------------------------------------ catalog
type P = any;
async function products(category?: string): Promise<P[]> {
  let q = db.from("products").select("*").eq("status", "available").not("sku", "is", null).order("sort");
  if (category) q = q.eq("category", category);
  return (await q).data ?? [];
}
async function bySku(sku: string): Promise<P | null> { return (await db.from("products").select("*").eq("sku", sku).maybeSingle()).data; }
const dot = (p: P) => (p.color === "Silver" ? "⚪" : p.color ? "⚫" : "");
const short = (p: P) => String(p.model).replace("Microsoft ", "").replace("Surface ", "").replace(/\s*\(.*?\)/g, "").replace(/ \d+GB\/\d+\w+/, "");
const priceTxt = (p: P) => (p.price_usd ? `${p.price_usd}$` : esc(p.price));
async function activeOrder(productId: number) {
  return (await db.from("orders").select("id,user_id").eq("product_id", productId).in("state", ACTIVE).maybeSingle()).data;
}
function mainKb(isAdmin: boolean) {
  const rows: any[] = [[{ text: "💻 Katalog" }, { text: "🔎 Byudjet bo'yicha" }], [{ text: "📦 Buyurtmalarim" }, { text: "🎁 Do'stni taklif qilish" }], [{ text: "💬 Admin bilan bog'lanish" }]];
  if (isAdmin) rows.push([{ text: "🛠 Admin panel" }]);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}
// Mini App buttons must be inline (keyboard-button launches get no login data).
async function appRow(label = "🛍 Do'konni ochish (ilova)", hash = "") { const app = await appUrl(); return app ? [[{ text: label, web_app: { url: app + hash }, style: "primary" }]] : []; }

async function showCatalog(chat: number, list?: P[], title = "💻 Hozir sotuvda") {
  const items = list ?? await products();
  const laptops = items.filter((p) => p.category === "laptop"), acc = items.filter((p) => p.category !== "laptop");
  if (!items.length) return send(chat, "Bu oraliqda hozir noutbuk yo'q. Yangi kelganda xabar beraylikmi?", { reply_markup: { inline_keyboard: [[{ text: "🔔 Ha, xabar bering", callback_data: "notify" }], [{ text: "💻 Butun katalog", callback_data: "cat" }]] } });
  const rows = (arr: P[]) => arr.map((p) => `<tr><td>${esc(short(p))}</td><td>${p.ram_gb ? p.ram_gb + "GB / " + esc(p.ssd ?? "") : esc(p.screen ?? "")}</td><td><b>${priceTxt(p)}</b> ${dot(p)}</td></tr>`).join("");
  const html = `<h3>${esc(title)}</h3>${laptops.length ? `<table bordered striped><tr><th>Model</th><th>RAM / SSD</th><th>Narx</th></tr>${rows(laptops)}</table>` : ""}${acc.length ? `<h4>🛠 Aksessuarlar</h4><table bordered striped><tr><th>Mahsulot</th><th>Tafsilot</th><th>Narx</th></tr>${rows(acc)}</table>` : ""}<p><i>Batafsil ko'rish uchun tanlang.</i></p>`;
  const fb = `<b>${esc(title)}</b>\n\n` + items.map((p) => `${dot(p)} ${esc(short(p))} — <b>${priceTxt(p)}</b>`).join("\n");
  const kb: any[] = [];
  for (let i = 0; i < items.length; i += 2) kb.push(items.slice(i, i + 2).map((p) => ({ text: `${dot(p)} ${short(p)}`.trim(), callback_data: `card:${p.sku}:0` })));
  kb.push([{ text: "🔎 Byudjet bo'yicha", callback_data: "budget" }, { text: "⚖️ Solishtirish", callback_data: "cmp:" }]);
  kb.push(...(await appRow()));
  return rich(chat, html, fb, { inline_keyboard: kb });
}
async function cardCaption(p: P, uid: number) {
  const r = await num("usd_rate", 12000), s = await session(uid), deal = s.deals?.[p.sku];
  const lines = [
    `<b>${esc(p.model)}</b>`, "",
    p.cpu ? `⚙️ ${esc(p.cpu)}` : null,
    p.ram_gb ? `🧠 ${p.ram_gb}GB RAM · 🗃 ${esc(p.ssd)}` : null,
    p.screen ? `🖥 ${esc(p.screen)}` : null,
    p.gpu ? `🎮 ${esc(p.gpu)}` : null,
    p.color ? `🎨 ${esc(p.color)} ${dot(p)}` : null,
    p.battery_pct ? `🔋 Batareya: ${p.battery_pct}%${p.battery_hours ? " · " + esc(p.battery_hours) : ""}` : null,
    p.cond_score ? `✨ Holati: ${esc(p.cond_score)}` : null,
    p.defects ? `⚠️ ${esc(p.defects)}` : null,
    p.category === "laptop" ? "🔌 Original zaryadka · 🛡 2 hafta kafolat" : null,
    "",
    p.price_usd ? `💰 <b>${p.price_usd}$</b> ≈ ${som(p.price_usd * r)} so'm${deal ? `\n🤝 Siz uchun: <b>${deal}$</b>` : ""}` : `💰 <b>${esc(p.price)}</b>`,
  ].filter((x) => x !== null);
  return lines.join("\n").slice(0, 1000);
}
async function cardKb(p: P, i: number) {
  const n = (p.photo_ids ?? []).length;
  const kb: any[] = [];
  if (n > 1) kb.push([{ text: "◀", callback_data: `card:${p.sku}:${(i - 1 + n) % n}:e` }, { text: `📷 ${i + 1}/${n}`, callback_data: `alb:${p.sku}` }, { text: "▶", callback_data: `card:${p.sku}:${(i + 1) % n}:e` }]);
  kb.push([{ text: "🛒 Buyurtma berish", callback_data: `ord:${p.sku}`, style: "success" }]);
  kb.push([{ text: "💬 Narx taklif qilish", callback_data: `off:${p.sku}` }, { text: "📋 Xususiyatlar", callback_data: `spec:${p.sku}` }]);
  if (p.category === "laptop") kb.push([{ text: "⚖️ Solishtirish", callback_data: `cmp:${p.sku}` }, p.video_id ? { text: "🎥 Video", callback_data: `vid:${p.sku}` } : { text: "📤 Ulashish", url: `https://t.me/share/url?url=${encodeURIComponent("https://t.me/noutgo_robot?start=" + p.sku)}&text=${encodeURIComponent(short(p) + " — noutgo")}` }]);
  kb.push(...(await appRow("🛍 Ilovada ko'rish", `#p=${p.sku}`)));
  kb.push([{ text: "⬅️ Katalog", callback_data: "cat" }]);
  return { inline_keyboard: kb };
}
async function showCard(chat: number, uid: number, sku: string, i = 0, editMsg?: number) {
  const p = await bySku(sku);
  if (!p) return send(chat, "Bu mahsulot topilmadi.");
  if (p.status !== "available") return send(chat, "Bu mahsulot sotilgan 🙏 Boshqa modellarni ko'ring.", { reply_markup: { inline_keyboard: [[{ text: "💻 Katalog", callback_data: "cat" }]] } });
  const caption = await cardCaption(p, uid), kb = await cardKb(p, i);
  const photo = (p.photo_ids ?? [])[i];
  if (editMsg && photo) return tg("editMessageMedia", { chat_id: chat, message_id: editMsg, media: { type: "photo", media: photo, caption, parse_mode: "HTML" }, reply_markup: kb });
  await log("bot", "view", uid, p.id, { sku });
  if (photo) return tg("sendPhoto", { chat_id: chat, photo, caption, parse_mode: "HTML", reply_markup: kb });
  return send(chat, caption, { reply_markup: kb });
}
async function showSpec(chat: number, sku: string) {
  const p = await bySku(sku); if (!p) return;
  const row = (k: string, v: unknown) => (v ? `<tr><td>${k}</td><td>${esc(v)}</td></tr>` : "");
  const html = `<h3>📋 ${esc(p.model)}</h3><table bordered striped>${row("Protsessor", p.cpu)}${row("RAM", p.ram_gb ? p.ram_gb + "GB" : "")}${row("SSD", p.ssd)}${row("Ekran", p.screen)}${row("Grafika", p.gpu)}${row("Rang", p.color)}${row("Batareya", p.battery_pct ? p.battery_pct + "%" : "")}${row("Holati", p.cond_score)}${row("Kamchilik", p.defects)}${row("Izoh", p.description)}${row("Narx", priceTxt(p))}</table>`;
  const fb = `<b>📋 ${esc(p.model)}</b>\n` + [["Protsessor", p.cpu], ["RAM", p.ram_gb ? p.ram_gb + "GB" : ""], ["SSD", p.ssd], ["Ekran", p.screen], ["Grafika", p.gpu], ["Holati", p.cond_score], ["Kamchilik", p.defects], ["Narx", priceTxt(p)]].filter((x) => x[1]).map(([k, v]) => `${k}: ${esc(v)}`).join("\n");
  return rich(chat, html, fb, { inline_keyboard: [[{ text: "🛒 Buyurtma berish", callback_data: `ord:${p.sku}`, style: "success" }], [{ text: "⬅️ Kartaga qaytish", callback_data: `card:${p.sku}:0` }, { text: "💻 Katalog", callback_data: "cat" }]] });
}

// ------------------------------------------------------------------ offers
async function askOffer(chat: number, uid: number, sku: string) {
  const p = await bySku(sku); if (!p?.price_usd) return send(chat, "Bu mahsulot narxi bo'yicha admin bilan kelishiladi: @noutgo");
  const s = await session(uid); s.step = { t: "offer", sku }; await setSession(uid, s);
  const o = [5, 10, 20, 30].map((d) => p.price_usd - d);
  return send(chat, `💬 <b>${esc(short(p))}</b> — ${p.price_usd}$.\nQancha taklif qilasiz? Tugmani bosing yoki summani yozing (masalan: ${p.price_usd - 15}).`,
    { reply_markup: { inline_keyboard: [o.slice(0, 2).map((v) => ({ text: v + "$", callback_data: `bid:${sku}:${v}` })), o.slice(2).map((v) => ({ text: v + "$", callback_data: `bid:${sku}:${v}` })), [{ text: "⬅️ Kartaga qaytish", callback_data: `card:${sku}:0` }]] } });
}
async function bid(chat: number, from: any, sku: string, v: number) {
  const p = await bySku(sku); if (!p?.price_usd) return;
  const uid = from.id, s = await session(uid);
  s.step = null; s.rounds = s.rounds ?? {}; s.rounds[sku] = (s.rounds[sku] ?? 0) + 1; s.deals = s.deals ?? {};
  const { data: off } = await db.from("offers").insert({ product_id: p.id, user_id: uid, amount_usd: v, round: s.rounds[sku] }).select("id").single();
  await log("bot", "offer", uid, p.id, { v });
  const order = { inline_keyboard: [[{ text: "🛒 Buyurtma berish", callback_data: `ord:${sku}`, style: "success" }]] };
  if (v >= p.price_usd) { s.deals[sku] = p.price_usd; await setSession(uid, s); await db.from("offers").update({ decision: "accepted", decided_by: "bot", final_usd: p.price_usd }).eq("id", off!.id); return send(chat, `🤝 Kelishdik — ${p.price_usd}$!`, { reply_markup: order }); }
  if (p.floor_usd && v >= p.floor_usd) {
    if (s.rounds[sku] === 1) {
      const c = Math.min(p.price_usd, Math.ceil(((v + p.price_usd) / 2) / 5) * 5);
      await setSession(uid, s); await db.from("offers").update({ decision: "countered", decided_by: "bot", final_usd: c }).eq("id", off!.id);
      return send(chat, `Taklifingiz uchun rahmat! ${v}$ ga bera olmaymiz, lekin siz uchun <b>${c}$</b> qilib berishimiz mumkin.`, { reply_markup: { inline_keyboard: [[{ text: `✅ ${c}$ ga roziman`, callback_data: `acc:${sku}:${c}`, style: "success" }], [{ text: "💬 Boshqa narx", callback_data: `off:${sku}` }, { text: "💻 Arzonroq", callback_data: `bud:0:${p.price_usd}` }]] } });
    }
    s.deals[sku] = v; await setSession(uid, s); await db.from("offers").update({ decision: "accepted", decided_by: "bot", final_usd: v }).eq("id", off!.id);
    return send(chat, `🤝 Mayli, ${v}$ — kelishdik! Narx 2 soat saqlanadi.`, { reply_markup: order });
  }
  await setSession(uid, s);
  await send(chat, `Taklifingizni adminga yubordim 🙏 Javob shu yerga keladi.`);
  const mid = Math.round((v + p.price_usd) / 2 / 5) * 5;
  return send(ADMIN, `💬 <b>Narx taklifi</b>${(await live()) ? "" : " (test)"}\n${who(from)}\n${esc(p.model)}\nRo'yxatda: ${p.price_usd}$${p.floor_usd ? ` · chegara ${p.floor_usd}$` : " · chegara belgilanmagan"}\nTaklif: <b>${v}$</b>`,
    { reply_markup: { inline_keyboard: [[{ text: `✅ ${v}$ ga rozi`, callback_data: `aok:${off!.id}:${v}`, style: "success" }, { text: `↔️ ${mid}$`, callback_data: `aok:${off!.id}:${mid}` }], [{ text: "❌ Rad etish", callback_data: `ano:${off!.id}`, style: "danger" }]] } });
}

// ------------------------------------------------------------------ order: delivery choice
async function startOrder(chat: number, from: any, sku: string) {
  const p = await bySku(sku);
  if (!p || p.status !== "available") return send(chat, "Kechirasiz, bu mahsulot hozir mavjud emas.");
  if (!p.price_usd) return send(chat, "Bu mahsulotni @noutgo orqali buyurtma qiling 🙏");
  if (await activeOrder(p.id)) return send(chat, "Bu noutbuk hozir boshqa mijoz uchun band qilingan. Boshqa modellarni ko'rasizmi?", { reply_markup: { inline_keyboard: [[{ text: "💻 Katalog", callback_data: "cat" }]] } });
  const s = await session(from.id);
  s.cart = { sku, price: s.deals?.[sku] ?? p.price_usd }; s.step = null; await setSession(from.id, s);
  return send(chat, `🛒 <b>${esc(short(p))}</b> — ${s.cart.price}$\nQanday olasiz?`, { reply_markup: { inline_keyboard: [[{ text: "🏠 O'zim olib ketaman (Yunusobod)", callback_data: "dl:p" }], [{ text: "🚚 BTS orqali yetkazish", callback_data: "dl:b" }], [{ text: "⬅️ Kartaga qaytish", callback_data: `card:${sku}:0` }]] } });
}
async function pickupInfo(chat: number) {
  const loc = JSON.parse((await setting("shop_location")) || "null");
  const addr = (await setting("address_text")) || "Toshkent, Yunusobod 15-mavze, Mirzoobod ko'chasi, 13-uy";
  if (loc) await tg("sendVenue", { chat_id: chat, latitude: loc.latitude, longitude: loc.longitude, title: "noutgo", address: addr });
  return send(chat, `📍 <b>Olib ketish manzili</b>\n${esc(addr)}\n\n📞 ${PHONE}\n🕒 Har kuni, oldindan kelishilgan vaqtda (biz do'kon emasmiz — uydan ishlaymiz)\n\n⚠️ Kelishdan oldin, albatta, qo'ng'iroq qiling yoki @noutgo ga yozing.\n🔍 Noutbukni joyida to'liq tekshirib olasiz: ekran, klaviatura, batareya, portlar.`);
}
async function askPayMode(chat: number, bts = false) {
  const dep = await num("deposit_uzs", 300000);
  if (bts) return send(chat, `💳 <b>To'lov usuli</b>\n\n• <b>Oldindan qisman — ${som(dep)} so'm.</b> Noutbukni BTS'ga topshirib, chekini yuboramiz. BTS ilovasida qabul qilinganini tekshirgach, qolganini to'laysiz.\n• <b>Hozir to'liq to'lash.</b>\n\nℹ️ <a href="${INFO_POST}">To'lov va yetkazish tartibi</a>`,
    { reply_markup: { inline_keyboard: [[{ text: `🔒 Oldindan ${som(dep)} so'm`, callback_data: "pm:deposit", style: "primary" }], [{ text: "💳 To'liq to'lash", callback_data: "pm:full", style: "success" }]] } });
  return send(chat, `💳 <b>To'lov usulini tanlang</b>\n\n• <b>Hozir to'liq to'lash</b> — noutbuk sizga band qilinadi va tayyorlab turiladi.\n• <b>Band qilish uchun ${som(dep)} so'm</b> — sotib olishga aniq qaror qilgan bo'lsangiz, oldindan qisman to'lov qiling: noutbuk boshqaga sotilmaydi, qolgan qismini ko'rib, olib ketishda to'laysiz.\n• <b>Ko'rib, keyin to'lash</b> — kelib tekshirasiz, yoqsa joyida to'laysiz. Bunda noutbuk faqat 3 soatga band qilinadi.`,
    { reply_markup: { inline_keyboard: [[{ text: "💳 Hozir to'liq to'lash", callback_data: "pm:full", style: "success" }], [{ text: `🔒 Band qilish — ${som(dep)} so'm`, callback_data: "pm:deposit", style: "primary" }], [{ text: "🤝 Ko'rib, keyin to'lash", callback_data: "pm:later" }]] } });
}
async function askRegion(chat: number) {
  const kb: any[] = []; for (let i = 0; i < REGIONS.length; i += 2) kb.push(REGIONS.slice(i, i + 2).map((r) => ({ text: r, callback_data: `rg:${REGIONS.indexOf(r)}` })));
  return send(chat, "📍 Viloyatingizni tanlang — keyin tuman va BTS filialini tanlaysiz:", { reply_markup: { inline_keyboard: kb } });
}
async function cities(region: string) {
  const { data } = await db.from("bts_offices").select("city").eq("region", region);
  return [...new Set((data ?? []).map((x: any) => x.city as string))].sort((a, b) => a.localeCompare(b));
}
async function askCity(chat: number, ri: number) {
  const list = await cities(REGIONS[ri]);
  if (!list.length) return send(chat, "Bu viloyatda BTS filiali topilmadi. Boshqa viloyatni tanlang.", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Viloyatlar", callback_data: "dl:b" }]] } });
  const kb: any[] = []; for (let i = 0; i < list.length; i += 2) kb.push(list.slice(i, i + 2).map((c) => ({ text: c, callback_data: `ct:${ri}:${list.indexOf(c)}` })));
  kb.push([{ text: "⬅️ Viloyatlar", callback_data: "dl:b" }]);
  return send(chat, `🏙 <b>${esc(REGIONS[ri])}</b> — shahar yoki tumanni tanlang:`, { reply_markup: { inline_keyboard: kb } });
}
async function askOffice(chat: number, ri: number, ci: number) {
  const city = (await cities(REGIONS[ri]))[ci];
  const { data } = await db.from("bts_offices").select("code,name,address").eq("region", REGIONS[ri]).eq("city", city).order("code");
  const kb = (data ?? []).map((o: any) => [{ text: `${o.name} — ${o.address}`.slice(0, 60), callback_data: `of:${o.code}` }]);
  kb.push([{ text: "⬅️ Tumanlar", callback_data: `rg:${ri}` }]);
  return send(chat, `🏢 <b>${esc(city)}</b> — BTS filialini tanlang:`, { reply_markup: { inline_keyboard: kb } });
}
async function askName(chat: number, from: any) {
  const s = await session(from.id); s.step = { t: "name" }; await setSession(from.id, s);
  return send(chat, "👤 Qabul qiluvchining ismini yozing yoki tugmani bosing:", { reply_markup: { keyboard: [[{ text: `👤 ${from.first_name}` }], [{ text: "❌ Bekor qilish" }]], resize_keyboard: true, one_time_keyboard: true } });
}
async function askPhone(chat: number, from: any) {
  const s = await session(from.id); s.step = { t: "phone" }; await setSession(from.id, s);
  return send(chat, "📱 Telefon raqamingizni yuboring — admin va BTS shu raqam orqali bog'lanadi.", { reply_markup: { keyboard: [[{ text: "📱 Raqamni yuborish", request_contact: true }], [{ text: "❌ Bekor qilish" }]], resize_keyboard: true, one_time_keyboard: true } });
}

// ------------------------------------------------------------------ order: create
async function createOrder(chat: number, from: any, t: Tester) {
  const s = await session(from.id), c = s.cart; if (!c) return;
  const p = await bySku(c.sku); if (!p) return;
  const r = await num("usd_rate", 12000), base = c.price * r;
  const pickup = c.delivery === "p";
  const dfee = pickup ? 0 : (String(c.region ?? "").startsWith("Toshkent") ? 30000 : 45000);
  const disc = await friendDiscount(from.id);
  const mode: "full" | "deposit" | "later" = pickup ? (c.pay ?? "full") : (c.pay === "deposit" ? "deposit" : "full");
  const isLive = await live();
  const office = c.office ? (await db.from("bts_offices").select("*").eq("code", c.office).maybeSingle()).data : null;
  const ins = await db.from("orders").insert({
    number: `T-${Date.now().toString(36).toUpperCase()}`, user_id: from.id, product_id: p.id, price_usd: c.price, rate: r, price_uzs: base, delivery: pickup ? "pickup" : "bts",
    region: pickup ? "Toshkent, Yunusobod (olib ketish)" : `${c.region}, ${office?.city ?? ""}`, bts_office: office ? `${office.name} (${office.code}) — ${office.address}` : null,
    delivery_uzs: dfee, total_uzs: base + dfee - disc, name: c.name, phone: c.phone, pay_mode: mode === "later" ? "on_pickup" : mode,
    reserved_until: new Date(Date.now() + (mode === "later" ? 3 : 2) * 3600e3).toISOString(), channel: "bot", is_test: !isLive,
    state: mode === "later" ? "reserved" : "await_pay",
  }).select("id").single();
  if (ins.error) { console.error("order insert", ins.error.message); s.cart = null; await setSession(from.id, s); return send(chat, "Kechirasiz, bu noutbuk hozirgina band qilindi 🙏 Boshqa modellarni ko'ring.", { reply_markup: mainKb(t.role === "admin") }); }
  const id = ins.data.id, uniq = 10 + (id % 90), number = `N-${1000 + id}`;
  const total = base + dfee - disc + uniq;
  const dep = mode === "deposit" ? (await num("deposit_uzs", 300000)) + uniq : 0;
  await db.from("orders").update({ number, total_uzs: total, deposit_uzs: dep }).eq("id", id);
  s.cart = null; s.step = null; s.order = id; await setSession(from.id, s);
  await log("bot", "order", from.id, p.id, { number, total, mode });
  const card = await setting("payment_card"), holder = await setting("payment_card_name");
  const payNow = mode === "deposit" ? dep : mode === "full" ? total : 0;
  const lines: [string, string][] = [
    ["Mahsulot", esc(p.model)], ["Narx", `${c.price}$ = ${som(base)} so'm`],
    ["Yetkazish", pickup ? "O'zi olib ketadi — bepul" : `BTS: ${esc(office?.name ?? c.region)} — ${som(dfee)} so'm`],
    ...(disc ? [["Taklif chegirmasi", `−${som(disc)} so'm`] as [string, string]] : []),
    ["Qabul qiluvchi", `${esc(c.name)} · ${esc(c.phone)}`], ["<b>Jami</b>", `<b>${som(total)} so'm</b>`],
    ...(mode === "deposit" ? [["Hozir to'lov", `<b>${som(dep)} so'm</b>`], [pickup ? "Olib ketishda" : "BTS cheki kelgach", `${som(total - dep)} so'm`]] as [string, string][] : []),
    ...(mode === "later" ? [["To'lov", "Olib ketishda, ko'rib bo'lgach"]] as [string, string][] : []),
  ];
  const html = `<h3>🧾 Buyurtma #${number}</h3><table bordered striped>${lines.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("")}</table>` +
    (office ? `<p>🏢 BTS filiali: ${esc(office.name)} (${esc(office.code)}), ${esc(office.address)} · ${esc(office.hours ?? "")}</p>` : "") +
    (payNow ? (card ? `<blockquote>💳 Karta: <b>${esc(card)}</b>${holder ? "<br>" + esc(holder) : ""}</blockquote><p>Iltimos, <b>aynan ${som(payNow)} so'm</b> o'tkazing — oxiridagi ${uniq} so'm to'lovingizni tez topish uchun. Noutbuk 2 soatga band qilindi.</p>` : `<blockquote>💳 Karta raqamini admin tez orada yuboradi.</blockquote>`) : `<p>🔒 Noutbuk siz uchun <b>3 soatga</b> band qilindi. Kelishdan oldin qo'ng'iroq qiling: ${PHONE}</p>`) +
    `<p>ℹ️ <a href="${INFO_POST}">To'lov va yetkazish tartibi</a></p>` +
    (isLive ? "" : "<p><i>🧪 Test buyurtma — haqiqiy sotuvga ta'sir qilmaydi.</i></p>");
  const fb = `🧾 Buyurtma #${number}\n` + lines.map(([a, b]) => `${a.replace(/<[^>]+>/g, "")}: ${b.replace(/<[^>]+>/g, "")}`).join("\n") + (payNow && card ? `\n\n💳 Karta: ${card}\nAynan ${som(payNow)} so'm o'tkazing.` : "");
  const kb: any[] = [];
  if (payNow) {
    if (card) kb.push([{ text: "📋 Karta raqamini nusxalash", copy_text: { text: card.replace(/\s/g, "") } }]);
    kb.push([{ text: "✅ To'ladim, chek yuboraman", callback_data: `paid:${id}`, style: "success" }]);
  }
  kb.push([{ text: "❌ Bekor qilish", callback_data: `can:${id}`, style: "danger" }]);
  await send(chat, "🧾 Buyurtmangiz tayyor:", { reply_markup: mainKb(t.role === "admin") });
  await rich(chat, html, fb, { inline_keyboard: kb }, FX.fire);
  const cu = (await db.from("customers").select("referred_by").eq("user_id", from.id).maybeSingle()).data;
  await send(ADMIN, `🔔 <b>Yangi buyurtma #${number}</b>${isLive ? "" : " (test)"}\n${who(from)} · ${esc(c.phone)}\n${esc(p.model)} — ${c.price}$${c.price < p.price_usd ? ` (ro'yxatda ${p.price_usd}$)` : ""}\n${pickup ? "🏠 Olib ketish" : "🚚 BTS: " + esc(office?.name ?? "") + ", " + esc(office?.city ?? c.region)}\nTo'lov: ${mode === "full" ? "to'liq oldindan" : mode === "deposit" ? `band uchun ${som(dep)} so'm` : "ko'rib, keyin (3 soat band)"}\nJami: <b>${som(total)} so'm</b>${disc ? ` (taklif chegirmasi ${som(disc)})` : ""}${cu?.referred_by ? `\n👥 Taklif qilgan: ID ${cu.referred_by}` : ""}` + (payNow && !card ? "\n\n⚠️ To'lov kartasi kiritilmagan: /card 8600123412341234 Ism Familiya" : ""),
    { reply_markup: { inline_keyboard: [[{ text: "📋 Buyurtmani boshqarish", callback_data: `aord:${id}` }]] } });
}

// ------------------------------------------------------------------ payment receipt
async function readReceipt(fileId: string, mime: string) {
  if (!GEMINI) return null;
  try {
    const f = await tg("getFile", { file_id: fileId }); if (!f.ok) return null;
    const bytes = new Uint8Array(await (await fetch(`https://api.telegram.org/file/bot${BOT}/${f.result.file_path}`)).arrayBuffer());
    let b64 = ""; for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const model = await setting("gemini_model", "gemini-3.1-flash-lite");
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: mime, data: btoa(b64) } }, { text: 'Bank/payment app transfer receipt from Uzbekistan. Return ONLY JSON: {"amount_uzs": number|null, "receiver_last4": "1234"|null, "datetime": string|null, "txn_id": string|null}' }] }], generationConfig: { responseMimeType: "application/json", temperature: 0 } }),
    });
    return JSON.parse((await r.json()).candidates?.[0]?.content?.parts?.[0]?.text ?? "null");
  } catch (e) { console.error("receipt read", e); return null; }
}
async function onReceipt(chat: number, from: any, m: any, orderId: number) {
  const { data: o } = await db.from("orders").select("*").eq("id", orderId).maybeSingle();
  const balance = !!o && Number(o.paid_uzs) > 0 && due(o) > 0 && ["paid", "reserved", "ready", "shipped", "delivered"].includes(o.state);
  if (!o || o.user_id !== from.id || !(["await_pay", "rejected"].includes(o.state) || balance)) return send(chat, "Bu buyurtma uchun chek kutilmayapti.");
  const expect = balance ? due(o) : o.pay_mode === "deposit" ? Number(o.deposit_uzs) : Number(o.total_uzs);
  const photo = m.photo ? m.photo[m.photo.length - 1] : null, doc = m.document ?? null;
  const fileId = photo?.file_id ?? doc?.file_id, uniq = photo?.file_unique_id ?? doc?.file_unique_id;
  const mime = photo ? "image/jpeg" : (doc?.mime_type ?? "application/pdf");
  const dup = await db.from("payments").insert({ order_id: o.id, amount_uzs: expect, receipt_file_id: fileId, receipt_hash: uniq }).select("id").single();
  if (dup.error) return send(chat, "⚠️ Bu chek avval yuborilgan. Iltimos, shu to'lovning o'z chekini yuboring.");
  await send(chat, "🔎 Chekni tekshiryapman…");
  const res = await readReceipt(fileId, mime);
  const card = (await setting("payment_card")).replace(/\D/g, "");
  const amountOk = res?.amount_uzs != null ? Math.abs(Number(res.amount_uzs) - expect) < 1 : null;
  const cardOk = res?.receiver_last4 && card ? card.endsWith(String(res.receiver_last4)) : null;
  if (res?.txn_id) {
    const { data: same } = await db.from("payments").select("id").neq("id", dup.data.id).contains("check_result", { txn_id: res.txn_id }).limit(1);
    if (same?.length) { await db.from("payments").update({ state: "duplicate", check_result: res }).eq("id", dup.data.id); return send(chat, "⚠️ Bu tranzaksiya avval ishlatilgan. Admin bilan bog'laning: @noutgo"); }
  }
  await db.from("payments").update({ check_result: res }).eq("id", dup.data.id);
  if (!balance) await db.from("orders").update({ state: "checking", updated_at: new Date().toISOString() }).eq("id", o.id);
  const s = await session(from.id); s.step = null; await setSession(from.id, s);
  const mark = (v: boolean | null) => (v === true ? "✅ mos" : v === false ? "❌ mos emas" : "❔ aniqlanmadi");
  await send(chat, amountOk === false ? `⚠️ Chekdagi summa (${som(Number(res.amount_uzs))} so'm) kutilgan summadan farq qiladi (${som(expect)} so'm). Admin tekshiradi.` : "✅ Chek qabul qilindi. Admin to'lov tushganini tasdiqlashi bilan sizga xabar beraman (odatda 5–15 daqiqa).");
  await tg(photo ? "sendPhoto" : "sendDocument", {
    chat_id: ADMIN, [photo ? "photo" : "document"]: fileId, parse_mode: "HTML",
    caption: `🧾 <b>Chek — #${o.number}</b>${o.is_test ? " (test)" : ""}\n${balance ? "Qolgan to'lov" : o.pay_mode === "deposit" ? "Oldindan to'lov" : "To'liq to'lov"}: <b>${som(expect)} so'm</b>\nSumma: ${mark(amountOk)}${res?.amount_uzs ? ` (${som(Number(res.amount_uzs))})` : ""}\nKarta: ${mark(cardOk)}${res?.receiver_last4 ? ` (…${esc(res.receiver_last4)})` : ""}\n\nBank ilovangizda pul tushganini tekshirib, tasdiqlang.`,
    reply_markup: { inline_keyboard: [[{ text: "✅ To'lovni tasdiqlash", callback_data: `pok:${o.id}`, style: "success" }, { text: "❌ Rad etish", callback_data: `pno:${o.id}`, style: "danger" }]] },
  });
}

// ------------------------------------------------------------------ order lifecycle (shared by admin actions)
async function setState(o: any, state: string, extra: Record<string, unknown> = {}) {
  await db.from("orders").update({ state, updated_at: new Date().toISOString(), ...extra }).eq("id", o.id);
  await log("bot", "status", o.user_id, o.product_id, { number: o.number, state });
}
async function confirmPayment(o: any, adminId: number) {
  const now = new Date().toISOString();
  await db.from("payments").update({ state: "confirmed", confirmed_by: adminId, decided_at: now }).eq("order_id", o.id).eq("state", "pending");
  if (o.pay_mode === "deposit" && o.delivery === "bts") {
    await setState(o, "paid", { paid_uzs: o.deposit_uzs, reserved_until: null });
    await log("bot", "paid", o.user_id, o.product_id, { number: o.number, deposit: o.deposit_uzs });
    await send(o.user_id, `✅ <b>Oldindan to'lov qabul qilindi — #${o.number}</b>\n\nNoutbukni BTS'ga topshirib, chek rasmini shu yerga yuboramiz. BTS ilovasida qabul qilinganini tekshirgach, qolgan <b>${som(o.total_uzs - o.deposit_uzs)} so'm</b>ni to'laysiz.\n\nℹ️ <a href="${INFO_POST}">To'lov tartibi</a>`, { message_effect_id: FX.like, link_preview_options: { is_disabled: true } });
  } else if (o.pay_mode === "deposit") {
    await setState(o, "reserved", { paid_uzs: o.deposit_uzs, reserved_until: null });
    await log("bot", "paid", o.user_id, o.product_id, { number: o.number, deposit: o.deposit_uzs });
    await send(o.user_id, `🔒 <b>Band qilish to'lovi qabul qilindi — #${o.number}</b>\nNoutbuk faqat siz uchun saqlanadi.\nQolgan <b>${som(o.total_uzs - o.deposit_uzs)} so'm</b>ni olib ketishda, ko'rib bo'lgach to'laysiz.\n\nKelishdan oldin qo'ng'iroq qiling: ${PHONE}`);
  } else {
    await setState(o, o.delivery === "pickup" ? "ready" : "paid", { paid_uzs: o.total_uzs, reserved_until: null });
    await log("bot", "paid", o.user_id, o.product_id, { number: o.number });
    await send(o.user_id, `✅ <b>To'lov qabul qilindi — buyurtma #${o.number} tasdiqlandi!</b>\n\n${o.delivery === "pickup" ? `Noutbuk tayyor. Kelishdan oldin qo'ng'iroq qiling: ${PHONE}` : "Noutbukni BTS'ga topshiramiz va trek raqamini rasm bilan yuboramiz."}\n\nRahmat, noutgo'ni tanlaganingiz uchun! 🙏`, { message_effect_id: FX.party });
  }
  if (!o.is_test) await db.from("products").update({ status: o.pay_mode === "deposit" ? "reserved" : "sold" }).eq("id", o.product_id);
}
async function confirmBalance(o: any, adminId: number) {
  const now = new Date().toISOString();
  await db.from("payments").update({ state: "confirmed", confirmed_by: adminId, decided_at: now }).eq("order_id", o.id).eq("state", "pending");
  await db.from("orders").update({ paid_uzs: o.total_uzs, updated_at: now }).eq("id", o.id);
  await log("bot", "paid", o.user_id, o.product_id, { number: o.number, balance: due(o) });
  if (!o.is_test) await db.from("products").update({ status: "sold" }).eq("id", o.product_id);
  await sticker(o.user_id, "🎉");
  await send(o.user_id, `✅ <b>#${o.number}: to'lov to'liq qabul qilindi.</b>\nRahmat! Noutbukni olganingizdan so'ng «✅ Qabul qildim» tugmasini bosing.`, { message_effect_id: FX.party, reply_markup: ["shipped", "delivered", "ready"].includes(o.state) ? { inline_keyboard: [[{ text: "✅ Qabul qildim", callback_data: `rcv:${o.id}`, style: "success" }]] } : undefined });
}
async function sendTracking(o: any, track: string, photo?: string) {
  await setState(o, "shipped", { track_number: track, track_photo: photo ?? null, shipped_at: new Date().toISOString() });
  const left = due(o), card = await setting("payment_card"), holder = await setting("payment_card_name");
  const text = `🚚 <b>Buyurtmangiz #${o.number} BTS'ga topshirildi!</b>\nTrek raqami: <code>${esc(track)}</code>\n${o.bts_office ? `🏢 Filial: ${esc(o.bts_office)}\n` : ""}` +
    (left ? `\n💳 <b>Qolgan to'lov: ${som(left)} so'm.</b>\nBTS ilovasida qabul qilinganini tekshirib, ${card ? `<code>${esc(card.replace(/\s/g, ""))}</code>${holder ? " (" + esc(holder) + ")" : ""} kartasiga` : "kartaga"} o'tkazing va chekini yuboring.\n` : "") +
    `\nFilialga yetganda pasport bilan oling, so'ng «✅ Qabul qildim» tugmasini bosing.`;
  const kb = { inline_keyboard: [[{ text: "📋 Trek raqami", copy_text: { text: track } }, ...(left && card ? [{ text: "📋 Karta", copy_text: { text: card.replace(/\s/g, "") } }] : [])], ...(left ? [[{ text: `📎 Qolgan to'lov chekini yuborish`, callback_data: `paid:${o.id}`, style: "primary" }]] : []), [{ text: "✅ Qabul qildim", callback_data: `rcv:${o.id}`, style: "success" }]] };
  if (photo) await tg("sendPhoto", { chat_id: o.user_id, photo, caption: text, parse_mode: "HTML", reply_markup: kb });
  else await send(o.user_id, text, { reply_markup: kb });
}
async function handOver(o: any) {
  await setState(o, "delivered", { paid_uzs: o.total_uzs });
  await send(o.user_id, `🤝 #${o.number}: noutbuk sizga topshirildi. Kafolat bugundan 2 hafta.\nIltimos, qabul qilganingizni tasdiqlang:`, { reply_markup: { inline_keyboard: [[{ text: "✅ Qabul qildim", callback_data: `rcv:${o.id}`, style: "success" }]] } });
}
async function adminOrderCard(chat: number, id: number) {
  const { data: o } = await db.from("orders").select("*,products(model)").eq("id", id).maybeSingle(); if (!o) return send(chat, "Topilmadi");
  const { data: c } = await db.from("customers").select("first_name,username,phone,referred_by,ref_code").eq("user_id", o.user_id).maybeSingle();
  const kb: any[] = [];
  const pend = (await db.from("payments").select("id").eq("order_id", o.id).eq("state", "pending").limit(1)).data?.length;
  if (o.state === "checking" || (pend && due(o) > 0)) kb.push([{ text: o.state === "checking" ? "✅ To'lovni tasdiqlash" : "✅ Qolgan to'lovni tasdiqlash", callback_data: `pok:${o.id}`, style: "success" }, { text: "❌ Rad etish", callback_data: `pno:${o.id}`, style: "danger" }]);
  if (o.delivery === "bts" && o.state === "paid") kb.push([{ text: "🚚 Trek qo'shish (rasm bilan)", callback_data: `atr:${o.id}`, style: "primary" }]);
  if (o.delivery === "pickup" && ["ready", "reserved"].includes(o.state)) kb.push([{ text: "🤝 Topshirildi (to'liq to'landi)", callback_data: `aho:${o.id}`, style: "success" }]);
  if (o.state === "shipped") kb.push([{ text: "📬 Yetkazildi deb belgilash", callback_data: `adl:${o.id}` }]);
  if (["await_pay", "reserved", "checking", "rejected"].includes(o.state)) kb.push([{ text: "❌ Buyurtmani bekor qilish", callback_data: `acn:${o.id}`, style: "danger" }]);
  const mode = o.pay_mode === "deposit" ? `band ${som(o.deposit_uzs)} / jami ${som(o.total_uzs)}` : o.pay_mode === "on_pickup" ? `olib ketishda ${som(o.total_uzs)}` : `to'liq ${som(o.total_uzs)}`;
  return send(chat, `📋 <b>#${o.number}</b>${o.is_test ? " 🧪" : ""} · ${ST[o.state] ?? o.state}\n${esc(o.products?.model)}\n👤 ${esc(o.name)} · ${esc(o.phone)}${c?.username ? " · @" + esc(c.username) : ""} (ID ${o.user_id})\n${o.delivery === "pickup" ? "🏠 Olib ketish" : "🚚 " + esc(o.bts_office ?? o.region)}\n💳 ${mode} so'm · to'langan ${som(o.paid_uzs ?? 0)}\n${o.track_number ? "📦 Trek: " + esc(o.track_number) + "\n" : ""}${c?.referred_by ? "👥 Taklif qilgan: ID " + c.referred_by + "\n" : ""}🕒 ${new Date(o.created_at).toLocaleString("ru-RU", { timeZone: "Asia/Tashkent" })}`, { reply_markup: { inline_keyboard: kb } });
}

// ------------------------------------------------------------------ lists
async function myOrders(chat: number, uid: number) {
  const { data } = await db.from("orders").select("id,number,state,total_uzs,paid_uzs,is_test,track_number,delivery,products(model)").eq("user_id", uid).order("id", { ascending: false }).limit(5);
  if (!data?.length) return send(chat, "📦 Hozircha buyurtma yo'q.", { reply_markup: { inline_keyboard: [[{ text: "💻 Katalog", callback_data: "cat" }]] } });
  const kb: any[] = [];
  for (const o of data as any[]) {
    if (["await_pay", "rejected"].includes(o.state)) kb.push([{ text: `💳 #${o.number}: to'lov chekini yuborish`, callback_data: `paid:${o.id}` }]);
    else if (Number(o.paid_uzs) > 0 && due(o) > 0 && ["paid", "shipped", "delivered"].includes(o.state) && o.delivery === "bts") kb.push([{ text: `💳 #${o.number}: qolgan ${som(due(o))} so'm`, callback_data: `paid:${o.id}`, style: "primary" }]);
    if (["shipped", "delivered"].includes(o.state)) kb.push([{ text: `✅ #${o.number}: qabul qildim`, callback_data: `rcv:${o.id}`, style: "success" }]);
  }
  return send(chat, "📦 <b>Buyurtmalaringiz</b>\n\n" + (data as any[]).map((o) => `#${o.number}${o.is_test ? " (test)" : ""} — ${esc(o.products?.model ?? "")}\n${som(o.total_uzs)} so'm · ${ST[o.state] ?? o.state}${o.track_number ? `\nTrek: <code>${esc(o.track_number)}</code>` : ""}`).join("\n\n"), kb.length ? { reply_markup: { inline_keyboard: kb } } : {});
}
async function referral(chat: number, from: any) {
  await customer(from);
  const code = await refCode(from);
  const bonus = await num("ref_friend_uzs", 100000), reward = await num("ref_reward_uzs", 150000);
  const { data: refs } = await db.from("referrals").select("state").eq("referrer_id", from.id);
  const joined = refs?.length ?? 0, bought = (refs ?? []).filter((r: any) => ["bought", "earned", "paid"].includes(r.state)).length;
  const link = `https://t.me/noutgo_robot?start=ref_${code}`;
  const html = `<h3>🎁 Do'stingizni olib keling</h3><table bordered striped><tr><td>Do'stingiz</td><td><b>${som(bonus)} so'm</b> chegirma (birinchi noutbukka)</td></tr><tr><td>Siz</td><td><b>${som(reward)} so'm</b> — har bir xarid qilgan do'st uchun, kartangizga</td></tr></table><p>Havolangiz: ${esc(link)}</p><p>Qo'shilganlar: <b>${joined}</b> · Xarid qilganlar: <b>${bought}</b></p><p><i>Mukofot do'stingiz noutbukni olib, 14 kun ichida qaytarmasa beriladi. Faqat yangi mijozlar hisoblanadi.</i></p>`;
  return rich(chat, html, `🎁 Havolangiz: ${link}\nDo'stingiz ${som(bonus)} so'm chegirma oladi, siz ${som(reward)} so'm.`, { inline_keyboard: [[{ text: "📋 Havolani nusxalash", copy_text: { text: link } }], [{ text: "📤 Do'stga taklifnoma yuborish", switch_inline_query_chosen_chat: { query: "ref", allow_user_chats: true, allow_group_chats: true }, style: "primary" }]] });
}
async function compareMenu(chat: number, a: string) {
  const list = await products("laptop");
  if (!a) return send(chat, "⚖️ Birinchi noutbukni tanlang:", { reply_markup: { inline_keyboard: list.map((p) => [{ text: `${dot(p)} ${short(p)} — ${p.price_usd}$`, callback_data: `cmp:${p.sku}` }]) } });
  return send(chat, "⚖️ Qaysi model bilan solishtiramiz?", { reply_markup: { inline_keyboard: list.filter((p) => p.sku !== a).map((p) => [{ text: `${dot(p)} ${short(p)} — ${p.price_usd}$`, callback_data: `cmpw:${a}:${p.sku}` }]) } });
}
async function compare(chat: number, a: string, b: string) {
  const [p, q] = [await bySku(a), await bySku(b)]; if (!p || !q) return;
  const r = (k: string, x: unknown, y: unknown) => `<tr><td>${k}</td><td>${esc(x ?? "—")}</td><td>${esc(y ?? "—")}</td></tr>`;
  const html = `<h3>⚖️ Solishtirish</h3><table bordered striped><tr><th></th><th>${esc(short(p))}</th><th>${esc(short(q))}</th></tr>${r("Narx", priceTxt(p), priceTxt(q))}${r("Protsessor", p.cpu, q.cpu)}${r("RAM", p.ram_gb + "GB", q.ram_gb + "GB")}${r("SSD", p.ssd, q.ssd)}${r("Ekran", p.screen, q.screen)}${r("Grafika", p.gpu, q.gpu)}${r("Batareya", p.battery_pct ? p.battery_pct + "%" : null, q.battery_pct ? q.battery_pct + "%" : null)}${r("Holati", p.cond_score, q.cond_score)}${r("Kamchilik", p.defects ?? "yo'q", q.defects ?? "yo'q")}</table>`;
  return rich(chat, html, `${short(p)}: ${p.price_usd}$ · ${short(q)}: ${q.price_usd}$`, { inline_keyboard: [[{ text: "🛒 " + short(p), callback_data: `ord:${p.sku}`, style: "success" }, { text: "🛒 " + short(q), callback_data: `ord:${q.sku}`, style: "success" }], [{ text: "⬅️ Katalog", callback_data: "cat" }]] });
}
function budget(chat: number) {
  return send(chat, "💰 Qaysi narx oralig'idagi noutbuk kerak?", { reply_markup: { inline_keyboard: [[{ text: "250$ gacha", callback_data: "bud:0:250" }, { text: "250–350$", callback_data: "bud:250:350" }], [{ text: "350$ dan yuqori", callback_data: "bud:350:99999" }, { text: "Barcha noutbuklar", callback_data: "bud:0:99999" }]] } });
}

// ------------------------------------------------------------------ admin
async function stats(chat: number) {
  const since = (d: number) => new Date(Date.now() - d * 864e5).toISOString();
  const cnt = async (source: string, kind: string, d: number) => (await db.from("events").select("*", { count: "exact", head: true }).eq("source", source).eq("kind", kind).gte("at", since(d))).count ?? 0;
  const row = async (label: string, s: string, k: string) => `<tr><td>${label}</td><td>${await cnt(s, k, 1)}</td><td>${await cnt(s, k, 7)}</td></tr>`;
  const members = (await tg("getChatMemberCount", { chat_id: CHANNEL })).result;
  const html = `<h3>📊 noutgo statistikasi</h3><p>Kanal obunachilari: <b>${members ?? "?"}</b></p><table bordered striped><tr><th>Ko'rsatkich</th><th>24 soat</th><th>7 kun</th></tr>${await row("Kanalga qo'shildi", "channel", "join")}${await row("Kanaldan chiqdi", "channel", "leave")}${await row("Kanal postlari", "channel", "post")}${await row("Izohlar", "group", "comment")}${await row("Biznes chat xabarlari", "business", "message")}${await row("Bot: /start", "bot", "start")}${await row("Taklif orqali kelgan", "bot", "referral")}${await row("Ko'rishlar (bot)", "bot", "view")}${await row("Ko'rishlar (ilova)", "app", "view")}${await row("Narx takliflari", "bot", "offer")}${await row("Buyurtmalar", "bot", "order")}${await row("To'lov tasdiqlandi", "bot", "paid")}${await row("Fikrlar", "bot", "feedback")}</table>`;
  return rich(chat, html, "📊 Statistika", { inline_keyboard: await appRow("📊 To'liq panel (ilova)", "#admin") });
}
async function adminOrders(chat: number) {
  const { data } = await db.from("orders").select("id,number,state,total_uzs,name,is_test").order("id", { ascending: false }).limit(10);
  if (!data?.length) return send(chat, "Buyurtmalar yo'q.");
  return send(chat, "📦 <b>Oxirgi buyurtmalar</b> — boshqarish uchun tanlang:", { reply_markup: { inline_keyboard: [...(data as any[]).map((o) => [{ text: `#${o.number}${o.is_test ? " 🧪" : ""} · ${(ST[o.state] ?? o.state).replace(/^\S+\s/, "")} · ${o.name ?? ""}`.slice(0, 60), callback_data: `aord:${o.id}` }]), ...(await appRow("📊 Panelda ochish", "#admin"))] } });
}
async function adminCommand(chat: number, cmd: string, arg: string): Promise<boolean> {
  if (cmd === "/stats") { await stats(chat); return true; }
  if (cmd === "/orders") { await adminOrders(chat); return true; }
  if (cmd === "/testers") {
    const { data } = await db.from("bot_testers").select("username,user_id,role").order("id");
    await send(chat, "👥 <b>Testerlar</b>\n" + (data ?? []).map((t: any) => `• ${t.username ? "@" + esc(t.username) : ""} ${t.user_id ?? "(hali /start bosmagan)"} — ${t.role}`).join("\n") + "\n\nQo'shish: /tester_add @username\nO'chirish: /tester_del @username"); return true;
  }
  if (cmd === "/tester_add" && arg) { const u = arg.replace(/^@/, "").trim(); await db.from("bot_testers").insert(/^\d+$/.test(u) ? { user_id: Number(u) } : { username: u }); await send(chat, `✅ ${esc(arg)} tester sifatida qo'shildi. U @noutgo_robot da /start bossin.`); return true; }
  if (cmd === "/tester_del" && arg) { const u = arg.replace(/^@/, "").trim(); if (/^\d+$/.test(u)) await db.from("bot_testers").delete().eq("user_id", Number(u)).neq("role", "admin"); else await db.from("bot_testers").delete().ilike("username", u).neq("role", "admin"); await send(chat, `🗑 ${esc(arg)} o'chirildi.`); return true; }
  if (cmd === "/card") {
    const m = arg.match(/^([\d\s]{16,23})\s*(.*)$/);
    if (!m) { await send(chat, `To'lov kartasi: ${esc(await setting("payment_card")) || "kiritilmagan"}\nO'rnatish: /card 8600123412341234 Ism Familiya`); return true; }
    const n = m[1].replace(/\D/g, "").replace(/(\d{4})(?=\d)/g, "$1 ");
    await setSetting("payment_card", n); await setSetting("payment_card_name", m[2].trim()); await send(chat, `✅ Karta saqlandi: ${esc(n)}${m[2] ? " — " + esc(m[2]) : ""}`); return true;
  }
  const setNum = async (field: string, label: string) => {
    const [sku, val] = arg.split(/\s+/); const p = sku ? await bySku(sku.toUpperCase()) : null;
    if (!p || !val) { await send(chat, `Foydalanish: ${cmd} SKU qiymat\nSKUlar: ${(await products()).map((x) => x.sku).join(", ")}`); return; }
    const v = Number(val);
    await db.from("products").update({ [field]: v, ...(field === "price_usd" ? { price: `$${v}` } : {}) }).eq("id", p.id); await send(chat, `✅ ${esc(p.sku)}: ${label} = ${esc(val)}`);
  };
  if (cmd === "/floor") { await setNum("floor_usd", "eng past narx"); return true; }
  if (cmd === "/price") { await setNum("price_usd", "narx"); return true; }
  if (cmd === "/battery") { await setNum("battery_pct", "batareya %"); return true; }
  const setSom = async (key: string, label: string) => { if (Number(arg) >= 1000) { await setSetting(key, String(Number(arg))); await send(chat, `✅ ${label}: ${som(Number(arg))} so'm`); } else await send(chat, `${label}: ${som(await num(key, 0))} so'm\nO'zgartirish: ${cmd} 150000`); };
  if (cmd === "/rate") { await setSom("usd_rate", "1$ kursi"); return true; }
  if (cmd === "/deposit") { await setSom("deposit_uzs", "Band qilish to'lovi"); return true; }
  if (cmd === "/ref_bonus") { await setSom("ref_friend_uzs", "Do'stga chegirma"); return true; }
  if (cmd === "/ref_reward") { await setSom("ref_reward_uzs", "Taklif qilganga mukofot"); return true; }
  if (cmd === "/app") { if (arg.startsWith("https://")) { await setSetting("miniapp_url", arg.trim()); await send(chat, "✅ Mini App manzili saqlandi."); } else await send(chat, `Mini App: ${esc(await appUrl()) || "hali ulanmagan"}`); return true; }
  if (cmd === "/admin") {
    await send(chat, "🛠 <b>Admin panel</b>\n\n/orders — buyurtmalar va holatini boshqarish\n/stats — kanal va bot statistikasi\n/testers, /tester_add @user, /tester_del @user\n/card 8600… Ism — to'lov kartasi\n/price SKU 270 · /floor SKU 250 · /battery SKU 89\n/rate 12000 · /deposit 300000\n/ref_bonus 100000 · /ref_reward 150000\n\n📦 <b>Trek yuborish:</b> BTS chekini rasmga olib, izohiga <code>N-1023 123456789</code> (buyurtma raqami va trek) yozib yuboring — mijozga avtomatik boradi.\n\nEski buyruqlar ishlaydi: /status /on /off /info /address /emergency /location",
      { reply_markup: { inline_keyboard: [[{ text: "📦 Buyurtmalar", callback_data: "a_orders" }, { text: "📊 Statistika", callback_data: "a_stats" }], [{ text: "👥 Testerlar", callback_data: "a_testers" }], ...(await appRow("📊 To'liq panel (ilova)", "#admin"))] } });
    return true;
  }
  return false;
}
// Admin sends a photo with caption "N-1023 TRACK" → tracking goes to the customer.
async function adminTrackPhoto(m: any): Promise<boolean> {
  const cap: string = m.caption ?? "", mt = cap.match(/N-?(\d{3,6})\s+([A-Za-z0-9-]{5,40})/i);
  if (!mt) return false;
  const { data: o } = await db.from("orders").select("*").eq("number", `N-${mt[1]}`).maybeSingle();
  if (!o) { await send(ADMIN, `#N-${mt[1]} topilmadi.`); return true; }
  if (o.delivery !== "bts") { await send(ADMIN, `#${o.number} — olib ketish buyurtmasi, trek kerak emas.`); return true; }
  const photo = m.photo ? m.photo[m.photo.length - 1].file_id : undefined;
  await sendTracking(o, mt[2], photo);
  await send(ADMIN, `✅ #${o.number}: trek ${esc(mt[2])} mijozga yuborildi, holat «yo'lda».`);
  return true;
}

// ------------------------------------------------------------------ private chat (testers)
async function onTesterMessage(m: any, t: Tester) {
  const chat = m.chat.id, from = m.from, text: string = m.text ?? "";
  const [cmd0] = text.split(/\s+/); const cmd = cmd0.split("@")[0]; const arg = text.slice(cmd0.length).trim();
  const { isNew } = await customer(from);
  const s = await session(from.id);
  if (text === "❌ Bekor qilish") { s.step = null; s.cart = null; await setSession(from.id, s); return send(chat, "Bekor qilindi.", { reply_markup: mainKb(t.role === "admin") }); }
  // Admin answers a customer question (copied to the customer as the bot).
  if (t.role === "admin" && s.step?.t === "reply" && !text.startsWith("/") && !MENU.includes(text)) {
    const to = s.step.to; s.step = null; await setSession(from.id, s);
    await send(to, "💬 <b>noutgo admin javobi:</b>");
    const r = await tg("copyMessage", { chat_id: to, from_chat_id: chat, message_id: m.message_id });
    return send(chat, r.ok ? "✅ Javob mijozga yuborildi." : "⚠️ Yuborilmadi: " + esc(r.description));
  }
  // Phone shared from the Mini App ("Telegram raqamimni olish") — save it quietly.
  if (m.contact && s.step?.t !== "phone") {
    if (m.contact.user_id === from.id) { await db.from("customers").update({ phone: String(m.contact.phone_number).startsWith("+") ? m.contact.phone_number : "+" + m.contact.phone_number }).eq("user_id", from.id); return send(chat, "✅ Raqamingiz saqlandi — ilovaga qayting."); }
    return send(chat, "Iltimos, o'zingizning raqamingizni yuboring.");
  }
  // Customer question for the main admin.
  if (s.step?.t === "ask" && !text.startsWith("/") && !MENU.includes(text)) {
    s.step = null; await setSession(from.id, s);
    const c = (await db.from("customers").select("phone").eq("user_id", from.id).maybeSingle()).data;
    await send(ADMIN, `📩 <b>Mijozdan savol</b>\n${who(from)} · ID ${from.id}${c?.phone ? " · " + esc(c.phone) : ""}`, { reply_markup: { inline_keyboard: [[{ text: "↩️ Javob berish", callback_data: `arp:${from.id}`, style: "primary" }]] } });
    await tg("copyMessage", { chat_id: ADMIN, from_chat_id: chat, message_id: m.message_id });
    return send(chat, "✅ <b>Xabaringiz asosiy adminga yuborildi.</b>\nJavob shu chatga keladi — odatda bir necha daqiqada.", { reply_markup: mainKb(t.role === "admin") });
  }
  if (t.role === "admin" && m.photo && s.step?.t === "track") {
    const o = (await db.from("orders").select("*").eq("id", s.step.order).maybeSingle()).data;
    const tr = (m.caption ?? "").trim();
    if (!tr) return send(chat, "Rasm izohiga trek raqamini yozib, qayta yuboring.");
    s.step = null; await setSession(from.id, s);
    if (o) { await sendTracking(o, tr, m.photo[m.photo.length - 1].file_id); return send(chat, `✅ #${o.number}: trek mijozga yuborildi, holat «yo'lda».`); }
  }
  if (t.role === "admin" && m.photo && (await adminTrackPhoto(m))) return;
  // steps
  if ((s.step?.t === "name" || s.step?.t === "phone") && !s.cart) { s.step = null; await setSession(from.id, s); }
  if (s.step?.t === "name" && text && !text.startsWith("/")) { s.cart.name = text.replace(/^👤\s*/, "").slice(0, 60); await setSession(from.id, s); return askPhone(chat, from); }
  if (s.step?.t === "phone" && (m.contact || /^\+?\d[\d\s-]{8,}$/.test(text))) {
    s.cart.phone = m.contact ? (String(m.contact.phone_number).startsWith("+") ? m.contact.phone_number : "+" + m.contact.phone_number) : text.trim();
    await setSession(from.id, s); await db.from("customers").update({ phone: s.cart.phone }).eq("user_id", from.id);
    return createOrder(chat, from, t);
  }
  if (s.step?.t === "offer" && /^\d{2,4}\s*\$?$/.test(text.trim())) return bid(chat, from, s.step.sku, parseInt(text, 10));
  if (s.step?.t === "receipt" && (m.photo || m.document)) return onReceipt(chat, from, m, s.step.order);
  if (s.step?.t === "feedback" && text && !text.startsWith("/")) {
    await db.from("feedback").update({ text: text.slice(0, 1500) }).eq("id", s.step.id);
    s.step = null; await setSession(from.id, s);
    await send(ADMIN, `💬 <b>Mijoz fikri</b> (${who(from)}):\n«${esc(text.slice(0, 800))}»`);
    return send(chat, "Rahmat! Fikringiz biz uchun juda muhim 🙏", { reply_markup: mainKb(t.role === "admin") });
  }
  if (cmd === "/start") {
    await log("bot", "start", from.id, null, { param: arg });
    if (arg.startsWith("ref_")) await applyReferral(from, arg.slice(4), isNew);
    await sticker(chat, "👋");
    await send(chat, `<b>Assalomu alaykum, ${esc(from.first_name)}!</b>\n\n<b>noutgo</b> — tekshirilgan premium b/u noutbuklar.\n✅ Original zaryadka  ·  🛡 2 hafta kafolat\n🚚 BTS — butun O'zbekiston  ·  🏠 Toshkentda olib ketish\n\n<i>🧪 Test rejimi — faqat testerlar ko'radi.</i>`, { reply_markup: mainKb(t.role === "admin") });
    const sku = arg.split("_")[0].toUpperCase();
    if (sku && !arg.startsWith("ref_") && (await bySku(sku))) return showCard(chat, from.id, sku);
    return send(chat, "Nimadan boshlaymiz?", { reply_markup: { inline_keyboard: [[{ text: "💻 Katalogni ochish", callback_data: "cat", style: "success" }], ...(await appRow()), [{ text: "🔎 Byudjet bo'yicha", callback_data: "budget" }, { text: "🎁 Taklif dasturi", callback_data: "ref" }]] } });
  }
  if (t.role === "admin" && cmd.startsWith("/") && (await adminCommand(chat, cmd, arg))) return;
  if (text === "💻 Katalog") return showCatalog(chat);
  if (text === "🔎 Byudjet bo'yicha") return budget(chat);
  if (text === "📦 Buyurtmalarim") return myOrders(chat, from.id);
  if (text === "🎁 Do'stni taklif qilish") return referral(chat, from);
  if (text === "💬 Admin bilan bog'lanish") { s.step = { t: "ask" }; await setSession(from.id, s); return send(chat, `✍️ <b>Savolingizni yozing</b> — matn, rasm yoki ovozli xabar.\nUni asosiy adminga yetkazaman.\n\n📞 Shoshilinch bo'lsa: ${PHONE}`, { reply_markup: { keyboard: [[{ text: "❌ Bekor qilish" }]], resize_keyboard: true, one_time_keyboard: true } }); }
  if (text === "🛠 Admin panel" && t.role === "admin") return adminCommand(chat, "/admin", "");
  if (text.startsWith("🛍")) return send(chat, "🛍 Ilovani shu tugma orqali oching:", { reply_markup: { inline_keyboard: await appRow() } }).then(() => send(chat, "Menyu yangilandi.", { reply_markup: mainKb(t.role === "admin") }));
  if (m.photo || m.document) return send(chat, "Chek yuborish uchun avval buyurtmadagi «✅ To'ladim» tugmasini bosing.");
  if (t.role !== "admin") return forward({ update_id: 0, message: m }); // free questions → the live AI
  return send(chat, "Buyruqlar: /admin · Mijoz sifatida sinash uchun tugmalardan foydalaning.");
}

// ------------------------------------------------------------------ callbacks
async function onCallback(q: any) {
  const from = q.from, chat = q.message?.chat?.id ?? from.id, mid = q.message?.message_id, d: string = q.data ?? "";
  const t = await tester(from);
  const ack = (text?: string, alert = false) => tg("answerCallbackQuery", { callback_query_id: q.id, ...(text ? { text, show_alert: alert } : {}) });
  if (!t) return ack("Tez orada ishga tushadi 🙂", true);
  const [k, a, b, c] = d.split(":");
  await ack();
  const isAdmin = t.role === "admin";
  const clearKb = () => (mid ? tg("editMessageReplyMarkup", { chat_id: chat, message_id: mid, reply_markup: { inline_keyboard: [] } }) : null);
  switch (k) {
    case "cat": return showCatalog(chat);
    case "budget": return budget(chat);
    case "bud": { const lo = Number(a), hi = Number(b); const list = (await products("laptop")).filter((p) => p.price_usd && p.price_usd >= lo && p.price_usd < hi); return showCatalog(chat, list, hi > 9000 ? (lo ? `💰 ${lo}$ dan yuqori` : "💻 Barcha noutbuklar") : `💰 ${lo}–${hi}$`); }
    case "notify": await log("bot", "notify_request", from.id); return send(chat, "✅ Yaxshi! Mos noutbuk kelishi bilan sizga yozamiz.");
    case "card": return showCard(chat, from.id, a, Number(b || 0), c === "e" ? mid : undefined);
    case "alb": { const p = await bySku(a); if (!p?.photo_ids?.length) return; return tg("sendMediaGroup", { chat_id: chat, media: p.photo_ids.slice(0, 10).map((id: string) => ({ type: "photo", media: id })) }); }
    case "vid": { const p = await bySku(a); if (p?.video_id) return tg("sendVideo", { chat_id: chat, video: p.video_id, caption: `🎥 ${short(p)} — holat videosi`, reply_markup: { inline_keyboard: [[{ text: "⬅️ Kartaga qaytish", callback_data: `card:${a}:0` }]] } }); return; }
    case "spec": return showSpec(chat, a);
    case "cmp": return compareMenu(chat, a ?? "");
    case "cmpw": return compare(chat, a, b);
    case "off": return askOffer(chat, from.id, a);
    case "bid": return bid(chat, from, a, Number(b));
    case "acc": { const s = await session(from.id); s.deals = s.deals ?? {}; s.deals[a] = Number(b); await setSession(from.id, s); return send(chat, `🤝 Kelishdik — ${b}$! Narx 2 soat saqlanadi.`, { reply_markup: { inline_keyboard: [[{ text: "🛒 Buyurtma berish", callback_data: `ord:${a}`, style: "success" }]] } }); }
    case "ord": return startOrder(chat, from, a);
    case "dl": {
      const s = await session(from.id); if (!s.cart) return send(chat, "Avval mahsulotni tanlang.", { reply_markup: { inline_keyboard: [[{ text: "💻 Katalog", callback_data: "cat" }]] } });
      s.cart.delivery = a; s.cart.office = null; s.cart.pay = null; await setSession(from.id, s);
      if (a === "p") { await pickupInfo(chat); return askPayMode(chat); }
      return askRegion(chat);
    }
    case "pm": { const s = await session(from.id); if (!s.cart) return; s.cart.pay = a; await setSession(from.id, s); return askName(chat, from); }
    case "rg": { const s = await session(from.id); if (!s.cart) return; s.cart.region = REGIONS[Number(a)]; await setSession(from.id, s); return askCity(chat, Number(a)); }
    case "ct": return askOffice(chat, Number(a), Number(b));
    case "of": {
      const s = await session(from.id); if (!s.cart) return;
      const { data: o } = await db.from("bts_offices").select("*").eq("code", a).maybeSingle(); if (!o) return;
      s.cart.office = o.code; s.cart.region = o.region; await setSession(from.id, s);
      await send(chat, `🏢 <b>BTS filiali:</b> ${esc(o.name)} (${esc(o.code)})\n📍 ${esc(o.city)}, ${esc(o.address)}\n🕒 ${esc(o.hours)}\n🚚 Yetkazish: taxminan ${String(o.region).startsWith("Toshkent") ? "30 000" : "45 000"} so'm, 1–3 kun.`);
      return askPayMode(chat, true);
    }
    case "paid": {
      const { data: o } = await db.from("orders").select("id,user_id,state,total_uzs,paid_uzs").eq("id", Number(a)).maybeSingle();
      const bal = o && Number(o.paid_uzs) > 0 && due(o) > 0 && ["paid", "reserved", "ready", "shipped", "delivered"].includes(o.state);
      if (!o || o.user_id !== from.id || !(["await_pay", "rejected"].includes(o.state) || bal)) return send(chat, "Bu buyurtma uchun chek kutilmayapti.");
      const s = await session(from.id); s.step = { t: "receipt", order: o.id }; await setSession(from.id, s); return send(chat, bal ? `📎 Qolgan <b>${som(due(o))} so'm</b> to'lov chekini (skrinshot yoki PDF) shu yerga yuboring.` : "📎 To'lov chekini (skrinshot yoki PDF) shu yerga yuboring.");
    }
    case "can": {
      const { data: o } = await db.from("orders").select("id,state,number,user_id").eq("id", Number(a)).maybeSingle();
      if (!o || o.user_id !== from.id || !["await_pay", "rejected", "reserved"].includes(o.state)) return send(chat, "Bu buyurtmani bekor qilib bo'lmaydi. Admin bilan bog'laning: @noutgo");
      await db.from("orders").update({ state: "cancelled", updated_at: new Date().toISOString() }).eq("id", o.id);
      await clearKb(); await send(ADMIN, `❌ #${o.number} mijoz tomonidan bekor qilindi.`);
      return send(chat, "Buyurtma bekor qilindi.");
    }
    case "rcv": {
      const { data: o } = await db.from("orders").select("*").eq("id", Number(a)).maybeSingle();
      if (!o || o.user_id !== from.id || !["shipped", "delivered", "ready"].includes(o.state)) return;
      await clearKb(); await setState(o, "received", { received_at: new Date().toISOString() });
      const { data: rf } = await db.from("referrals").select("id,referrer_id").eq("friend_id", from.id).eq("state", "joined").maybeSingle();
      if (rf) {
        const reward = await num("ref_reward_uzs", 150000);
        await db.from("referrals").update({ state: "bought", order_id: o.id, reward_uzs: reward }).eq("id", rf.id);
        await send(rf.referrer_id, `🎉 Siz taklif qilgan do'stingiz ${who(from)} noutbuk sotib oldi! 14 kun o'tgach, qaytarilmasa, sizga <b>${som(reward)} so'm</b> o'tkaziladi.`);
        await send(ADMIN, `👥 Taklif bo'yicha xarid: ${who(from)} (#${o.number}) ← ID ${rf.referrer_id}. 14 kundan so'ng ${som(reward)} so'm mukofot to'lanadi.`);
      }
      await send(ADMIN, `🎉 #${o.number}: mijoz qabul qilganini tasdiqladi.${due(o) ? ` ⚠️ Qolgan to'lov: ${som(due(o))} so'm` : ""}`);
      await sticker(chat, "🎉");
      if (due(o)) await send(chat, `💳 Eslatma: qolgan <b>${som(due(o))} so'm</b> to'lovni kartaga o'tkazib, chekini yuboring.`, { reply_markup: { inline_keyboard: [[{ text: "📎 Chekni yuborish", callback_data: `paid:${o.id}`, style: "primary" }]] } });
      return send(chat, `<b>Xaridingiz bilan tabriklaymiz!</b>\n🛡 Kafolat bugundan 2 hafta — tugashidan oldin eslatamiz.\n\nnoutgo'ni qanday baholaysiz?`, { message_effect_id: FX.party, reply_markup: { inline_keyboard: [[1, 2, 3, 4, 5].map((n) => ({ text: `${n} ⭐`, callback_data: `rt:${o.id}:${n}` }))] } });
    }
    case "rt": {
      const n = Math.max(1, Math.min(5, Number(b)));
      const { data: o } = await db.from("orders").select("id,user_id,number").eq("id", Number(a)).maybeSingle();
      if (!o || o.user_id !== from.id) return;
      await clearKb();
      const { data: f } = await db.from("feedback").insert({ order_id: o.id, user_id: from.id, rating: n }).select("id").single();
      await log("bot", "feedback", from.id, null, { order: o.id, rating: n });
      const s = await session(from.id); s.step = { t: "feedback", id: f!.id }; await setSession(from.id, s);
      await send(ADMIN, `⭐ Baho: <b>${n}/5</b> — ${who(from)} (#${o.number})`);
      return send(chat, `${"⭐".repeat(n)} Rahmat! Fikringizni bir-ikki gap bilan yozib qoldirasizmi? (noutbuk, xizmat, yetkazish haqida)`, { reply_markup: { keyboard: [[{ text: "❌ Bekor qilish" }]], resize_keyboard: true, one_time_keyboard: true } });
    }
    case "ref": return referral(chat, from);
    case "shp": { // test-only shipping simulation
      const { data: o } = await db.from("orders").select("*").eq("id", Number(a)).maybeSingle();
      if (o && o.is_test && (o.user_id === from.id || isAdmin)) { await clearKb(); if (o.delivery === "pickup") return handOver(o); return sendTracking(o, "TEST" + (100000 + o.id)); }
      return;
    }
  }
  // ---- admin only below
  if (!isAdmin) return;
  if (k === "a_orders") return adminOrders(chat);
  if (k === "a_stats") return stats(chat);
  if (k === "a_testers") return adminCommand(chat, "/testers", "");
  if (k === "aord") return adminOrderCard(chat, Number(a));
  if (k === "arp") { const s = await session(from.id); s.step = { t: "reply", to: Number(a) }; await setSession(from.id, s); return send(chat, `↩️ Javobingizni yozing (matn, rasm yoki ovoz) — mijozga bot nomidan yuboriladi.`, { reply_markup: { keyboard: [[{ text: "❌ Bekor qilish" }]], resize_keyboard: true, one_time_keyboard: true } }); }
  if (k === "aok" || k === "ano") {
    const { data: off } = await db.from("offers").select("*,products(sku,model)").eq("id", Number(a)).maybeSingle(); if (!off) return;
    await clearKb();
    if (k === "ano") { await db.from("offers").update({ decision: "declined", decided_by: "admin" }).eq("id", off.id); await send(chat, "Rad javobi yuborildi."); return send(off.user_id, "Afsuski, bu narxda bera olmaymiz 🙏 Arzonroq variantlarni ko'rasizmi?", { reply_markup: { inline_keyboard: [[{ text: "💻 Arzonroq variantlar", callback_data: "bud:0:300" }]] } }); }
    const v = Number(b); await db.from("offers").update({ decision: "accepted", decided_by: "admin", final_usd: v }).eq("id", off.id);
    const s = await session(off.user_id); s.deals = s.deals ?? {}; s.deals[off.products.sku] = v; await setSession(off.user_id, s);
    await send(chat, `Javob yuborildi: ${v}$`);
    return send(off.user_id, `✅ Admin javobi: <b>${esc(off.products.model)}</b> siz uchun <b>${v}$</b>.`, { reply_markup: { inline_keyboard: [[{ text: "🛒 Buyurtma berish", callback_data: `ord:${off.products.sku}`, style: "success" }]] } });
  }
  const { data: o } = await db.from("orders").select("*").eq("id", Number(a)).maybeSingle();
  if (!o) return;
  if ((k === "pok" || k === "pno") && o.state !== "checking") {
    const { data: pend } = await db.from("payments").select("id").eq("order_id", o.id).eq("state", "pending").limit(1);
    if (!pend?.length || due(o) <= 0) return send(chat, `#${o.number} holati: ${ST[o.state] ?? o.state}${due(o) ? "" : " · to'liq to'langan"}`);
    await clearKb();
    if (k === "pok") { await confirmBalance(o, from.id); return send(chat, `✅ #${o.number}: qolgan to'lov tasdiqlandi — to'liq to'langan.`); }
    await db.from("payments").update({ state: "rejected", confirmed_by: from.id, decided_at: new Date().toISOString() }).eq("order_id", o.id).eq("state", "pending");
    await send(chat, `❌ #${o.number}: qolgan to'lov rad etildi.`);
    return send(o.user_id, `⚠️ #${o.number}: qolgan to'lov topilmadi. Chekni tekshirib qayta yuboring yoki @noutgo ga yozing.`, { reply_markup: { inline_keyboard: [[{ text: "📎 Chekni qayta yuborish", callback_data: `paid:${o.id}` }]] } });
  }
  if (k === "pok" || k === "pno") {
    await clearKb();
    if (k === "pok") { await confirmPayment(o, from.id); return send(chat, `✅ #${o.number} tasdiqlandi.${o.is_test ? "\n🧪 Test: haqiqiy mahsulot va kanal o'zgarmadi." : ""}`, { reply_markup: { inline_keyboard: [[{ text: "📋 Buyurtmani boshqarish", callback_data: `aord:${o.id}` }], ...(o.is_test ? [[{ text: "⏩ Keyingi bosqich (test)", callback_data: `shp:${o.id}` }]] : [])] } }); }
    await setState(o, "rejected");
    await db.from("payments").update({ state: "rejected", confirmed_by: from.id, decided_at: new Date().toISOString() }).eq("order_id", o.id).eq("state", "pending");
    await send(chat, `❌ #${o.number} rad etildi.`);
    return send(o.user_id, `⚠️ #${o.number}: to'lov topilmadi. Iltimos, chekni tekshirib qayta yuboring yoki admin bilan bog'laning: @noutgo`, { reply_markup: { inline_keyboard: [[{ text: "📎 Chekni qayta yuborish", callback_data: `paid:${o.id}` }]] } });
  }
  if (k === "atr") { const s = await session(from.id); s.step = { t: "track", order: o.id }; await setSession(from.id, s); return send(chat, `📦 #${o.number}: BTS chekining rasmini yuboring, izohiga trek raqamini yozing.`); }
  if (k === "aho") { await clearKb(); if (!o.is_test) await db.from("products").update({ status: "sold" }).eq("id", o.product_id); await handOver(o); return send(chat, `🤝 #${o.number} topshirildi deb belgilandi.`); }
  if (k === "adl") { await clearKb(); await setState(o, "delivered"); await send(o.user_id, `📬 #${o.number}: buyurtmangiz yetkazildi. Iltimos, qabul qilganingizni tasdiqlang:`, { reply_markup: { inline_keyboard: [[{ text: "✅ Qabul qildim", callback_data: `rcv:${o.id}`, style: "success" }]] } }); return send(chat, "Belgilandi."); }
  if (k === "acn") { await clearKb(); await setState(o, "cancelled"); if (!o.is_test) await db.from("products").update({ status: "available" }).eq("id", o.product_id).eq("status", "reserved"); await send(o.user_id, `❌ #${o.number} buyurtmangiz bekor qilindi. Savollar bo'lsa: @noutgo`); return send(chat, `#${o.number} bekor qilindi.`); }
}

// ------------------------------------------------------------------ inline: referral invite card
async function onInline(q: any) {
  const t = await tester(q.from);
  if (!t) return tg("answerInlineQuery", { inline_query_id: q.id, results: [], cache_time: 30, is_personal: true });
  await customer(q.from);
  const code = await refCode(q.from), bonus = await num("ref_friend_uzs", 100000);
  const link = `https://t.me/noutgo_robot?start=ref_${code}`;
  const caption = `🎁 <b>${esc(q.from.first_name)} sizga noutgo'dan ${som(bonus)} so'm chegirma sovg'a qildi!</b>\n\nTekshirilgan premium noutbuklar · original zaryadka · 2 hafta kafolat · BTS orqali butun O'zbekiston bo'ylab.\n\nChegirma birinchi noutbukingizga avtomatik qo'llanadi 👇`;
  const markup = { inline_keyboard: [[{ text: `🎁 ${som(bonus)} so'm chegirmani olish`, url: link }]] };
  const card = `${SUPA}/functions/v1/shop-api?a=refcard&v=2`;
  return tg("answerInlineQuery", { inline_query_id: q.id, cache_time: 0, is_personal: true, results: [
    { type: "photo", id: "ref_card", photo_url: card, thumbnail_url: card, photo_width: 960, photo_height: 540, title: "Taklifnoma", description: `Do'stingizga ${som(bonus)} so'm chegirma`, caption, parse_mode: "HTML", reply_markup: markup },
  ] });
}

// ------------------------------------------------------------------ channel & group
async function onChannelPost(p: any) {
  if (p.chat?.id !== CHANNEL) return;
  if (p.new_chat_photo || p.delete_chat_photo || p.pinned_message) {
    if (p.new_chat_photo || p.delete_chat_photo) {
      const r = await tg("deleteMessage", { chat_id: CHANNEL, message_id: p.message_id });
      if (r.ok) await setSetting("logo_notice_deleted", JSON.stringify({ id: p.message_id, at: Date.now() }));
    }
    await setSetting("channel_last_id", String(p.message_id));
    return;
  }
  await setSetting("channel_last_id", String(p.message_id));
  await db.from("channel_posts").upsert({ message_id: p.message_id, chat_id: CHANNEL, kind: p.photo ? "photo" : p.video ? "video" : "text", text: (p.caption ?? p.text ?? "").slice(0, 2000), has_photo: !!p.photo, posted_at: new Date(p.date * 1000).toISOString() });
  if (!p.media_group_id || !(await db.from("events").select("id").eq("kind", "post").contains("data", { group: p.media_group_id }).limit(1)).data?.length)
    await log("channel", "post", null, null, { id: p.message_id, group: p.media_group_id ?? null });
}
async function onChatMember(u: any) {
  if (u.chat?.id !== CHANNEL) return;
  const was = u.old_chat_member?.status, now = u.new_chat_member?.status, user = u.new_chat_member?.user;
  const inS = ["member", "administrator", "creator", "restricted"];
  if (!inS.includes(was) && inS.includes(now)) await log("channel", "join", user?.id, null, { name: user?.first_name, username: user?.username, via: u.invite_link?.name ?? u.invite_link?.invite_link ?? null });
  if (inS.includes(was) && !inS.includes(now)) await log("channel", "leave", user?.id, null, { name: user?.first_name, username: user?.username });
}
async function onReactionCount(r: any) {
  if (r.chat?.id !== CHANNEL) return;
  await db.from("channel_posts").update({ reactions: r.reactions, updated_at: new Date().toISOString() }).eq("message_id", r.message_id);
  await log("channel", "reaction", null, null, { id: r.message_id, reactions: r.reactions });
}

// ------------------------------------------------------------------ cron jobs
async function dailyReport() {
  const since = new Date(Date.now() - 864e5).toISOString();
  const { data: ev } = await db.from("events").select("source,kind,data").gte("at", since).limit(5000);
  const c = (s: string, k: string) => (ev ?? []).filter((e: any) => e.source === s && e.kind === k).length;
  const leftNames = (ev ?? []).filter((e: any) => e.kind === "leave").slice(0, 8).map((e: any) => (e.data?.username ? "@" + e.data.username : e.data?.name ?? "?"));
  const members = (await tg("getChatMemberCount", { chat_id: CHANNEL })).result;
  await send(ADMIN, `🌙 <b>Kunlik hisobot</b>\n\n📢 Kanal: ${members ?? "?"} obunachi\n➕ Qo'shildi: ${c("channel", "join")} · ➖ Chiqdi: ${c("channel", "leave")}${leftNames.length ? " (" + esc(leftNames.join(", ")) + ")" : ""}\n📝 Postlar: ${c("channel", "post")} · 💬 Izohlar: ${c("group", "comment")} · ❤️ Reaksiyalar: ${c("channel", "reaction")}\n💼 Biznes chat xabarlari: ${c("business", "message")}\n🤖 Bot: ${c("bot", "start")} start · ${c("bot", "referral")} taklif orqali · ${c("bot", "view") + c("app", "view")} ko'rish · ${c("bot", "offer") + c("app", "offer")} narx taklifi · ${c("bot", "order") + c("app", "order")} buyurtma · ${c("bot", "paid")} to'lov · ${c("bot", "feedback")} fikr\n\nBatafsil: /stats`);
}
async function warrantyJob() {
  const cutoff = new Date(Date.now() - 14 * 864e5).toISOString();
  const { data: os } = await db.from("orders").select("id,number,user_id,received_at,is_test,products(model)").eq("state", "received").is("warranty_notified_at", null).lt("received_at", cutoff).limit(50);
  for (const o of (os ?? []) as any[]) {
    await send(o.user_id, `🛡 <b>#${o.number}: 2 haftalik kafolat muddati tugadi.</b>\n${esc(o.products?.model ?? "")} sizga yoqyaptimi? Savol bo'lsa — yozing, doim yordam beramiz.\n\n🎁 Do'stlaringizni taklif qiling: har bir xarid uchun pul mukofoti.`, { reply_markup: { inline_keyboard: [[{ text: "🎁 Taklif havolam", callback_data: "ref" }]] } });
    await db.from("orders").update({ warranty_notified_at: new Date().toISOString() }).eq("id", o.id);
  }
  const { data: rs } = await db.from("referrals").select("id,referrer_id,friend_id,reward_uzs,order_id,orders(received_at,number,state)").eq("state", "bought").is("due_notified_at", null).limit(50);
  for (const r of (rs ?? []) as any[]) {
    if (!r.orders?.received_at || r.orders.received_at > cutoff || r.orders.state !== "received") continue;
    await send(ADMIN, `💸 <b>Taklif mukofoti to'lash vaqti</b>\nTaklif qilgan: ID ${r.referrer_id}\nDo'st: ID ${r.friend_id} (#${r.orders.number}, 14 kun o'tdi)\nSumma: <b>${som(r.reward_uzs ?? 150000)} so'm</b>`);
    await send(r.referrer_id, `🎉 Do'stingizning xaridi tasdiqlandi — sizga <b>${som(r.reward_uzs ?? 150000)} so'm</b> mukofot! Admin karta raqamingizni so'raydi.`, { message_effect_id: FX.party });
    await db.from("referrals").update({ state: "earned", due_notified_at: new Date().toISOString() }).eq("id", r.id);
  }
}
async function expireOrders() {
  const now = new Date().toISOString();
  const a = await db.from("orders").update({ state: "expired", updated_at: now }).eq("state", "await_pay").lt("reserved_until", now).select("id,number,user_id");
  const b = await db.from("orders").update({ state: "expired", updated_at: now }).eq("state", "reserved").eq("pay_mode", "on_pickup").lt("reserved_until", now).select("id,number,user_id");
  for (const o of [...(a.data ?? []), ...(b.data ?? [])] as any[]) { await send(o.user_id, `⌛ #${o.number}: band qilish muddati tugadi. Noutbuk yana sotuvda — kerak bo'lsa, qaytadan buyurtma bering.`); await send(ADMIN, `⌛ #${o.number} muddati o'tdi.`); }
}

// ------------------------------------------------------------------ entry
Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") {
    const tok = url.searchParams.get("t");
    if (!tok || tok !== (await setting("selftest_token"))) return new Response("ok");
    if (url.searchParams.get("setup")) {
      const r = await tg("setWebhook", { url: HUB_URL, secret_token: await sha("hub:" + BOT), allowed_updates: ["message", "business_message", "business_connection", "callback_query", "inline_query", "channel_post", "chat_member", "message_reaction_count"] });
      await tg("setMyCommands", { commands: [{ command: "start", description: "Boshlash" }] });
      await tg("setMyCommands", { scope: { type: "chat", chat_id: ADMIN }, commands: [
        { command: "admin", description: "Admin panel" }, { command: "orders", description: "Buyurtmalar" }, { command: "stats", description: "Statistika" }, { command: "testers", description: "Testerlar" },
        { command: "card", description: "To'lov kartasi" }, { command: "status", description: "AI holati" }, { command: "on", description: "AI yoqish" }, { command: "off", description: "AI o'chirish" }] });
      return Response.json(r);
    }
    if (url.searchParams.get("rollback")) return Response.json(await tg("setWebhook", { url: OLD_URL, secret_token: await sha("noutgo:" + BOT), allowed_updates: ["message", "business_message", "business_connection"] }));
    if (url.searchParams.get("cron") === "report") { await dailyReport(); return new Response("sent"); }
    if (url.searchParams.get("cron") === "expire") { await expireOrders(); return new Response("ok"); }
    if (url.searchParams.get("cron") === "warranty") { await warrantyJob(); return new Response("ok"); }
    if (url.searchParams.get("profile")) {
      const r = [
        await tg("setMyShortDescription", { short_description: "Noutbuk tanlang, solishtiring, narx taklif qiling va buyurtma bering — BTS orqali yoki Toshkentda olib ketish." }),
        await tg("setMyDescription", { description: "noutgo rasmiy boti — premium b/u noutbuklar.\n\nBu yerda siz:\n💻 sotuvdagi noutbuklarni rasm, narx va holati bilan ko'rasiz\n⚖️ modellarni solishtirasiz, byudjet bo'yicha tanlaysiz\n💬 narx taklif qilasiz\n🛒 buyurtma berasiz: BTS — butun O'zbekiston, yoki Toshkentda olib ketish\n💳 kartaga to'laysiz, holat va BTS trek raqamini kuzatasiz\n✍️ adminga savol yuborasiz\n🎁 do'st taklif qilib, pul mukofoti olasiz\n\n🛡 2 hafta kafolat · original zaryadka\n📞 +998 50 570 55 79" }),
        await tg("setMySettings", { supports_inline_queries: true, inline_query_placeholder: "do'stga taklifnoma" }),
      ];
      return Response.json(r);
    }
    return new Response("ok");
  }
  if (req.headers.get("x-telegram-bot-api-secret-token") !== (await sha("hub:" + BOT))) return new Response("forbidden", { status: 403 });
  const u = await req.json();
  const task = (async () => {
    try {
      if (u.business_message || u.business_connection) {
        if (u.business_message && u.business_message.from?.id !== ADMIN) await log("business", "message", u.business_message.from?.id);
        return forward(u);
      }
      if (u.message) {
        const m = u.message, type = m.chat?.type;
        if (type === "private") {
          const t = await tester(m.from);
          const text: string = m.text ?? "";
          const cmd = text.split(/\s+/)[0].split("@")[0];
          if (!t) return forward(u);
          if (LEGACY.includes(cmd) || ((m.location || m.venue) && t.role === "admin") || text === "/start location") return forward(u);
          return onTesterMessage(m, t);
        }
        if (type === "group" || type === "supergroup") {
          if (m.chat.id === GROUP && !m.is_automatic_forward && m.from?.id !== ADMIN && !m.sender_chat) await log("group", "comment", m.from?.id, null, { len: (m.text ?? "").length });
          return forward(u);
        }
        return;
      }
      if (u.callback_query) return onCallback(u.callback_query);
      if (u.inline_query) return onInline(u.inline_query);
      if (u.channel_post) return onChannelPost(u.channel_post);
      if (u.chat_member) return onChatMember(u.chat_member);
      if (u.message_reaction_count) return onReactionCount(u.message_reaction_count);
    } catch (e) { console.error("hub error", e); }
  })();
  // @ts-ignore EdgeRuntime is provided by Supabase
  EdgeRuntime.waitUntil(task);
  return new Response("ok");
});
