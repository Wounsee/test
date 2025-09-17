// server.js
// Простой Node.js + Express + Socket.IO backend для общего чата.
// Запуск: node server.js
// Порт: process.env.PORT || 3000

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Если будете запускать с другого хоста — настроьте origin
  cors: { origin: "*" },
});

const PORT = process.env.PORT || 3000;

// Храним последние N сообщений в памяти
const MAX_MESSAGES = 200;
let messages = []; // { id, user, text, time }

// Простая функция ID
function genId() {
  return Math.random().toString(36).slice(2, 9);
}

// Отдаём статические файлы (index.html и прочие) из текущей папки
app.use(express.static(path.resolve(__dirname, ".")));

// Health check
app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

io.on("connection", (socket) => {
  console.log("socket connected:", socket.id);

  // отправляем историю при подключении
  socket.emit("history", messages);

  // пользователь присоединился, можно сохранить имя в сокете
  socket.on("join", (payload) => {
    // payload: { user }
    const user = (payload && payload.user) ? String(payload.user).slice(0, 64) : "Anon";
    socket.data.user = user;
    console.log(`user joined: ${user} (${socket.id})`);
    // уведомление в чат
    const sysMsg = {
      id: genId(),
      user: "System",
      text: `${user} присоединился к чату`,
      time: new Date().toISOString(),
      meta: { system: true }
    };
    messages.push(sysMsg);
    if (messages.length > MAX_MESSAGES) messages.shift();
    io.emit("message", sysMsg);
  });

  socket.on("message", (payload) => {
    // payload: { text }
    const text = payload && payload.text ? String(payload.text).trim() : "";
    if (!text) return;
    const user = socket.data.user || "Anon";
    const msg = {
      id: genId(),
      user,
      text: text.slice(0, 1000), // ограничение длины
      time: new Date().toISOString(),
    };
    messages.push(msg);
    if (messages.length > MAX_MESSAGES) messages.shift();
    io.emit("message", msg);
  });

  socket.on("typing", (isTyping) => {
    const user = socket.data.user || "Anon";
    socket.broadcast.emit("typing", { user, typing: !!isTyping });
  });

  socket.on("disconnect", (reason) => {
    const user = socket.data.user;
    console.log(`socket disconnect: ${socket.id} (${reason})`);
    if (user) {
      const sysMsg = {
        id: genId(),
        user: "System",
        text: `${user} покинул(а) чат`,
        time: new Date().toISOString(),
        meta: { system: true }
      };
      messages.push(sysMsg);
      if (messages.length > MAX_MESSAGES) messages.shift();
      io.emit("message", sysMsg);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT} (port ${PORT})`);
});
