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
let currentPairingCode = null;

// ============================================================
// HELPER FUNCTIONS
// ============================================================

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
        timestamp: new Date().toISOString()
    });
});

// FIXED /pair endpoint - follows working pattern
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

        sock.ev.on('creds.update', saveCreds);

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

                    // Send response back to client
                    return res.json({
                        success: true,
                        code: code,
                        expires_in: 60,
                        message: 'Enter this code in WhatsApp: Settings → Linked Devices → Link a Device'
                    });

                } catch (err) {
                    console.error('❌ Pairing error:', err.message);
                    
                    // Clean up on error
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
                currentPairingCode = null;
                console.log('✅ WhatsApp connected!');
                notifyFlaskBackend({ type: 'connected' });
            }

            if (connection === 'close') {
                console.log('🔌 Connection closed');
                connectionStatus = 'disconnected';
                sock = null;
            }
        });

        // Incoming messages
        sock.ev.on('messages.upsert', async (m) => {
            const message = m.messages[0];
            if (!message.message || message.key.fromMe) return;

            const msgText = message.message.conversation || 
                           message.message.extendedTextMessage?.text || '';
            if (!msgText.trim()) return;

            const sender = message.key.remoteJid;
            const senderNumber = sender.split('@')[0];
            const senderName = message.pushName || 'Contact';

            console.log(`📨 WhatsApp from ${senderName}: ${msgText.substring(0, 50)}`);

            await notifyFlaskBackend({
                type: 'message',
                sender_number: senderNumber,
                sender_name: senderName,
                message_text: msgText,
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
        connected: connectionStatus === 'connected'
    });
});

app.post('/send', async (req, res) => {
    const secret = req.headers['x-internal-secret'];
    if (secret !== ADMIN_SECRET) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    const { to_number, text } = req.body;
    if (!to_number || !text) {
        return res.status(400).json({ success: false, error: 'Missing fields' });
    }
    
    if (!sock || connectionStatus !== 'connected') {
        return res.status(503).json({ success: false, error: 'WhatsApp not connected' });
    }
    
    try {
        const jid = `${to_number}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/logout', async (req, res) => {
    const secret = req.headers['x-internal-secret'];
    if (secret !== ADMIN_SECRET) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    console.log('🚪 Logout requested');
    if (sock) {
        try { await sock.logout(); sock.end(); } catch(e) {}
    }
    
    try {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        fs.mkdirSync(AUTH_DIR, { recursive: true });
    } catch(e) {}
    
    connectionStatus = 'idle';
    currentPairingCode = null;
    sock = null;
    
    res.json({ success: true, message: 'Logged out' });
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
║  Status: IDLE (waiting for /pair request)               
║  Flask Backend: ${FLASK_APP_URL || 'NOT SET'}           
╠══════════════════════════════════════════════════════════╣
║  Endpoints:                                             ║
║  POST /pair     - Request pairing code                  ║
║  GET  /status   - Connection status                     ║
║  POST /send     - Send WhatsApp message                 ║
║  POST /logout   - Logout                                ║
╚══════════════════════════════════════════════════════════╝
    `);
});
