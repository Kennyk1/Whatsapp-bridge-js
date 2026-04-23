from flask import Flask, jsonify
import threading
from sms import main as run_bot

app = Flask(__name__)

# Start bot in background
bot_thread = threading.Thread(target=run_bot, daemon=True)
bot_thread.start()

@app.route('/')
def status():
    return jsonify({
        "status": "running",
        "bot": "active",
        "message": "SMS bot is working"
    })

@app.route('/health')
def health():
    return jsonify({"status": "healthy"})

if __name__ == "__main__":
    app.run(host='0.0.0.0', port=8080)
