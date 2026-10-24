import { createReadStream } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { BotConfig } from './config.js';
import { logger } from './logger.js';
import type { BotStore } from './store.js';

const log = logger('web');

/**
 * Minimal control panel: list the chats the bot is in, toggle it per chat,
 * review tracked edits and the media archive, and lift mutes. Guarded by a
 * single shared token (query `?token=` or header `x-bot-token`) — fine for a
 * personal deployment behind a tunnel, not a public multi-tenant surface.
 */
export function createWeb(cfg: BotConfig, store: BotStore): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: true });

  app.addHook('onRequest', async (req, reply) => {
    const token =
      (req.query as Record<string, string> | undefined)?.token ??
      req.headers['x-bot-token'];
    if (!cfg.webToken || token !== cfg.webToken) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/', async (_req, reply) => {
    await reply.type('text/html').send(renderDashboard());
  });

  app.get('/api/chats', async () => store.listChats());

  app.post('/api/chats/:id/:flag/:value', async (req, reply) => {
    const { id, flag, value } = req.params as { id: string; flag: string; value: string };
    if (flag !== 'enabled' && flag !== 'trackEdits') {
      return reply.code(400).send({ error: 'bad_flag' });
    }
    store.setChatFlag(Number(id), flag, value === 'true');
    return { ok: true };
  });

  app.get('/api/mutes', async () => store.listMutes());

  app.get('/api/edits', async (req) => {
    const limit = Number((req.query as Record<string, string>)?.limit ?? 100);
    return store.listEdits(Number.isFinite(limit) ? limit : 100);
  });

  app.get('/api/media', async (req) => {
    const limit = Number((req.query as Record<string, string>)?.limit ?? 100);
    return store.listMedia(Number.isFinite(limit) ? limit : 100);
  });

  app.get('/api/media/:id/file', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = store.getMedia(id);
    if (!rec) return reply.code(404).send({ error: 'not_found' });
    const full = path.join(store.mediaDirectory, rec.file);
    return reply.type(rec.mime).send(createReadStream(full));
  });

  return app;
}

export async function startWeb(cfg: BotConfig, store: BotStore): Promise<FastifyInstance> {
  const app = createWeb(cfg, store);
  await app.listen({ port: cfg.webPort, host: cfg.webHost });
  log.info(`panel on ${cfg.webHost}:${cfg.webPort} (token required)`);
  return app;
}

function renderDashboard(): string {
  // Self-contained page; it reads the JSON APIs with the token from the URL.
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>esgram</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --muted:#666; --line:#e3e3e3; --card:#fafafa; }
  @media (prefers-color-scheme: dark){ :root{ --bg:#15171a; --fg:#e8e8e8; --muted:#9aa0a6; --line:#2a2e33; --card:#1c1f23; } }
  *{box-sizing:border-box}
  body{margin:0;padding:24px 16px;max-width:860px;margin-inline:auto;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
  h1{font-size:22px;margin:0 0 4px} .sub{color:var(--muted);margin:0 0 24px}
  h2{font-size:15px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:28px 0 10px}
  .row{display:flex;gap:10px;align-items:center;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card);margin-bottom:8px}
  .row .name{flex:1;min-width:0} .row .name b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .row .name span{color:var(--muted);font-size:13px}
  button{font:inherit;padding:6px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--fg);cursor:pointer}
  button.on{background:#2d7d46;color:#fff;border-color:transparent}
  .diff del{color:#c0392b;text-decoration:line-through} .diff ins{color:#2d7d46;text-decoration:none}
  .empty{color:var(--muted);font-style:italic;padding:8px 0}
  a{color:#3b82f6}
</style></head><body>
<h1>esgram</h1>
<p class="sub">Чаты, муты, правки и архив медиа.</p>
<div id="app"><p class="empty">Загрузка…</p></div>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const h = { 'x-bot-token': token };
const esc = s => (s||'').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function j(u, o){ const r = await fetch(u, { ...o, headers: { ...h, ...(o&&o.headers) } }); return r.json(); }
async function load(){
  const [chats, mutes, edits, media] = await Promise.all([
    j('/api/chats'), j('/api/mutes'), j('/api/edits?limit=50'), j('/api/media?limit=50')
  ]);
  const app = document.getElementById('app');
  app.innerHTML =
    section('Чаты', chats.length ? chats.map(chatRow).join('') : empty()) +
    section('Муты', mutes.length ? mutes.map(muteRow).join('') : empty()) +
    section('Правки', edits.length ? edits.map(editRow).join('') : empty()) +
    section('Архив медиа', media.length ? media.map(mediaRow).join('') : empty());
}
const section = (t, body) => '<h2>'+t+'</h2>'+body;
const empty = () => '<p class="empty">пусто</p>';
const chatRow = c => '<div class="row"><div class="name"><b>'+esc(c.title)+'</b><span>'+c.type+' · '+c.chatId+'</span></div>'+
  toggle(c.chatId,'enabled',c.enabled,'бот')+toggle(c.chatId,'trackEdits',c.trackEdits,'правки')+'</div>';
const toggle = (id,flag,val,label) => '<button class="'+(val?'on':'')+'" onclick="flip('+id+",'"+flag+"',"+(!val)+')">'+label+'</button>';
const muteRow = m => '<div class="row"><div class="name"><b>'+esc(m.userName)+'</b><span>чат '+m.chatId+' · с '+new Date(m.since).toLocaleString()+'</span></div></div>';
const editRow = e => '<div class="row"><div class="name"><b>'+esc(e.userName)+'</b><span>'+esc(e.chatTitle)+' · '+new Date(e.at).toLocaleString()+'</span>'+
  '<div class="diff"><del>'+esc(e.before)+'</del> → <ins>'+esc(e.after)+'</ins></div></div></div>';
const mediaRow = x => '<div class="row"><div class="name"><b>'+esc(x.fromName)+'</b><span>'+x.kind+' · '+esc(x.chatTitle)+' · '+new Date(x.at).toLocaleString()+'</span>'+
  (x.caption?'<div>'+esc(x.caption)+'</div>':'')+'</div><a href="/api/media/'+x.id+'/file?token='+encodeURIComponent(token)+'" target="_blank">открыть</a></div>';
async function flip(id, flag, val){ await j('/api/chats/'+id+'/'+flag+'/'+val, { method:'POST' }); load(); }
load();
</script>
</body></html>`;
}
