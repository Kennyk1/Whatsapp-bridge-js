const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion,
    DisconnectReason,
    Browsers
} = require('@whiskeysockets/baileys');
const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const PORT = process.env.PORT || 10000;
const SESSION_ID = process.env.SESSION_ID || 'default';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-this-secret';
const FLASK_APP_URL = process.env.FLASK_APP_URL;
const USE_SUPABASE = process.env.SUPABASE_URL && process.env.SUPABASE_KEY;

let supabase = null;
if (USE_SUPABASE) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
}

const AUTH_DIR = path.join(__dirname, 'auth_state', SESSION_ID);
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

let sock = null;
let connectionStatus = 'idle';
let currentPairingCode = null;
let lastError = null;
let pendingPairResolve = null;

function clearSession() {
    try {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        fs.mkdirSync(AUTH_DIR, { recursive: true });
    } catch (e) {}
}

async function backupToSupabase() {
    if (!supabase) return;
    try {
        const files = fs.readdirSync(AUTH_DIR);
        const sessionData = {};
        files.forEach(f => {
            sessionData[f] = fs.readFileSync(path.join(AUTH_DIR, f), 'utf8');
        });
        await supabase.from('teleagent_settings').upsert({
            key: `wa_session_${SESSION_ID}`,
            value: JSON.stringify(sessionData)
        });
    } catch (e) {}
}

async function notifyFlask(event) {
    if (!FLASK_APP_URL) return;
    try {
        await fetch(`${FLASK_APP_URL}/api/ta/whatsapp/webhook`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Internal-Secret': ADMIN_SECRET
            },
            body: JSON.stringify({ session_id: SESSION_ID, ...event })
        });
    } catch (e) {}
}

async function startSocket() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.appropriate('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 45000,
});

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        await backupToSupabase();
    });

    sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
        if (qr && pendingPairResolve) {
            const { phone, resolve, reject } = pendingPairResolve;
            pendingPairResolve = null;

            try {
                await new Promise(r => setTimeout(r, 500));
                const code = await sock.requestPairingCode(phone);
                currentPairingCode = code;
                connectionStatus = 'pairing_pending';
                resolve(code);
            } catch (err) {
                connectionStatus = 'idle';
                reject(err);
            }
        }

        if (connection === 'open') {
            connectionStatus = 'connected';
            currentPairingCode = null;
            lastError = null;
            notifyFlask({ type: 'connected' });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = statusCode === DisconnectReason.loggedOut;

            connectionStatus = 'disconnected';
            lastError = `Disconnected: ${statusCode}`;
            notifyFlask({ type: 'disconnected' });

            if (loggedOut || statusCode === 401) {
                clearSession();
                connectionStatus = 'idle';
                sock = null;
                return;
            }

            setTimeout(() => startSocket(), 5000);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const message = m.messages[0];
        if (!message.message || message.key.fromMe) return;

        const msgType = Object.keys(message.message)[0];
        let msgText = '';

        if (msgType === 'conversation') msgText = message.message.conversation;
        else if (msgType === 'extendedTextMessage') msgText = message.message.extendedTextMessage.text;
        else if (msgType === 'imageMessage') msgText = message.message.imageMessage.caption || '[Image]';
        else if (msgType === 'videoMessage') msgText = message.message.videoMessage.caption || '[Video]';
        else if (msgType === 'audioMessage') msgText = '[Voice Message]';
        else if (msgType === 'documentMessage') msgText = '[Document]';
        else return;

        if (!msgText.trim()) return;

        const sender = message.key.remoteJid;
        const senderNumber = sender.split('@')[0];
        const senderName = message.pushName || 'Contact';
        const isGroup = sender.endsWith('@g.us');

        await notifyFlask({
            type: 'message',
            sender_number: senderNumber,
            sender_name: senderName,
            message_text: msgText,
            is_group: isGroup,
            timestamp: new Date().toISOString()
        });
    });
}

const app = express();

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Internal-Secret');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json());

app.get('/', (req, res) => {
    res.json({
        service: 'TeleAgent WhatsApp Bridge',
        status: connectionStatus,
        connected: connectionStatus === 'connected',
        timestamp: new Date().toISOString()
    });
});

app.post('/pair', async (req, res) => {
    const { phone_number } = req.body;
    if (!phone_number) return res.status(400).json({ success: false, error: 'Phone number required' });

    const cleanNumber = phone_number.replace(/\D/g, '');

    if (sock) {
        try { sock.end(); } catch {}
        sock = null;
    }

    connectionStatus = 'connecting';

    const timeout = setTimeout(() => {
        if (pendingPairResolve) {
            pendingPairResolve = null;
            connectionStatus = 'idle';
            if (sock) { try { sock.end(); } catch {} sock = null; }
            res.status(504).json({ success: false, error: 'Timeout waiting for WhatsApp connection' });
        }
    }, 30000);

    try {
        const code = await new Promise((resolve, reject) => {
            pendingPairResolve = { phone: cleanNumber, resolve, reject };
            startSocket().catch(reject);
        });

        clearTimeout(timeout);
        res.json({ success: true, code, expires_in: 60 });
    } catch (err) {
        clearTimeout(timeout);
        connectionStatus = 'idle';
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/status', (req, res) => {
    res.json({
        success: true,
        status: connectionStatus,
        connected: connectionStatus === 'connected',
        has_code: currentPairingCode !== null,
        last_error: lastError
    });
});

app.post('/send', async (req, res) => {
    if (req.headers['x-internal-secret'] !== ADMIN_SECRET)
        return res.status(401).json({ success: false, error: 'Unauthorized' });

    const { to_number, text } = req.body;
    if (!to_number || !text)
        return res.status(400).json({ success: false, error: 'Missing fields' });

    if (!sock || connectionStatus !== 'connected')
        return res.status(503).json({ success: false, error: 'WhatsApp not connected' });

    try {
        await sock.sendMessage(`${to_number}@s.whatsapp.net`, { text });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/restart', async (req, res) => {
    if (req.headers['x-internal-secret'] !== ADMIN_SECRET)
        return res.status(401).json({ success: false, error: 'Unauthorized' });

    if (sock) { try { sock.end(); } catch {} sock = null; }
    connectionStatus = 'idle';
    currentPairingCode = null;

    res.json({ success: true, message: 'Restarted' });
});

app.post('/logout', async (req, res) => {
    if (req.headers['x-internal-secret'] !== ADMIN_SECRET)
        return res.status(401).json({ success: false, error: 'Unauthorized' });

    if (sock) { try { await sock.logout(); sock.end(); } catch {} sock = null; }
    clearSession();
    connectionStatus = 'idle';
    currentPairingCode = null;

    res.json({ success: true, message: 'Logged out and session cleared' });
});

app.listen(PORT, () => {
    console.log(`TeleAgent WhatsApp Bridge running on port ${PORT}`);
});

if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
    startSocket().catch(console.error);
}
