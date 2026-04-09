// bailey_bridge.js - WhatsApp Bridge Service for TeleAgent

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ============================================================
// CONFIGURATION
// ============================================================
const PORT = process.env.PORT || 10000;
const SESSION_ID = process.env.SESSION_ID || 'default';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-this-secret';
const FLASK_APP_URL = process.env.FLASK_APP_URL;
const USE_SUPABASE = process.env.SUPABASE_URL && process.env.SUPABASE_KEY;

let supabase = null;
if (USE_SUPABASE) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    console.log('✅ Supabase configured for session backup');
}

// ============================================================
// AUTH STATE STORAGE
// ============================================================
const AUTH_DIR = path.join(__dirname, 'auth_state', SESSION_ID);
if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    console.log(`📁 Created auth directory: ${AUTH_DIR}`);
}

// ============================================================
// GLOBAL STATE
// ============================================================
let sock = null;
let connectionStatus = 'idle';
let isSocketReady = false;
let currentPairingCode = null;
let lastError = null;

// ============================================================
// HELPER FUNCTIONS
// ============================================================

async function backupSessionToSupabase(sessionData) {
    if (!supabase) return;
    try {
        const { error } = await supabase
            .from('teleagent_settings')
            .upsert({
                key: `wa_session_${SESSION_ID}`,
                value: JSON.stringify(sessionData)
            });
        if (error) console.error('❌ Supabase backup failed:', error.message);
        else console.log('💾 Session backed up to Supabase');
    } catch (e) {
        console.error('❌ Supabase backup error:', e.message);
    }
}

async function notifyFlaskBackend(event) {
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
    } catch (e) {
        console.error('❌ Webhook error:', e.message);
    }
}

// ============================================================
// EXPRESS API SERVER
// ============================================================
const app = express();

// CORS
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
        socket_ready: isSocketReady,
        timestamp: new Date().toISOString()
    });
});

// FIXED /pair endpoint - waits for QR event before requesting code
app.post('/pair', async (req, res) => {
    const { phone_number } = req.body;

    if (!phone_number) {
        return res.status(400).json({ success: false, error: 'Phone number required' });
    }

    const cleanNumber = phone_number.replace(/\D/g, '');

    try {
        // Kill existing socket if any
        if (sock) {
            try { sock.end(); } catch(e) {}
            sock = null;
        }

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: ['TeleAgent', 'Chrome', '1.0.0']
        });

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            console.log('🔐 Credentials saved');
            
            // Backup to Supabase if configured
            if (supabase) {
                try {
                    const files = fs.readdirSync(AUTH_DIR);
                    const sessionData = {};
                    files.forEach(f => {
                        sessionData[f] = fs.readFileSync(path.join(AUTH_DIR, f), 'utf8');
                    });
                    await backupSessionToSupabase(sessionData);
                } catch (e) {}
            }
        });

        let codeRequested = false;

        sock.ev.on('connection.update', async (update) => {
            const { connection, qr } = update;

            // ✅ CRITICAL: Wait for QR event, then request pairing code
            if (qr && !codeRequested) {
                codeRequested = true;

                try {
                    const code = await sock.requestPairingCode(cleanNumber);
                    currentPairingCode = code;
                    connectionStatus = 'pairing_pending';

                    console.log(`🔑 Pairing code for ${cleanNumber}: ${code}`);

                    return res.json({
                        success: true,
                        code: code,
                        expires_in: 60,
                        message: 'Enter this code in WhatsApp: Settings → Linked Devices → Link a Device'
                    });

                } catch (err) {
                    console.error('❌ Pairing error:', err.message);
                    
                    sock = null;
                    connectionStatus = 'idle';
                    
                    return res.status(500).json({
                        success: false,
                        error: err.message
                    });
                }
            }

            if (connection === 'open') {
                connectionStatus = 'connected';
                isSocketReady = true;
                currentPairingCode = null;
                lastError = null;
                console.log('✅ WhatsApp connected!');
                notifyFlaskBackend({ type: 'connected' });
            }

            if (connection === 'close') {
                console.log('🔌 Connection closed');
                connectionStatus = 'disconnected';
                isSocketReady = false;
                sock = null;
            }
        });

        // Incoming messages
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

            console.log(`📨 [${isGroup ? 'GROUP' : 'DM'}] ${senderName}: ${msgText.substring(0, 50)}`);

            await notifyFlaskBackend({
                type: 'message',
                sender_number: senderNumber,
                sender_name: senderName,
                message_text: msgText,
                is_group: isGroup,
                timestamp: new Date().toISOString()
            });
        });

    } catch (error) {
        console.error('❌ Setup error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/status', (req, res) => {
    res.json({ 
        success: true,
        status: connectionStatus,
        connected: connectionStatus === 'connected',
        socket_ready: isSocketReady,
        has_code: currentPairingCode !== null,
        last_error: lastError
    });
});

app.post('/send', async (req, res) => {
    const secret = req.headers['x-internal-secret'];
    if (secret !== ADMIN_SECRET) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    const { to_number, text } = req.body;
    if (!to_number || !text) {
        return res.status(400).json({ success: false, error: 'Missing to_number or text' });
    }
    
    if (!sock || connectionStatus !== 'connected') {
        return res.status(503).json({ 
            success: false, 
            error: 'WhatsApp not connected',
            status: connectionStatus
        });
    }
    
    try {
        const jid = `${to_number}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text });
        console.log(`📤 Sent reply to ${to_number}`);
        res.json({ success: true });
    } catch (e) {
        console.error('❌ Send error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/restart', async (req, res) => {
    const secret = req.headers['x-internal-secret'];
    if (secret !== ADMIN_SECRET) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    console.log('🔄 Manual restart requested');
    if (sock) {
        try { sock.end(); } catch(e) {}
    }
    
    connectionStatus = 'idle';
    isSocketReady = false;
    currentPairingCode = null;
    sock = null;
    
    res.json({ success: true, message: 'Restart complete. Ready for new connection.' });
});

app.post('/logout', async (req, res) => {
    const secret = req.headers['x-internal-secret'];
    if (secret !== ADMIN_SECRET) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    console.log('🚪 Logout requested - clearing session');
    if (sock) {
        try { await sock.logout(); sock.end(); } catch(e) {}
    }
    
    try {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        fs.mkdirSync(AUTH_DIR, { recursive: true });
        console.log('🗑️ Auth directory cleared');
    } catch(e) {}
    
    connectionStatus = 'idle';
    isSocketReady = false;
    currentPairingCode = null;
    sock = null;
    
    res.json({ success: true, message: 'Logged out and session cleared' });
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║         TELEAGENT WHATSAPP BRIDGE - READY               ║
╠══════════════════════════════════════════════════════════╣
║  Port: ${PORT}                                           
║  Session ID: ${SESSION_ID}                              
║  Flask Backend: ${FLASK_APP_URL || 'NOT SET'}           
║  Supabase Backup: ${USE_SUPABASE ? 'Enabled' : 'Disabled'}
╠══════════════════════════════════════════════════════════╣
║  Endpoints:                                             ║
║  GET  /         - Health check                          ║
║  POST /pair     - Request pairing code                  ║
║  GET  /status   - Connection status                     ║
║  POST /send     - Send WhatsApp message                 ║
║  POST /restart  - Restart connection                    ║
║  POST /logout   - Logout and clear session              ║
╚══════════════════════════════════════════════════════════╝
    `);
});
