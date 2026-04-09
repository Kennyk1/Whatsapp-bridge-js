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
let connectionStatus = 'idle'; // idle, connecting, pairing_pending, connected
let isSocketReady = false;
let currentPairingCode = null;
let connectionPromise = null;

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
// WHATSAPP CONNECTION (ONLY CALLED WHEN NEEDED)
// ============================================================

async function initializeSocket() {
    if (sock) {
        console.log('⚠️ Socket already exists');
        return sock;
    }
    
    console.log('🔄 Initializing WhatsApp socket...');
    connectionStatus = 'connecting';
    isSocketReady = false;
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();
        console.log(`📦 Baileys version: ${version}`);
        
        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: ['TeleAgent', 'Chrome', '1.0.0'],
            markOnlineOnConnect: false,
            syncFullHistory: false
        });
        
        // Mark socket ready after delay
        setTimeout(() => { 
            if (sock) {
                isSocketReady = true;
                console.log('✅ Socket ready for pairing');
            }
        }, 5000);
        
        sock.ev.on('creds.update', async () => {
            await saveCreds();
            console.log('🔐 Credentials saved');
        });
        
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'open') {
                connectionStatus = 'connected';
                isSocketReady = true;
                currentPairingCode = null;
                console.log('✅ WhatsApp connected!');
                notifyFlaskBackend({ type: 'connected' });
            }
            
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                connectionStatus = 'disconnected';
                isSocketReady = false;
                
                console.log(`🔌 Connection closed. Reason: ${statusCode}`);
                
                // DO NOT AUTO-RECONNECT - wait for user to request pairing again
                if (!shouldReconnect) {
                    console.log('❌ Logged out - needs new pairing');
                    sock = null;
                }
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
            else return;
            
            if (!msgText.trim()) return;
            
            const sender = message.key.remoteJid;
            const senderNumber = sender.split('@')[0];
            const senderName = message.pushName || 'Contact';
            
            console.log(`📨 WhatsApp from ${senderName}: ${msgText.substring(0, 50)}...`);
            
            await notifyFlaskBackend({
                type: 'message',
                sender_number: senderNumber,
                sender_name: senderName,
                message_text: msgText,
                timestamp: new Date().toISOString()
            });
        });
        
        global.whatsappSocket = sock;
        return sock;
        
    } catch (error) {
        console.error('❌ Fatal error:', error);
        connectionStatus = 'idle';
        sock = null;
        throw error;
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

// REQUEST PAIRING CODE - Initializes socket if needed
app.post('/pair', async (req, res) => {
    const { phone_number } = req.body;
    
    if (!phone_number) {
        return res.status(400).json({ success: false, error: 'Phone number required' });
    }
    
    const cleanNumber = phone_number.replace(/\D/g, '');
    
    try {
        // Initialize socket if not exists or disconnected
        if (!sock || connectionStatus === 'disconnected') {
            await initializeSocket();
        }
        
        // Wait for socket to be ready
        let attempts = 0;
        while (!isSocketReady && attempts < 20) {
            await new Promise(r => setTimeout(r, 1000));
            attempts++;
        }
        
        if (!isSocketReady) {
            return res.status(503).json({ 
                success: false, 
                error: 'Socket not ready. Please try again in a few seconds.' 
            });
        }
        
        // Check if already connected
        if (connectionStatus === 'connected') {
            return res.json({ 
                success: true, 
                already_connected: true,
                message: 'WhatsApp is already connected!'
            });
        }
        
        // Request pairing code
        await new Promise(r => setTimeout(r, 1000));
        const code = await sock.requestPairingCode(cleanNumber);
        currentPairingCode = code;
        connectionStatus = 'pairing_pending';
        
        console.log(`🔑 Pairing code for ${cleanNumber}: ${code}`);
        
        res.json({ 
            success: true, 
            code: code,
            expires_in: 60,
            message: 'Enter this code in WhatsApp: Settings → Linked Devices → Link a Device'
        });
        
        await notifyFlaskBackend({ type: 'pairing_code', phone: cleanNumber, code: code });
        
    } catch (error) {
        console.error('❌ Pairing error:', error.message);
        
        if (error.message.includes('Connection Closed')) {
            // Reset and retry
            sock = null;
            connectionStatus = 'idle';
            isSocketReady = false;
            return res.status(503).json({ 
                success: false, 
                error: 'Connection lost. Please try again.' 
            });
        }
        
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/status', (req, res) => {
    res.json({ 
        success: true,
        status: connectionStatus,
        connected: connectionStatus === 'connected',
        socket_ready: isSocketReady,
        has_code: currentPairingCode !== null
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
    isSocketReady = false;
    currentPairingCode = null;
    sock = null;
    
    res.json({ success: true, message: 'Logged out' });
});

// ============================================================
// START SERVER - DO NOT AUTO CONNECT
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
    
    //nice
});
