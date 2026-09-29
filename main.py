import discord
from discord.ext import commands
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn
import os

# --- Discord Bot Setup ---
intents = discord.Intents.default()
intents.members = True  # Crucial for seeing joins

bot = commands.Bot(command_prefix='!', self_bot=True, intents=intents)

Store joined members in memory (or use Redis/Postgres for persistence)
joined_members = []

@bot.event
async def on_ready():
    print(f'Self-bot logged in as {bot.user}')

@bot.event
async def on_guild_join(guild):
    # Optional: Log when the bot itself joins a server
    pass

@bot.event
async def on_member_join(member):
    # Filter for specific servers if needed
    # Example: Only log joins in Server ID 123456789
    if member.guild.id == YOUR_TARGET_SERVER_ID:
        joined_members.append({
            "username": member.name,
            "discriminator": member.discriminator,
            "id": member.id,
            "joined_at": str(member.joined_at)
        })
        print(f"New join: {member.name}")

--- FastAPI Dashboard Setup ---
app = FastAPI()

class Member(BaseModel):
    username: str
    discriminator: str
    id: str
    joined_at: str

@app.get("/api/members")
async def get_members():
    return {"members": joined_members}

@app.on_event("startup")
async def startup():
    # Run the Discord bot in the background
    import asyncio
    asyncio.create_task(bot.start(YOUR_USER_TOKEN, bot=False))

if name == "main":
    uvicorn.run(app, host="0.0.0.0", port=8000)
