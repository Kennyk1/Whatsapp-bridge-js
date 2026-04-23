import os
import re
import json
import time
import asyncio
import logging
import threading
from datetime import datetime, date

import requests as req
from supabase import create_client
from telegram import (
    Update, InlineKeyboardButton, InlineKeyboardMarkup,
    InputMediaPhoto
)
from telegram.ext import (
    Application, CommandHandler, CallbackQueryHandler,
    MessageHandler, filters, ContextTypes
)
from telegram.constants import ParseMode

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO
)
log = logging.getLogger("sms_bot")

# ── Env ───────────────────────────────────────────────────────────────────────
SUPABASE_URL  = os.environ.get("SUPABASE_URL")
SUPABASE_KEY  = os.environ.get("SUPABASE_KEY")
BOT_TOKEN     = os.environ.get("SMS_BOT_TOKEN", "8678832619:AAEfj-aARTsfdYisISoXXjTHcFXVKX4mlv4")

IVASMS_EMAIL    = os.environ.get("IVASMS_EMAIL", "kennyfavour11@gmail.com")
IVASMS_PASSWORD = os.environ.get("IVASMS_PASSWORD", "@Favour11")
CAPMONSTER_KEY  = os.environ.get("CAPMONSTER_KEY", "451ba43cc3b959f24e7f5b01d4add0f9")
IVASMS_WEBSITE_KEY = "0x4AAAAAACqVmW6ncA-jc10z"
IVASMS_LOGIN_URL   = "https://www.ivasms.com/login"

WELCOME_IMAGE = "https://i.ibb.co/20XR6NvT/1776950186215.png"
NUMBERS_PER_PAGE = 10
POLL_INTERVAL    = 30  # seconds between OTP polls

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# ── iVAS Session ──────────────────────────────────────────────────────────────
ivas_session   = req.Session()
ivas_logged_in = False
login_done = threading.Event()  # Track when login completes

def solve_turnstile():
    """Solve Cloudflare Turnstile via CapMonster."""
    try:
        task = req.post("https://api.capmonster.cloud/createTask", json={
            "clientKey": CAPMONSTER_KEY,
            "task": {
                "type": "TurnstileTaskProxyless",
                "websiteURL": IVASMS_LOGIN_URL,
                "websiteKey": IVASMS_WEBSITE_KEY
            }
        }, timeout=30).json()

        task_id = task.get("taskId")
        if not task_id:
            log.error(f"CapMonster error: {task}")
            return None

        for _ in range(20):
            time.sleep(4)
            result = req.post("https://api.capmonster.cloud/getTaskResult", json={
                "clientKey": CAPMONSTER_KEY,
                "taskId": task_id
            }, timeout=15).json()
            if result.get("status") == "ready":
                return result["solution"]["token"]

        log.error("Turnstile solve timeout")
        return None
    except Exception as e:
        log.error(f"solve_turnstile error: {e}")
        return None

def ivas_login():
    """Login to iVAS SMS portal."""
    global ivas_session, ivas_logged_in
    try:
        ivas_session = req.Session()
        resp = ivas_session.get(IVASMS_LOGIN_URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=15)
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(resp.text, "html.parser")
        csrf = soup.find("input", {"name": "_token"})["value"]

        token = solve_turnstile()
        if not token:
            login_done.set()
            return False

        login = ivas_session.post(IVASMS_LOGIN_URL, data={
            "_token": csrf,
            "email": IVASMS_EMAIL,
            "password": IVASMS_PASSWORD,
            "cf-turnstile-response": token,
            "submit": "register"
        }, headers={"Referer": IVASMS_LOGIN_URL, "User-Agent": "Mozilla/5.0"}, allow_redirects=True, timeout=15)

        if "login" not in login.url:
            ivas_logged_in = True
            log.info("✅ iVAS login successful")
            login_done.set()
            return True

        log.error("iVAS login failed")
        login_done.set()
        return False
    except Exception as e:
        log.error(f"ivas_login error: {e}")
        login_done.set()
        return False

