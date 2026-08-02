const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

// 显式根路由：确保 Railway 上能正确返回首页
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// 静态文件服务
app.use(express.static(__dirname));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  next();
});

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"], credentials: false },
  pingTimeout: 20000,
  pingInterval: 10000,
});

// ============ 数据结构 ============
const rooms = new Map();
const matchmaking = [];
let onlineCount = 0;

function generateRoomCode() {
  let code;
  do {
    code = Math.random().toString(36).substring(2, 8).toUpperCase();
  } while (rooms.has(code));
  return code;
}

function cleanName(s) {
  const n = String(s || "")
    .replace(/[<>&"'`]/g, "")
    .trim()
    .substring(0, 24);
  return n || "玩家";
}

function getRoomPublic(room) {
  return {
    code: room.code,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      side: p.side,
      ready: p.ready,
    })),
    host: room.host,
    status: room.status,
    seed: room.status === "playing" ? room.seed : null,
    turn: room.turn || 1,
  };
}

function removeFromRoom(socket) {
  const code = socket.roomCode;
  if (!code) return;
  socket.roomCode = null;
  const room = rooms.get(code);
  if (!room) return;
  const idx = room.players.findIndex((p) => p.socketId === socket.id);
  if (idx === -1) return;
  const player = room.players[idx];
  room.players.splice(idx, 1);
  socket.leave(code);

  if (room.status === "playing") {
    room.status = "ended";
    const winner = room.players.find(
      (p) => p.socketId && p.socketId !== socket.id
    );
    if (winner) {
      io.to(code).emit("game_over", {
        winner: winner.side,
        reason: "对手已断开连接",
      });
    }
  }

  socket
    .to(code)
    .emit("player_left", { playerId: player.id, room: getRoomPublic(room) });

  if (room.players.length === 0) {
    rooms.delete(code);
  } else if (room.host === socket.id) {
    const next = room.players.find((p) => p.socketId);
    if (next) {
      room.host = next.socketId;
      io.to(code).emit("host_changed", { newHost: room.host });
    }
  }
}

function tryMatch() {
  while (matchmaking.length >= 2) {
    const p1 = matchmaking.shift();
    const p2 = matchmaking.shift();
    if (!p1.socket.connected || !p2.socket.connected) {
      if (p1.socket.connected) matchmaking.unshift(p1);
      if (p2.socket.connected) matchmaking.unshift(p2);
      continue;
    }

    const code = generateRoomCode();
    const room = {
      code,
      host: p1.socket.id,
      players: [
        {
          id: p1.socket.id,
          name: p1.name,
          side: "A",
          ready: true,
          socketId: p1.socket.id,
        },
        {
          id: p2.socket.id,
          name: p2.name,
          side: "B",
          ready: true,
          socketId: p2.socket.id,
        },
      ],
      status: "playing",
      seed: Date.now() + Math.floor(Math.random() * 1000000),
      turn: 1,
      pendingA: null,
      pendingB: null,
      history: [],
      createdAt: Date.now(),
    };
    rooms.set(code, room);
    p1.socket.join(code);
    p1.socket.roomCode = code;
    p2.socket.join(code);
    p2.socket.roomCode = code;

    p1.socket.emit("match_found", {
      room: getRoomPublic(room),
      yourSide: "A",
      seed: room.seed,
      opponent: p2.name,
    });
    p2.socket.emit("match_found", {
      room: getRoomPublic(room),
      yourSide: "B",
      seed: room.seed,
      opponent: p1.name,
    });
  }
}

