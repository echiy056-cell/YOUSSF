# main.py
import os
import asyncio
import discord
from typing import List, Dict

from fastapi import FastAPI, Request, Form, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware

# ------------------------------------------------------------------
# 1️⃣  FastAPI + Jinja2
# ------------------------------------------------------------------
app = FastAPI()
templates = Jinja2Templates(directory="templates")

# Secret key for session cookies – use a long random string in production!
app.add_middleware(SessionMiddleware, secret_key="CHANGE_ME_TO_A_RANDOM_STRING")

# ------------------------------------------------------------------
# 2️⃣  Global in‑memory state
# ------------------------------------------------------------------
token: str | None = None
bot: discord.Client | None = None
joined_members: List[Dict] = []

# ------------------------------------------------------------------
# 3️⃣  Discord client (self‑bot)
# ------------------------------------------------------------------
intents = discord.Intents.default()
intents.members = True       # Needed for on_member_join

def build_bot(the_token: str):
    """Return a new discord.Client instance bound to the supplied token."""
    # Pass bot=False – this is a self‑bot, not a bot account.
    client = discord.Client(intents=intents, bot=False)

    @client.event
    async def on_ready():
        print(f"✅ Self‑bot logged in as {client.user}")

    @client.event
    async def on_member_join(member):
        if member.guild.id == int(os.getenv("TARGET_SERVER_ID", "0")):
            joined_members.append({
                "id": member.id,
                "name": f"{member.name}#{member.discriminator}",
                "joined_at": str(member.joined_at),
            })
            print(f"🆕 New member: {member.name}#{member.discriminator}")

    return client

# ------------------------------------------------------------------
# 4️⃣  Routes
# ------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    """Show token input form (or the dashboard if token is present)."""
    if request.session.get("token"):
        # User already submitted a token – show dashboard
        return templates.TemplateResponse(
            "dashboard.html",
            {"request": request, "members": joined_members},
        )
    return templates.TemplateResponse("index.html", {"request": request})

@app.post("/set_token")
async def set_token(request: Request, user_token: str = Form(...)):
    """Save token in session and start the bot."""
    global token, bot

    if not user_token.startswith("M"):
        raise HTTPException(status_code=400, detail="Invalid Discord user token")

    # Store in session (keeps it in the browser cookie, not in DB)
    request.session["token"] = user_token
    token = user_token

    # Start the bot if not already running
    if bot is None:
        bot = build_bot(token)
        asyncio.create_task(bot.start(token))

    return RedirectResponse(url="/", status_code=303)

@app.post("/stop_bot")
async def stop_bot(request: Request):
    """Shut down the bot and clear the token."""
    global token, bot, joined_members
    token = None
    if bot:
        await bot.close()
        bot = None
    joined_members.clear()
    request.session.pop("token", None)
    return RedirectResponse(url="/", status_code=303)

# ------------------------------------------------------------------
# 5️⃣  Graceful shutdown
# ------------------------------------------------------------------
@app.on_event("shutdown")
async def shutdown_event():
    global bot
    if bot:
        await bot.close()

# ------------------------------------------------------------------
# 6️⃣  Run locally (optional)
# ------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", 8000)),
        reload=True,
    )
