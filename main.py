# main.py
import os
import asyncio
import discord
from fastapi import FastAPI
import uvicorn

# --------------------------- #
# 1️⃣  Load secrets & config  #
# --------------------------- #
TOKEN = os.getenv("USER_TOKEN")          # <--- your Discord user token
TARGET_SERVER_ID = int(os.getenv("TARGET_SERVER_ID", "0"))  # ID of the server you want to watch

# --------------------------- #
# 2️⃣  Discord bot (self‑bot) #
# --------------------------- #
intents = discord.Intents.default()
intents.members = True  # Needed for GUILD_MEMBER_ADD

bot = discord.Client(intents=intents)

# In‑memory store (you can swap this for Redis/Postgres later)
joined_members = []

@bot.event
async def on_ready():
    print(f"✅ Self‑bot logged in as {bot.user}")

@bot.event
async def on_member_join(member):
    if member.guild.id == TARGET_SERVER_ID:
        joined_members.append({
            "id": member.id,
            "name": f"{member.name}#{member.discriminator}",
            "joined_at": str(member.joined_at),
        })
        print(f"🆕 New member: {member.name}#{member.discriminator}")

# --------------------------- #
# 3️⃣  FastAPI dashboard      #
# --------------------------- #
app = FastAPI()

@app.get("/api/members")
async def get_members():
    # Return a list of joined members
    return {"members": joined_members}

# --------------------------- #
# 4️⃣  Startup hook           #
# --------------------------- #
@app.on_event("startup")
async def startup():
    # Run the Discord bot in the background
    asyncio.create_task(bot.start(TOKEN, bot=False))

# --------------------------- #
# 5️⃣  Run the app            #
# --------------------------- #
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8000)))
