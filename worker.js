// animedekho-resolver — Cloudflare Worker
// GET /?slug=naruto-1x1                          → resolve episode
// GET /?slug=...&anilistId=20&ep=1&season=1&saltId=naruto → full resolve
// GET /?slug=...&type=movie&saltId=...           → movie
// GET /vidstream?hash=<hash>                     → rewritten m3u8 (HLS.js ready)
// GET /m3u8?url=<playlist>&referer=<ref>         → recursive rewrite
// GET /proxy?url=<any>&referer=<ref>             → pipe through with CORS

const ANIMESALT_API  = 'https://aniversee.vercel.app/api/animesalt';
const ANIMEDEKHO_API = 'https://animedekho-api.pages.dev/api/embed';
const TOONAPI        = 'https://toonapi.apiplay.workers.dev/api/embed';
const VIDSTREAM_HOST = 'https://as-cdn21.top';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

// ─── entry point ─────────────────────────────────────────────────────────────
addEventListener('fetch', e => e.respondWith(handleRequest(e.request)));

async function handleRequest(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const { pathname } = new URL(request.url);
  if (pathname === '/vidstream') return handleVidstream(request);
  if (pathname === '/m3u8')      return handleM3u8(request);
  if (pathname === '/proxy')     return handleProxy(request);
  return handleResolve(request);
}

// ─── /vidstream?hash=<hash> ───────────────────────────────────────────────────
// POST getVideo from CF IP → signed m3u8 → redirect to /m3u8 for recursive rewrite
async function handleVidstream(request) {
  const { searchParams, origin } = new URL(request.url);
  const hash = searchParams.get('hash');
  if (!hash) return errResp('?hash= required', 400);

  const referer = `${VIDSTREAM_HOST}/video/${hash}`;
  let m3u8Url;
  try {
    const r = await fetch(`${VIDSTREAM_HOST}/player/index.php?data=${hash}&do=getVideo`, {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest', 'Referer': referer, 'User-Agent': UA },
    });
    const d = await r.json();
    m3u8Url = d?.videoSource || d?.securedLink;
  } catch (e) { return errResp('getVideo failed: ' + e.message, 502); }

  if (!m3u8Url) return errResp('no m3u8 in getVideo response', 404);

  return Response.redirect(
    `${origin}/m3u8?url=${encodeURIComponent(m3u8Url)}&referer=${encodeURIComponent(referer)}`, 302
  );
}

// ─── /m3u8?url=<playlist>&referer=<ref> ──────────────────────────────────────
// Fetch m3u8 from CF IP, rewrite ALL URIs (segments + child playlists + audio tracks)
async function handleM3u8(request) {
  const { searchParams, origin } = new URL(request.url);
  const raw     = searchParams.get('url');
  const referer = searchParams.get('referer') || '';
  if (!raw) return errResp('?url= required', 400);

  let url;
  try { url = decodeURIComponent(raw); } catch { url = raw; }

  let text;
  try {
    const r = await fetch(url, { headers: { 'Referer': referer, 'User-Agent': UA, 'Accept': '*/*' } });
    if (!r.ok) return errResp(`upstream ${r.status}`, r.status);
    text = await r.text();
  } catch (e) { return errResp('fetch failed: ' + e.message, 502); }

  const rewritten = text.split('\n').map(line => {
    const t = line.trim();
    if (!t) return line;

    // init segment
    if (t.startsWith('#EXT-X-MAP:'))
      return t.replace(/URI="([^"]+)"/, (_, uri) =>
        `URI="${mkProxy(origin, absUrl(url, uri), referer)}"`);

    // audio/subtitle track — child playlist, rewrite recursively
    if (t.startsWith('#EXT-X-MEDIA:') && t.includes('URI="'))
      return t.replace(/URI="([^"]+)"/, (_, uri) =>
        `URI="${mkM3u8(origin, absUrl(url, uri), referer)}"`);

    if (t.startsWith('#')) return line;

    // segment or child playlist
    const abs = absUrl(url, t);
    return abs.includes('.m3u8') ? mkM3u8(origin, abs, referer) : mkProxy(origin, abs, referer);
  }).join('\n');

  return new Response(rewritten, {
    headers: { ...CORS, 'Content-Type': 'application/vnd.apple.mpegurl' },
  });
}

