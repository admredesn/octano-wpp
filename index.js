// ============================================================
// octano-wpp — Gateway WhatsApp da rede Octano (Baileys)
// API REST: /status, /qr, /send-text, /send-image, /send-document  (envio protegido por token)
// Sessao persistida no Supabase (authState.js) + status/QR em oct_wpp_status.
// ============================================================
import express from 'express';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import { useSupabaseAuthState } from './authState.js';

const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const TOKEN = (process.env.WPP_TOKEN || '').trim();
const SESSION = process.env.WPP_SESSION || 'rede';
const PORT = process.env.PORT || 3000;

const logger = pino({ level: 'silent' });
let sock = null;
let currentQR = null;
let connected = false;
let numero = null;
let iniciando = false;

// --- diagnostico (visivel em /debug) ---
let startCount = 0;
let lastError = null;
let lastStep = 'boot';
let lastConn = null;
let tentativas = 0;          // reconexoes seguidas sem conseguir abrir
let encerrando = false;      // SIGTERM do Railway (deploy): nao reconectar, a instancia nova assume
const dbg = (s) => { lastStep = s; console.log('[wpp]', s); };

// --- mensagens enviadas (11/10/2026) ---
// Quando o aparelho de quem recebe nao consegue decifrar, o WhatsApp pede ao remetente para
// REENVIAR (retry). O Baileys so atende se souber a mensagem original (getMessage). Sem isso
// a mensagem fica para sempre em "Aguardando mensagem" no aparelho de quem recebe — foi o que
// aconteceu com todas as mensagens do sistema a partir de 09/10/2026, depois de uma tempestade
// de reconexoes (16.346 starts) que deixou as chaves das conversas fora de sincronia.
const enviadas = new Map();  // id da mensagem -> conteudo (proto), as ultimas 500
const MAX_ENVIADAS = 500;
function guardarEnviada(r) {
  try {
    const id = r && r.key && r.key.id;
    if (!id || !r.message) return;
    enviadas.set(id, r.message);
    while (enviadas.size > MAX_ENVIADAS) enviadas.delete(enviadas.keys().next().value);
  } catch (e) { /* diagnostico apenas */ }
}

async function gravarStatus() {
  if (!SB_URL || !SB_KEY) return;
  try {
    await fetch(`${SB_URL.replace(/\/$/, '')}/rest/v1/oct_wpp_status`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify([{
        session_id: SESSION, connected, numero,
        qr: currentQR ? await QRCode.toDataURL(currentQR) : null,
        atualizado_em: new Date().toISOString(),
      }]),
    });
  } catch (e) { /* best-effort */ }
}

async function start() {
  if (iniciando) return;
  iniciando = true;
  startCount++;
  try {
    dbg('carregando auth state (supabase)');
    const { state, saveCreds } = await useSupabaseAuthState(SB_URL, SB_KEY, SESSION);

    dbg('buscando versao do baileys');
    let version;
    try {
      const r = await Promise.race([
        fetchLatestBaileysVersion(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout versao')), 8000)),
      ]);
      version = r.version;
      dbg('versao ' + JSON.stringify(version));
    } catch (e) {
      dbg('fetchLatestBaileysVersion falhou (' + e.message + '), usando default');
      version = undefined;
    }

    dbg('criando socket');
    sock = makeWASocket({
      version,
      // chaves em cache na memoria: o Baileys le a MESMA chave varias vezes por mensagem e cada
      // leitura era uma ida ao Supabase (lento e sujeito a ler um estado ja trocado)
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger, browser: ['Octano', 'Chrome', '1.0'], syncFullHistory: false,
      markOnlineOnConnect: false,           // o celular do numero continua recebendo as notificacoes
      getMessage: async (key) => enviadas.get(key && key.id) || undefined,   // reenvio quando o aparelho pede
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u;
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode : null;
      lastConn = { connection: connection || null, code, hasQr: !!qr, at: new Date().toISOString() };
      dbg('connection.update: ' + JSON.stringify({ connection, code, qr: !!qr }));
      if (qr) { currentQR = qr; connected = false; await gravarStatus(); }
      if (connection === 'open') {
        connected = true; currentQR = null; tentativas = 0;
        numero = (sock.user && sock.user.id ? String(sock.user.id).split(':')[0].split('@')[0] : null);
        await gravarStatus();
      }
      if (connection === 'close') {
        connected = false;
        await gravarStatus();
        iniciando = false;
        if (encerrando) return;                                              // deploy: a instancia nova assume
        if (code === DisconnectReason.loggedOut) { await resetar(); return; } // deslogado -> limpa e gera QR novo
        tentativas++;
        // Reconexao com espera crescente (3 s, 6, 12... ate 60 s) em vez de 3 s fixos: sem isso uma
        // queda de rede virava milhares de reconexoes seguidas. Codigo 440 = OUTRA instancia abriu a
        // mesma sessao (deploy em andamento): espera 30 s para nao ficar derrubando uma a outra.
        const espera = code === DisconnectReason.connectionReplaced ? 30000
          : Math.min(60000, 3000 * Math.pow(2, Math.min(tentativas - 1, 5)));
        dbg(`reconectando em ${espera} ms (tentativa ${tentativas}, codigo ${code})`);
        setTimeout(start, espera);
      }
    });
  } catch (e) {
    lastError = (e && e.stack) ? e.stack.slice(0, 600) : String(e);
    dbg('ERRO start: ' + (e && e.message));
    iniciando = false;
    if (!encerrando) setTimeout(start, 5000);
  }
}

// Railway manda SIGTERM antes de trocar a instancia no deploy: fecha o socket de proposito
// (sem reconectar) para a instancia nova nao disputar a sessao com esta.
process.on('SIGTERM', () => {
  encerrando = true;
  dbg('SIGTERM: encerrando o socket sem reconectar');
  try { if (sock) sock.end(undefined); } catch (e) { /* ja fechado */ }
  setTimeout(() => process.exit(0), 1500);
});

async function limparSessao() {
  if (!SB_URL || !SB_KEY) return;
  try {
    await fetch(`${SB_URL.replace(/\/$/, '')}/rest/v1/oct_wpp_sessao?session_id=eq.${encodeURIComponent(SESSION)}`,
      { method: 'DELETE', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Prefer: 'return=minimal' } });
  } catch (e) { /* best-effort */ }
}

