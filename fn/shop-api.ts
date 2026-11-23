// shop-api v2 — backend for the noutgo Mini App (customer shop + admin panel).
// Every call carries Telegram's signed initData; only bot_testers may use it while testing.
// Admin order actions are replayed through noutgo-hub so the bot and the app share one order lifecycle.
import { createClient } from "npm:@supabase/supabase-js@2";
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";
const BOT = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const GEMINI = Deno.env.get("GEMINI_API_KEY") ?? "";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SUPA, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const ADMIN = 7420108945, CHANNEL = -1002274386795;
const PHONE = "+998 50 570 55 79";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,x-init-data", "access-control-allow-methods": "GET,POST,OPTIONS" };
const json = (x: unknown, s = 200) => new Response(JSON.stringify(x), { status: s, headers: { "content-type": "application/json", ...CORS } });
const enc = new TextEncoder();
async function hmac(key: ArrayBuffer | Uint8Array, msg: string) { const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg))); }
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
async function sha(s: string) { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))).slice(0, 48); }
async function tg(m: string, b: Record<string, unknown>) { const r = await fetch(`https://api.telegram.org/bot${BOT}/${m}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return r.json(); }
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const som = (n: number) => Math.round(Number(n) || 0).toLocaleString("ru-RU").replace(/[  ,]/g, " ");
async function setting(k: string, d = "") { const { data } = await db.from("bot_settings").select("value").eq("key", k).maybeSingle(); return data?.value ?? d; }
// One round trip for many settings.
async function settings(keys: string[]) { const { data } = await db.from("bot_settings").select("key,value").in("key", keys); return Object.fromEntries((data ?? []).map((r: any) => [r.key, r.value])) as Record<string, string>; }
async function num(k: string, d: number) { return Number(await setting(k, String(d))) || d; }
async function log(kind: string, uid: number, pid?: number | null, data?: unknown) { await db.from("events").insert({ source: "app", kind, user_id: uid, product_id: pid ?? null, data: data ?? null }); }
const INFO_POST = "https://t.me/noutgo_uz/1669";
const due = (o: any) => Math.max(0, Number(o.total_uzs) - Number(o.paid_uzs ?? 0));
const who = (u: any) => `${esc(u?.first_name ?? "")}${u?.username ? " @" + esc(u.username) : ""}`;

// Telegram Mini App login check (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
async function verify(initData: string) {
  const p = new URLSearchParams(initData); const hash = p.get("hash"); if (!hash) return null; p.delete("hash");
  const dcs = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(enc.encode("WebAppData"), BOT);
  if (hex(await hmac(secret, dcs)) !== hash) return null;
  if (Date.now() / 1000 - Number(p.get("auth_date") ?? 0) > 86400) return null;
  return JSON.parse(p.get("user") ?? "null");
}
async function role(user: any) {
  let { data } = await db.from("bot_testers").select("id,role,user_id").eq("user_id", user.id).maybeSingle();
  if (!data && user.username) { const r = await db.from("bot_testers").select("id,role,user_id").ilike("username", user.username).maybeSingle(); if (r.data) { await db.from("bot_testers").update({ user_id: user.id }).eq("id", r.data.id); data = r.data; } }
  return data?.role ?? null;
}
async function touch(u: any) {
  const { data } = await db.from("customers").select("user_id").eq("user_id", u.id).maybeSingle();
  if (data) await db.from("customers").update({ first_name: u.first_name, username: u.username ?? null, last_seen: new Date().toISOString() }).eq("user_id", u.id);
  else await db.from("customers").insert({ user_id: u.id, first_name: u.first_name, username: u.username ?? null, lang: u.language_code ?? null, prefers: "app" });
}
// Replay an admin action as a callback through the hub (same code path as the bot buttons).
async function viaHub(from: any, data: string) {
  const upd = { update_id: 0, callback_query: { id: "app", from: { id: from.id, is_bot: false, first_name: from.first_name, username: from.username }, chat_instance: "app", data } };
  const r = await fetch(`${SUPA}/functions/v1/noutgo-hub`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": await sha("hub:" + BOT) }, body: JSON.stringify(upd) });
  return r.ok;
}
const imgSig = async (f: string) => hex(await hmac(enc.encode(BOT), "img:" + f)).slice(0, 20);
const imgUrl = async (f: string) => `${SUPA}/functions/v1/shop-api?a=img&f=${encodeURIComponent(f)}&s=${await imgSig(f)}`;
async function view(p: any) {
  const photos = (p.photo_urls ?? []).length ? p.photo_urls : await Promise.all((p.photo_ids ?? []).map(imgUrl));
  return { sku: p.sku, model: p.model, category: p.category, price: p.price_usd, price_text: p.price, cpu: p.cpu, ram: p.ram_gb, ssd: p.ssd, screen: p.screen, gpu: p.gpu, color: p.color, battery: p.battery_pct, battery_hours: p.battery_hours, cond: p.cond_score, defects: p.defects, description: p.description, photos, has_video: !!p.video_id };
}
async function friendDiscount(uid: number) {
  const { data: r } = await db.from("referrals").select("id").eq("friend_id", uid).eq("state", "joined").maybeSingle();
  if (!r) return 0;
  const { count } = await db.from("orders").select("*", { count: "exact", head: true }).eq("user_id", uid).in("state", ["paid", "ready", "shipped", "delivered", "received", "reserved"]);
  return (count ?? 0) ? 0 : await num("ref_friend_uzs", 100000);
}

// ------------------------------------------------------------------ orders
async function createOrder(u: any, b: any) {
  const { data: p } = await db.from("products").select("*").eq("sku", b.sku).maybeSingle();
  if (!p || p.status !== "available" || !p.price_usd) return { error: "Mahsulot mavjud emas" };
  const pickup = b.delivery === "pickup";
  const office = !pickup ? (await db.from("bts_offices").select("*").eq("code", String(b.office ?? "")).maybeSingle()).data : null;
  if (!pickup && !office) return { error: "BTS filialini tanlang" };
  if (!String(b.name ?? "").trim() || String(b.phone ?? "").replace(/\D/g, "").length < 9) return { error: "Ism va telefon raqamini kiriting" };
  await touch(u);
  const { data: c } = await db.from("customers").select("session").eq("user_id", u.id).maybeSingle();
  const price = (c?.session?.deals ?? {})[b.sku] ?? p.price_usd;
  const rate = await num("usd_rate", 12000), base = price * rate;
  const dfee = pickup ? 0 : (String(office!.region).startsWith("Toshkent") ? 30000 : 45000);
  const mode: "full" | "deposit" | "later" = pickup ? (["deposit", "later"].includes(b.pay) ? b.pay : "full") : (b.pay === "deposit" ? "deposit" : "full");
  const disc = await friendDiscount(u.id);
  const live = (await setting("shop_live", "0")) === "1";
  const ins = await db.from("orders").insert({
    number: "T-" + Date.now().toString(36), user_id: u.id, product_id: p.id, price_usd: price, rate, price_uzs: base, delivery: pickup ? "pickup" : "bts",
    region: pickup ? "Toshkent, Yunusobod (olib ketish)" : `${office!.region}, ${office!.city}`, bts_office: office ? `${office.name} (${office.code}) — ${office.address}` : null,
    delivery_uzs: dfee, total_uzs: base + dfee - disc, name: String(b.name).slice(0, 60), phone: String(b.phone).slice(0, 30), pay_mode: mode === "later" ? "on_pickup" : mode,
    reserved_until: new Date(Date.now() + (mode === "later" ? 3 : 2) * 3600e3).toISOString(), channel: "app", is_test: !live, state: mode === "later" ? "reserved" : "await_pay",
  }).select("id").single();
  if (ins.error) return { error: "Bu noutbuk hozirgina band qilindi" };
  const id = ins.data.id, uniq = 10 + (id % 90), total = base + dfee - disc + uniq, number = `N-${1000 + id}`;
  const dep = mode === "deposit" ? (await num("deposit_uzs", 300000)) + uniq : 0;
  await db.from("orders").update({ number, total_uzs: total, deposit_uzs: dep }).eq("id", id);
  await db.from("customers").update({ phone: b.phone }).eq("user_id", u.id);
  await log("order", u.id, p.id, { number, total, mode });
  const { data: cu } = await db.from("customers").select("referred_by").eq("user_id", u.id).maybeSingle();
  await tg("sendMessage", { chat_id: ADMIN, parse_mode: "HTML", text: `🔔 <b>Yangi buyurtma #${number}</b> (ilova${live ? "" : ", test"})\n${who(u)} · ${esc(b.phone)}\n${esc(p.model)} — ${price}$\n${pickup ? "🏠 Olib ketish" : "🚚 BTS: " + esc(office!.name) + ", " + esc(office!.city)}\nTo'lov: ${mode === "full" ? "to'liq oldindan" : mode === "deposit" ? `band uchun ${som(dep)} so'm` : "ko'rib, keyin (3 soat band)"}\nJami: <b>${som(total)} so'm</b>${disc ? ` (taklif chegirmasi ${som(disc)})` : ""}${cu?.referred_by ? `\n👥 Taklif qilgan: ID ${cu.referred_by}` : ""}`, reply_markup: { inline_keyboard: [[{ text: "📋 Buyurtmani boshqarish", callback_data: `aord:${id}` }]] } });
  return { id, number, total, deposit: dep, discount: disc, mode, pay_now: mode === "deposit" ? dep : mode === "full" ? total : 0, uniq, card: await setting("payment_card"), holder: await setting("payment_card_name"), reserved_until: Date.now() + (mode === "later" ? 3 : 2) * 3600e3 };
}

async function readReceipt(bytes: Uint8Array, mime: string) {
  if (!GEMINI) return null;
  try {
    let b64 = ""; for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const model = await setting("gemini_model", "gemini-3.1-flash-lite");
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: mime, data: btoa(b64) } }, { text: 'Bank transfer receipt (Uzbekistan). Return ONLY JSON: {"amount_uzs": number|null, "receiver_last4": "1234"|null, "txn_id": string|null}' }] }], generationConfig: { responseMimeType: "application/json", temperature: 0 } }) });
    return JSON.parse((await r.json()).candidates?.[0]?.content?.parts?.[0]?.text ?? "null");
  } catch { return null; }
}
async function upload(chat: number, bin: Uint8Array, mime: string, caption: string, markup?: unknown) {
  const isImg = mime.startsWith("image/");
  const fd = new FormData();
  fd.append("chat_id", String(chat)); fd.append("parse_mode", "HTML");
  fd.append(isImg ? "photo" : "document", new Blob([bin], { type: mime }), isImg ? "rasm.jpg" : "fayl.pdf");
  fd.append("caption", caption);
  if (markup) fd.append("reply_markup", JSON.stringify(markup));
  const sent = await (await fetch(`https://api.telegram.org/bot${BOT}/${isImg ? "sendPhoto" : "sendDocument"}`, { method: "POST", body: fd })).json();
  return isImg ? sent.result?.photo?.at(-1) : sent.result?.document;
}
const decode = (b64: string) => Uint8Array.from(atob(String(b64)), (c) => c.charCodeAt(0));
async function receipt(u: any, b: any) {
  const { data: o } = await db.from("orders").select("*").eq("id", b.order_id).eq("user_id", u.id).maybeSingle();
  const balance = !!o && Number(o.paid_uzs) > 0 && due(o) > 0 && ["paid", "reserved", "ready", "shipped", "delivered"].includes(o.state);
  if (!o || !(["await_pay", "rejected"].includes(o.state) || balance)) return { error: "Bu buyurtma uchun chek kutilmayapti" };
  const bin = decode(b.data);
  if (bin.length > 8e6) return { error: "Fayl juda katta" };
  const expect = balance ? due(o) : o.pay_mode === "deposit" ? Number(o.deposit_uzs) : Number(o.total_uzs);
  const mime = String(b.mime || "image/jpeg");
  const res = await readReceipt(bin, mime);
  const card = (await setting("payment_card")).replace(/\D/g, "");
  const amountOk = res?.amount_uzs != null ? Math.abs(Number(res.amount_uzs) - expect) < 1 : null;
  const cardOk = res?.receiver_last4 && card ? card.endsWith(String(res.receiver_last4)) : null;
  const mark = (v: boolean | null) => (v === true ? "✅ mos" : v === false ? "❌ mos emas" : "❔ aniqlanmadi");
  const file = await upload(ADMIN, bin, mime, `🧾 <b>Chek — #${o.number}</b> (ilova${o.is_test ? ", test" : ""})\n${balance ? "Qolgan to'lov" : o.pay_mode === "deposit" ? "Oldindan to'lov" : "To'liq to'lov"}: <b>${som(expect)} so'm</b>\nSumma: ${mark(amountOk)}${res?.amount_uzs ? ` (${som(Number(res.amount_uzs))})` : ""}\nKarta: ${mark(cardOk)}\n\nBank ilovangizda pul tushganini tekshirib, tasdiqlang.`,
    { inline_keyboard: [[{ text: "✅ To'lovni tasdiqlash", callback_data: `pok:${o.id}`, style: "success" }, { text: "❌ Rad etish", callback_data: `pno:${o.id}`, style: "danger" }]] });
  const ins = await db.from("payments").insert({ order_id: o.id, amount_uzs: expect, receipt_file_id: file?.file_id, receipt_hash: file?.file_unique_id ?? crypto.randomUUID(), check_result: res });
  if (ins.error) return { error: "Bu chek avval yuborilgan" };
  if (!balance) await db.from("orders").update({ state: "checking", updated_at: new Date().toISOString() }).eq("id", o.id);
  await log("receipt", u.id, o.product_id, { number: o.number });
  return { ok: true, amountOk, cardOk };
}
async function cancel(u: any, b: any) {
  const { data: o } = await db.from("orders").select("id,number,state,user_id").eq("id", b.order_id).eq("user_id", u.id).maybeSingle();
  if (!o || !["await_pay", "rejected", "reserved"].includes(o.state)) return { error: "Bu buyurtmani bekor qilib bo'lmaydi" };
  await db.from("orders").update({ state: "cancelled", updated_at: new Date().toISOString() }).eq("id", o.id);
  await tg("sendMessage", { chat_id: ADMIN, text: `❌ #${o.number} mijoz tomonidan bekor qilindi (ilova).` });
  return { ok: true };
}
async function received(u: any, b: any) {
  const { data: o } = await db.from("orders").select("*").eq("id", b.order_id).eq("user_id", u.id).maybeSingle();
  if (!o || !["shipped", "delivered", "ready"].includes(o.state)) return { error: "Holat: " + (o?.state ?? "?") };
  await db.from("orders").update({ state: "received", received_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", o.id);
  await db.from("events").insert({ source: "bot", kind: "status", user_id: u.id, product_id: o.product_id, data: { number: o.number, state: "received", via: "app" } });
  const { data: rf } = await db.from("referrals").select("id,referrer_id").eq("friend_id", u.id).eq("state", "joined").maybeSingle();
  if (rf) {
    const reward = await num("ref_reward_uzs", 150000);
    await db.from("referrals").update({ state: "bought", order_id: o.id, reward_uzs: reward }).eq("id", rf.id);
    await tg("sendMessage", { chat_id: rf.referrer_id, parse_mode: "HTML", text: `🎉 Siz taklif qilgan do'stingiz ${who(u)} noutbuk sotib oldi! 14 kun o'tgach, qaytarilmasa, sizga <b>${som(reward)} so'm</b> o'tkaziladi.` });
    await tg("sendMessage", { chat_id: ADMIN, parse_mode: "HTML", text: `👥 Taklif bo'yicha xarid: ${who(u)} (#${o.number}) ← ID ${rf.referrer_id}. 14 kundan so'ng ${som(reward)} so'm mukofot to'lanadi.` });
  }
  await tg("sendMessage", { chat_id: ADMIN, text: `🎉 #${o.number}: mijoz qabul qilganini tasdiqladi (ilova).` });
  return { ok: true };
}
async function feedback(u: any, b: any) {
  const { data: o } = await db.from("orders").select("id,number").eq("id", b.order_id).eq("user_id", u.id).maybeSingle();
  if (!o) return { error: "?" };
  const rating = Math.max(1, Math.min(5, Number(b.rating) || 5)), text = String(b.text ?? "").slice(0, 1500);
  await db.from("feedback").insert({ order_id: o.id, user_id: u.id, rating, text: text || null });
  await db.from("events").insert({ source: "bot", kind: "feedback", user_id: u.id, data: { order: o.id, rating, via: "app" } });
  await tg("sendMessage", { chat_id: ADMIN, parse_mode: "HTML", text: `⭐ Baho: <b>${rating}/5</b> — ${who(u)} (#${o.number})${text ? `\n«${esc(text.slice(0, 800))}»` : ""}` });
  return { ok: true };
}

async function offer(u: any, b: any) {
  const { data: p } = await db.from("products").select("*").eq("sku", b.sku).maybeSingle(); if (!p?.price_usd) return { error: "?" };
  const v = Number(b.v);
  if (!(v > 0)) return { error: "Summani kiriting" };
  await touch(u);
  const { data: c } = await db.from("customers").select("session").eq("user_id", u.id).maybeSingle();
  const s = c?.session ?? {}; s.rounds = s.rounds ?? {}; s.deals = s.deals ?? {}; s.rounds[b.sku] = (s.rounds[b.sku] ?? 0) + 1;
  const { data: off } = await db.from("offers").insert({ product_id: p.id, user_id: u.id, amount_usd: v, round: s.rounds[b.sku] }).select("id").single();
  await log("offer", u.id, p.id, { v });
  const save = () => db.from("customers").update({ session: s }).eq("user_id", u.id);
  if (v >= p.price_usd) { s.deals[b.sku] = p.price_usd; await save(); return { result: "accepted", price: p.price_usd }; }
  if (p.floor_usd && v >= p.floor_usd) {
    if (s.rounds[b.sku] === 1) { const cp = Math.min(p.price_usd, Math.ceil((v + p.price_usd) / 2 / 5) * 5); await save(); return { result: "counter", price: cp }; }
    s.deals[b.sku] = v; await save(); return { result: "accepted", price: v };
  }
  await save();
  const mid = Math.round((v + p.price_usd) / 2 / 5) * 5;
  await tg("sendMessage", { chat_id: ADMIN, parse_mode: "HTML", text: `💬 <b>Narx taklifi</b> (ilova)\n${who(u)}\n${esc(p.model)}\nRo'yxatda: ${p.price_usd}$${p.floor_usd ? ` · chegara ${p.floor_usd}$` : ""}\nTaklif: <b>${v}$</b>`, reply_markup: { inline_keyboard: [[{ text: `✅ ${v}$ ga rozi`, callback_data: `aok:${off!.id}:${v}`, style: "success" }, { text: `↔️ ${mid}$`, callback_data: `aok:${off!.id}:${mid}` }], [{ text: "❌ Rad etish", callback_data: `ano:${off!.id}`, style: "danger" }]] } });
  return { result: "admin" };
}
async function accept(u: any, b: any) { // customer accepts a counter-offer
  const { data: c } = await db.from("customers").select("session").eq("user_id", u.id).maybeSingle();
  const s = c?.session ?? {}; s.deals = s.deals ?? {}; s.deals[b.sku] = Number(b.price);
  await db.from("customers").update({ session: s }).eq("user_id", u.id);
  return { ok: true };
}
async function referral(u: any) {
  await touch(u);
  const { data: c } = await db.from("customers").select("ref_code").eq("user_id", u.id).maybeSingle();
  let code = c?.ref_code;
  if (!code) { code = (String(u.first_name || "NG").replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 6) || "NG") + (100 + Math.floor(Math.random() * 899)); await db.from("customers").update({ ref_code: code }).eq("user_id", u.id); }
  const { data: refs } = await db.from("referrals").select("state").eq("referrer_id", u.id);
  return { link: `https://t.me/noutgo_robot?start=ref_${code}`, invited: refs?.length ?? 0, bought: (refs ?? []).filter((r: any) => ["bought", "earned", "paid"].includes(r.state)).length, bonus: await num("ref_friend_uzs", 100000), reward: await num("ref_reward_uzs", 150000) };
}

// ------------------------------------------------------------------ admin
async function dashboard() {
  const since = (d: number) => new Date(Date.now() - d * 864e5).toISOString();
  const { data: ev } = await db.from("events").select("at,source,kind,user_id,product_id,data").gte("at", since(30)).order("at", { ascending: false }).limit(3000);
  const E = ev ?? [];
  const count = (s: string, k: string, d: number) => E.filter((e: any) => e.source === s && e.kind === k && e.at >= since(d)).length;
  const kinds: [string, string, string][] = [["channel", "join", "Kanalga qo'shildi"], ["channel", "leave", "Kanaldan chiqdi"], ["channel", "post", "Kanal postlari"], ["group", "comment", "Guruhdagi izohlar"], ["channel", "reaction", "Reaksiyalar"], ["business", "message", "Biznes chat xabarlari"], ["bot", "start", "Bot: /start"], ["bot", "referral", "Taklif orqali kelgan"], ["bot", "view", "Bot: ko'rishlar"], ["app", "open", "Ilova: ochildi"], ["app", "view", "Ilova: ko'rishlar"], ["bot", "offer", "Narx takliflari (bot)"], ["app", "offer", "Narx takliflari (ilova)"], ["bot", "order", "Buyurtmalar (bot)"], ["app", "order", "Buyurtmalar (ilova)"], ["bot", "paid", "To'lov tasdiqlandi"], ["bot", "feedback", "Fikrlar"]];
  const metrics = kinds.map(([s, k, label]) => ({ label, d1: count(s, k, 1), d7: count(s, k, 7), d30: count(s, k, 30) }));
  const days: { day: string; joins: number; leaves: number; views: number; orders: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    const on = E.filter((e: any) => e.at.slice(0, 10) === d);
    days.push({ day: d.slice(5), joins: on.filter((e: any) => e.kind === "join").length, leaves: on.filter((e: any) => e.kind === "leave").length, views: on.filter((e: any) => e.kind === "view").length, orders: on.filter((e: any) => e.kind === "order").length });
  }
  const { data: prods } = await db.from("products").select("id,sku,model,price_usd,floor_usd").eq("status", "available").not("sku", "is", null);
  const top = (prods ?? []).map((p: any) => ({ sku: p.sku, model: p.model, price: p.price_usd, floor: p.floor_usd, views: E.filter((e: any) => e.kind === "view" && e.product_id === p.id && e.at >= since(7)).length, offers: E.filter((e: any) => e.kind === "offer" && e.product_id === p.id && e.at >= since(7)).length })).sort((a, b) => b.views - a.views);
  const uids = [...new Set(E.slice(0, 60).map((e: any) => e.user_id).filter(Boolean))];
  const { data: names } = uids.length ? await db.from("customers").select("user_id,first_name,username").in("user_id", uids) : { data: [] };
  const nm = Object.fromEntries((names ?? []).map((n: any) => [n.user_id, n.username ? "@" + n.username : n.first_name]));
  const feed = E.slice(0, 60).map((e: any) => ({ at: e.at, source: e.source, kind: e.kind, who: e.user_id ? (nm[e.user_id] ?? (e.data?.username ? "@" + e.data.username : (e.data?.name ?? String(e.user_id)))) : "", product: (prods ?? []).find((p: any) => p.id === e.product_id)?.model ?? null, data: e.data }));
  const members = (await tg("getChatMemberCount", { chat_id: CHANNEL })).result ?? null;
  return { members, metrics, days, top, feed };
}
async function adminOrders() {
  const { data } = await db.from("orders").select("id,number,state,user_id,total_uzs,deposit_uzs,paid_uzs,pay_mode,name,phone,delivery,region,bts_office,track_number,track_photo,is_test,channel,created_at,products(model)").order("id", { ascending: false }).limit(60);
  const rows = await Promise.all((data ?? []).map(async (o: any) => ({ ...o, track_photo_url: o.track_photo ? await imgUrl(o.track_photo) : null })));
  const { data: fb } = await db.from("feedback").select("order_id,rating,text").in("order_id", rows.map((o) => o.id));
  const f = Object.fromEntries((fb ?? []).map((x: any) => [x.order_id, x]));
  const { data: pp } = await db.from("payments").select("order_id").eq("state", "pending").in("order_id", rows.map((o) => o.id));
  const pend = new Set((pp ?? []).map((x: any) => x.order_id));
  return { orders: rows.map((o) => ({ ...o, feedback: f[o.id] ?? null, pending: pend.has(o.id), due: due(o) })) };
}
async function adminUsers() {
  const { data: cs } = await db.from("customers").select("user_id,first_name,username,phone,ref_code,referred_by,source,prefers,created_at,last_seen").order("created_at", { ascending: false }).limit(300);
  const ids = (cs ?? []).map((c: any) => c.user_id);
  const { data: os } = ids.length ? await db.from("orders").select("user_id,state").in("user_id", ids) : { data: [] };
  const { data: rs } = await db.from("referrals").select("referrer_id,friend_id,state,reward_uzs,created_at").order("id", { ascending: false }).limit(300);
  const name = Object.fromEntries((cs ?? []).map((c: any) => [c.user_id, c.username ? "@" + c.username : c.first_name]));
  const users = (cs ?? []).map((c: any) => ({
    ...c, referred_by_name: c.referred_by ? (name[c.referred_by] ?? String(c.referred_by)) : null,
    orders: (os ?? []).filter((o: any) => o.user_id === c.user_id).length,
    bought: (os ?? []).filter((o: any) => o.user_id === c.user_id && ["paid", "ready", "shipped", "delivered", "received"].includes(o.state)).length,
    invited: (rs ?? []).filter((r: any) => r.referrer_id === c.user_id).length,
  }));
  const referrals = (rs ?? []).map((r: any) => ({ ...r, referrer: name[r.referrer_id] ?? String(r.referrer_id), friend: name[r.friend_id] ?? String(r.friend_id) }));
  const { data: fbs } = await db.from("feedback").select("order_id,user_id,rating,text,created_at").order("id", { ascending: false }).limit(100);
  const feedback = (fbs ?? []).map((x: any) => ({ ...x, who: name[x.user_id] ?? String(x.user_id) }));
  return { users, referrals, feedback };
}
async function adminTrack(adminUser: any, b: any) {
  const { data: o } = await db.from("orders").select("*").eq("id", b.order_id).maybeSingle();
  if (!o || o.delivery !== "bts") return { error: "BTS buyurtmasi emas" };
  if (!["paid", "shipped"].includes(o.state)) return { error: "Avval to'lovni tasdiqlang (holat: " + o.state + ")" };
  const track = String(b.track ?? "").trim().slice(0, 40);
  if (!track) return { error: "Trek raqamini kiriting" };
  const left = due(o), card = await setting("payment_card"), holder = await setting("payment_card_name");
  const text = `🚚 <b>Buyurtmangiz #${o.number} BTS'ga topshirildi!</b>\nTrek raqami: <code>${esc(track)}</code>\n${o.bts_office ? `🏢 Filial: ${esc(o.bts_office)}\n` : ""}` +
    (left ? `\n💳 <b>Qolgan to'lov: ${som(left)} so'm.</b>\nBTS ilovasida qabul qilinganini tekshirib, ${card ? `<code>${esc(card.replace(/\s/g, ""))}</code>${holder ? " (" + esc(holder) + ")" : ""} kartasiga` : "kartaga"} o'tkazing va chekini yuboring.\n` : "") +
    `\nFilialga yetganda pasport bilan oling, so'ng «✅ Qabul qildim» tugmasini bosing.`;
  const kb = { inline_keyboard: [[{ text: "📋 Trek raqami", copy_text: { text: track } }, ...(left && card ? [{ text: "📋 Karta", copy_text: { text: card.replace(/\s/g, "") } }] : [])], ...(left ? [[{ text: "📎 Qolgan to'lov chekini yuborish", callback_data: `paid:${o.id}`, style: "primary" }]] : []), [{ text: "✅ Qabul qildim", callback_data: `rcv:${o.id}`, style: "success" }]] };
  let photo: string | null = null;
  if (b.data) { const f = await upload(o.user_id, decode(b.data), String(b.mime || "image/jpeg"), text, kb); photo = f?.file_id ?? null; if (!photo) return { error: "Rasm yuborilmadi" }; }
  else await tg("sendMessage", { chat_id: o.user_id, parse_mode: "HTML", text, reply_markup: kb });
  await db.from("orders").update({ state: "shipped", track_number: track, track_photo: photo, shipped_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", o.id);
  await db.from("events").insert({ source: "bot", kind: "status", user_id: o.user_id, product_id: o.product_id, data: { number: o.number, state: "shipped", by: adminUser.id } });
  await tg("sendMessage", { chat_id: ADMIN, text: `✅ #${o.number}: trek ${track} mijozga yuborildi (ilova).` });
  return { ok: true };
}
async function adminNote(b: any) { await db.from("orders").update({ admin_note: String(b.note ?? "").slice(0, 500) }).eq("id", b.order_id); return { ok: true }; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url), a = url.searchParams.get("a");
  if (a === "img") {
    const f = url.searchParams.get("f") ?? "";
    if (url.searchParams.get("s") !== (await imgSig(f))) return new Response("no", { status: 403 });
    const fi = await tg("getFile", { file_id: f }); if (!fi.ok) return new Response("gone", { status: 404 });
    const r = await fetch(`https://api.telegram.org/file/bot${BOT}/${fi.result.file_path}`);
    return new Response(r.body, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=604800, immutable", ...CORS } });
  }
  if (a === "tgs") { // animated emoji sticker (Lottie .tgs, gzipped) for the Mini App
    const e = url.searchParams.get("e") ?? "";
    const map = JSON.parse((await setting("anim_stickers")) || "{}");
    const id = map[e] ?? map[e.replace("\ufe0f", "")];
    if (!id) return new Response("none", { status: 404, headers: CORS });
    const fi = await tg("getFile", { file_id: id }); if (!fi.ok) return new Response("gone", { status: 404, headers: CORS });
    const r = await fetch(`https://api.telegram.org/file/bot${BOT}/${fi.result.file_path}`);
    return new Response(r.body, { headers: { "content-type": "application/octet-stream", "cache-control": "public, max-age=2592000, immutable", ...CORS } });
  }
  if (a === "logo") {
    const { data } = await db.from("branding_assets").select("b64").eq("name", url.searchParams.get("v") === "light" ? "light" : "original").maybeSingle();
    if (!data) return new Response("no", { status: 404 });
    const bin = decode(data.b64), png = bin[0] === 0x89;
    return new Response(bin, { headers: { "content-type": png ? "image/png" : "image/jpeg", "cache-control": "public, max-age=86400", ...CORS } });
  }
  if (a === "refcard") {
    const [bg, lg] = await Promise.all([
      fetch("https://nizomjonumaraliyev.github.io/github-slideshow/assets/ref-bg.png").then((r) => r.arrayBuffer()),
      db.from("branding_assets").select("b64").eq("name", "original").maybeSingle(),
    ]);
    const card = await Image.decode(new Uint8Array(bg));
    if (lg.data) { const logo = (await Image.decode(decode(lg.data.b64))).resize(120, 120).roundCorners(28); card.composite(logo, 52, 52); }
    return new Response(await card.encodeJPEG(88), { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400", ...CORS } });
  }
  if (a === "offices") { // public BTS office list (no personal data)
    const { data } = await db.from("bts_offices").select("code,region,city,name,address,hours").order("region").order("city").order("code");
    return new Response(JSON.stringify({ offices: data ?? [] }), { headers: { "content-type": "application/json", "cache-control": "public, max-age=86400", ...CORS } });
  }
  const user = await verify(req.headers.get("x-init-data") ?? "");
  if (!user) return json({ error: "Telegram orqali oching" }, 401);
  const r = await role(user);
  if (!r) return json({ error: "closed", message: "Tez orada ishga tushadi" }, 403);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const adminOnly = () => json({ error: "admin only" }, 403);
  try {
    switch (a) {
      case "me": {
        await touch(user); await log("open", user.id, null, { start: body.start ?? null });
        const loc = JSON.parse((await setting("shop_location")) || "null");
        const cu = (await db.from("customers").select("phone").eq("user_id", user.id).maybeSingle()).data;
        return json({ user: { id: user.id, first_name: user.first_name, last_name: user.last_name ?? "", phone: cu?.phone ?? null }, info_post: INFO_POST, role: r, rate: await num("usd_rate", 12000), live: (await setting("shop_live", "0")) === "1", deposit: await num("deposit_uzs", 300000), discount: await friendDiscount(user.id), pickup: { address: await setting("address_text"), phone: PHONE, lat: loc?.latitude, lng: loc?.longitude } });
      }
      case "prep": { // prepared message for Telegram.WebApp.shareMessage
        const PAGES = "https://nizomjonumaraliyev.github.io/github-slideshow";
        let result: any;
        if (body.kind === "ref") {
          const ref = await referral(user);
          const caption = `🎁 <b>${esc(user.first_name)} sizga noutgo'dan ${som(ref.bonus)} so'm chegirma sovg'a qildi!</b>\n\nTekshirilgan premium noutbuklar · original zaryadka · 2 hafta kafolat · BTS orqali butun O'zbekiston bo'ylab.\n\nChegirma birinchi noutbukingizga avtomatik qo'llanadi 👇`;
          result = { type: "photo", id: "ref" + Date.now(), photo_url: `${SUPA}/functions/v1/shop-api?a=refcard&v=2`, thumbnail_url: `${SUPA}/functions/v1/shop-api?a=refcard&v=2`, photo_width: 960, photo_height: 540, caption, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: `🎁 ${som(ref.bonus)} so'm chegirmani olish`, url: ref.link }]] } };
        } else {
          const { data: p } = await db.from("products").select("*").eq("sku", String(body.sku ?? "")).eq("status", "available").maybeSingle();
          if (!p) return json({ error: "Mahsulot topilmadi" });
          const rate = await num("usd_rate", 12000);
          const caption = `<b>${esc(p.model)}</b>\n${[p.cpu, p.ram_gb ? p.ram_gb + "GB RAM" : null, p.ssd, p.battery_pct ? "🔋 " + p.battery_pct + "%" : null].filter(Boolean).map(esc).join(" · ")}\n\n💰 <b>${p.price_usd}$</b> ≈ ${som(p.price_usd * rate)} so'm\n✅ Original zaryadka · 🛡 2 hafta kafolat · 🚚 BTS`;
          const kb = { inline_keyboard: [[{ text: "🛍 Ko'rish va buyurtma", url: `https://t.me/noutgo_robot?start=${p.sku}` }]] };
          result = p.photo_ids?.[0] ? { type: "photo", id: "p" + Date.now(), photo_file_id: p.photo_ids[0], caption, parse_mode: "HTML", reply_markup: kb } : { type: "article", id: "p" + Date.now(), title: p.model, input_message_content: { message_text: caption, parse_mode: "HTML" }, reply_markup: kb };
        }
        const r2 = await tg("savePreparedInlineMessage", { user_id: user.id, result, allow_user_chats: true, allow_group_chats: true, allow_channel_chats: true });
        if (!r2.ok) return json({ error: r2.description || "share" });
        await log("share", user.id, null, { kind: body.kind ?? "product", sku: body.sku ?? null });
        return json({ id: r2.result.id });
      }
      case "phone": { const cu = (await db.from("customers").select("phone").eq("user_id", user.id).maybeSingle()).data; return json({ phone: cu?.phone ?? null }); }
      case "boot": {
        const [_, s, cu, prods, ref] = await Promise.all([
          touch(user),
          settings(["usd_rate", "shop_live", "deposit_uzs", "shop_location", "address_text", "ref_friend_uzs"]),
          db.from("customers").select("phone,session").eq("user_id", user.id).maybeSingle(),
          db.from("products").select("*").eq("status", "available").not("sku", "is", null).order("sort"),
          db.from("referrals").select("id").eq("friend_id", user.id).eq("state", "joined").maybeSingle(),
        ]);
        log("open", user.id, null, { start: body.start ?? null });
        let discount = 0;
        if (ref.data) { const { count } = await db.from("orders").select("*", { count: "exact", head: true }).eq("user_id", user.id).in("state", ["paid", "ready", "shipped", "delivered", "received", "reserved"]); discount = (count ?? 0) ? 0 : Number(s.ref_friend_uzs) || 100000; }
        const loc = JSON.parse(s.shop_location || "null");
        return json({
          me: { user: { id: user.id, first_name: user.first_name, last_name: user.last_name ?? "", phone: cu.data?.phone ?? null }, info_post: INFO_POST, role: r, rate: Number(s.usd_rate) || 12000, live: s.shop_live === "1", deposit: Number(s.deposit_uzs) || 300000, discount, pickup: { address: s.address_text, phone: PHONE, lat: loc?.latitude, lng: loc?.longitude } },
          items: await Promise.all((prods.data ?? []).map(view)), deals: cu.data?.session?.deals ?? {},
        });
      }
      case "catalog": { const { data } = await db.from("products").select("*").eq("status", "available").not("sku", "is", null).order("sort"); const { data: c } = await db.from("customers").select("session").eq("user_id", user.id).maybeSingle(); return json({ items: await Promise.all((data ?? []).map(view)), deals: c?.session?.deals ?? {} }); }
      case "view": { const { data: p } = await db.from("products").select("id").eq("sku", body.sku).maybeSingle(); if (p) await log("view", user.id, p.id, { sku: body.sku }); return json({ ok: true }); }
      case "offer": return json(await offer(user, body));
      case "accept": return json(await accept(user, body));
      case "order": return json(await createOrder(user, body));
      case "receipt": return json(await receipt(user, body));
      case "cancel": return json(await cancel(user, body));
      case "received": return json(await received(user, body));
      case "feedback": return json(await feedback(user, body));
      case "orders": {
        const { data } = await db.from("orders").select("id,number,state,total_uzs,deposit_uzs,paid_uzs,pay_mode,delivery,region,bts_office,track_number,is_test,created_at,reserved_until,products(model,sku)").eq("user_id", user.id).order("id", { ascending: false }).limit(10);
        const { data: fb } = await db.from("feedback").select("order_id").eq("user_id", user.id);
        const done = new Set((fb ?? []).map((x: any) => x.order_id));
        return json({ orders: (data ?? []).map((o: any) => ({ ...o, rated: done.has(o.id) })), card: await setting("payment_card"), holder: await setting("payment_card_name") });
      }
      case "ref": return json(await referral(user));
      case "dash": if (r !== "admin") return adminOnly(); return json(await dashboard());
      case "a_orders": if (r !== "admin") return adminOnly(); return json(await adminOrders());
      case "a_users": if (r !== "admin") return adminOnly(); return json(await adminUsers());
      case "a_track": if (r !== "admin") return adminOnly(); return json(await adminTrack(user, body));
      case "a_note": if (r !== "admin") return adminOnly(); return json(await adminNote(body));
      case "a_act": { // pok | pno | aho | adl | acn  → same handler as the bot buttons
        if (r !== "admin") return adminOnly();
        if (!["pok", "pno", "aho", "adl", "acn"].includes(body.act)) return json({ error: "?" }, 400);
        return json({ ok: await viaHub(user, `${body.act}:${Number(body.order_id)}`) });
      }
      case "decide": if (r !== "admin") return adminOnly(); return json({ ok: await viaHub(user, `${body.ok ? "pok" : "pno"}:${Number(body.order_id)}`) });
      case "testers": if (r !== "admin") return adminOnly(); return json({ testers: (await db.from("bot_testers").select("username,user_id,role").order("id")).data });
    }
    return json({ error: "unknown" }, 400);
  } catch (e) { console.error(e); return json({ error: "server" }, 500); }
});
