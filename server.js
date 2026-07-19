// server.js
// Авторитетный сервер: комнаты, назначение персонажей, вся боевая логика
// (M1-удар, капканы, пассивки) считается и проверяется только здесь.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Person = require('./person.js');
const Roles = require('./roles.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(__dirname));
app.get('/health', (req, res) => res.send('ok'));

const TICK_RATE = 30;
const BROADCAST_RATE = 15;
const MAX_PLAYERS = 3;       // 1 убийца + 2 выживших
const ROUND_TIME = 180;

const rooms = new Map();

function makeRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do { code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
    while (rooms.has(code));
    return code;
}

function createRoom() {
    const code = makeRoomCode();
    const room = {
        code,
        players: new Map(), // socketId -> entry
        obstacles: Person.generateObstacles(),
        traps: [],
        phase: 'lobby', // lobby -> selecting -> playing
        selection: null,
        selectionTimer: null,
        started: false,
        timeLeft: ROUND_TIME,
        tickTimer: null,
        broadcastTimer: null,
        roundTimer: null
    };
    rooms.set(code, room);
    return room;
}

const SELECT_TIME_LIMIT = 25; // сек на выбор персонажа

// Кто станет убийцей в этом раунде: наибольшая "злость" (сколько раз подряд был выжившим).
// При равенстве — первый по порядку присоединения к комнате.
function determineKillerId(room) {
    let maxAnger = -1, killerId = null;
    for (const [id, entry] of room.players) {
        const anger = entry.anger || 0;
        if (anger > maxAnger) { maxAnger = anger; killerId = id; }
    }
    return killerId;
}

function beginCharacterSelection(room) {
    room.phase = 'selecting';
    room.traps = [];
    const killerId = determineKillerId(room);
    room.selection = { killerId, choices: new Map() };

    for (const [id, entry] of room.players) {
        entry.pendingRole = id === killerId ? Roles.ROLE_TYPES.KILLER : Roles.ROLE_TYPES.SURVIVOR;
        // +1 злости всем, кто в этом раунде остаётся выжившим (не убийце)
        if (entry.pendingRole === Roles.ROLE_TYPES.SURVIVOR) {
            entry.anger = (entry.anger || 0) + 1;
        }
        const availableIds = entry.pendingRole === Roles.ROLE_TYPES.KILLER ? Roles.KILLER_ORDER : Roles.SURVIVOR_ORDER;
        entry.socket.emit('selectCharacter', {
            role: entry.pendingRole,
            availableIds,
            timeLimit: SELECT_TIME_LIMIT
        });
    }

    io.to(room.code).emit('lobbyUpdate', lobbyPayload(room));
    room.selectionTimer = setTimeout(() => finalizeSelection(room), SELECT_TIME_LIMIT * 1000);
}

function finalizeSelection(room) {
    if (room.phase !== 'selecting') return;
    clearTimeout(room.selectionTimer);

    // Всем, кто не успел выбрать — назначаем первый свободный вариант автоматически
    for (const [id, entry] of room.players) {
        if (room.selection.choices.has(id)) continue;
        const pool = entry.pendingRole === Roles.ROLE_TYPES.KILLER ? Roles.KILLER_ORDER : Roles.SURVIVOR_ORDER;
        const takenIds = new Set(room.selection.choices.values());
        const fallback = pool.find(cid => !takenIds.has(cid)) || pool[0];
        room.selection.choices.set(id, fallback);
    }

    for (const [id, entry] of room.players) {
        entry.role = entry.pendingRole;
        entry.characterId = room.selection.choices.get(id);
    }

    startRound(room);
}

function lobbyPayload(room) {
    return {
        code: room.code,
        players: Array.from(room.players.values()).map(p => ({ id: p.id, name: p.name, anger: p.anger || 0 })),
        canStart: room.phase === 'lobby' && room.players.size >= 2 && room.players.size <= MAX_PLAYERS
    };
}

function startRound(room) {
    room.phase = 'playing';
    room.started = true;
    room.timeLeft = ROUND_TIME;
    room.traps = [];

    for (const [id, entry] of room.players) {
        entry.person = Person.createPerson(id, entry.name, entry.role, entry.characterId);
        entry.ability = entry.role === Roles.ROLE_TYPES.KILLER
            ? { m1: { phase: null, timer: 0, hitSet: new Set() }, m1CooldownUntil: 0, qCooldownUntil: 0, eCooldownUntil: 0, eRevealUntil: 0 }
            : { blockedUntil: 0, adrenalineUntil: 0, lastAdrenalineTrigger: -9999 };
    }

    io.to(room.code).emit('gameStart', {
        obstacles: room.obstacles,
        worldWidth: Person.WORLD_WIDTH,
        worldHeight: Person.WORLD_HEIGHT,
        players: Array.from(room.players.values()).map(p => ({
            id: p.id, name: p.name, role: p.role, characterId: p.characterId
        }))
    });

    room.tickTimer = setInterval(() => tickRoom(room), 1000 / TICK_RATE);
    room.broadcastTimer = setInterval(() => broadcastState(room), 1000 / BROADCAST_RATE);
    room.roundTimer = setInterval(() => {
        room.timeLeft -= 1;
        if (room.timeLeft <= 0) endGame(room, 'survivors', 'Время вышло');
    }, 1000);
}

function nowSec() { return Date.now() / 1000; }

function tickRoom(room) {
    const dt = 1 / TICK_RATE;
    const now = nowSec();
    const entries = Array.from(room.players.values());
    const killerEntry = entries.find(e => e.role === Roles.ROLE_TYPES.KILLER);

    // --- Движение ---
    for (const entry of entries) {
        if (entry.role === Roles.ROLE_TYPES.SURVIVOR) {
            const character = Roles.SURVIVORS[entry.characterId];
            const frozen = now < entry.ability.blockedUntil;
            let speedMultiplier = 1;
            if (character.passive.type === 'adrenaline' && now < entry.ability.adrenalineUntil) {
                speedMultiplier = 1 + character.passive.speedBoostPct;
            }
            Person.stepPerson(entry.person, entry.input, dt, room.obstacles, { speedMultiplier, frozen });
        } else {
            Person.stepPerson(entry.person, entry.input, dt, room.obstacles, {});
        }
    }

    // --- Атака M1 убийцы ---
    if (killerEntry && killerEntry.person.alive) {
        const character = Roles.KILLERS[killerEntry.characterId];
        const ab = killerEntry.ability;
        if (ab.m1.phase === 'telegraph') {
            ab.m1.timer -= dt;
            if (ab.m1.timer <= 0) { ab.m1.phase = 'active'; ab.m1.timer = character.m1.activeTime; }
        } else if (ab.m1.phase === 'active') {
            const hitbox = Person.getAttackHitbox(killerEntry.person, character.m1.hitboxWidth, character.m1.hitboxHeight);
            for (const entry of entries) {
                if (entry.role !== Roles.ROLE_TYPES.SURVIVOR || !entry.person.alive) continue;
                if (ab.m1.hitSet.has(entry.id)) continue;
                const rect = { x: entry.person.x, y: entry.person.y, w: entry.person.width, h: entry.person.height };
                if (Person.rectsOverlap(hitbox, rect)) {
                    ab.m1.hitSet.add(entry.id);
                    applyDamage(entry, character.m1.damage, now);
                }
            }
            ab.m1.timer -= dt;
            if (ab.m1.timer <= 0) {
                ab.m1.phase = null;
                ab.m1CooldownUntil = now + character.m1.cooldown;
                ab.m1.hitSet.clear();
            }
        }
    }

    // --- Капканы ---
    room.traps = room.traps.filter(trap => now < trap.spawnedAt + trap.lifetime);
    for (const trap of room.traps) {
        if (trap.consumed) continue;
        for (const entry of entries) {
            if (entry.role !== Roles.ROLE_TYPES.SURVIVOR || !entry.person.alive) continue;
            if (now < entry.ability.blockedUntil) continue;
            if (Person.distance(entry.person, trap) < trap.radius) {
                entry.ability.blockedUntil = now + trap.slowDuration;
                trap.consumed = true;
                break;
            }
        }
    }
    room.traps = room.traps.filter(trap => !trap.consumed);

    // --- Проверка победы ---
    const survivorsAlive = entries.some(e => e.role === Roles.ROLE_TYPES.SURVIVOR && e.person.alive);
    if (killerEntry && !survivorsAlive) endGame(room, 'maniac', 'Все выжившие мертвы');
}

function applyDamage(entry, damage, now) {
    entry.person.health = Math.max(0, entry.person.health - damage);
    if (entry.person.health <= 0) entry.person.alive = false;

    const character = Roles.SURVIVORS[entry.characterId];
    if (character.passive.type === 'adrenaline' && entry.person.alive) {
        if (now - entry.ability.lastAdrenalineTrigger > character.passive.cooldown) {
            entry.ability.lastAdrenalineTrigger = now;
            entry.ability.adrenalineUntil = now + character.passive.duration;
        }
    }
}

function broadcastState(room) {
    const now = nowSec();
    const entries = Array.from(room.players.values());
    const basePlayers = entries.map(p => ({
        id: p.id, x: p.person.x, y: p.person.y, facing: p.person.facing,
        role: p.role, characterId: p.characterId, alive: p.person.alive,
        health: p.person.health, maxHealth: p.person.maxHealth,
        attackPhase: p.role === Roles.ROLE_TYPES.KILLER ? p.ability.m1.phase : null
    }));

    for (const recipient of entries) {
        let visibleTraps;
        if (recipient.role === Roles.ROLE_TYPES.KILLER) {
            visibleTraps = room.traps.map(t => ({ x: t.x, y: t.y, radius: t.radius }));
        } else {
            const character = Roles.SURVIVORS[recipient.characterId];
            const bonus = character.passive.type === 'trap_sense' ? (1 + character.passive.visionBonusPct) : 1;
            const visionRadius = Roles.TRAP_BASE_VISION_RADIUS * bonus;
            visibleTraps = room.traps
                .filter(t => Person.distance(recipient.person, t) < visionRadius)
                .map(t => ({ x: t.x, y: t.y, radius: t.radius }));
        }

        const payload = {
            timeLeft: Math.ceil(room.timeLeft),
            players: basePlayers,
            traps: visibleTraps
        };

        if (recipient.role === Roles.ROLE_TYPES.KILLER) {
            const ab = recipient.ability;
            const character = Roles.KILLERS[recipient.characterId];
            payload.self = {
                m1Phase: ab.m1.phase,
                m1CooldownRemaining: Math.max(0, ab.m1CooldownUntil - now),
                qCooldownRemaining: Math.max(0, ab.qCooldownUntil - now),
                eCooldownRemaining: Math.max(0, ab.eCooldownUntil - now),
                eRevealActive: now < ab.eRevealUntil,
                activeTrapCount: room.traps.filter(t => t.ownerId === recipient.id).length,
                maxTraps: character.q.maxActive
            };
        } else {
            payload.self = { blocked: now < recipient.ability.blockedUntil };
        }

        if (recipient.socket) recipient.socket.emit('state', payload);
    }
}

function endGame(room, winner, reason) {
    io.to(room.code).emit('gameOver', { winner, reason });
    clearInterval(room.tickTimer);
    clearInterval(room.broadcastTimer);
    clearInterval(room.roundTimer);
    room.started = false;
    room.phase = 'lobby';
    room.selection = null;
    io.to(room.code).emit('lobbyUpdate', lobbyPayload(room));
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

    socket.on('createRoom', ({ name }) => {
        const room = createRoom();
        joinRoom(room, name);
    });

    socket.on('joinRoom', ({ name, code }) => {
        const room = rooms.get((code || '').toUpperCase());
        if (!room) return socket.emit('errorMsg', 'Комната не найдена');
        if (room.players.size >= MAX_PLAYERS) return socket.emit('errorMsg', 'Комната заполнена');
        if (room.phase !== 'lobby') return socket.emit('errorMsg', 'Игра уже началась');
        joinRoom(room, name);
    });

    function joinRoom(room, name) {
        currentRoom = room;
        socket.join(room.code);
        room.players.set(socket.id, {
            id: socket.id,
            name: (name || 'Игрок').slice(0, 20),
            socket,
            role: null, characterId: null, pendingRole: null,
            person: null, ability: null,
            anger: 0,
            input: { dx: 0, dy: 0 }
        });
        socket.emit('joined', { code: room.code, selfId: socket.id });
        io.to(room.code).emit('lobbyUpdate', lobbyPayload(room));
    }

    socket.on('startGame', () => {
        if (currentRoom && currentRoom.phase === 'lobby' && currentRoom.players.size >= 2) {
            beginCharacterSelection(currentRoom);
        }
    });

    // Выбор персонажа в фазе 'selecting'
    socket.on('chooseCharacter', ({ characterId }) => {
        const entry = currentRoom && currentRoom.players.get(socket.id);
        if (!currentRoom || currentRoom.phase !== 'selecting' || !entry || !entry.pendingRole) return;
        const pool = entry.pendingRole === Roles.ROLE_TYPES.KILLER ? Roles.KILLERS : Roles.SURVIVORS;
        if (!pool[characterId]) return;

        if (entry.pendingRole === Roles.ROLE_TYPES.SURVIVOR) {
            for (const [otherId, otherChoice] of currentRoom.selection.choices) {
                if (otherId === socket.id) continue;
                const otherEntry = currentRoom.players.get(otherId);
                if (otherEntry && otherEntry.pendingRole === Roles.ROLE_TYPES.SURVIVOR && otherChoice === characterId) {
                    socket.emit('errorMsg', 'Этот персонаж уже занят');
                    return;
                }
            }
        }

        currentRoom.selection.choices.set(socket.id, characterId);
        socket.emit('characterConfirmed', { characterId });
        if (entry.pendingRole === Roles.ROLE_TYPES.SURVIVOR) {
            io.to(currentRoom.code).emit('characterTaken', { characterId, byId: socket.id });
        }

        const everyoneChosen = Array.from(currentRoom.players.keys())
            .every(id => currentRoom.selection.choices.has(id));
        if (everyoneChosen) finalizeSelection(currentRoom);
    });

    socket.on('input', (input) => {
        if (!currentRoom) return;
        const entry = currentRoom.players.get(socket.id);
        if (entry) entry.input = { dx: input.dx || 0, dy: input.dy || 0 };
    });

    // M1 — атака убийцы
    socket.on('attackM1', () => {
        const entry = currentRoom && currentRoom.players.get(socket.id);
        if (!entry || entry.role !== Roles.ROLE_TYPES.KILLER || !entry.person.alive) return;
        const now = nowSec();
        const character = Roles.KILLERS[entry.characterId];
        const ab = entry.ability;
        if (now < ab.m1CooldownUntil || ab.m1.phase !== null) return;
        ab.m1.phase = 'telegraph';
        ab.m1.timer = character.m1.telegraphTime;
        ab.m1.hitSet.clear();
    });

    // Q — способность убийцы (пока только капкан у Лесника)
    socket.on('useQ', () => {
        const entry = currentRoom && currentRoom.players.get(socket.id);
        if (!entry || entry.role !== Roles.ROLE_TYPES.KILLER || !entry.person.alive) return;
        const now = nowSec();
        const character = Roles.KILLERS[entry.characterId];
        const ab = entry.ability;
        if (now < ab.qCooldownUntil) return;
        const activeCount = currentRoom.traps.filter(t => t.ownerId === entry.id).length;
        if (activeCount >= character.q.maxActive) return;
        currentRoom.traps.push({
            x: entry.person.x + entry.person.width / 2,
            y: entry.person.y + entry.person.height / 2,
            radius: character.q.radius,
            slowDuration: character.q.slowDuration,
            lifetime: character.q.lifetime,
            ownerId: entry.id,
            spawnedAt: now,
            consumed: false
        });
        ab.qCooldownUntil = now + character.q.cooldown;
    });

    // E — способность убийцы (Чутьё)
    socket.on('useE', () => {
        const entry = currentRoom && currentRoom.players.get(socket.id);
        if (!entry || entry.role !== Roles.ROLE_TYPES.KILLER || !entry.person.alive) return;
        const now = nowSec();
        const character = Roles.KILLERS[entry.characterId];
        const ab = entry.ability;
        if (now < ab.eCooldownUntil) return;
        ab.eRevealUntil = now + character.e.revealDuration;
        ab.eCooldownUntil = now + character.e.cooldown;
    });

    // F — взаимодействие выжившего (задел на будущее: генераторы, двери и т.д.)
    socket.on('interact', () => {
        const entry = currentRoom && currentRoom.players.get(socket.id);
        if (!entry || entry.role !== Roles.ROLE_TYPES.SURVIVOR) return;
        // Пока без эффекта — точка расширения под будущие объекты на карте.
    });

    socket.on('disconnect', () => {
        if (!currentRoom) return;
        const leaving = currentRoom.players.get(socket.id);
        const wasKiller = leaving && leaving.role === Roles.ROLE_TYPES.KILLER;
        const wasPlaying = currentRoom.phase === 'playing';

        currentRoom.players.delete(socket.id);
        io.to(currentRoom.code).emit('playerLeft', { id: socket.id });

        if (currentRoom.phase === 'selecting') {
            clearTimeout(currentRoom.selectionTimer);
            currentRoom.phase = 'lobby';
            currentRoom.selection = null;
            io.to(currentRoom.code).emit('selectionCancelled');
        } else if (wasPlaying && wasKiller) {
            endGame(currentRoom, 'survivors', 'Убийца отключился');
        }

        io.to(currentRoom.code).emit('lobbyUpdate', lobbyPayload(currentRoom));
        destroyRoomIfEmpty(currentRoom);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
