from flask import Flask, jsonify
import threading
from sms import main as run_bot
import os

app = Flask(__name__)

# Start bot in background
bot_thread = threading.Thread(target=run_bot, daemon=True)
bot_thread.start()

@app.route('/')
def status():
    return jsonify({"status": "running", "bot": "active"})

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    app.run(host='0.0.0.0', port=port)
