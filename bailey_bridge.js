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
const FLASK_APP_URL = process.env.FLASK_APP_URL; // Required: Your Flask app URL
const USE_SUPABASE = process.env.SUPABASE_URL && process.env.SUPABASE_KEY;

// Optional Supabase for session backup
let supabase = null;
if (USE_SUPABASE) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    console.log('✅ Supabase configured for session backup');
}

// ============================================================
// AUTH STATE STORAGE (Local filesystem)
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
let connectionStatus = 'disconnected'; // 'disconnected', 'connecting', 'qr_pending', 'connected'
let currentQR = null;
let lastError = null;

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Save session to Supabase (optional backup)
 */
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

/**
 * Notify Flask backend about events (messages, status changes)
 */
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
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();
        console.log(`📦 Baileys version: ${version}`);
        
        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: true,
            browser: ['TeleAgent', 'Chrome', '1.0.0'],
            markOnlineOnConnect: true,
            syncFullHistory: false
        });
        
        // ========== CREDENTIALS UPDATE ==========
        sock.ev.on('creds.update', async () => {
            await saveCreds();
            console.log('🔐 Credentials updated and saved');
            
            // Backup to Supabase if configured
            if (supabase) {
                try {
                    const files = fs.readdirSync(AUTH_DIR);
                    const sessionData = {};
                    files.forEach(f => {
                        const content = fs.readFileSync(path.join(AUTH_DIR, f), 'utf8');
                        sessionData[f] = content;
                    });
                    await backupSessionToSupabase(sessionData);
                } catch (e) {
                    console.error('❌ Failed to read session files:', e.message);
                }
            }
        });
        
        // ========== CONNECTION UPDATES ==========
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                currentQR = qr;
                connectionStatus = 'qr_pending';
                console.log('\n📱 ========== SCAN QR CODE ==========');
                console.log('QR Code received - scan with WhatsApp!');
                notifyFlaskBackend({ type: 'qr_ready', qr: qr });
            }
            
            if (connection === 'open') {
                connectionStatus = 'connected';
                currentQR = null;
                lastError = null;
                console.log('✅ WhatsApp connected successfully!');
                notifyFlaskBackend({ type: 'connected' });
            }
            
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                connectionStatus = 'disconnected';
                lastError = lastDisconnect?.error?.message || 'Connection closed';
                
                console.log(`🔌 Connection closed. Reason: ${statusCode}`);
                console.log(`🔄 Will reconnect: ${shouldReconnect}`);
                
                notifyFlaskBackend({ 
                    type: 'disconnected', 
                    reason: statusCode,
                    reconnect: shouldReconnect 
                });
                
                if (shouldReconnect) {
                    console.log('⏳ Reconnecting in 5 seconds...');
                    setTimeout(startWhatsApp, 5000);
                } else {
                    console.log('❌ Logged out - manual QR scan required');
                }
            }
        });
        
        // ========== INCOMING MESSAGES ==========
        sock.ev.on('messages.upsert', async (m) => {
            const message = m.messages[0];
            
            // Ignore if no message content or it's our own message
            if (!message.message) return;
            if (message.key.fromMe) return;
            
            // Extract message text
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
                return; // Ignore other message types
            }
            
            if (!msgText.trim()) return;
            
            const sender = message.key.remoteJid;
            const senderNumber = sender.split('@')[0];
            const senderName = message.pushName || 'Contact';
            const isGroup = sender.endsWith('@g.us');
            
            console.log(`📨 [${isGroup ? 'GROUP' : 'DM'}] ${senderName}: ${msgText.substring(0, 50)}...`);
            
            // Forward to Flask backend
            await notifyFlaskBackend({
                type: 'message',
                sender_number: senderNumber,
                sender_name: senderName,
                message_text: msgText,
                is_group: isGroup,
                timestamp: new Date().toISOString()
            });
        });
        
        // Store socket globally
        global.whatsappSocket = sock;
        
    } catch (error) {
        console.error('❌ Fatal error starting WhatsApp:', error);
        connectionStatus = 'error';
        lastError = error.message;
        
        // Retry after delay
        console.log('⏳ Retrying in 10 seconds...');
        setTimeout(startWhatsApp, 10000);
    }
}

// ============================================================
// EXPRESS API SERVER
// ============================================================
const app = express();
app.use(express.json());

// Health check endpoint (required for Render)
app.get('/', (req, res) => {
    res.json({
        service: 'TeleAgent WhatsApp Bridge',
        status: connectionStatus,
        connected: connectionStatus === 'connected',
        timestamp: new Date().toISOString()
    });
});

// Get QR code for scanning
app.get('/qr', (req, res) => {
    if (currentQR) {
        res.json({ 
            success: true, 
            qr: currentQR,
            status: 'qr_pending'
        });
    } else if (connectionStatus === 'connected') {
        res.json({ 
            success: true, 
            connected: true,
            status: 'connected'
        });
    } else {
        res.json({ 
            success: false, 
            status: connectionStatus,
            message: 'No QR available. Status: ' + connectionStatus
        });
    }
});

// Get connection status
app.get('/status', (req, res) => {
    res.json({ 
        success: true,
        status: connectionStatus,
        connected: connectionStatus === 'connected',
        has_qr: currentQR !== null,
        last_error: lastError
    });
});

// Send a message (called by Flask backend)
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

// Restart connection (admin only)
app.post('/restart', async (req, res) => {
    const secret = req.headers['x-internal-secret'];
    
    if (secret !== ADMIN_SECRET) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    console.log('🔄 Manual restart requested');
    
    if (sock) {
        try { 
            sock.end(); 
        } catch(e) {
            console.error('Error ending socket:', e.message);
        }
    }
    
    connectionStatus = 'disconnected';
    currentQR = null;
    
    // Start fresh connection
    setTimeout(startWhatsApp, 1000);
    
    res.json({ success: true, message: 'Restarting WhatsApp connection' });
});

// Logout (clear session)
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
        } catch(e) {
            console.error('Error during logout:', e.message);
        }
    }
    
    // Clear auth directory
    try {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        fs.mkdirSync(AUTH_DIR, { recursive: true });
        console.log('🗑️ Auth directory cleared');
    } catch(e) {
        console.error('Error clearing auth dir:', e.message);
    }
    
    connectionStatus = 'disconnected';
    currentQR = null;
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
║  GET  /qr       - Get QR code for scanning              ║
║  GET  /status   - Get connection status                 ║
║  POST /send     - Send WhatsApp message                 ║
║  POST /restart  - Restart connection                    ║
║  POST /logout   - Logout and clear session              ║
╚══════════════════════════════════════════════════════════╝
    `);
    
    // Start WhatsApp connection
    startWhatsApp();
});
