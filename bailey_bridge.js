const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 10000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-this-secret';
const FLASK_APP_URL = process.env.FLASK_APP_URL;
const USE_SUPABASE = process.env.SUPABASE_URL && process.env.SUPABASE_KEY;

let supabase = null;
if (USE_SUPABASE) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
}

// ✅ MULTIPLE SOCKETS - Key change!
const sockets = {};              // phone_number -> socket
const socketStatus = {};         // phone_number -> status
const pendingPairs = {};         // phone_number -> { resolve, reject }

// Helper: Get auth directory for a specific phone
function getAuthDir(phone) {
    const dir = path.join(__dirname, 'auth_state', phone);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function clearSession(phone) {
    try {
        const dir = getAuthDir(phone);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
    } catch (e) {}
}

async function backupToSupabase(phone) {
    if (!supabase) return;
    try {
        const dir = getAuthDir(phone);
        const files = fs.readdirSync(dir);
        const sessionData = {};
        files.forEach(f => {
            sessionData[f] = fs.readFileSync(path.join(dir, f), 'utf8');
        });
        await supabase.from('teleagent_settings').upsert({
            key: `wa_session_${phone}`,
            value: JSON.stringify(sessionData)
        });
    } catch (e) {}
}

async function notifyFlask(event, waOwnerNumber) {
    if (!FLASK_APP_URL) return;
    try {
        await fetch(`${FLASK_APP_URL}/api/ta/whatsapp/webhook`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Internal-Secret': ADMIN_SECRET
            },
            body: JSON.stringify({ wa_owner_number: waOwnerNumber, ...event })
        });
    } catch (e) {}
}

// ✅ Start socket for a SPECIFIC phone number
async function startSocketForPhone(phone) {
    const authDir = getAuthDir(phone);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.appropriate('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: false,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 45000,
    });

    sockets[phone] = sock;
    socketStatus[phone] = 'connecting';

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        await backupToSupabase(phone);
    });

    sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
        // Handle pairing code request
        if (qr && pendingPairs[phone]) {
            const { resolve, reject } = pendingPairs[phone];
            delete pendingPairs[phone];

            try {
                await new Promise(r => setTimeout(r, 500));
                const code = await sock.requestPairingCode(phone);
                socketStatus[phone] = 'pairing_pending';
                resolve(code);
            } catch (err) {
                socketStatus[phone] = 'idle';
                reject(err);
            }
        }

        if (connection === 'open') {
            socketStatus[phone] = 'connected';
            console.log(`✅ WhatsApp connected: ${phone}`);
            notifyFlask({ type: 'connected' }, phone);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = statusCode === DisconnectReason.loggedOut;

            socketStatus[phone] = 'disconnected';
            console.log(`🔌 WhatsApp disconnected: ${phone}`);
            notifyFlask({ type: 'disconnected' }, phone);

            if (loggedOut || statusCode === 401) {
                clearSession(phone);
                delete sockets[phone];
                socketStatus[phone] = 'idle';
                return;
            }

            // Auto-reconnect
            setTimeout(() => {
                if (sockets[phone]) {
                    startSocketForPhone(phone).catch(console.error);
                }
            }, 5000);
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
        }, phone);  // ✅ Include the owner phone number
    });

    return sock;
}

// ✅ Restore all previously connected sessions on startup
async function restoreAllSessions() {
    if (!supabase) return;
    
    try {
        const { data } = await supabase.from('teleagent_settings')
            .select('key')
            .like('key', 'wa_session_%');
        
        for (const row of (data || [])) {
            const phone = row.key.replace('wa_session_', '');
            const authDir = getAuthDir(phone);
            
            // Check if we have local creds or need to pull from Supabase
            if (!fs.existsSync(path.join(authDir, 'creds.json'))) {
                // Pull from Supabase
                const { data: sessionData } = await supabase.from('teleagent_settings')
                    .select('value')
                    .eq('key', `wa_session_${phone}`)
                    .single();
                
                if (sessionData?.value) {
                    const files = JSON.parse(sessionData.value);
                    for (const [filename, content] of Object.entries(files)) {
                        fs.writeFileSync(path.join(authDir, filename), content);
                    }
                }
            }
            
            // Start the socket
            console.log(`🔄 Restoring session for: ${phone}`);
            startSocketForPhone(phone).catch(e => console.error(`Failed to restore ${phone}:`, e));
        }
    } catch (e) {
        console.error('Restore sessions error:', e);
    }
}

// ============================================================
// EXPRESS API
// ============================================================
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
        active_sessions: Object.keys(sockets).length,
        sessions: Object.keys(socketStatus).map(p => ({ phone: p, status: socketStatus[p] })),
        timestamp: new Date().toISOString()
    });
});

