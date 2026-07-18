// server.js
// Авторитетный сервер комнат для асимметричной хоррор-игры.
// 1 игрок получает роль Маньяка, остальные (до 3) — Выжившие.

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Person = require('./person.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

// Отдаём клиентские файлы и общий модуль person.js
app.use(express.static(__dirname));
// Простой health-check эндпоинт — пригодится для keep-alive пинга (см. инструкцию по деплою)
app.get('/health', (req, res) => res.send('ok'));

const TICK_RATE = 30;          // симуляция, раз в секунду
const BROADCAST_RATE = 15;     // рассылка состояния клиентам, раз в секунду
const MAX_PLAYERS = 4;
const ROUND_TIME = 180;        // секунд на раунд — выжившие побеждают, если продержались

const rooms = new Map(); // code -> room

function makeRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
        code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (rooms.has(code));
    return code;
}

function createRoom() {
    const code = makeRoomCode();
    const room = {
        code,
        players: new Map(), // socketId -> person + meta
        obstacles: Person.generateObstacles(),
        started: false,
        timeLeft: ROUND_TIME,
        tickTimer: null,
        broadcastTimer: null,
        roundTimer: null
    };
    rooms.set(code, room);
    return room;
}

function lobbyPayload(room) {
    return {
        code: room.code,
        players: Array.from(room.players.values()).map(p => ({ id: p.id, name: p.name })),
        canStart: room.players.size >= 2 && room.players.size <= MAX_PLAYERS
    };
}

function assignRoles(room) {
    const ids = Array.from(room.players.keys());
    const shuffled = ids.sort(() => Math.random() - 0.5);
    const maniacId = shuffled[0];
    for (const id of ids) {
        const entry = room.players.get(id);
        const role = id === maniacId ? Person.ROLES.MANIAC : Person.ROLES.SURVIVOR;
        entry.person = Person.createPerson(id, entry.name, role);
    }
}

function startGame(room) {
    if (room.started) return;
    room.started = true;
    room.timeLeft = ROUND_TIME;
    assignRoles(room);

    io.to(room.code).emit('gameStart', {
        obstacles: room.obstacles,
        worldWidth: Person.WORLD_WIDTH,
        worldHeight: Person.WORLD_HEIGHT,
        players: Array.from(room.players.values()).map(p => ({
            id: p.id, name: p.name, role: p.person.role
        })),
        youAre: null // клиент подставит себя сам по своему id
    });

    room.tickTimer = setInterval(() => tickRoom(room), 1000 / TICK_RATE);
    room.broadcastTimer = setInterval(() => broadcastState(room), 1000 / BROADCAST_RATE);
    room.roundTimer = setInterval(() => {
        room.timeLeft -= 1;
        if (room.timeLeft <= 0) {
            endGame(room, 'survivors', 'Время вышло');
        }
    }, 1000);
}

function tickRoom(room) {
    const dt = 1 / TICK_RATE;
    const people = Array.from(room.players.values()).map(p => p.person);
    const maniac = people.find(p => p.role === Person.ROLES.MANIAC);

    for (const entry of room.players.values()) {
        Person.stepPerson(entry.person, entry.input, dt, room.obstacles);
    }

    if (maniac) {
        for (const p of people) {
            if (p.role === Person.ROLES.SURVIVOR && p.alive) {
                if (Person.distance(maniac, p) < Person.KILL_RADIUS) {
                    p.alive = false;
                }
            }
        }
        const survivorsLeft = people.some(p => p.role === Person.ROLES.SURVIVOR && p.alive);
        if (!survivorsLeft) {
            endGame(room, 'maniac', 'Все выжившие пойманы');
        }
    }
}

function broadcastState(room) {
    io.to(room.code).emit('state', {
        timeLeft: Math.ceil(room.timeLeft),
        players: Array.from(room.players.values()).map(p => ({
            id: p.id,
            x: p.person.x,
            y: p.person.y,
            facing: p.person.facing,
            role: p.person.role,
            alive: p.person.alive
        }))
    });
}

function endGame(room, winner, reason) {
    io.to(room.code).emit('gameOver', { winner, reason });
    clearInterval(room.tickTimer);
    clearInterval(room.broadcastTimer);
    clearInterval(room.roundTimer);
    room.started = false;
}

function destroyRoomIfEmpty(room) {
    if (room.players.size === 0) {
        clearInterval(room.tickTimer);
        clearInterval(room.broadcastTimer);
        clearInterval(room.roundTimer);
        rooms.delete(room.code);
    }
}

io.on('connection', (socket) => {
    let currentRoom = null;

    // Создать новую комнату
    socket.on('createRoom', ({ name }) => {
        const room = createRoom();
        joinRoom(room, name);
    });

    // Присоединиться по коду
    socket.on('joinRoom', ({ name, code }) => {
        const room = rooms.get((code || '').toUpperCase());
        if (!room) {
            socket.emit('errorMsg', 'Комната не найдена');
            return;
        }
        if (room.players.size >= MAX_PLAYERS) {
            socket.emit('errorMsg', 'Комната заполнена');
            return;
        }
        if (room.started) {
            socket.emit('errorMsg', 'Игра уже началась');
            return;
        }
        joinRoom(room, name);
    });

    function joinRoom(room, name) {
        currentRoom = room;
        socket.join(room.code);
        room.players.set(socket.id, {
            id: socket.id,
            name: (name || 'Игрок').slice(0, 20),
            person: null,
            input: { dx: 0, dy: 0 }
        });
        socket.emit('joined', { code: room.code, selfId: socket.id });
        io.to(room.code).emit('lobbyUpdate', lobbyPayload(room));
    }

    socket.on('startGame', () => {
        if (currentRoom && !currentRoom.started && currentRoom.players.size >= 2) {
            startGame(currentRoom);
        }
    });

    // input: { dx, dy } — нормализованное направление от джойстика/клавиш
    socket.on('input', (input) => {
        if (!currentRoom) return;
        const entry = currentRoom.players.get(socket.id);
        if (entry) entry.input = { dx: input.dx || 0, dy: input.dy || 0 };
    });

    socket.on('disconnect', () => {
        if (!currentRoom) return;
        currentRoom.players.delete(socket.id);
        io.to(currentRoom.code).emit('lobbyUpdate', lobbyPayload(currentRoom));
        io.to(currentRoom.code).emit('playerLeft', { id: socket.id });
        destroyRoomIfEmpty(currentRoom);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