def ensure_logged_in():
    """Ensure iVAS session is active, re-login if needed."""
    global ivas_logged_in
    if not ivas_logged_in:
        return ivas_login()
    try:
        r = ivas_session.get("https://www.ivasms.com/portal/numbers", timeout=10)
        if "login" in r.url:
            ivas_logged_in = False
            return ivas_login()
        return True
    except:
        ivas_logged_in = False
        return ivas_login()

# ── iVAS API calls ────────────────────────────────────────────────────────────

def fetch_my_numbers_from_ivas():
    """Fetch numbers already in 'My Numbers' from iVAS (not test pool)."""
    if not ensure_logged_in():
        return []
    try:
        r = ivas_session.get("https://www.ivasms.com/portal/numbers/my-numbers",
                            headers={"User-Agent": "Mozilla/5.0"}, timeout=15)
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(r.text, "html.parser")
        
        numbers = []
        # Look for table with numbers
        rows = soup.find_all("tr")
        for row in rows:
            cells = row.find_all("td")
            if len(cells) >= 1:
                text = row.get_text()
                # Extract phone numbers (234 format)
                phones = re.findall(r'234\d{10}', text)
                for phone in phones:
                    numbers.append({"phone_number": phone, "id": phone})
        return numbers
    except Exception as e:
        log.error(f"fetch_my_numbers error: {e}")
        return []

def fetch_nigeria_numbers(page=0, search="NIGERIA"):
    """Fetch Nigeria numbers from test pool."""
    if not ensure_logged_in():
        return []
    try:
        r = ivas_session.get(
            "https://www.ivasms.com/portal/numbers/test",
            params={
                "draw": str(page + 1),
                "columns[0][data]": "range",
                "columns[0][name]": "terminations.range",
                "columns[1][data]": "test_number",
                "columns[1][name]": "terminations.test_number",
                "columns[2][data]": "term",
                "columns[3][data]": "A2P",
                "columns[4][data]": "Limit_Range",
                "columns[5][data]": "limit_did_a2p",
                "columns[6][data]": "limit_cli_did_a2p",
                "columns[7][data]": "created_at",
                "columns[7][name]": "terminations.created_at",
                "columns[8][data]": "action",
                "order[0][column]": "8",
                "order[0][dir]": "desc",
                "start": str(page * 50),
                "length": "50",
                "search[value]": search,
                "_": str(int(time.time() * 1000))
            },
            headers={
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "X-Requested-With": "XMLHttpRequest",
                "Referer": "https://www.ivasms.com/portal/numbers/test"
            },
            timeout=15
        )
        data = r.json()
        return data.get("data", [])
    except Exception as e:
        log.error(f"fetch_nigeria_numbers error: {e}")
        return []