// Desconecta (logout), apaga a sessao salva e reinicia -> gera QR novo (trocar de numero)
async function resetar() {
  dbg('reset: logout + limpa sessao + novo QR');
  connected = false; currentQR = null; numero = null;
  try { if (sock) await sock.logout(); } catch (e) { /* pode ja estar deslogado */ }
  await limparSessao();
  await gravarStatus();
  sock = null; iniciando = false;
  setTimeout(start, 1500);
}

// Comando via Supabase: retaguarda grava oct_wpp_status.comando='logout' (botao Desconectar).
// Poll defensivo — se a coluna 'comando' nao existir ainda, so ignora.
setInterval(async () => {
  if (!SB_URL || !SB_KEY) return;
  const b = SB_URL.replace(/\/$/, '');
  try {
    const r = await fetch(`${b}/rest/v1/oct_wpp_status?session_id=eq.${encodeURIComponent(SESSION)}&select=comando`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
    if (!r.ok) return;
    const arr = await r.json();
    if (arr && arr[0] && arr[0].comando === 'logout') {
      await fetch(`${b}/rest/v1/oct_wpp_status?session_id=eq.${encodeURIComponent(SESSION)}`,
        { method: 'PATCH', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ comando: null }) });
      await resetar();
    }
  } catch (e) { /* ignora */ }
}, 8000);

function normalizaTelefone(n) {
  let d = String(n || '').replace(/\D/g, '').replace(/^0+/, '');
  if (!d) return null;
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return d;
  if (d.length === 10 || d.length === 11) return '55' + d;
  return d;
}

// Resolve o JID REAL do numero no WhatsApp (trata o "9o digito" brasileiro e
// confirma que o numero existe). Sem isso, mandar direto pra 55...@s.whatsapp.net
// pode "enviar" (retorna id) mas nao entregar.
async function resolverJid(phone) {
  try {
    const res = await sock.onWhatsApp(phone);
    if (res && res[0] && res[0].exists) return res[0].jid;
  } catch (e) { dbg('onWhatsApp erro: ' + e.message); }
  return null;
}

const app = express();
app.use(express.json({ limit: '25mb' }));

function auth(req, res, next) {
  if (TOKEN && req.headers['x-wpp-token'] !== TOKEN) return res.status(401).json({ ok: false, error: 'token invalido' });
  next();
}

app.get('/', (req, res) => res.json({ ok: true, service: 'octano-wpp', connected, numero }));
app.get('/status', (req, res) => res.json({ ok: true, connected, numero, session: SESSION }));
app.get('/debug', (req, res) => res.json({
  ok: true, connected, numero, session: SESSION,
  startCount, tentativas, encerrando, enviadasGuardadas: enviadas.size,
  lastStep, lastConn, hasQR: !!currentQR, lastError,
  env: { SB_URL: !!SB_URL, SB_KEY: !!SB_KEY, TOKEN: !!TOKEN },
}));

