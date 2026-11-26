// Copies product photos (Telegram file_ids) into the public 'media' bucket so the Mini App loads them from the CDN,
// plus a 480px JPEG thumbnail per photo for the catalog grid.
// ?t=TOKEN[&all=1]  — by default only products whose photo_urls/thumbs are missing or out of date.
import { createClient } from "npm:@supabase/supabase-js@2";
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";
const BOT = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SUPA = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SUPA, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const tg = async (m: string, b: unknown) => (await fetch(`https://api.telegram.org/bot${BOT}/${m}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const pub = (path: string) => `${SUPA}/storage/v1/object/public/media/${path}`;
Deno.serve(async (req) => {
  const u = new URL(req.url);
  const { data: tok } = await db.from("bot_settings").select("value").eq("key", "selftest_token").maybeSingle();
  if (u.searchParams.get("t") !== tok?.value) return new Response("no", { status: 403 });
  const { data: ps } = await db.from("products").select("id,sku,photo_ids,photo_urls,photo_thumbs").not("sku", "is", null).eq("status", "available");
  const out: unknown[] = [];
  for (const p of ps ?? []) {
    const ids: string[] = p.photo_ids ?? [];
    const fresh = (p.photo_urls ?? []).length === ids.length && (p.photo_thumbs ?? []).length === ids.length;
    if (!u.searchParams.get("all") && fresh) continue;
    const urls: string[] = [], thumbs: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const f = await tg("getFile", { file_id: ids[i] });
      if (!f.ok) { out.push({ sku: p.sku, i, err: f.description }); continue; }
      const bytes = new Uint8Array(await (await fetch(`https://api.telegram.org/file/bot${BOT}/${f.result.file_path}`)).arrayBuffer());
      const base = `products/${p.sku}/${i}-${f.result.file_unique_id}`;
      const up = await db.storage.from("media").upload(`${base}.jpg`, bytes, { contentType: "image/jpeg", cacheControl: "31536000", upsert: true });
      if (up.error) { out.push({ sku: p.sku, i, err: up.error.message }); continue; }
      urls.push(pub(`${base}.jpg`));
      try {
        const img = await Image.decode(bytes);
        const w = 480, h = Math.round(img.height * (w / img.width));
        const small = await img.resize(w, h).encodeJPEG(78);
        const ut = await db.storage.from("media").upload(`${base}-480.jpg`, small, { contentType: "image/jpeg", cacheControl: "31536000", upsert: true });
        thumbs.push(ut.error ? pub(`${base}.jpg`) : pub(`${base}-480.jpg`));
      } catch (_) { thumbs.push(pub(`${base}.jpg`)); }
    }
    await db.from("products").update({ photo_urls: urls, photo_thumbs: thumbs }).eq("id", p.id);
    out.push({ sku: p.sku, n: urls.length, thumbs: thumbs.filter((t) => t.endsWith("-480.jpg")).length });
  }
  return Response.json(out);
});
