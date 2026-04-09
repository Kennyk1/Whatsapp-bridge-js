// bailey_bridge.js - WhatsApp Bridge Service for TeleAgent
// Deployed on Render as a standalone Node.js Web Service

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
let connectionStatus = 'disconnected';
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
// WHATSAPP CONNECTION
// ============================================================

async function startWhatsApp() {
    console.log('🔄 Starting WhatsApp connection...');
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
            markOnlineOnConnect: true,
            syncFullHistory: false
        });
        
        // Mark socket ready after a delay
        setTimeout(() => { 
            if (sock) {
                isSocketReady = true;
                console.log('✅ Socket marked ready');
            }
        }, 5000);
        
        sock.ev.on('creds.update', async () => {
            await saveCreds();
            console.log('🔐 Credentials saved');
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
        
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'open') {
                connectionStatus = 'connected';
                isSocketReady = true;
                currentPairingCode = null;
                lastError = null;
                console.log('✅ WhatsApp connected successfully!');
                notifyFlaskBackend({ type: 'connected' });
            }
            
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                connectionStatus = 'disconnected';
                isSocketReady = false;
                lastError = lastDisconnect?.error?.message || 'Connection closed';
                
                console.log(`🔌 Connection closed. Reason: ${statusCode}`);
                
                if (shouldReconnect) {
                    console.log('⏳ Reconnecting in 5 seconds...');
                    setTimeout(startWhatsApp, 5000);
                } else {
                    console.log('❌ Logged out - needs new pairing');
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
            else if (msgType === 'audioMessage') msgText = '[Voice Message]';
            else if (msgType === 'documentMessage') msgText = '[Document]';
            else return;
            
            if (!msgText.trim()) return;
            
            const sender = message.key.remoteJid;
            const senderNumber = sender.split('@')[0];
            const senderName = message.pushName || 'Contact';
            const isGroup = sender.endsWith('@g.us');
            
            console.log(`📨 [${isGroup ? 'GROUP' : 'DM'}] ${senderName}: ${msgText.substring(0, 50)}...`);
            
            await notifyFlaskBackend({
                type: 'message',
                sender_number: senderNumber,
                sender_name: senderName,
                message_text: msgText,
                is_group: isGroup,
                timestamp: new Date().toISOString()
            });
        });
        
        global.whatsappSocket = sock;
        
    } catch (error) {
        console.error('❌ Fatal error starting WhatsApp:', error);
        connectionStatus = 'error';
        lastError = error.message;
        setTimeout(startWhatsApp, 10000);
    }
}

// ============================================================
// EXPRESS API SERVER
// ============================================================
const app = express();
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

// FIXED: Request pairing code
app.post('/pair', async (req, res) => {
    const { phone_number } = req.body;
    
    if (!phone_number) {
        return res.status(400).json({ success: false, error: 'Phone number required' });
    }
    
    const cleanNumber = phone_number.replace(/\D/g, '');
    
    if (!sock) {
        return res.status(503).json({ success: false, error: 'WhatsApp not initialized. Try again in a few seconds.' });
    }
    
    // Wait for socket to be ready (max 15 seconds)
    let attempts = 0;
    while (!isSocketReady && attempts < 15) {
        await new Promise(r => setTimeout(r, 1000));
        attempts++;
    }
    
    if (!isSocketReady) {
        return res.status(503).json({ success: false, error: 'Socket not ready. Please try again in 10 seconds.' });
    }
    
    try {
        // Small additional delay for stability
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
        
        if (error.message.includes('timeout') || error.message.includes('408')) {
            return res.status(400).json({ 
                success: false, 
                error: 'Pairing request timed out. Please try again.',
                fallback: 'qr'
            });
        }
        
        if (error.message.includes('already connected')) {
            return res.status(400).json({ 
                success: false, 
                error: 'Already connected. Use /logout first to reconnect.' 
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
        return res.status(400).json({ success: false, error: 'Missing to_number or text' });
    }
    
    if (!sock || connectionStatus !== 'connected') {
        return res.status(503).json({ success: false, error: 'WhatsApp not connected' });
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
    
    connectionStatus = 'disconnected';
    isSocketReady = false;
    currentPairingCode = null;
    sock = null;
    
    setTimeout(startWhatsApp, 1000);
    res.json({ success: true, message: 'Logged out. Restarting...' });
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
╠══════════════════════════════════════════════════════════╣
║  Endpoints:                                             ║
║  GET  /         - Health check                          ║
║  POST /pair     - Request pairing code                  ║
║  GET  /status   - Connection status                     ║
║  POST /send     - Send WhatsApp message                 ║
║  POST /logout   - Logout and clear session              ║
╚══════════════════════════════════════════════════════════╝
    `);
    
    startWhatsApp();
});
