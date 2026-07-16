// ============================================================
// octano-wpp — Gateway WhatsApp da rede Octano (Baileys)
// API REST: /status, /qr, /send-text, /send-image  (envio protegido por token)
// Sessao persistida no Supabase (authState.js) + status/QR em oct_wpp_status.
// ============================================================
import express from 'express';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
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
  try {
    const { state, saveCreds } = await useSupabaseAuthState(SB_URL, SB_KEY, SESSION);
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
      version, auth: state, logger, printQRInTerminal: false,
      browser: ['Octano', 'Chrome', '1.0'], syncFullHistory: false,
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) { currentQR = qr; connected = false; await gravarStatus(); }
      if (connection === 'open') {
        connected = true; currentQR = null;
        numero = (sock.user && sock.user.id ? String(sock.user.id).split(':')[0].split('@')[0] : null);
        console.log('WhatsApp conectado:', numero);
        await gravarStatus();
      }
      if (connection === 'close') {
        connected = false;
        const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
          ? lastDisconnect.error.output.statusCode : null;
        await gravarStatus();
        console.log('conexao fechada, code=', code);
        iniciando = false;
        if (code !== DisconnectReason.loggedOut) setTimeout(start, 3000); // reconecta
        else console.log('deslogado — precisa novo QR');
      }
    });
  } catch (e) {
    console.error('erro ao iniciar:', e.message);
    iniciando = false;
    setTimeout(start, 5000);
  }
}

function normalizaTelefone(n) {
  let d = String(n || '').replace(/\D/g, '').replace(/^0+/, '');
  if (!d) return null;
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return d;
  if (d.length === 10 || d.length === 11) return '55' + d;
  return d;
}

const app = express();
app.use(express.json({ limit: '25mb' }));

function auth(req, res, next) {
  if (TOKEN && req.headers['x-wpp-token'] !== TOKEN) return res.status(401).json({ ok: false, error: 'token invalido' });
  next();
}

app.get('/', (req, res) => res.json({ ok: true, service: 'octano-wpp', connected, numero }));
app.get('/status', (req, res) => res.json({ ok: true, connected, numero, session: SESSION }));

app.get('/qr', async (req, res) => {
  if (connected) return res.json({ ok: true, connected: true, qr: null, numero });
  if (!currentQR) return res.json({ ok: true, connected: false, qr: null });
  res.json({ ok: true, connected: false, qr: await QRCode.toDataURL(currentQR) });
});

app.post('/send-text', auth, async (req, res) => {
  try {
    if (!connected || !sock) return res.status(503).json({ ok: false, error: 'whatsapp desconectado' });
    const phone = normalizaTelefone(req.body.phone);
    const message = req.body.message || '';
    if (!phone) return res.status(400).json({ ok: false, error: 'telefone invalido' });
    const r = await sock.sendMessage(`${phone}@s.whatsapp.net`, { text: message });
    res.json({ ok: true, id: r && r.key ? r.key.id : null });
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
    img = img.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(img, 'base64');
    const r = await sock.sendMessage(`${phone}@s.whatsapp.net`, { image: buffer, caption });
    res.json({ ok: true, id: r && r.key ? r.key.id : null });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.listen(PORT, () => console.log('octano-wpp ouvindo na porta', PORT));
start();
