// Anikoto resolver/discovery worker
// GET /?q=One%20Piece
// GET /?title=One%20Piece&episode=1&lang=sub
//
// This worker discovers Anikoto watch routes and the internal IDs exposed by
// the watch page. It intentionally does not scrape media segments or bypass
// anti-bot protections.

const SITE = 'https://anikototv.to';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*',
  'Vary': 'Origin'
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      const u = new URL(request.url);
      const q = u.searchParams.get('q') || u.searchParams.get('title');
      if (!q) return json({ error: 'missing ?q= or ?title=' }, 400);

      const results = await search(q);
      const episode = u.searchParams.get('episode');
      const lang = (u.searchParams.get('lang') || 'sub').toLowerCase();

      if (!episode) {
        return json({
          query: q,
          source: SITE,
          results
        });
      }

      const selected = chooseResult(results, q);
      if (!selected) return json({ query: q, results, error: 'no matching Anikoto title found' }, 404);

      const watch = await inspectWatch(selected.watchUrl, episode, lang);
      return json({
        query: q,
        episode: String(episode),
        language: lang,
        match: selected,
        watch
      });
    } catch (e) {
      return json({ error: e?.message || 'resolver failed' }, 502);
    }
  }
};

async function search(query) {
  const url = `${SITE}/filter/?keyword=${encodeURIComponent(query)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' } });
  if (!r.ok) throw new Error(`Anikoto search returned ${r.status}`);
  const html = await r.text();
  return extractWatchLinks(html);
}

function extractWatchLinks(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href=["']([^"']*\/watch\/[^"'#?]+)(?:\?[^"']*)?["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const href = absolute(m[1]);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    const label = strip(m[2]);
    const slug = new URL(href).pathname.match(/^\/watch\/([^/]+)/i)?.[1] || '';
    out.push({ title: label || slug.replace(/-/g, ' '), slug, watchUrl: href });
  }
  return out;
}

function chooseResult(results, query) {
  if (!results.length) return null;
  const q = normalize(query);
  return results.find(x => normalize(x.title) === q) ||
         results.find(x => normalize(x.slug.replace(/-/g, ' ')) === q) ||
         results.find(x => normalize(x.title).includes(q) || q.includes(normalize(x.title))) ||
         results[0];
}

async function inspectWatch(baseWatchUrl, episode, lang) {
  const base = new URL(baseWatchUrl);
  const basePath = base.pathname.replace(/\/$/, '');
  const candidates = [
    `${SITE}${basePath}/ep-${encodeURIComponent(episode)}`,
    `${SITE}${basePath}/episode-${encodeURIComponent(episode)}`,
    `${SITE}${basePath}/episode/${encodeURIComponent(episode)}`,
    `${SITE}${basePath}`
  ];

  let pageUrl = '';
  let html = '';
  for (const candidate of candidates) {
    const r = await fetch(candidate, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' } });
    if (r.ok) {
      pageUrl = candidate;
      html = await r.text();
      if (/episode|server|VidTube|server\/list|episode\/list/i.test(html) || candidate !== candidates[candidates.length - 1]) break;
    }
  }

  if (!html) return { error: 'watch page could not be fetched', candidates };

  const internalIds = [...new Set([
    ...matches(html, /(?:anime[_-]?id|data-anime-id|data-id|animeId)["'\s:=]+([0-9]{2,})/gi),
    ...matches(html, /\/api\/(?:seasons|watch-order)\/([0-9]{2,})/gi),
    ...matches(html, /\/ajax\/episode\/list\/([0-9]{2,})/gi)
  ])];

  const episodeListUrls = [...new Set([
    ...urlsMatching(html, /(?:https?:)?\/\/[^"'\s<>]+\/ajax\/episode\/list\/[^"'\s<>]+/gi),
    ...urlsMatching(html, /(?:\/ajax\/episode\/list\/[^"'\s<>]+)/gi)
  ])].map(absolute);

  const serverListUrls = [...new Set(urlsMatching(html, /(?:https?:)?\/\/[^"'\s<>]+\/ajax\/server\/list\?[^"'\s<>]+/gi))].map(absolute);
  const serverResolveUrls = [...new Set(urlsMatching(html, /(?:https?:)?\/\/[^"'\s<>]+\/ajax\/server\/\?[^"'\s<>]+/gi))].map(absolute);
  const vidTubeUrls = [...new Set(urlsMatching(html, /(?:https?:)?\/\/[^"'\s<>]*vidtube\.site[^"'\s<>]+/gi))].map(absolute);

  const episodeLinks = extractEpisodeLinks(html, lang);

  return {
    pageUrl,
    internalIds,
    requestedLanguage: lang,
    episode,
    episodeListUrls,
    serverListUrls,
    serverResolveUrls,
    vidTubeUrls,
    episodeLinks
  };
}

function extractEpisodeLinks(html, lang) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/href=["']([^"']*\/watch\/[^"']*(?:ep|episode)[-_\/][^"']*)["']/gi)) {
    const url = absolute(m[1]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, language: lang });
  }
  return out;
}

function matches(text, re) {
  return [...text.matchAll(re)].map(m => m[1]).filter(Boolean);
}
function urlsMatching(text, re) { return [...text.matchAll(re)].map(m => m[0]); }
function absolute(value) { try { return new URL(decodeHtml(value), SITE).href; } catch { return ''; } }
function decodeHtml(s) { return String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/gi, "'"); }
function strip(s) { return String(s || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim(); }
function normalize(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function json(data, status = 200) { return new Response(JSON.stringify(data, null, 2), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