// ─── /proxy?url=<any>&referer=<ref> ──────────────────────────────────────────
async function handleProxy(request) {
  const { searchParams } = new URL(request.url);
  const target  = searchParams.get('url');
  const referer = searchParams.get('referer') || '';
  if (!target) return errResp('?url= required', 400);

  let decoded;
  try { decoded = decodeURIComponent(target); } catch { decoded = target; }

  let originH = {};
  try { originH = referer ? { Origin: new URL(referer).origin } : {}; } catch {}

  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      if (i > 0) await sleep(500 * i);
      const up = await fetch(decoded, {
        headers: { 'User-Agent': UA, Accept: '*/*', ...(referer ? { Referer: referer, ...originH } : {}) },
      });
      if (up.status === 429 || up.status >= 500) { lastErr = new Error('upstream ' + up.status); continue; }
      const h = new Headers(CORS);
      h.set('Content-Type', up.headers.get('Content-Type') || 'application/octet-stream');
      const cl = up.headers.get('Content-Length');
      if (cl) h.set('Content-Length', cl);
      return new Response(up.body, { status: up.status, headers: h });
    } catch (e) { lastErr = e; }
  }
  return errResp((lastErr?.message) || 'proxy failed', 502);
}

// ─── / — resolve slug ─────────────────────────────────────────────────────────
async function handleResolve(request) {
  const { searchParams, origin } = new URL(request.url);
  const slug      = searchParams.get('slug');
  const anilistId = searchParams.get('anilistId');
  const ep        = searchParams.get('ep');
  const season    = searchParams.get('season');
  const saltId    = searchParams.get('saltId');
  const isMovie   = searchParams.get('type') === 'movie';

  if (!slug) return errResp('missing ?slug=', 400);

  const results = { slug, servers: [], m3u8s: [], downloads: [] };

  // AnimeDekho + ToonAPI in parallel
  const [dekho, toon] = await Promise.all([
    fetchJSON(`${ANIMEDEKHO_API}/${encodeURIComponent(slug)}`),
    fetchJSON(`${TOONAPI}/${encodeURIComponent(slug)}`),
  ]);

  await Promise.all([
    { name: 'AnimeDekho', data: dekho, type: 'sub' },
    { name: 'ToonAPI',    data: toon,  type: 'multi' },
  ].map(async ({ name, data, type }) => {
    if (!data?.servers) return;
    for (const s of data.servers) {
      if (!s?.url) continue;
      const sType = detectType(s.name, type);
      const entry = { provider: name, name: s.name, type: sType, embedUrl: s.url };
      const hash = extractHash(s.url);
      if (hash) {
        // point to /vidstream on this same worker
        entry.m3u8 = `${origin}/vidstream?hash=${hash}`;
        results.m3u8s.push({ provider: `${name} · ${s.name}`, type: sType, m3u8: entry.m3u8 });
      }
      results.servers.push(entry);
    }
    for (const d of (data.downloads || [])) {
      if (d?.url) results.downloads.push({ name: d.name, url: d.url, provider: name });
    }
  }));

  // AnimeSalt
  if (anilistId && saltId && ep) {
    try {
      const d = await fetchJSON(`${ANIMESALT_API}?anilistId=${anilistId}&ep=${ep}&season=${season ?? ''}&saltId=${encodeURIComponent(saltId)}`);
      for (const s of (d?.servers || [])) {
        if (s?.url) results.servers.push({ provider: 'AnimeSalt', name: s.name, type: 'multi', embedUrl: s.url });
      }
    } catch (_) {}
  }

  // Movie fallback
  if (isMovie && saltId && saltId !== slug) {
    const d = await fetchJSON(`${ANIMEDEKHO_API}/${encodeURIComponent(saltId)}`);
    for (const s of (d?.servers || [])) {
      if (!s?.url) continue;
      const hash = extractHash(s.url);
      const entry = { provider: 'AnimeDekho·Movie', name: s.name, type: 'sub', embedUrl: s.url };
      if (hash) { entry.m3u8 = `${origin}/vidstream?hash=${hash}`; results.m3u8s.push({ provider: entry.provider, type: 'sub', m3u8: entry.m3u8 }); }
      results.servers.push(entry);
    }
  }

  results.total = results.servers.length;
  return jsonResp(results);
}

// ─── helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function absUrl(base, href) { try { return new URL(href.trim(), base).toString(); } catch { return href.trim(); } }
function mkProxy(origin, url, ref) { return `${origin}/proxy?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(ref)}`; }
function mkM3u8(origin, url, ref)  { return `${origin}/m3u8?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(ref)}`; }
function extractHash(url) { const m = url.match(/as-cdn\d+\.top\/video\/([a-f0-9]{32})/i); return m ? m[1] : null; }
function detectType(name, fb) { const n = (name||'').toLowerCase(); return n.includes('dub') ? 'dub' : n.includes('sub') ? 'sub' : fb; }

async function fetchJSON(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

function jsonResp(data, status) {
  return new Response(JSON.stringify(data, null, 2), { status: status||200, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function errResp(msg, status) { return jsonResp({ error: msg }, status||400); }
