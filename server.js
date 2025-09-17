// server.js
// Node.js + Express + Socket.IO chat + integrated Telegram bot (single process).
// Mobile-first UI served from index.html
//
// Required env:
//   BOT_TOKEN    - telegram bot token
//   MOD_SECRET   - secret string for internal moderation endpoints (optional, default devsecret)
//   APP_ORIGIN   - public URL of the app (used by bot when building link). Optional (fallback to localhost).
//
// Run:
//   npm install express socket.io node-telegram-bot-api node-fetch
//   BOT_TOKEN=123:ABC MOD_SECRET=yyy APP_ORIGIN=https://yoururl.onrender.com node server.js

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const fetch = require("node-fetch");
const TelegramBot = require("node-telegram-bot-api");

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || "8246983928:AAH9BRXupUHBQf0c0oSn45Owlr5GV3VWW8E";
const MOD_SECRET = process.env.MOD_SECRET || "devsecret";
const APP_ORIGIN = process.env.APP_ORIGIN || null;
const MODERATOR = "@wounsee"; // strict moderator username

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, ".")));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// In-memory store
const MAX_MESSAGES = 400;
let messages = []; // { id, user, text, time }
let banned = new Set(); // lowercase '@nick'
const rateMap = new Map(); // user -> timestamps array

function genId() { return Math.random().toString(36).slice(2,10); }
function nowISO() { return new Date().toISOString(); }
function pushMessage(msg) {
  messages.push(msg);
  if (messages.length > MAX_MESSAGES) messages.shift();
}

// Basic spam protection
function isRateLimited(user) {
  const now = Date.now();
  const windowStart = now - 10_000; // 10s window
  const arr = (rateMap.get(user) || []).filter(t => t > windowStart);
  arr.push(now);
  rateMap.set(user, arr);
  return arr.length > 5; // >5 messages in window => rate limited
}

// Socket.IO: no manual login — client sends join with tg param or we fallback to 'Anon'
io.on("connection", socket => {
  socket.emit("history", messages);

  socket.on("join", ({ user }) => {
    const uname = (user && String(user).trim()) || "Anon";
    socket.data.user = uname.startsWith("@") ? uname : (uname);
    const sys = { id: genId(), user: "System", text: `${socket.data.user} присоединился`, time: nowISO(), meta:{system:true} };
    pushMessage(sys);
    io.emit("message", sys);
  });

  socket.on("message", ({ text }) => {
    const user = socket.data.user || "Anon";
    const uname = user.startsWith("@") ? user : (user);
    const unameKey = uname.toLowerCase();

    if (banned.has(unameKey)) {
      socket.emit("error_msg", { reason: "banned" });
      return;
    }
    // spam
    if (isRateLimited(unameKey)) {
      socket.emit("error_msg", { reason: "rate_limit" });
      return;
    }
    // no identical consecutive message
    const last = messages.length ? messages[messages.length-1] : null;
    if (last && last.user && last.user.toLowerCase() === unameKey && last.text === text) {
      socket.emit("error_msg", { reason: "repeat" });
      return;
    }

    const msg = { id: genId(), user: uname, text: String(text).slice(0,1500), time: nowISO() };
    pushMessage(msg);
    io.emit("message", msg);
  });

  socket.on("typing", (isTyping) => {
    const user = socket.data.user || "Anon";
    socket.broadcast.emit("typing", { user, typing: !!isTyping });
  });

  socket.on("disconnect", () => {
    // nothing heavy
  });
});

// Moderation endpoints (protected by header X-MOD-SECRET)
function checkSecret(req, res) {
  const s = req.header("X-MOD-SECRET");
  if (!s || s !== MOD_SECRET) {
    res.status(403).json({ ok:false, error:"forbidden" });
    return false;
  }
  return true;
}

app.post("/moderator/ban", (req, res) => {
  if (!checkSecret(req, res)) return;
  const { user } = req.body;
  if (!user) return res.status(400).json({ ok:false, error:"user required" });
  const uname = user.startsWith("@") ? user : ("@" + user);
  banned.add(uname.toLowerCase());
  const sys = { id: genId(), user: "System", text: `${uname} был забанен модератором`, time: nowISO(), meta:{system:true} };
  pushMessage(sys);
  io.emit("message", sys);
  res.json({ ok:true });
});

app.post("/moderator/unban", (req, res) => {
  if (!checkSecret(req, res)) return;
  const { user } = req.body;
  if (!user) return res.status(400).json({ ok:false, error:"user required" });
  const uname = user.startsWith("@") ? user : ("@" + user);
  banned.delete(uname.toLowerCase());
  const sys = { id: genId(), user: "System", text: `${uname} был разбанен`, time: nowISO(), meta:{system:true} };
  pushMessage(sys); io.emit("message", sys);
  res.json({ ok:true });
});