// ============ Socket 事件 ============
io.on("connection", (socket) => {
  onlineCount++;
  io.emit("online_count", onlineCount);
  socket.playerName = "玩家";

  socket.on("join_matchmaking", (payload) => {
    const name = cleanName(payload?.name);
    socket.playerName = name;
    const existingIdx = matchmaking.findIndex((m) => m.socket.id === socket.id);
    if (existingIdx !== -1) matchmaking.splice(existingIdx, 1);
    removeFromRoom(socket);
    matchmaking.push({ socket, name });
    socket.emit("matchmaking_joined");
    tryMatch();
  });

  socket.on("leave_matchmaking", () => {
    const idx = matchmaking.findIndex((m) => m.socket.id === socket.id);
    if (idx !== -1) matchmaking.splice(idx, 1);
    socket.emit("matchmaking_left");
  });

  socket.on("create_room", (payload) => {
    const now = Date.now();
    if (socket.lastRoomCreate && now - socket.lastRoomCreate < 2000) {
      socket.emit("error_msg", { message: "操作太频繁" });
      return;
    }
    if (rooms.size > 2000) {
      socket.emit("error_msg", { message: "服务器繁忙" });
      return;
    }
    socket.lastRoomCreate = now;
    removeFromRoom(socket);
    const mmIdx = matchmaking.findIndex((m) => m.socket.id === socket.id);
    if (mmIdx !== -1) matchmaking.splice(mmIdx, 1);

    let { name } = payload || {};
    name = cleanName(name);
    socket.playerName = name;

    const code = generateRoomCode();
    const room = {
      code,
      host: socket.id,
      players: [
        { id: socket.id, name, side: null, ready: false, socketId: socket.id },
      ],
      status: "waiting",
      seed: null,
      turn: 1,
      pendingA: null,
      pendingB: null,
      history: [],
      createdAt: Date.now(),
    };
    rooms.set(code, room);
    socket.join(code);
    socket.roomCode = code;
    socket.emit("room_created", { code, room: getRoomPublic(room) });
  });

  socket.on("join_room", (payload) => {
    let { code, name } = payload || {};
    code = String(code || "")
      .trim()
      .toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      socket.emit("error_msg", { message: "房间不存在" });
      return;
    }

    if (room.players.some((p) => p.socketId === socket.id)) {
      socket.join(code);
      socket.roomCode = code;
      socket.emit("room_joined", {
        code,
        room: getRoomPublic(room),
        you: socket.id,
      });
      return;
    }
    if (room.status !== "waiting") {
      socket.emit("error_msg", { message: "游戏已开始" });
      return;
    }
    if (room.players.length >= 2) {
      socket.emit("error_msg", { message: "房间已满" });
      return;
    }

    removeFromRoom(socket);
    const mmIdx = matchmaking.findIndex((m) => m.socket.id === socket.id);
    if (mmIdx !== -1) matchmaking.splice(mmIdx, 1);

    name = cleanName(name);
    socket.playerName = name;
    room.players.push({
      id: socket.id,
      name,
      side: null,
      ready: false,
      socketId: socket.id,
    });
    socket.join(code);
    socket.roomCode = code;
    socket.emit("room_joined", {
      code,
      room: getRoomPublic(room),
      you: socket.id,
    });
    socket.to(code).emit("player_joined", {
      player: { id: socket.id, name },
      room: getRoomPublic(room),
    });
  });

  socket.on("leave_room", () => removeFromRoom(socket));

  socket.on("toggle_ready", () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.status !== "waiting") return;
    const p = room.players.find((p) => p.socketId === socket.id);
    if (!p) return;
    p.ready = !p.ready;
    io.to(room.code).emit("player_ready", {
      playerId: p.id,
      ready: p.ready,
      room: getRoomPublic(room),
    });
  });

  socket.on("start_game", () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.host !== socket.id || room.status === "playing") return;
    if (room.players.length < 2) {
      socket.emit("error_msg", { message: "需要2名玩家" });
      return;
    }
    if (!room.players.every((p) => p.ready)) {
      socket.emit("error_msg", { message: "有玩家未准备" });
      return;
    }

    room.players[0].side = "A";
    room.players[1].side = "B";
    room.status = "playing";
    room.seed = Date.now() + Math.floor(Math.random() * 1000000);
    room.turn = 1;
    room.pendingA = null;
    room.pendingB = null;
    room.history = [];

    const publicRoom = getRoomPublic(room);
    room.players.forEach((p) => {
      if (!p.socketId) return;
      const s = io.sockets.sockets.get(p.socketId);
      if (s)
        s.emit("game_started", {
          room: publicRoom,
          yourSide: p.side,
          seed: room.seed,
        });
    });
  });

  socket.on("submit_moves", (payload) => {
    const { moves } = payload || {};
    const room = rooms.get(socket.roomCode);
    if (!room || room.status !== "playing") return;

    const player = room.players.find((p) => p.socketId === socket.id);
    if (!player || !player.side) return;

    const validMoves = Array.isArray(moves)
      ? moves.filter(
          (m) =>
            typeof m.from === "number" &&
            typeof m.to === "number" &&
            typeof m.amt === "number" &&
            m.amt > 0
        )
      : [];

    if (player.side === "A") room.pendingA = validMoves;
    else room.pendingB = validMoves;

    socket.to(room.code).emit("opponent_submitted", { side: player.side });
    socket.emit("moves_accepted", { side: player.side });

    if (room.pendingA !== null && room.pendingB !== null) {
      io.to(room.code).emit("turn_resolved", {
        turn: room.turn,
        movesA: room.pendingA,
        movesB: room.pendingB,
      });
      room.turn++;
      room.pendingA = null;
      room.pendingB = null;
    }
  });

  socket.on("game_over", (data) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    socket.to(room.code).emit("game_over", data);
  });

  socket.on("return_to_room", (payload) => {
    const { code } = payload || {};
    const room = rooms.get(code);
    if (!room) return;
    if (room.host !== socket.id && room.status !== "ended") return;
    room.status = "waiting";
    room.seed = null;
    room.turn = 1;
    room.pendingA = null;
    room.pendingB = null;
    room.history = [];
    room.players.forEach((p) => {
      p.side = null;
      p.ready = false;
    });
    io.to(code).emit("room_reset", { room: getRoomPublic(room) });
  });

  socket.on("disconnect", () => {
    onlineCount--;
    io.emit("online_count", onlineCount);
    const mmIdx = matchmaking.findIndex((m) => m.socket.id === socket.id);
    if (mmIdx !== -1) matchmaking.splice(mmIdx, 1);
    removeFromRoom(socket);
  });
});

// ============ 清理闲置房间 ============
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, code) => {
    if (room.status === "waiting" && now - room.createdAt > 30 * 60 * 1000) {
      io.to(code).emit("error_msg", { message: "房间长时间未开始，已解散" });
      rooms.delete(code);
    }
  });
}, 10 * 60 * 1000);

process.on("uncaughtException", (err) => {
  console.error("未捕获异常:", err);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`🎮 节点战争服务器已启动`);
  console.log(`📍 端口: ${PORT}`);
  console.log(`========================================`);
});