// Diagnostico: verifica se um numero esta no WhatsApp e qual JID ele resolve.
app.get('/check', async (req, res) => {
  try {
    if (!connected || !sock) return res.json({ ok: false, error: 'desconectado' });
    const phone = normalizaTelefone(req.query.phone);
    if (!phone) return res.json({ ok: false, error: 'telefone invalido' });
    const r = await sock.onWhatsApp(phone);
    res.json({ ok: true, phone, existe: !!(r && r[0] && r[0].exists), jid: r && r[0] ? r[0].jid : null, raw: r });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/qr', async (req, res) => {
  if (connected) return res.json({ ok: true, connected: true, qr: null, numero });
  if (!currentQR) return res.json({ ok: true, connected: false, qr: null });
  res.json({ ok: true, connected: false, qr: await QRCode.toDataURL(currentQR) });
});

// Pagina HTML para escanear o QR (atualiza sozinha; o QR do WhatsApp expira ~30s)
app.get('/scan', async (req, res) => {
  let corpo;
  if (connected) corpo = `<p style="color:#4ade80;font-size:1.4rem">&#10004; Conectado! N&uacute;mero: ${numero || ''}</p>`;
  else if (currentQR) corpo = `<p>No celular do n&uacute;mero da rede: WhatsApp &rarr; Aparelhos conectados &rarr; Conectar um aparelho &rarr; escaneie:</p>
    <img src="${await QRCode.toDataURL(currentQR)}" alt="QR">`;
  else corpo = `<p>Gerando QR... aguarde alguns segundos (a p&aacute;gina atualiza sozinha).</p>`;
  res.set('Content-Type', 'text/html').send(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Conectar WhatsApp - Octano</title>
     <meta http-equiv="refresh" content="6"><meta name="viewport" content="width=device-width,initial-scale=1">
     <style>body{font-family:system-ui,sans-serif;text-align:center;background:#0b0d14;color:#e5e7eb;padding:30px}
     img{width:300px;height:300px;background:#fff;padding:12px;border-radius:10px;margin:12px auto;display:block}
     h2{color:#f97316}</style></head><body><h2>Conectar WhatsApp da rede</h2>${corpo}
     <p style="color:#6b7688;font-size:.8rem">A p&aacute;gina atualiza a cada 6s.</p></body></html>`);
});

app.post('/reset', auth, async (req, res) => {
  resetar();
  res.json({ ok: true, msg: 'desconectando e gerando QR novo' });
});

app.post('/send-text', auth, async (req, res) => {
  try {
    if (!connected || !sock) return res.status(503).json({ ok: false, error: 'whatsapp desconectado' });
    const phone = normalizaTelefone(req.body.phone);
    const message = req.body.message || '';
    if (!phone) return res.status(400).json({ ok: false, error: 'telefone invalido' });
    const jid = await resolverJid(phone);
    if (!jid) return res.status(404).json({ ok: false, error: 'numero nao esta no WhatsApp', phone });
    const r = await sock.sendMessage(jid, { text: message });
    guardarEnviada(r);
    res.json({ ok: true, id: r && r.key ? r.key.id : null, jid });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/send-image', auth, async (req, res) => {
  try {
    if (!connected || !sock) return res.status(503).json({ ok: false, error: 'whatsapp desconectado' });
    const phone = normalizaTelefone(req.body.phone);
    let img = req.body.image || '';
    const caption = req.body.caption || '';
    if (!phone) return res.status(400).json({ ok: false, error: 'telefone invalido' });
    if (!img) return res.status(400).json({ ok: false, error: 'imagem ausente' });
    const jid = await resolverJid(phone);
    if (!jid) return res.status(404).json({ ok: false, error: 'numero nao esta no WhatsApp', phone });
    img = img.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(img, 'base64');
    const r = await sock.sendMessage(jid, { image: buffer, caption });
    guardarEnviada(r);
    res.json({ ok: true, id: r && r.key ? r.key.id : null, jid });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/send-document', auth, async (req, res) => {
  try {
    if (!connected || !sock) return res.status(503).json({ ok: false, error: 'whatsapp desconectado' });
    const phone = normalizaTelefone(req.body.phone);
    const b64 = String(req.body.document || '').replace(/^data:[^;]+;base64,/, '');
    const fileName = req.body.fileName || 'documento.pdf';
    const mimetype = req.body.mimetype || 'application/pdf';
    const caption = req.body.caption || '';
    if (!phone) return res.status(400).json({ ok: false, error: 'telefone invalido' });
    if (!b64) return res.status(400).json({ ok: false, error: 'documento ausente' });
    const jid = await resolverJid(phone);
    if (!jid) return res.status(404).json({ ok: false, error: 'numero nao esta no WhatsApp', phone });
    const r = await sock.sendMessage(jid, {
      document: Buffer.from(b64, 'base64'), mimetype, fileName, caption,
    });
    guardarEnviada(r);
    res.json({ ok: true, id: r && r.key ? r.key.id : null, jid });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.listen(PORT, () => console.log('octano-wpp ouvindo na porta', PORT));
start();
