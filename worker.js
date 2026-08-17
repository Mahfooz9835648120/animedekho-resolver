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
const ANIMESALT_SITE = 'https://animesalt.link';
const VIDSTREAM_HOST = 'https://as-cdn21.top';
const ALLOWED_ORIGIN = '*';

function corsHeaders(){return {'Access-Control-Allow-Origin':ALLOWED_ORIGIN,'Access-Control-Allow-Methods':'GET,HEAD,OPTIONS','Access-Control-Allow-Headers':'*','Access-Control-Expose-Headers':'*','Vary':'Origin'}}
const CORS=corsHeaders();const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';
addEventListener('fetch',e=>e.respondWith(handleRequest(e.request)));
async function handleRequest(request){if(request.method==='OPTIONS')return new Response(null,{status:204,headers:CORS});const {pathname}=new URL(request.url);if(pathname==='/vidstream')return handleVidstream(request);if(pathname==='/m3u8')return handleM3u8(request);if(pathname==='/proxy')return handleProxy(request);return handleResolve(request)}
async function handleVidstream(request){const {searchParams,origin}=new URL(request.url);const hash=searchParams.get('hash');if(!hash)return errResp('?hash= required',400);const referer=`${VIDSTREAM_HOST}/video/${hash}`;let m3u8Url;try{const r=await fetch(`${VIDSTREAM_HOST}/player/index.php?data=${hash}&do=getVideo`,{method:'POST',headers:{'X-Requested-With':'XMLHttpRequest',Referer:referer,'User-Agent':UA}});const d=await r.json();m3u8Url=d?.videoSource||d?.securedLink}catch(e){return errResp('getVideo failed: '+e.message,502)}if(!m3u8Url)return errResp('no m3u8 in getVideo response',404);return handleM3u8(new Request(`${origin}/m3u8?url=${encodeURIComponent(m3u8Url)}&referer=${encodeURIComponent(referer)}`,request))}
async function handleM3u8(request){const {searchParams,origin}=new URL(request.url);const raw=searchParams.get('url');const referer=searchParams.get('referer')||'';if(!raw)return errResp('?url= required',400);let url;try{url=decodeURIComponent(raw)}catch{url=raw}let text;try{const r=await fetch(url,{headers:{Referer:referer,'User-Agent':UA,Accept:'*/*'}});if(!r.ok)return errResp(`upstream ${r.status}`,r.status);text=await r.text()}catch(e){return errResp('fetch failed: '+e.message,502)}const rewritten=text.split('\n').map(line=>{const t=line.trim();if(!t)return line;if(t.startsWith('#EXT-X-MAP:'))return t.replace(/URI="([^"]+)"/,(_,uri)=>`URI="${mkProxy(origin,absUrl(url,uri),referer)}"`);if(t.startsWith('#EXT-X-MEDIA:')&&t.includes('URI="'))return t.replace(/URI="([^"]+)"/,(_,uri)=>`URI="${mkM3u8(origin,absUrl(url,uri),referer)}"`);if(t.startsWith('#'))return line;const abs=absUrl(url,t);return abs.includes('.m3u8')?mkM3u8(origin,abs,referer):mkProxy(origin,abs,referer)}).join('\n');return new Response(rewritten,{headers:{...CORS,'Content-Type':'application/vnd.apple.mpegurl'}})}
async function handleProxy(request){const {searchParams}=new URL(request.url);const target=searchParams.get('url');const referer=searchParams.get('referer')||'';if(!target)return errResp('?url= required',400);let decoded;try{decoded=decodeURIComponent(target)}catch{decoded=target}let originH={};try{originH=referer?{Origin:new URL(referer).origin}:{}}catch{}let lastErr=null;for(let i=0;i<3;i++){try{if(i>0)await sleep(500*i);const up=await fetch(decoded,{headers:{'User-Agent':UA,Accept:'*/*',...(referer?{Referer:referer,...originH}:{})}});if(up.status===429||up.status>=500){lastErr=new Error('upstream '+up.status);continue}const h=new Headers(CORS);h.set('Content-Type',up.headers.get('Content-Type')||'application/octet-stream');const cl=up.headers.get('Content-Length');if(cl)h.set('Content-Length',cl);return new Response(up.body,{status:up.status,headers:h})}catch(e){lastErr=e}}return errResp(lastErr?.message||'proxy failed',502)}

async function extractMoviePageServers(slug){
 try{
  const url=`${ANIMESALT_SITE}/movies/${encodeURIComponent(slug)}/`;
  const r=await fetch(url,{headers:{'User-Agent':UA,'Accept':'text/html'}});
  if(!r.ok)return [];
  const html=await r.text();
  const out=[];const seen=new Set();
  const add=(url,name='Movie Server')=>{if(!url)return;const u=absUrl(ANIMESALT_SITE,url);if(!/^https?:/i.test(u)||seen.has(u))return;seen.add(u);out.push({provider:'AnimeSalt · Movie',name,type:'embed',embedUrl:u})};
  for(const m of html.matchAll(/<iframe[^>]+(?:src|data-src|data-url|data-embed|data-player)=["']([^"']+)["'][^>]*>/gi))add(m[1],'Iframe');
  for(const m of html.matchAll(/<(?:a|button)[^>]+(?:href|data-url|data-embed|data-iframe|data-player|data-server)=["']([^"']+)["'][^>]*>([\s\S]{0,180})<\/(?:a|button)>/gi)){
   const label=m[2].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
   if(/server|play|abyss|mystream|embed/i.test(label))add(m[1],label||'Movie Server');
  }
  return out;
 }catch{return []}
}

async function handleResolve(request){const {searchParams,origin}=new URL(request.url);const slug=searchParams.get('slug');const anilistId=searchParams.get('anilistId')||'';const ep=searchParams.get('ep');const season=searchParams.get('season');const saltId=searchParams.get('saltId');
 // A movie slug has no SxE/episode marker. Treat it as a movie automatically,
 // while still accepting the explicit ?type=movie form.
 const isMovie=searchParams.get('type')==='movie'||(!ep&&!season&&!/(?:s?\d{1,3}x\d{1,5}|(?:episode|ep)[-_ ]?\d+)/i.test(slug||''));
 if(!slug)return errResp('missing ?slug=',400);
 const parsed=parseSlugEpisode(slug);const effectiveEp=ep||(!isMovie?parsed.ep:'');const effectiveSeason=season||(!isMovie?parsed.season:'');const effectiveSaltId=saltId||parsed.saltId||slug;const results={slug,media:isMovie?'movie':'episode',servers:[],m3u8s:[],downloads:[]};
 const [dekho,toon]=await Promise.all([fetchJSON(`${ANIMEDEKHO_API}/${encodeURIComponent(slug)}`),isMovie?Promise.resolve(null):fetchJSON(`${TOONAPI}/${encodeURIComponent(slug)}`)]);
 await Promise.all([{name:'AnimeDekho',data:dekho,type:isMovie?'multi':'sub'},{name:'ToonAPI',data:toon,type:'multi'}].map(async({name,data,type})=>{if(!data?.servers)return;for(const s of data.servers){if(!s?.url)continue;const sType=detectType(s.name,type);const entry={provider:isMovie?`${name} · Movie`:name,name:s.name,type:sType,embedUrl:s.url};const hash=extractHash(s.url);if(hash){entry.m3u8=`${origin}/vidstream?hash=${hash}`;results.m3u8s.push({provider:`${name} · ${s.name}`,type:sType,m3u8:entry.m3u8})}results.servers.push(entry)}for(const d of(data.downloads||[])){if(d?.url)results.downloads.push({name:d.name,url:d.url,provider:name})}}));
 if(effectiveSaltId&&effectiveEp&&!isMovie){try{const base=`${ANIMESALT_API}?ep=${encodeURIComponent(effectiveEp)}&season=${encodeURIComponent(effectiveSeason||'')}&saltId=${encodeURIComponent(effectiveSaltId)}`;let d=await fetchJSON(anilistId?`${base}&anilistId=${encodeURIComponent(anilistId)}`:base);if(!d?.servers?.length)d=await fetchJSON(base);for(const s of(d?.servers||[])){if(!s?.url)continue;results.servers.push({provider:'AnimeSalt',name:s.name||s.title||'AnimeSalt',type:detectType(s.name,'multi'),embedUrl:s.url})}}catch(_){}}
 if(isMovie){const movieServers=await extractMoviePageServers(effectiveSaltId);for(const s of movieServers){if(!results.servers.some(x=>x.embedUrl===s.embedUrl))results.servers.push(s)}}
 results.total=results.servers.length;return jsonResp(results)}
function parseSlugEpisode(slug){const s=decodeURIComponent(slug||'').replace(/\/$/,'');const m=s.match(/(?:^|[-_\s])s?(\d{1,3})x(\d{1,5})(?:[-_\s]|$)/i);if(m)return{season:m[1],ep:m[2],saltId:s.replace(new RegExp(`[-_]?s?${m[1]}x${m[2]}$`,'i'),'')};const m2=s.match(/(?:episode|ep)[-_\s:]*(\d{1,5})/i);return{season:'1',ep:m2?.[1]||'1',saltId:s.replace(/(?:[-_]?episode|[-_]?ep)[-_\s:]*(\d{1,5})$/i,'')||s}}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}function absUrl(base,href){try{return new URL(href.trim(),base).toString()}catch{return href.trim()}}function mkProxy(origin,url,ref){return `${origin}/proxy?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(ref)}`}function mkM3u8(origin,url,ref){return `${origin}/m3u8?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(ref)}`}function extractHash(url){const m=url.match(/as-cdn\d+\.top\/video\/([a-f0-9]{32})/i);return m?m[1]:null}function detectType(name,fb){const n=(name||'').toLowerCase();return n.includes('dub')?'dub':n.includes('sub')?'sub':fb}
async function fetchJSON(url){try{const r=await fetch(url,{headers:{'User-Agent':UA}});if(!r.ok)return null;return r.json()}catch{return null}}
function jsonResp(data,status){return new Response(JSON.stringify(data,null,2),{status:status||200,headers:{...CORS,'Content-Type':'application/json','Cache-Control':'no-store'}})}function errResp(msg,status){return jsonResp({error:msg},status||400)}