// ✅ Pair endpoint - now phone-specific
app.post('/pair', async (req, res) => {
    const { phone_number } = req.body;
    if (!phone_number) return res.status(400).json({ success: false, error: 'Phone number required' });

    const cleanNumber = phone_number.replace(/\D/g, '');

    // Check if already connected
    if (sockets[cleanNumber] && socketStatus[cleanNumber] === 'connected') {
        return res.json({ success: true, already_connected: true, message: 'Already connected!' });
    }

    // Kill existing socket for this phone if any (force fresh start)
    if (sockets[cleanNumber]) {
        try { sockets[cleanNumber].end(); } catch {}
        delete sockets[cleanNumber];
    }

    socketStatus[cleanNumber] = 'connecting';

    const timeout = setTimeout(() => {
        if (pendingPairs[cleanNumber]) {
            const { reject } = pendingPairs[cleanNumber];
            delete pendingPairs[cleanNumber];
            socketStatus[cleanNumber] = 'idle';
            reject(new Error('Timeout waiting for WhatsApp connection'));
        }
    }, 30000);

    try {
        const code = await new Promise((resolve, reject) => {
            pendingPairs[cleanNumber] = { resolve, reject };
            startSocketForPhone(cleanNumber).catch(reject);
        });

        clearTimeout(timeout);
        res.json({ success: true, code, expires_in: 60 });
    } catch (err) {
        clearTimeout(timeout);
        socketStatus[cleanNumber] = 'idle';
        res.status(500).json({ success: false, error: err.message });
    }
});

// ✅ Status endpoint - returns status for a specific phone
app.get('/status', (req, res) => {
    const phone = req.query.phone;
    
    if (phone) {
        return res.json({
            success: true,
            phone: phone,
            status: socketStatus[phone] || 'idle',
            connected: socketStatus[phone] === 'connected'
        });
    }
    
    res.json({
        success: true,
        sessions: Object.keys(socketStatus).map(p => ({ 
            phone: p, 
            status: socketStatus[p],
            connected: socketStatus[p] === 'connected'
        }))
    });
});

// ✅ Send endpoint - now phone-specific
app.post('/send', async (req, res) => {
    if (req.headers['x-internal-secret'] !== ADMIN_SECRET)
        return res.status(401).json({ success: false, error: 'Unauthorized' });

    const { from_number, to_number, text } = req.body;
    if (!from_number || !to_number || !text)
        return res.status(400).json({ success: false, error: 'Missing from_number, to_number, or text' });

    const sock = sockets[from_number];
    if (!sock || socketStatus[from_number] !== 'connected')
        return res.status(503).json({ success: false, error: 'WhatsApp not connected for this number' });

    try {
        await sock.sendMessage(`${to_number}@s.whatsapp.net`, { text });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ✅ Logout endpoint - phone-specific
app.post('/logout', async (req, res) => {
    if (req.headers['x-internal-secret'] !== ADMIN_SECRET)
        return res.status(401).json({ success: false, error: 'Unauthorized' });

    const { phone_number } = req.body;
    if (!phone_number) return res.status(400).json({ success: false, error: 'Phone number required' });

    const cleanNumber = phone_number.replace(/\D/g, '');
    const sock = sockets[cleanNumber];

    if (sock) {
        try { await sock.logout(); sock.end(); } catch {}
        delete sockets[cleanNumber];
    }

    clearSession(cleanNumber);
    socketStatus[cleanNumber] = 'idle';

    res.json({ success: true, message: `Logged out ${cleanNumber}` });
});

// ✅ Restart endpoint - phone-specific
app.post('/restart', async (req, res) => {
    if (req.headers['x-internal-secret'] !== ADMIN_SECRET)
        return res.status(401).json({ success: false, error: 'Unauthorized' });

    const { phone_number } = req.body;
    if (!phone_number) return res.status(400).json({ success: false, error: 'Phone number required' });

    const cleanNumber = phone_number.replace(/\D/g, '');
    
    if (sockets[cleanNumber]) {
        try { sockets[cleanNumber].end(); } catch {}
        delete sockets[cleanNumber];
    }
    
    socketStatus[cleanNumber] = 'idle';
    
    // Restart
    startSocketForPhone(cleanNumber).catch(console.error);

    res.json({ success: true, message: `Restarted ${cleanNumber}` });
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, async () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║     TELEAGENT WHATSAPP BRIDGE - MULTI-USER READY        ║
╠══════════════════════════════════════════════════════════╣
║  Port: ${PORT}                                           
║  Flask Backend: ${FLASK_APP_URL || 'NOT SET'}           
╠══════════════════════════════════════════════════════════╣
║  Endpoints:                                             ║
║  POST /pair?phone=xxx    - Request pairing code         ║
║  GET  /status?phone=xxx  - Connection status            ║
║  POST /send              - Send WhatsApp message        ║
║  POST /logout?phone=xxx  - Logout specific number       ║
║  POST /restart?phone=xxx - Restart specific number      ║
╚══════════════════════════════════════════════════════════╝
    `);
    
    // Restore all previous sessions
    await restoreAllSessions();
});
