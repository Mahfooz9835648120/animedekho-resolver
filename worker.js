// animedekho-resolver — AnimeSalt extraction patch
// Keeps the existing resolver behavior while exposing only real embeds and download links.

const ANIMESALT_SITE = 'https://animesalt.link';
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

function isValidEmbed(raw){
  try{
    const u=new URL(raw); if(!/^https?:$/i.test(u.protocol)) return false;
    const s=`${u.hostname}${u.pathname}${u.search}`.toLowerCase();
    if(/\.(css|js|mjs|json|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf)(?:$|[?#])/i.test(s)) return false;
    if(/googletagmanager|google-analytics|image\.tmdb\.org|img\.animesalt\.link/i.test(s)) return false;
    if(/animesalt\.link\/(?:$|series\/|episodes?\/|movies?\/|category\/|wp-content\/|wp-includes\/)/i.test(s)) return false;
    if(/(?:^|[/?])(?:download|dl)(?:[/?]|\.)/i.test(u.pathname)) return false;
    return /(?:iframe|embed|player|play|mystream|abyss|megacloud|vidstream|multi-lang-plyr|modalclonism|quiahussars)/i.test(s) || !/animesalt\.link$/i.test(u.hostname);
  }catch{return false}
}

function decodeHtml(s){return String(s||'').replace(/&amp;/gi,'&').replace(/&#038;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')}
function absUrl(base,href){try{return new URL(href.trim(),base).toString()}catch{return href.trim()}}

function extractAnimeSaltDownloads(html){
  const out=[]; const seen=new Set();
  const add=(raw,label='AnimeSalt Download')=>{
    const u=absUrl(ANIMESALT_SITE,decodeHtml(raw));
    if(!/^https?:/i.test(u)||seen.has(u)) return;
    const low=u.toLowerCase();
    if(/googletagmanager|google-analytics|\.(css|js|mjs|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf)(?:$|[?#])/i.test(low)) return;
    if(!/(?:trdownload|download|dl\.php|download\/|dl2\.php)/i.test(u)) return;
    seen.add(u); out.push({name:label.trim()||'AnimeSalt Download',url:u,provider:'AnimeSalt'});
  };
  for(const m of html.matchAll(/<(?:a|button)[^>]*(?:href|data-url|data-download|data-href)=["']([^"']+)["'][^>]*>([\s\S]{0,300})<\/(?:a|button)>/gi)){
    const label=m[2].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(); add(m[1],label);
  }
  for(const m of html.matchAll(/(?:https?:)?\/\/[^"'<>\s]+/gi)) add(m[0]);
  return out;
}

async function extractAnimeSaltPageData(slug){
  try{
    const candidates=[`${ANIMESALT_SITE}/episode/${encodeURIComponent(slug)}/`,`${ANIMESALT_SITE}/episodes/${encodeURIComponent(slug)}/`];
    const out={servers:[],downloads:[]}; const seen=new Set();
    const add=(raw,name='Iframe')=>{
      const u=absUrl(ANIMESALT_SITE,decodeHtml(raw));
      if(!isValidEmbed(u)||seen.has(u)) return;
      seen.add(u); out.servers.push({provider:'AnimeSalt',name,type:'multi',embedUrl:u});
    };
    for(const target of candidates){
      const r=await fetch(target,{headers:{'User-Agent':UA,'Accept':'text/html,application/xhtml+xml'}});
      if(!r.ok) continue;
      const html=await r.text();
      out.downloads.push(...extractAnimeSaltDownloads(html));
      for(const m of html.matchAll(/<iframe[^>]+(?:src|data-src|data-url|data-embed|data-iframe|data-player)=["']([^"']+)["'][^>]*>/gi)) add(m[1]);
      for(const m of html.matchAll(/(?:data-(?:src|url|embed|iframe|player)|(?:src|href))=["']([^"']+)["']/gi)) add(m[1]);
      if(out.servers.length||out.downloads.length) break;
    }
    out.downloads=[...new Map(out.downloads.map(x=>[x.url,x])).values()];
    return out;
  }catch{return {servers:[],downloads:[]}}
}

// Merge this helper's result into the existing handleResolve() AnimeSalt section:
//   const saltPage = await extractAnimeSaltPageData(slug)
//   results.servers.push(...saltPage.servers not already present)
//   results.downloads.push(...saltPage.downloads not already present)