app.post("/moderator/delete", (req, res) => {
  if (!checkSecret(req, res)) return;
  const { id } = req.body;
  if (!id) return res.status(400).json({ ok:false, error:"id required" });
  const idx = messages.findIndex(m => m.id === id);
  if (idx === -1) return res.status(404).json({ ok:false, error:"not_found" });
  const removed = messages.splice(idx,1)[0];
  const sys = { id: genId(), user: "System", text: `Сообщение ${removed.id} удалено модератором`, time: nowISO(), meta:{system:true} };
  pushMessage(sys);
  io.emit("deleted", { id: removed.id });
  io.emit("message", sys);
  res.json({ ok:true });
});

app.get("/health", (req, res) => res.json({ ok:true }));

// --------- Telegram bot integrated ---------
if (BOT_TOKEN) {
  const bot = new TelegramBot(BOT_TOKEN, { polling: true });

  function buildAppLink(username) {
    const user = username ? (username.startsWith("@") ? username : ("@" + username)) : "";
    if (APP_ORIGIN) return `${APP_ORIGIN}/?tg=${encodeURIComponent(user)}`;
    const host = process.env.HOSTNAME || `http://localhost:${PORT}`;
    return `${host}/?tg=${encodeURIComponent(user)}`;
  }

  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const uname = msg.from.username ? ("@" + msg.from.username) : (msg.from.first_name || "User");
    const link = buildAppLink(uname);
    const text = `Привет, ${uname}!\nОткрой приложение:`;
    const opts = {
      reply_markup: { inline_keyboard: [[ { text: "Открыть приложение", url: link } ]] }
    };
    try { await bot.sendMessage(chatId, text, opts); } catch(e){ console.error("bot send error", e.message); }
  });

  // Moderator-only commands: /ban /unban /delete
  bot.onText(/\/ban (.+)/, async (msg, match) => {
    const from = msg.from;
    const sender = from.username ? ("@" + from.username) : null;
    if (!sender || sender.toLowerCase() !== MODERATOR.toLowerCase()) {
      return bot.sendMessage(msg.chat.id, "Access denied");
    }
    const target = (match && match[1]) ? match[1].trim() : null;
    if (!target) return bot.sendMessage(msg.chat.id, "Usage: /ban @username");
    try {
      const url = (APP_ORIGIN || `http://localhost:${PORT}`) + "/moderator/ban";
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type":"application/json", "X-MOD-SECRET": MOD_SECRET },
        body: JSON.stringify({ user: target })
      });
      const j = await r.json();
      if (j.ok) bot.sendMessage(msg.chat.id, `${target} banned`);
      else bot.sendMessage(msg.chat.id, `Error: ${j.error || "unknown"}`);
    } catch(e){ bot.sendMessage(msg.chat.id, "Request failed: " + e.message); }
  });

  bot.onText(/\/unban (.+)/, async (msg, match) => {
    const sender = msg.from.username ? ("@" + msg.from.username) : null;
    if (!sender || sender.toLowerCase() !== MODERATOR.toLowerCase()) return bot.sendMessage(msg.chat.id, "Access denied");
    const target = (match && match[1]) ? match[1].trim() : null;
    if (!target) return bot.sendMessage(msg.chat.id, "Usage: /unban @username");
    try {
      const url = (APP_ORIGIN || `http://localhost:${PORT}`) + "/moderator/unban";
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type":"application/json", "X-MOD-SECRET": MOD_SECRET },
        body: JSON.stringify({ user: target })
      });
      const j = await r.json();
      if (j.ok) bot.sendMessage(msg.chat.id, `${target} unbanned`);
      else bot.sendMessage(msg.chat.id, `Error: ${j.error || "unknown"}`);
    } catch(e){ bot.sendMessage(msg.chat.id, "Request failed: " + e.message); }
  });

  bot.onText(/\/delete (.+)/, async (msg, match) => {
    const sender = msg.from.username ? ("@" + msg.from.username) : null;
    if (!sender || sender.toLowerCase() !== MODERATOR.toLowerCase()) return bot.sendMessage(msg.chat.id, "Access denied");
    const id = (match && match[1]) ? match[1].trim() : null;
    if (!id) return bot.sendMessage(msg.chat.id, "Usage: /delete <message_id>");
    try {
      const url = (APP_ORIGIN || `http://localhost:${PORT}`) + "/moderator/delete";
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type":"application/json", "X-MOD-SECRET": MOD_SECRET },
        body: JSON.stringify({ id })
      });
      const j = await r.json();
      if (j.ok) bot.sendMessage(msg.chat.id, `message ${id} deleted`);
      else bot.sendMessage(msg.chat.id, `Error: ${j.error || "unknown"}`);
    } catch(e){ bot.sendMessage(msg.chat.id, "Request failed: " + e.message); }
  });

  console.log("Telegram bot started (integrated)");
} else {
  console.log("BOT_TOKEN not provided — telegram bot disabled");
}

// Start server
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
