from flask import Flask, request, jsonify
from telegram import Update, Bot
from telegram.ext import Application, CommandHandler, CallbackQueryHandler, MessageHandler, filters
import os
import logging
import asyncio

# Import everything from sms.py
from sms import (
    start, button_handler, handle_text_message,
    ivas_login, login_done, refill_numbers_if_needed,
    poll_otps_sync, log
)

app = Flask(__name__)
BOT_TOKEN = os.environ.get("SMS_BOT_TOKEN")

# Build telegram application
telegram_app = Application.builder().token(BOT_TOKEN).build()

# Add handlers
telegram_app.add_handler(CommandHandler("start", start))
telegram_app.add_handler(CallbackQueryHandler(button_handler))
telegram_app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text_message))

# Start iVAS login and background tasks
def start_background():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    
    # Login to iVAS
    ivas_login()
    
    # Wait for login
    login_done.wait(timeout=30)
    
    if ivas_logged_in:
        # Start OTP poller (this will run forever)
        poll_otps_sync(telegram_app)

import threading
threading.Thread(target=start_background, daemon=True).start()

@app.route('/webhook', methods=['POST'])
async def webhook():
    """Handle Telegram webhook updates"""
    try:
        update = Update.de_json(request.get_json(force=True), telegram_app.bot)
        await telegram_app.process_update(update)
        return jsonify({"status": "ok"})
    except Exception as e:
        logging.error(f"Webhook error: {e}")
        return jsonify({"status": "error"}), 500

@app.route('/')
def health():
    return jsonify({"status": "running", "bot": "active"})

@app.route('/set_webhook', methods=['GET'])
def set_webhook():
    """Set webhook endpoint (run once after deployment)"""
    webhook_url = f"https://{os.environ.get('RENDER_EXTERNAL_HOSTNAME')}/webhook"
    telegram_app.bot.set_webhook(webhook_url)
    return jsonify({"status": f"Webhook set to {webhook_url}"})

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    app.run(host='0.0.0.0', port=port)
