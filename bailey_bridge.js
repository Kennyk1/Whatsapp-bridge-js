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
    if (!FLASK_APP_URL) {
        console.warn('⚠️ FLASK_APP_URL not set - cannot notify backend');
        return;
    }
    const webhookUrl = `${FLASK_APP_URL}/api/ta/whatsapp/webhook`;
    try {
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Internal-Secret': ADMIN_SECRET
            },
            body: JSON.stringify({
                session_id: SESSION_ID,
                ...event
            })
        });
        if (!response.ok) {
            console.error(`❌ Webhook failed: ${response.status}`);
        }
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
        
        // Mark socket ready after delay
        setTimeout(() => { isSocketReady = true; }, 3000);
        
        sock.ev.on('creds.update', async () => {
            await saveCreds();
            console.log('🔐 Credentials saved');
        });
        
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'open') {
                connectionStatus = 'connected';
                currentPairingCode = null;
                isSocketReady = true;
                console.log('✅ WhatsApp connected!');
                notifyFlaskBackend({ type: 'connected' });
            }
            
            // 🔥 HARDCODED PAIRING CODE TEST
            if (connection === 'connecting' && !sock.authState.creds.registered) {
                setTimeout(async () => {
                    try {
                        const code = await sock.requestPairingCode('2349131584114');
                        console.log(`\n🔑🔑🔑 PAIRING CODE: ${code} 🔑🔑🔑\n`);
                        currentPairingCode = code;
                        connectionStatus = 'pairing_pending';
                    } catch (e) {
                        console.error('❌ Pairing code failed:', e.message);
                        console.log('📱 Falling back to QR code - check /qr endpoint');
                    }
                }, 5000);
            }
            
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                connectionStatus = 'disconnected';
                isSocketReady = false;
                
                console.log(`🔌 Connection closed. Reconnect: ${shouldReconnect}`);
                
                if (shouldReconnect) {
                    setTimeout(startWhatsApp, 5000);
                }
            }
        });
        
        // Incoming messages
        sock.ev.on('messages.upsert', async (m) => {
            const message = m.messages[0];
            if (!message.message) return;
            if (message.key.fromMe) return;
            
            const msgType = Object.keys(message.message)[0];
            let msgText = '';
            
            if (msgType === 'conversation') {
                msgText = message.message.conversation;
            } else if (msgType === 'extendedTextMessage') {
                msgText = message.message.extendedTextMessage.text;
            } else if (msgType === 'imageMessage') {
                msgText = message.message.imageMessage.caption || '[Image]';
            } else if (msgType === 'videoMessage') {
                msgText = message.message.videoMessage.caption || '[Video]';
            } else if (msgType === 'audioMessage') {
                msgText = '[Voice Message]';
            } else if (msgType === 'documentMessage') {
                msgText = '[Document]';
            } else {
                return;
            }
            
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
        console.log('⏳ Retrying in 10 seconds...');
        setTimeout(startWhatsApp, 10000);
    }
}

// ============================================================
// EXPRESS API SERVER
// ============================================================
const app = express();
app.use(express.json());

// Health check
app.get('/', (req, res) => {
    res.json({
        service: 'TeleAgent WhatsApp Bridge',
        status: connectionStatus,
        connected: connectionStatus === 'connected',
        timestamp: new Date().toISOString()
    });
});

// NEW: Request pairing code with phone number
app.post('/pair', async (req, res) => {
    const { phone_number } = req.body;
    
    if (!phone_number) {
        return res.status(400).json({ success: false, error: 'Phone number required' });
    }
    
    // Clean phone number (remove +, spaces, etc)
    const cleanNumber = phone_number.replace(/\D/g, '');
    
    if (!sock) {
        return res.status(503).json({ success: false, error: 'WhatsApp not initialized yet' });
    }
    
    try {
        // Wait a moment for socket to be ready
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const code = await sock.requestPairingCode(cleanNumber);
        currentPairingCode = code;
        connectionStatus = 'pairing_pending';
        
        console.log(`🔑 Pairing code for ${cleanNumber}: ${code}`);
        
        res.json({ 
            success: true, 
            code: code,
            message: 'Enter this code in WhatsApp: Settings → Linked Devices → Link a Device'
        });
        
        // Notify Flask
        notifyFlaskBackend({ 
            type: 'pairing_code', 
            phone: cleanNumber, 
            code: code 
        });
        
    } catch (error) {
        console.error('❌ Pairing error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get status
app.get('/status', (req, res) => {
    res.json({ 
        success: true,
        status: connectionStatus,
        connected: connectionStatus === 'connected',
        pairing_code: currentPairingCode,
        last_error: lastError
    });
});

// Send message
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

// Restart
app.post('/restart', async (req, res) => {
    const secret = req.headers['x-internal-secret'];
    if (secret !== ADMIN_SECRET) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    console.log('🔄 Manual restart requested');
    if (sock) {
        try { sock.end(); } catch(e) {}
    }
    
    connectionStatus = 'disconnected';
    currentPairingCode = null;
    setTimeout(startWhatsApp, 1000);
    
    res.json({ success: true, message: 'Restarting WhatsApp connection' });
});

// Logout
app.post('/logout', async (req, res) => {
    const secret = req.headers['x-internal-secret'];
    if (secret !== ADMIN_SECRET) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    console.log('🚪 Logout requested - clearing session');
    if (sock) {
        try { 
            await sock.logout();
            sock.end();
        } catch(e) {}
    }
    
    try {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        fs.mkdirSync(AUTH_DIR, { recursive: true });
        console.log('🗑️ Auth directory cleared');
    } catch(e) {}
    
    connectionStatus = 'disconnected';
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
║  POST /pair     - Request pairing code with phone       ║
║  GET  /status   - Get connection status                 ║
║  POST /send     - Send WhatsApp message                 ║
║  POST /restart  - Restart connection                    ║
║  POST /logout   - Logout and clear session              ║
╚══════════════════════════════════════════════════════════╝
    `);
    
    startWhatsApp();
});
