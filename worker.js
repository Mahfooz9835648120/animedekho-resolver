// animedekho-resolver — Cloudflare Worker
// GET /?slug=naruto-1x1&type=sub        → episode
// GET /?slug=one-piece-film-red&type=movie → movie
// GET /?anilistId=20&ep=1&season=1&saltId=naruto → full resolve like player

const ANIMESALT_API = "https://aniversee.vercel.app/api/animesalt";
const ANIMEDEKHO_API = "https://animedekho-api.pages.dev/api/embed";
const TOONAPI = "https://toonapi.apiplay.workers.dev/api/embed";
const VIDSTREAM_HOST = "https://as-cdn21.top";
const PROXY_WORKER  = "https://late-sunset-3efc.ammhfoo.workers.dev";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

export default {
  async fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(req.url);
    const p = url.searchParams;

    // ── params ──
    const slug      = p.get("slug");       // e.g. naruto-1x1  OR  one-piece-film-red
    const anilistId = p.get("anilistId");  // optional — for AnimeSalt
    const ep        = p.get("ep");         // optional
    const season    = p.get("season");     // optional
    const saltId    = p.get("saltId");     // optional — base slug without episode suffix
    const isMovie   = p.get("type") === "movie";

    if (!slug) return json({ error: "missing ?slug=" }, 400);

    const results = { slug, servers: [], m3u8s: [], downloads: [] };

    // ── 1. AnimeDekho + ToonAPI ──
    const [dekho, toon] = await Promise.all([
      fetchEmbed(ANIMEDEKHO_API, slug),
      fetchEmbed(TOONAPI, slug),
    ]);

    // Collect embed servers & try resolve VidStream ones to m3u8
    const embedProviders = [
      { name: "AnimeDekho", data: dekho, type: "sub" },
      { name: "ToonAPI",    data: toon,  type: "multi" },
    ];

    await Promise.all(embedProviders.map(async ({ name, data, type }) => {
      if (!data?.servers) return;
      for (const s of data.servers) {
        if (!s?.url) continue;
        const sType = detectType(s.name, type);
        const entry = { provider: name, name: s.name, type: sType, embedUrl: s.url };

        // VidStream — resolve to direct m3u8
        const hash = extractVidstreamHash(s.url);
        if (hash) {
          const m3u8 = await resolveVidstream(hash);
          if (m3u8) {
            const proxied = proxyM3u8(m3u8, VIDSTREAM_HOST);
            entry.m3u8 = proxied;
            entry.rawM3u8 = m3u8;
            results.m3u8s.push({ provider: `${name} · ${s.name}`, type: sType, m3u8: proxied });
          }
        }

        results.servers.push(entry);
      }

      // Downloads
      if (data.downloads) {
        for (const d of data.downloads) {
          if (d?.url) results.downloads.push({ name: d.name, url: d.url, provider: name });
        }
      }
    }));

    // ── 2. AnimeSalt (multi-audio) — needs anilistId + saltId ──
    if (anilistId && saltId && ep) {
      try {
        const saltUrl = `${ANIMESALT_API}?anilistId=${anilistId}&ep=${ep}&season=${season ?? ""}&saltId=${encodeURIComponent(saltId)}`;
        const d = await fetchJSON(saltUrl);
        for (const s of (d?.servers || [])) {
          if (!s?.url) continue;
          results.servers.push({ provider: "AnimeSalt", name: s.name, type: "multi", embedUrl: s.url });
        }
      } catch (_) {}
    }

    // ── 3. Movie slug fallback — try base saltId without episode suffix ──
    if (isMovie && saltId && saltId !== slug) {
      const movieDekho = await fetchEmbed(ANIMEDEKHO_API, saltId);
      if (movieDekho?.servers) {
        for (const s of movieDekho.servers) {
          if (!s?.url) continue;
          const hash = extractVidstreamHash(s.url);
          const entry = { provider: "AnimeDekho·Movie", name: s.name, type: "sub", embedUrl: s.url };
          if (hash) {
            const m3u8 = await resolveVidstream(hash);
            if (m3u8) {
              const proxied = proxyM3u8(m3u8, VIDSTREAM_HOST);
              entry.m3u8 = proxied; entry.rawM3u8 = m3u8;
              results.m3u8s.push({ provider: entry.provider, type: "sub", m3u8: proxied });
            }
          }
          results.servers.push(entry);
        }
      }
    }

    results.total = results.servers.length;
    return json(results);
  }
};

// ── helpers ──

async function fetchEmbed(base, slug) {
  return fetchJSON(`${base}/${encodeURIComponent(slug)}`);
}

async function fetchJSON(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}

function extractVidstreamHash(url) {
  // matches as-cdn21.top/video/<hash>  or  as-cdn*.top/video/<hash>
  const m = url.match(/as-cdn\d+\.top\/video\/([a-f0-9]{32})/i);
  return m ? m[1] : null;
}

async function resolveVidstream(hash) {
  try {
    const r = await fetch(
      `${VIDSTREAM_HOST}/player/index.php?data=${hash}&do=getVideo`,
      {
        method: "POST",
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          "Referer": `${VIDSTREAM_HOST}/video/${hash}`,
          "User-Agent": "Mozilla/5.0",
        },
      }
    );
    const d = await r.json();
    return d?.videoSource || d?.securedLink || null;
  } catch (_) { return null; }
}

function detectType(name, fallback) {
  const n = (name || "").toLowerCase();
  if (n.includes("dub")) return "dub";
  if (n.includes("sub")) return "sub";
  return fallback;
}

function proxyM3u8(m3u8, referer) {
  return `${PROXY_WORKER}/proxy?url=${encodeURIComponent(m3u8)}&referer=${encodeURIComponent(referer)}`;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: CORS });
}