def delete_number_from_ivas(termination_id):
    """Delete a number from 'My Numbers' on iVAS."""
    if not ensure_logged_in():
        return False
    try:
        page = ivas_session.get("https://www.ivasms.com/portal/numbers/my-numbers",
                                headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(page.text, "html.parser")
        csrf_input = soup.find("input", {"name": "_token"})
        csrf = csrf_input["value"] if csrf_input else ""

        r = ivas_session.post(
            "https://www.ivasms.com/portal/numbers/termination/number/delete",
            data={"_token": csrf, "id": str(termination_id)},
            headers={
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "X-Requested-With": "XMLHttpRequest",
                "Referer": "https://www.ivasms.com/portal/numbers/my-numbers",
                "Origin": "https://www.ivasms.com"
            },
            timeout=15
        )
        return True
    except Exception as e:
        log.error(f"delete_number error: {e}")
        return False

def add_number_to_my_numbers(termination_id):
    """Add a number from test pool to My Numbers."""
    if not ensure_logged_in():
        return False
    try:
        page = ivas_session.get("https://www.ivasms.com/portal/numbers/test",
                                headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(page.text, "html.parser")
        csrf_input = soup.find("input", {"name": "_token"})
        csrf = csrf_input["value"] if csrf_input else ""

        r = ivas_session.post(
            "https://www.ivasms.com/portal/numbers/termination/number/add",
            data={"_token": csrf, "id": str(termination_id)},
            headers={
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "X-Requested-With": "XMLHttpRequest",
                "Referer": "https://www.ivasms.com/portal/numbers/test",
                "Origin": "https://www.ivasms.com"
            },
            timeout=15
        )
        if r.text and r.text.strip():
            try:
                result = r.json()
                return "done" in result.get("message", "").lower()
            except:
                return False
        return False
    except Exception as e:
        log.error(f"add_number error: {e}")
        return False

def fetch_otps_today():
    """Fetch OTPs received today from iVAS."""
    if not ensure_logged_in():
        return ""
    try:
        today = date.today().isoformat()

        page = ivas_session.get("https://www.ivasms.com/portal/sms/received",
                                headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(page.text, "html.parser")
        csrf_input = soup.find("input", {"name": "_token"})
        csrf = csrf_input["value"] if csrf_input else ""

        r = ivas_session.post(
            "https://www.ivasms.com/portal/sms/received/getsms",
            data={"from": today, "to": today, "_token": csrf},
            headers={
                "Accept": "text/html, */*; q=0.01",
                "X-Requested-With": "XMLHttpRequest",
                "Referer": "https://www.ivasms.com/portal/sms/received",
                "Origin": "https://www.ivasms.com"
            },
            timeout=15
        )
        return r.text
    except Exception as e:
        log.error(f"fetch_otps error: {e}")
        return ""

def parse_otps_from_html(html):
    """Parse OTP messages from iVAS HTML response."""
    otps = []
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, "html.parser")

        rows = soup.find_all("tr")
        for row in rows:
            cells = row.find_all("td")
            if len(cells) >= 3:
                number = cells[0].get_text(strip=True) if cells[0] else ""
                message = cells[1].get_text(strip=True) if cells[1] else ""
                timestamp = cells[2].get_text(strip=True) if cells[2] else ""
                if number.startswith("234") or number.startswith("+234"):
                    otps.append({
                        "number": number.replace("+", "").strip(),
                        "message": message,
                        "timestamp": timestamp
                    })

        if not otps:
            sms_items = soup.find_all(class_=re.compile(r"sms|message|received", re.I))
            for item in sms_items:
                text = item.get_text(strip=True)
                nums = re.findall(r'234\d{10,11}', text)
                for n in nums:
                    otps.append({"number": n, "message": text, "timestamp": ""})

    except Exception as e:
        log.error(f"parse_otps error: {e}")
    return otps

# ── Supabase DB helpers ───────────────────────────────────────────────────────

def db_upsert_user(user_id, username, first_name):
    try:
        supabase.table("sms_users").upsert({
            "user_id": user_id,
            "username": username or "",
            "first_name": first_name or "",
            "last_active": datetime.utcnow().isoformat()
        }, on_conflict="user_id").execute()
    except Exception as e:
        log.error(f"db_upsert_user: {e}")

def db_get_available_numbers(page=0):
    try:
        offset = page * NUMBERS_PER_PAGE
        r = (supabase.table("sms_numbers")
             .select("*")
             .eq("is_used", False)
             .is_("assigned_to", "null")
             .order("created_at", desc=False)
             .range(offset, offset + NUMBERS_PER_PAGE - 1)
             .execute())
        return r.data or []
    except Exception as e:
        log.error(f"db_get_available_numbers: {e}")
        return []

def db_get_numbers_count():
    try:
        r = (supabase.table("sms_numbers")
             .select("id", count="exact")
             .eq("is_used", False)
             .is_("assigned_to", "null")
             .execute())
        return r.count or 0
    except:
        return 0

def db_assign_number(number_id, user_id):
    try:
        supabase.table("sms_numbers").update({
            "assigned_to": user_id,
            "assigned_at": datetime.utcnow().isoformat()
        }).eq("id", number_id).execute()
    except Exception as e:
        log.error(f"db_assign_number: {e}")

def db_get_user_numbers(user_id):
    try:
        r = (supabase.table("sms_numbers")
             .select("*")
             .eq("assigned_to", user_id)
             .eq("otp_delivered", False)
             .execute())
        return r.data or []
    except Exception as e:
        log.error(f"db_get_user_numbers: {e}")
        return []

def db_mark_otp_delivered(number_id, otp_text, user_id):
    try:
        supabase.table("sms_numbers").update({
            "is_used": True,
            "used_at": datetime.utcnow().isoformat(),
            "otp_delivered": True,
            "otp_text": otp_text,
            "assigned_to": None
        }).eq("id", number_id).execute()

        supabase.table("sms_otps").insert({
            "phone_number": None,
            "message": otp_text,
            "received_at": datetime.utcnow().isoformat(),
            "delivered_to": user_id,
            "delivered_at": datetime.utcnow().isoformat()
        }).execute()
    except Exception as e:
        log.error(f"db_mark_otp_delivered: {e}")

def db_number_exists(phone_number):
    try:
        r = (supabase.table("sms_numbers")
             .select("id")
             .eq("phone_number", phone_number)
             .execute())
        return len(r.data) > 0
    except:
        return False

def db_add_number(termination_id, phone_number, range_name):
    try:
        if not db_number_exists(phone_number):
            supabase.table("sms_numbers").insert({
                "termination_id": str(termination_id),
                "phone_number": str(phone_number),
                "range_name": range_name,
                "is_used": False,
                "otp_delivered": False
            }).execute()
            return True
        return False
    except Exception as e:
        log.error(f"db_add_number: {e}")
        return False

def db_get_number_by_phone(phone_number):
    try:
        phone = phone_number.replace("+", "").replace(" ", "").strip()
        r = (supabase.table("sms_numbers")
             .select("*")
             .eq("phone_number", phone)
             .execute())
        return r.data[0] if r.data else None
    except Exception as e:
        log.error(f"db_get_number_by_phone: {e}")
        return None

def db_delete_all_numbers():
    """Delete all numbers from database (for refresh cycle)."""
    try:
        supabase.table("sms_numbers").delete().neq("id", 0).execute()
        log.info("All numbers deleted from database")
    except Exception as e:
        log.error(f"db_delete_all_numbers: {e}")

# ── Smart Refill Numbers ───────────────────────────────────────────────────────

def refill_numbers_if_needed():
    """Smart refill: Check if numbers are running low, if yes, delete old and add new batch."""
    try:
        # Wait for login to complete
        login_done.wait(timeout=30)
        
        if not ivas_logged_in:
            log.error("Cannot refill - not logged in")
            return
            
        count = db_get_numbers_count()
        log.info(f"Number pool: {count} available")
        
        # If less than 100 numbers available, refresh entire pool
        if count < 100:
            log.info("Numbers running low. Refreshing entire pool...")
            
            # Delete all existing numbers from DB
            db_delete_all_numbers()
            
            # Fetch new batch from iVAS test pool
            numbers = fetch_nigeria_numbers(page=0)
            added = 0
            
            for n in numbers[:1000]:  # Get up to 1000 numbers
                phone = str(n.get("test_number", ""))
                term_id = n.get("id")
                range_name = n.get("range", "")
                if not phone or not term_id:
                    continue
                
                # Add to database without calling iVAS add API
                if db_add_number(term_id, phone, range_name):
                    added += 1
                time.sleep(0.1)  # Small delay to avoid rate limiting
            
            log.info(f"Added {added} fresh numbers to database")
            
    except Exception as e:
        log.error(f"refill_numbers_if_needed: {e}")

# ── OTP Poller ────────────────────────────────────────────────────────────────

delivered_otps = set()

async def notify_user_otp(app, user_id, phone_number, message):
    """Send OTP to user via Telegram."""
    try:
        otp_codes = re.findall(r'\b\d{4,8}\b', message)
        otp_display = " | ".join(otp_codes) if otp_codes else "See full message"

        text = (
            f"🎉 *OTP Received!*\n\n"
            f"📱 *Number:* `{phone_number}`\n"
            f"🔑 *OTP Code:* `{otp_display}`\n\n"
            f"📨 *Full Message:*\n"
            f"_{message}_\n\n"
            f"⏰ *Time:* {datetime.utcnow().strftime('%H:%M:%S UTC')}"
        )

        keyboard = InlineKeyboardMarkup([[
            InlineKeyboardButton("🔢 Get New Numbers", callback_data="get_numbers_0"),
            InlineKeyboardButton("📋 My Numbers", callback_data="my_numbers")
        ]])

        await app.bot.send_message(
            chat_id=user_id,
            text=text,
            parse_mode=ParseMode.MARKDOWN,
            reply_markup=keyboard
        )
    except Exception as e:
        log.error(f"notify_user_otp error: {e}")

def poll_otps_sync(app):
    """Background thread that polls iVAS for new OTPs."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    while True:
        try:
            html = fetch_otps_today()
            if html and "sms-empty" not in html:
                otps = parse_otps_from_html(html)
                for otp in otps:
                    phone = otp["number"]
                    message = otp["message"]
                    otp_key = f"{phone}:{message[:30]}"

                    if otp_key in delivered_otps:
                        continue

                    row = db_get_number_by_phone(phone)
                    if row and row.get("assigned_to") and not row.get("otp_delivered"):
                        user_id = row["assigned_to"]
                        delivered_otps.add(otp_key)
                        db_mark_otp_delivered(row["id"], message, user_id)
                        loop.run_until_complete(notify_user_otp(app, user_id, phone, message))
                        log.info(f"OTP delivered to user {user_id} for {phone}")

        except Exception as e:
            log.error(f"poll_otps_sync error: {e}")

        time.sleep(POLL_INTERVAL)

# ── Keyboards (same as before) ────────────────────────────────────────────────

def main_menu_keyboard():
    return InlineKeyboardMarkup([
        [
            InlineKeyboardButton("📱 Get Numbers", callback_data="get_numbers_0"),
            InlineKeyboardButton("📋 My Numbers", callback_data="my_numbers")
        ],
        [
            InlineKeyboardButton("🔍 Check OTP", callback_data="check_otp"),
            InlineKeyboardButton("ℹ️ How It Works", callback_data="how_it_works")
        ]
    ])

def numbers_keyboard(numbers, page, total_available):
    rows = []
    for i, num in enumerate(numbers):
        phone = num["phone_number"]
        display = f"📞 +{phone}"
        rows.append([InlineKeyboardButton(display, callback_data=f"assign_{num['id']}")])

    nav = []
    if page > 0:
        nav.append(InlineKeyboardButton("⬅️ Prev", callback_data=f"get_numbers_{page-1}"))
    nav.append(InlineKeyboardButton(f"📊 {total_available} available", callback_data="noop"))
    if len(numbers) == NUMBERS_PER_PAGE:
        nav.append(InlineKeyboardButton("Next ➡️", callback_data=f"get_numbers_{page+1}"))
    rows.append(nav)

    rows.append([
        InlineKeyboardButton("📋 My Numbers", callback_data="my_numbers"),
        InlineKeyboardButton("🏠 Menu", callback_data="main_menu")
    ])

    return InlineKeyboardMarkup(rows)

def my_numbers_keyboard(numbers):
    rows = []
    for num in numbers:
        phone = num["phone_number"]
        rows.append([InlineKeyboardButton(f"🔍 Check OTP → +{phone}", callback_data=f"check_single_{phone}")])

    rows.append([
        InlineKeyboardButton("🔄 Refresh", callback_data="my_numbers"),
        InlineKeyboardButton("🏠 Menu", callback_data="main_menu")
    ])
    return InlineKeyboardMarkup(rows)

# ── Handlers ──────────────────────────────────────────────────────────────────

async def start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    db_upsert_user(user.id, user.username, user.first_name)

    caption = (
        f"👋 *Welcome, {user.first_name}!*\n\n"
        f"🇳🇬 *Nigeria OTP Bot* — Your premium SMS number service\n\n"
        f"*What I do:*\n"
        f"• 📱 Give you real Nigerian phone numbers\n"
        f"• 🔑 Automatically deliver OTPs when they arrive\n"
        f"• ⚡ Real-time monitoring — no manual refresh needed\n"
        f"• 🔄 Fresh numbers always available\n\n"
        f"*How to use:*\n"
        f"1️⃣ Tap *Get Numbers* to see available numbers\n"
        f"2️⃣ Tap any number to assign it to yourself\n"
        f"3️⃣ Use the number wherever you need OTP\n"
        f"4️⃣ OTP auto-delivers here when it arrives ✅\n\n"
        f"👇 *Choose an option to get started:*"
    )

    try:
        await update.message.reply_photo(
            photo=WELCOME_IMAGE,
            caption=caption,
            parse_mode=ParseMode.MARKDOWN,
            reply_markup=main_menu_keyboard()
        )
    except Exception:
        await update.message.reply_text(
            caption,
            parse_mode=ParseMode.MARKDOWN,
            reply_markup=main_menu_keyboard()
        )

async def handle_text_message(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    text = update.message.text.strip()

    phone_clean = re.sub(r'[\s\+\-\(\)]', '', text)

    if re.match(r'^(234|0)\d{10}$', phone_clean):
        if phone_clean.startswith("0"):
            phone_clean = "234" + phone_clean[1:]

        await update.message.chat.send_action("typing")

        row = db_get_number_by_phone(phone_clean)
        if not row:
            await update.message.reply_text(
                f"❌ *Number not found in our system*\n\n"
                f"`+{phone_clean}`\n\n"
                f"This number isn't in our pool. Use *Get Numbers* to get available numbers.",
                parse_mode=ParseMode.MARKDOWN,
                reply_markup=main_menu_keyboard()
            )
            return

        if row.get("otp_delivered") and row.get("otp_text"):
            await update.message.reply_text(
                f"✅ *OTP already received for this number*\n\n"
                f"📱 `+{phone_clean}`\n"
                f"📨 _{row['otp_text']}_",
                parse_mode=ParseMode.MARKDOWN,
                reply_markup=main_menu_keyboard()
            )
            return

        db_assign_number(row["id"], user.id)

        await update.message.reply_text(
            f"👀 *Watching for OTP*\n\n"
            f"📱 Number: `+{phone_clean}`\n\n"
            f"⏳ I'll notify you the moment an OTP arrives on this number!\n"
            f"🔄 Polling every {POLL_INTERVAL} seconds...",
            parse_mode=ParseMode.MARKDOWN,
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton("🔍 Check Now", callback_data=f"check_single_{phone_clean}"),
                InlineKeyboardButton("📋 My Numbers", callback_data="my_numbers")
            ]])
        )
    else:
        await update.message.reply_text(
            "👋 Use the menu below to get started!\n\n"
            "_Tip: You can also send me a Nigerian phone number directly to check its OTP._",
            parse_mode=ParseMode.MARKDOWN,
            reply_markup=main_menu_keyboard()
        )

async def button_handler(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user = update.effective_user
    data = query.data

    if data == "main_menu":
        caption = f"🏠 *Main Menu*\n\nWelcome back, {user.first_name}! Choose an option:"
        try:
            await query.edit_message_caption(caption=caption, parse_mode=ParseMode.MARKDOWN, reply_markup=main_menu_keyboard())
        except:
            await query.edit_message_text(caption, parse_mode=ParseMode.MARKDOWN, reply_markup=main_menu_keyboard())

    elif data.startswith("get_numbers_"):
        page = int(data.split("_")[-1])
        numbers = db_get_available_numbers(page=page)
        total = db_get_numbers_count()

        if not numbers:
            if page == 0:
                msg_text = "⏳ *Loading numbers...*\n\nFetching fresh Nigeria numbers from our pool.\nPlease wait a moment!"
                try:
                    await query.edit_message_caption(caption=msg_text, parse_mode=ParseMode.MARKDOWN)
                except:
                    await query.edit_message_text(msg_text, parse_mode=ParseMode.MARKDOWN)

                threading.Thread(target=refill_numbers_if_needed, daemon=True).start()
                time.sleep(3)
                numbers = db_get_available_numbers(page=0)
                total = db_get_numbers_count()

            if not numbers:
                err_text = "😔 *No numbers available right now*\n\nOur team is adding more numbers.\nPlease try again in a few minutes!"
                try:
                    await query.edit_message_caption(caption=err_text, parse_mode=ParseMode.MARKDOWN, reply_markup=InlineKeyboardMarkup([[
                        InlineKeyboardButton("🔄 Retry", callback_data="get_numbers_0"),
                        InlineKeyboardButton("🏠 Menu", callback_data="main_menu")
                    ]]))
                except:
                    await query.edit_message_text(err_text, parse_mode=ParseMode.MARKDOWN, reply_markup=InlineKeyboardMarkup([[
                        InlineKeyboardButton("🔄 Retry", callback_data="get_numbers_0"),
                        InlineKeyboardButton("🏠 Menu", callback_data="main_menu")
                    ]]))
                return

        start_num = page * NUMBERS_PER_PAGE + 1
        end_num = start_num + len(numbers) - 1

        text = f"📱 *Available Nigeria Numbers*\n\nShowing #{start_num}–#{end_num} of {total} available\n\n👇 *Tap any number to assign it to yourself*\nOnce assigned, I'll watch for your OTP automatically!"

        try:
            await query.edit_message_caption(caption=text, parse_mode=ParseMode.MARKDOWN, reply_markup=numbers_keyboard(numbers, page, total))
        except:
            await query.edit_message_text(text, parse_mode=ParseMode.MARKDOWN, reply_markup=numbers_keyboard(numbers, page, total))

    elif data.startswith("assign_"):
        number_id = int(data.split("_")[1])
        try:
            r = supabase.table("sms_numbers").select("*").eq("id", number_id).execute()
            if not r.data:
                await query.answer("❌ Number not found!", show_alert=True)
                return

            num = r.data[0]
            if num.get("assigned_to") and num["assigned_to"] != user.id:
                await query.answer("⚡ Just taken! Showing you another...", show_alert=False)
                return

            db_assign_number(number_id, user.id)

            phone = num["phone_number"]
            text = f"✅ *Number Assigned to You!*\n\n📱 *Your Number:* `+{phone}`\n🌍 *Range:* {num.get('range_name', 'Nigeria')}\n\n*What to do next:*\n1️⃣ Use this number on the website/app\n2️⃣ Request the OTP\n3️⃣ I'll auto-send it here when it arrives! 🚀\n\n⏰ *Monitoring:* Active ✅\n🔄 *Poll interval:* Every {POLL_INTERVAL}s"

            keyboard = InlineKeyboardMarkup([
                [InlineKeyboardButton(f"🔍 Check OTP for +{phone}", callback_data=f"check_single_{phone}")],
                [InlineKeyboardButton("📋 My Numbers", callback_data="my_numbers"), InlineKeyboardButton("📱 Get More", callback_data="get_numbers_0")],
                [InlineKeyboardButton("🏠 Menu", callback_data="main_menu")]
            ])

            try:
                await query.edit_message_caption(caption=text, parse_mode=ParseMode.MARKDOWN, reply_markup=keyboard)
            except:
                await query.edit_message_text(text, parse_mode=ParseMode.MARKDOWN, reply_markup=keyboard)

        except Exception as e:
            log.error(f"assign error: {e}")
            await query.answer("❌ Error assigning number", show_alert=True)

    elif data == "my_numbers":
        numbers = db_get_user_numbers(user.id)

        if not numbers:
            text = "📋 *Your Numbers*\n\nYou don't have any active numbers yet.\n\nTap *Get Numbers* to grab some!"
            keyboard = InlineKeyboardMarkup([[
                InlineKeyboardButton("📱 Get Numbers", callback_data="get_numbers_0"),
                InlineKeyboardButton("🏠 Menu", callback_data="main_menu")
            ]])
        else:
            lines = []
            for num in numbers:
                phone = num["phone_number"]
                lines.append(f"📞 `+{phone}` — ⏳ Waiting for OTP")
            text = f"📋 *Your Active Numbers*\n\n" + "\n".join(lines) + f"\n\n🔍 Tap a number below to check OTP manually\n⚡ Auto-delivery is always running!"
            keyboard = my_numbers_keyboard(numbers)

        try:
            await query.edit_message_caption(caption=text, parse_mode=ParseMode.MARKDOWN, reply_markup=keyboard)
        except:
            await query.edit_message_text(text, parse_mode=ParseMode.MARKDOWN, reply_markup=keyboard)

    elif data == "check_otp":
        numbers = db_get_user_numbers(user.id)
        if not numbers:
            await query.answer("📭 No active numbers. Get numbers first!", show_alert=True)
            return

        await query.answer("🔍 Checking OTPs...", show_alert=False)

        html = fetch_otps_today()
        found_any = False

        if html and "sms-empty" not in html:
            otps = parse_otps_from_html(html)
            for num in numbers:
                phone = num["phone_number"]
                for otp in otps:
                    if otp["number"] == phone:
                        otp_key = f"{phone}:{otp['message'][:30]}"
                        if otp_key not in delivered_otps:
                            delivered_otps.add(otp_key)
                            db_mark_otp_delivered(num["id"], otp["message"], user.id)
                            await notify_user_otp(ctx.application, user.id, phone, otp["message"])
                            found_any = True

        if not found_any:
            text = f"🔍 *OTP Check Complete*\n\nNo new OTPs found for your numbers yet.\n\n📱 *Your numbers:*\n" + "\n".join([f"• `+{n['phone_number']}`" for n in numbers]) + f"\n\n⏳ I'm auto-monitoring every {POLL_INTERVAL}s.\nYou'll be notified instantly!"
            keyboard = InlineKeyboardMarkup([[
                InlineKeyboardButton("🔄 Check Again", callback_data="check_otp"),
                InlineKeyboardButton("📋 My Numbers", callback_data="my_numbers")
            ], [InlineKeyboardButton("🏠 Menu", callback_data="main_menu")]])

            try:
                await query.edit_message_caption(caption=text, parse_mode=ParseMode.MARKDOWN, reply_markup=keyboard)
            except:
                await query.edit_message_text(text, parse_mode=ParseMode.MARKDOWN, reply_markup=keyboard)

    elif data.startswith("check_single_"):
        phone = data.replace("check_single_", "")
        await query.answer("🔍 Checking...", show_alert=False)

        html = fetch_otps_today()
        found = False

        if html and "sms-empty" not in html:
            otps = parse_otps_from_html(html)
            for otp in otps:
                if otp["number"] == phone:
                    row = db_get_number_by_phone(phone)
                    otp_key = f"{phone}:{otp['message'][:30]}"
                    if otp_key not in delivered_otps:
                        delivered_otps.add(otp_key)
                        if row:
                            db_mark_otp_delivered(row["id"], otp["message"], user.id)
                        await notify_user_otp(ctx.application, user.id, phone, otp["message"])
                        found = True
                        break

        if not found:
            text = f"🔍 *No OTP yet for:*\n`+{phone}`\n\n⏳ Still monitoring... You'll be notified automatically!\n\n_Make sure you've used this number to request an OTP on the target site._"
            keyboard = InlineKeyboardMarkup([[
                InlineKeyboardButton("🔄 Check Again", callback_data=f"check_single_{phone}"),
                InlineKeyboardButton("📋 My Numbers", callback_data="my_numbers")
            ], [InlineKeyboardButton("🏠 Menu", callback_data="main_menu")]])

            try:
                await query.edit_message_caption(caption=text, parse_mode=ParseMode.MARKDOWN, reply_markup=keyboard)
            except:
                await query.edit_message_text(text, parse_mode=ParseMode.MARKDOWN, reply_markup=keyboard)

    elif data == "how_it_works":
        text = "ℹ️ *How This Bot Works*\n\n*Step 1 — Get a Number* 📱\nTap Get Numbers to see real Nigerian phone numbers.\n\n*Step 2 — Use the Number* 🌐\nEnter the number on any website or app that asks for a Nigerian phone number.\n\n*Step 3 — Request OTP* 🔑\nClick 'Send OTP' or 'Verify' on that website.\n\n*Step 4 — Receive OTP Here* ✅\nThe bot monitors 24/7 and sends you the OTP the moment it arrives!\n\n*Extra Tips:*\n• Send me any number directly to check it\n• Use *My Numbers* to see your assigned numbers\n• Numbers recycle after use for others\n\n💡 _Numbers are exclusively yours once assigned_"
        keyboard = InlineKeyboardMarkup([[
            InlineKeyboardButton("📱 Get Numbers", callback_data="get_numbers_0"),
            InlineKeyboardButton("🏠 Menu", callback_data="main_menu")
        ]])
        try:
            await query.edit_message_caption(caption=text, parse_mode=ParseMode.MARKDOWN, reply_markup=keyboard)
        except:
            await query.edit_message_text(text, parse_mode=ParseMode.MARKDOWN, reply_markup=keyboard)

    elif data == "noop":
        await query.answer()
