// Copies product photos (Telegram file_ids) into the public 'media' bucket so the Mini App loads them from the CDN,
// plus a 480px JPEG thumbnail per photo for the catalog grid.
// Works in small steps (at most MAX photos per call) so a run never exceeds the edge worker's memory/CPU limits;
// the 30-minute cron (or repeated calls) finishes the rest.  ?t=TOKEN[&all=1 to rebuild everything]
import { createClient } from "npm:@supabase/supabase-js@2";
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";
const BOT = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SUPA = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SUPA, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const MAX = 2;
const tg = async (m: string, b: unknown) => (await fetch(`https://api.telegram.org/bot${BOT}/${m}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const pub = (path: string) => `${SUPA}/storage/v1/object/public/media/${path}`;

async function thumb(bytes: Uint8Array, base: string, full: string) {
  try {
    const img = await Image.decode(bytes);
    const w = 480, h = Math.round(img.height * (w / img.width));
    const small = await img.resize(w, h).encodeJPEG(76);
    const ut = await db.storage.from("media").upload(`${base}-480.jpg`, small, { contentType: "image/jpeg", cacheControl: "31536000", upsert: true });
    return ut.error ? full : pub(`${base}-480.jpg`);
  } catch (_) { return full; }
}

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const { data: tok } = await db.from("bot_settings").select("value").eq("key", "selftest_token").maybeSingle();
  if (u.searchParams.get("t") !== tok?.value) return new Response("no", { status: 403 });
  if (u.searchParams.get("all")) await db.from("products").update({ photo_urls: null, photo_thumbs: null }).not("sku", "is", null).eq("status", "available");
  const { data: ps } = await db.from("products").select("id,sku,photo_ids,photo_urls,photo_thumbs").not("sku", "is", null).eq("status", "available").order("sort");
  let budget = MAX;
  const out: unknown[] = [];
  for (const p of ps ?? []) {
    const ids: string[] = p.photo_ids ?? [];
    if (!ids.length) continue;
    const urls: (string | null)[] = ids.map((_, i) => (p.photo_urls ?? [])[i] ?? null);
    const thumbs: (string | null)[] = ids.map((_, i) => (p.photo_thumbs ?? [])[i] ?? null);
    let changed = false;
    for (let i = 0; i < ids.length && budget > 0; i++) {
      if (urls[i] && thumbs[i] && thumbs[i]!.endsWith("-480.jpg")) continue;
      budget--;
      const f = await tg("getFile", { file_id: ids[i] });
      if (!f.ok) { out.push({ sku: p.sku, i, err: f.description }); continue; }
      const base = `products/${p.sku}/${i}-${f.result.file_unique_id}`;
      let bytes: Uint8Array;
      if (urls[i]) bytes = new Uint8Array(await (await fetch(urls[i]!)).arrayBuffer());
      else {
        bytes = new Uint8Array(await (await fetch(`https://api.telegram.org/file/bot${BOT}/${f.result.file_path}`)).arrayBuffer());
        const up = await db.storage.from("media").upload(`${base}.jpg`, bytes, { contentType: "image/jpeg", cacheControl: "31536000", upsert: true });
        if (up.error) { out.push({ sku: p.sku, i, err: up.error.message }); continue; }
        urls[i] = pub(`${base}.jpg`);
      }
      thumbs[i] = await thumb(bytes, base, urls[i]!);
      changed = true;
      out.push({ sku: p.sku, i, thumb: thumbs[i]!.endsWith("-480.jpg") });
    }
    // Save progress every run; a slot without a small thumbnail yet uses the full photo (next run upgrades it).
    if (changed && urls.every(Boolean)) await db.from("products").update({ photo_urls: urls, photo_thumbs: thumbs.map((t, i) => t ?? urls[i]) }).eq("id", p.id);
    if (budget <= 0) break;
  }
  const left = (ps ?? []).reduce((n, p) => n + (p.photo_ids ?? []).filter((_: string, i: number) => !((p.photo_thumbs ?? [])[i] ?? "").endsWith("-480.jpg")).length, 0);
  return Response.json({ done: out, remaining_before_this_run: left });
});
