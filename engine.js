// engine.js
// Клиент: рендер, ввод (джойстик + кнопки способностей), сеть, музыка.
// Зависит от roles.js и person.js (глобальные RolesModule/PersonModule) и socket.io-client,
// подключённых в index.html до этого файла.

(function () {
    const P = window.PersonModule;
    const R = window.RolesModule;
    const socket = io();

    const canvas = document.getElementById('gameCanvas');
    const ctx = canvas.getContext('2d');

    function resizeCanvas() {
        const isPortrait = window.innerHeight > window.innerWidth;
        const targetW = isPortrait ? Math.min(window.innerWidth, 900) : Math.min(window.innerWidth, 1000);
        const targetH = isPortrait ? Math.min(window.innerHeight * 0.7, 900) : Math.min(window.innerHeight, 750);
        canvas.width = Math.floor(targetW);
        canvas.height = Math.floor(targetH);
        camera.width = canvas.width;
        camera.height = canvas.height;
        layoutControls();
    }
    window.addEventListener('resize', resizeCanvas);
    window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 200));

    const camera = { x: 0, y: 0, width: 800, height: 600 };

    // ---------- Состояние игры ----------
    let selfId = null;
    let selfRole = null;
    let selfCharacterId = null;
    let obstacles = [];
    let gameStarted = false;
    let lastSelfInfo = {}; // payload.self с сервера (кулдауны и т.д.)
    let traps = [];

    const renderPlayers = new Map();
    let localPredicted = null;

    // ---------- Ввод: клавиатура (для теста на ПК) ----------
    const keys = { ArrowUp: false, ArrowDown: false, ArrowLeft: false, ArrowRight: false, KeyW: false, KeyS: false, KeyA: false, KeyD: false };
    window.addEventListener('keydown', (e) => {
        if (e.code in keys) { e.preventDefault(); keys[e.code] = true; }
        if (e.code === 'KeyQ') socket.emit('useQ');
        if (e.code === 'KeyE') socket.emit('useE');
        if (e.code === 'KeyF') socket.emit('interact');
    });
    window.addEventListener('keyup', (e) => { if (e.code in keys) { e.preventDefault(); keys[e.code] = false; } });
    canvas.addEventListener('mousedown', (e) => { if (e.button === 0) socket.emit('attackM1'); });

    // ---------- Джойстик (движение) ----------
    const joystick = {
        active: false, touchId: null,
        baseX: 90, baseY: 460, baseRadius: 55,
        knobX: 90, knobY: 460, knobRadius: 25,
        maxDist: 40, dx: 0, dy: 0
    };

    // ---------- Кнопки способностей (правая часть экрана) ----------
    // layout зависит от роли и пересчитывается в layoutControls()
    const buttons = {
        m1: { x: 0, y: 0, r: 42, label: 'M1', key: 'm1' },
        q: { x: 0, y: 0, r: 32, label: 'Q', key: 'q' },
        e: { x: 0, y: 0, r: 32, label: 'E', key: 'e' },
        f: { x: 0, y: 0, r: 42, label: 'F', key: 'f' }
    };
    const activeButtonTouches = new Map(); // touchId -> buttonKey

    function layoutControls() {
        joystick.baseX = 90;
        joystick.baseY = canvas.height - 110;
        joystick.knobX = joystick.baseX;
        joystick.knobY = joystick.baseY;

        buttons.m1.x = canvas.width - 60; buttons.m1.y = canvas.height - 90;
        buttons.q.x = canvas.width - 130; buttons.q.y = canvas.height - 60;
        buttons.e.x = canvas.width - 130; buttons.e.y = canvas.height - 140;
        buttons.f.x = canvas.width - 60; buttons.f.y = canvas.height - 90;
    }

    function getCanvasCoords(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
    }
    function clampKnob() {
        const dx = joystick.knobX - joystick.baseX;
        const dy = joystick.knobY - joystick.baseY;
        const dist = Math.hypot(dx, dy);
        if (dist > joystick.maxDist) {
            const angle = Math.atan2(dy, dx);
            joystick.knobX = joystick.baseX + Math.cos(angle) * joystick.maxDist;
            joystick.knobY = joystick.baseY + Math.sin(angle) * joystick.maxDist;
        }
        const fdx = joystick.knobX - joystick.baseX, fdy = joystick.knobY - joystick.baseY;
        const fdist = Math.hypot(fdx, fdy);
        if (fdist > 1) { joystick.dx = fdx / joystick.maxDist; joystick.dy = fdy / joystick.maxDist; }
        else { joystick.dx = 0; joystick.dy = 0; }
    }

    function buttonAt(x, y) {
        const activeBtns = selfRole === R.ROLE_TYPES.KILLER ? [buttons.m1, buttons.q, buttons.e] : [buttons.f];
        for (const b of activeBtns) {
            if (Math.hypot(x - b.x, y - b.y) <= b.r) return b;
        }
        return null;
    }
    function fireButton(key) {
        if (key === 'm1') socket.emit('attackM1');
        if (key === 'q') socket.emit('useQ');
        if (key === 'e') socket.emit('useE');
        if (key === 'f') socket.emit('interact');
    }

    function handleTouchStart(e) {
        e.preventDefault();
        for (const touch of e.changedTouches) {
            const { x, y } = getCanvasCoords(touch.clientX, touch.clientY);
            const btn = buttonAt(x, y);
            if (btn) {
                activeButtonTouches.set(touch.identifier, btn.key);
                fireButton(btn.key);
                continue;
            }
            if (Math.hypot(x - joystick.baseX, y - joystick.baseY) <= joystick.baseRadius && !joystick.active) {
                joystick.active = true; joystick.touchId = touch.identifier;
                joystick.knobX = x; joystick.knobY = y;
                clampKnob();
            }
        }
    }
    function handleTouchMove(e) {
        e.preventDefault();
        if (!joystick.active) return;
        for (const touch of e.changedTouches) {
            if (touch.identifier === joystick.touchId) {
                const { x, y } = getCanvasCoords(touch.clientX, touch.clientY);
                joystick.knobX = x; joystick.knobY = y;
                clampKnob();
            }
        }
    }
    function handleTouchEnd(e) {
        e.preventDefault();
        for (const touch of e.changedTouches) {
            activeButtonTouches.delete(touch.identifier);
            if (touch.identifier === joystick.touchId) {
                joystick.active = false; joystick.touchId = null;
                joystick.knobX = joystick.baseX; joystick.knobY = joystick.baseY;
                joystick.dx = 0; joystick.dy = 0;
            }
        }
    }
    canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
    canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
    canvas.addEventListener('touchend', handleTouchEnd);
    canvas.addEventListener('touchcancel', handleTouchEnd);

    function getInputDirection() {
        if (joystick.active && (joystick.dx !== 0 || joystick.dy !== 0)) return { dx: joystick.dx, dy: joystick.dy };
        let dx = 0, dy = 0;
        if (keys.ArrowUp || keys.KeyW) dy -= 1;
        if (keys.ArrowDown || keys.KeyS) dy += 1;
        if (keys.ArrowLeft || keys.KeyA) dx -= 1;
        if (keys.ArrowRight || keys.KeyD) dx += 1;
        if (dx !== 0 || dy !== 0) { const len = Math.hypot(dx, dy); dx /= len; dy /= len; }
        return { dx, dy };
    }

    setInterval(() => socket.emit('input', getInputDirection()), 100);

    // ---------- Музыка ----------
    const bgMusic = document.getElementById('bgMusic');
    const chaseMusic = document.getElementById('chaseMusic');
    let isChasing = false;
    bgMusic.volume = 0.3; chaseMusic.volume = 0.5;
    function updateMusic() {
        if (!gameStarted || !localPredicted) return;
        let dist = Infinity;
        if (selfRole === R.ROLE_TYPES.SURVIVOR) {
            for (const rp of renderPlayers.values()) if (rp.role === R.ROLE_TYPES.KILLER) dist = Math.hypot(rp.x - localPredicted.x, rp.y - localPredicted.y);
        } else {
            for (const rp of renderPlayers.values()) {
                if (rp.role === R.ROLE_TYPES.SURVIVOR && rp.alive) {
                    const d = Math.hypot(rp.x - localPredicted.x, rp.y - localPredicted.y);
                    if (d < dist) dist = d;
                }
            }
        }
        const chaseRadius = 350;
        if (dist < chaseRadius && !isChasing) { isChasing = true; bgMusic.pause(); chaseMusic.currentTime = 0; chaseMusic.play().catch(() => {}); }
        else if (dist >= chaseRadius && isChasing) { isChasing = false; chaseMusic.pause(); bgMusic.currentTime = 0; bgMusic.play().catch(() => {}); }
    }

    // ---------- Лобби ----------
    const lobbyOverlay = document.getElementById('lobbyOverlay');
    const nameInput = document.getElementById('playerName');
    const roomCodeInput = document.getElementById('roomCode');
    const createBtn = document.getElementById('createBtn');
    const joinBtn = document.getElementById('joinBtn');
    const startBtn = document.getElementById('startGameBtn');
    const playersListEl = document.getElementById('playersList');
    const roomCodeDisplay = document.getElementById('roomCodeDisplay');
    const statusMsg = document.getElementById('statusMsg');

    const selectOverlay = document.getElementById('selectOverlay');
    const selectTitle = document.getElementById('selectTitle');
    const selectTimerEl = document.getElementById('selectTimer');
    const charCardsEl = document.getElementById('charCards');
    const selectStatusEl = document.getElementById('selectStatus');

    createBtn.onclick = () => { socket.emit('createRoom', { name: nameInput.value.trim() || 'Игрок' }); bgMusic.play().catch(() => {}); };
    joinBtn.onclick = () => {
        const code = roomCodeInput.value.trim();
        if (!code) { statusMsg.textContent = 'Введите код комнаты'; return; }
        socket.emit('joinRoom', { name: nameInput.value.trim() || 'Игрок', code });
        bgMusic.play().catch(() => {});
    };
    startBtn.onclick = () => socket.emit('startGame');

    socket.on('joined', ({ code }) => { roomCodeDisplay.textContent = `Код комнаты: ${code}`; statusMsg.textContent = ''; });
    socket.on('errorMsg', (msg) => { statusMsg.textContent = msg; selectStatusEl.textContent = msg; });
    socket.on('lobbyUpdate', ({ players, canStart }) => {
        playersListEl.innerHTML = players.length
            ? players.map(p => `<div>👤 ${p.name}${p.anger ? ` <span style="color:#a55;">(злость: ${p.anger})</span>` : ''}</div>`).join('')
            : '<div style="color:#555;">Ожидание игроков...</div>';
        startBtn.style.display = canStart ? 'block' : 'none';
    });

    // ---------- Экран выбора персонажа ----------
    let selectionRole = null;
    let selectionAvailableIds = [];
    let selectionTakenIds = new Set();
    let selectionChosenId = null;
    let selectionDeadline = 0;
    let selectionTimerInterval = null;

    // Человекочитаемое описание способности по её "type" — не завязано на конкретного персонажа,
    // поэтому будет работать и для будущих killer.q/killer.e с новыми типами (со стандартным fallback).
    function describeKillerAbility(ability) {
        if (ability.type === 'trap') {
            return `${ability.name}: блокирует движение на ${ability.slowDuration} сек при срабатывании. `
                + `Максимум ${ability.maxActive} шт. одновременно, живёт ${ability.lifetime} сек. Перезарядка ${ability.cooldown} сек.`;
        }
        if (ability.type === 'reveal') {
            return `${ability.name}: подсвечивает выживших в радиусе ${ability.radius} на ${ability.revealDuration} сек. Перезарядка ${ability.cooldown} сек.`;
        }
        return `${ability.name}: перезарядка ${ability.cooldown} сек.`;
    }
    function describeSurvivorPassive(passive) {
        if (passive.type === 'adrenaline') {
            return `${passive.name}: после получения урона скорость растёт на ${Math.round(passive.speedBoostPct * 100)}% на ${passive.duration} сек (не чаще раза в ${passive.cooldown} сек).`;
        }
        if (passive.type === 'trap_sense') {
            return `${passive.name}: способности убийцы, оставленные в мире (капканы и т.п.), видны на ${Math.round(passive.visionBonusPct * 100)}% дальше обычного.`;
        }
        return passive.name;
    }

    function renderCharacterCards() {
        const pool = selectionRole === R.ROLE_TYPES.KILLER ? R.KILLERS : R.SURVIVORS;
        charCardsEl.innerHTML = '';
        for (const id of selectionAvailableIds) {
            const c = pool[id];
            const card = document.createElement('div');
            const taken = selectionTakenIds.has(id) && selectionChosenId !== id;
            const chosen = selectionChosenId === id;
            card.className = 'char-card' + (taken ? ' taken' : '') + (chosen ? ' chosen' : '');
            let statsHtml = `<div class="stats"><b>Здоровье:</b> ${c.health} &nbsp; <b>Скорость:</b> ${c.speed}<br>`;
            if (selectionRole === R.ROLE_TYPES.KILLER) {
                statsHtml += `<b>M1 (${c.m1.name}):</b> урон ${c.m1.damage}, замах ${c.m1.telegraphTime}с, удар ${c.m1.activeTime}с, кд ${c.m1.cooldown}с<br>`;
                statsHtml += `<b>Q:</b> ${describeKillerAbility(c.q)}<br>`;
                statsHtml += `<b>E:</b> ${describeKillerAbility(c.e)}`;
            } else {
                statsHtml += `<b>Пассивка:</b> ${describeSurvivorPassive(c.passive)}`;
            }
            statsHtml += '</div>';
            card.innerHTML = `<h3>${c.name}</h3><div class="desc">${c.description}</div>${statsHtml}`;
            if (!taken) card.onclick = () => { socket.emit('chooseCharacter', { characterId: id }); };
            charCardsEl.appendChild(card);
        }
    }

    function tickSelectionTimer() {
        const remaining = Math.max(0, Math.ceil(selectionDeadline - Date.now() / 1000));
        selectTimerEl.textContent = `Осталось: ${remaining} сек`;
        if (remaining <= 0) clearInterval(selectionTimerInterval);
    }

    socket.on('selectCharacter', ({ role, availableIds, timeLimit }) => {
        selectionRole = role;
        selectionAvailableIds = availableIds;
        selectionTakenIds = new Set();
        selectionChosenId = null;
        selectionDeadline = Date.now() / 1000 + timeLimit;
        selectTitle.textContent = role === R.ROLE_TYPES.KILLER ? 'Ты — Убийца. Выбери персонажа' : 'Ты — Выживший. Выбери персонажа';
        selectStatusEl.textContent = '';
        lobbyOverlay.style.display = 'none';
        selectOverlay.style.display = 'flex';
        renderCharacterCards();
        clearInterval(selectionTimerInterval);
        selectionTimerInterval = setInterval(tickSelectionTimer, 250);
        tickSelectionTimer();
    });

    socket.on('characterConfirmed', ({ characterId }) => {
        selectionChosenId = characterId;
        selectStatusEl.textContent = 'Выбор сделан. Ждём остальных...';
        renderCharacterCards();
    });

    socket.on('characterTaken', ({ characterId, byId }) => {
        if (byId === selfId) return;
        selectionTakenIds.add(characterId);
        renderCharacterCards();
    });

    socket.on('selectionCancelled', () => {
        clearInterval(selectionTimerInterval);
        selectOverlay.style.display = 'none';
        lobbyOverlay.style.display = 'flex';
        statusMsg.textContent = 'Игрок вышел, выбор отменён. Нажми "Начать игру" ещё раз.';
    });

    socket.on('gameStart', (data) => {
        selfId = socket.id;
        obstacles = data.obstacles;
        const self = data.players.find(p => p.id === selfId);
        selfRole = self ? self.role : R.ROLE_TYPES.SURVIVOR;
        selfCharacterId = self ? self.characterId : null;
        camera.width = canvas.width; camera.height = canvas.height;
        lobbyOverlay.style.display = 'none';
        selectOverlay.style.display = 'none';
        clearInterval(selectionTimerInterval);
        gameStarted = true;
        localPredicted = null;
        renderPlayers.clear();
        traps = [];
        layoutControls();
    });

    socket.on('state', (data) => {
        lastSelfInfo = data.self || {};
        traps = data.traps || [];
        for (const p of data.players) {
            const character = R.getCharacter(p.role, p.characterId);
            if (p.id === selfId) {
                if (!localPredicted) {
                    const phys = R.PHYSICS_DEFAULTS[p.role];
                    localPredicted = {
                        x: p.x, y: p.y, facing: p.facing, vx: 0, vy: 0,
                        width: phys.width, height: phys.height,
                        speed: character.speed, acceleration: phys.acceleration, friction: phys.friction,
                        alive: true
                    };
                }
                localPredicted.x += (p.x - localPredicted.x) * 0.2;
                localPredicted.y += (p.y - localPredicted.y) * 0.2;
                localPredicted.alive = p.alive;
                renderPlayers.set(p.id, { x: localPredicted.x, y: localPredicted.y, facing: p.facing, role: p.role, characterId: p.characterId, alive: p.alive, health: p.health, maxHealth: p.maxHealth, attackPhase: p.attackPhase, targetX: p.x, targetY: p.y, name: character.name });
            } else {
                const prev = renderPlayers.get(p.id);
                renderPlayers.set(p.id, { x: prev ? prev.x : p.x, y: prev ? prev.y : p.y, facing: p.facing, role: p.role, characterId: p.characterId, alive: p.alive, health: p.health, maxHealth: p.maxHealth, attackPhase: p.attackPhase, targetX: p.x, targetY: p.y, name: character.name });
            }
        }
    });

    socket.on('playerLeft', ({ id }) => renderPlayers.delete(id));

    socket.on('gameOver', ({ winner, reason }) => {
        gameStarted = false;
        statusMsg.textContent = winner === 'maniac' ? `Убийца победил: ${reason}` : `Выжившие спаслись: ${reason}`;
        selectOverlay.style.display = 'none';
        clearInterval(selectionTimerInterval);
        lobbyOverlay.style.display = 'flex';
        startBtn.style.display = 'none';
        bgMusic.pause(); chaseMusic.pause();
    });

    // ---------- Обновление ----------
    function update(dt) {
        if (!localPredicted) return;
        if (localPredicted.alive !== false) {
            const frozen = selfRole === R.ROLE_TYPES.SURVIVOR && lastSelfInfo.blocked;
            const input = frozen ? { dx: 0, dy: 0 } : getInputDirection();
            P.stepPerson(localPredicted, input, dt, obstacles, {});
        }
        const lerp = 1 - Math.pow(0.001, dt);
        for (const [id, rp] of renderPlayers) {
            if (id === selfId) { rp.x = localPredicted.x; rp.y = localPredicted.y; continue; }
            rp.x += (rp.targetX - rp.x) * lerp;
            rp.y += (rp.targetY - rp.y) * lerp;
        }
        camera.x = localPredicted.x + localPredicted.width / 2 - camera.width / 2;
        camera.y = localPredicted.y + localPredicted.height / 2 - camera.height / 2;
        updateMusic();
    }

    // ---------- Рендер мира ----------
    function drawObstacles() {
        for (const obs of obstacles) {
            if (obs.isTree) {
                ctx.fillStyle = '#1a1410'; ctx.fillRect(obs.centerX - 4, obs.centerY - 2, 8, 15);
                ctx.fillStyle = '#0d1a0d'; ctx.beginPath(); ctx.arc(obs.centerX, obs.centerY - 6, obs.radius, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = '#0a120a'; ctx.beginPath(); ctx.arc(obs.centerX - 4, obs.centerY - 10, obs.radius * 0.7, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = '#050d05'; ctx.beginPath(); ctx.arc(obs.centerX + 5, obs.centerY - 8, obs.radius * 0.6, 0, Math.PI * 2); ctx.fill();
            } else {
                ctx.fillStyle = '#1a1410'; ctx.fillRect(obs.x, obs.y, obs.w, obs.h);
                ctx.fillStyle = '#0d0a08'; ctx.fillRect(obs.x + 3, obs.y + 3, obs.w - 6, obs.h - 6);
                ctx.fillStyle = '#2a1f15'; ctx.beginPath(); ctx.moveTo(obs.x - 8, obs.y); ctx.lineTo(obs.x + obs.w / 2, obs.y - 22); ctx.lineTo(obs.x + obs.w + 8, obs.y); ctx.fill();
            }
        }
    }

    function drawTraps() {
        for (const t of traps) {
            ctx.strokeStyle = '#8a6a3a'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(t.x, t.y, t.radius, 0, Math.PI * 2); ctx.stroke();
            ctx.fillStyle = 'rgba(138,106,58,0.25)';
            ctx.beginPath(); ctx.arc(t.x, t.y, t.radius, 0, Math.PI * 2); ctx.fill();
        }
    }

    const KILLER_COLORS = { forester: '#8b0000' };
    const SURVIVOR_COLORS = { sonya: '#aaccff', mark: '#c9aaff' };

    function drawKiller(p) {
        const cfg = R.PHYSICS_DEFAULTS.killer;
        const mx = p.x, my = p.y, mw = cfg.width, mh = cfg.height;
        const color = KILLER_COLORS[p.characterId] || '#8b0000';
        ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.beginPath(); ctx.ellipse(mx + mw / 2, my + mh - 2, mw / 2, 4, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#4a1010'; ctx.fillRect(mx + 4, my + 6, mw - 8, mh - 12);
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(mx + mw / 2, my + 6, 9, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#000';
        ctx.beginPath(); ctx.arc(mx + mw / 2 - 3, my + 5, 1.5, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(mx + mw / 2 + 3, my + 5, 1.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#2a0a0a';
        ctx.beginPath(); ctx.moveTo(mx + mw / 2 - 6, my); ctx.lineTo(mx + mw / 2 - 10, my - 10); ctx.lineTo(mx + mw / 2 - 2, my - 2); ctx.fill();
        ctx.beginPath(); ctx.moveTo(mx + mw / 2 + 6, my); ctx.lineTo(mx + mw / 2 + 10, my - 10); ctx.lineTo(mx + mw / 2 + 2, my - 2); ctx.fill();

        // Замах: телеграф (жёлтый контур) во время подготовки, полноценный удар (красный) во время активной фазы
        if (p.attackPhase) {
            const character = R.KILLERS[p.characterId];
            const hitbox = P.getAttackHitbox({ x: p.x, y: p.y, width: mw, height: mh, facing: p.facing }, character.m1.hitboxWidth, character.m1.hitboxHeight);
            ctx.strokeStyle = p.attackPhase === 'telegraph' ? 'rgba(230,200,60,0.8)' : 'rgba(255,40,40,0.9)';
            ctx.lineWidth = 2;
            ctx.strokeRect(hitbox.x, hitbox.y, hitbox.w, hitbox.h);
        }

        // Полоска здоровья над убийцей
        drawHealthBar(mx + mw / 2, my - 12, mw, p.health, p.maxHealth, color);
    }

    function drawSurvivor(p) {
        if (p.alive === false) return;
        const cfg = R.PHYSICS_DEFAULTS.survivor;
        const pw = cfg.width, ph = cfg.height, px = p.x, py = p.y;
        const glowColor = SURVIVOR_COLORS[p.characterId] || '#aaccff';
        ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.beginPath(); ctx.ellipse(px + pw / 2, py + ph - 2, pw / 2, 4, 0, 0, Math.PI * 2); ctx.fill();
        ctx.shadowColor = glowColor; ctx.shadowBlur = 20;
        ctx.fillStyle = glowColor; ctx.fillRect(px + 4, py + 6, pw - 8, ph - 12);
        ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
        ctx.fillStyle = '#f5d6a8'; ctx.beginPath(); ctx.arc(px + pw / 2, py + 6, 8, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#4a2c0a'; ctx.beginPath(); ctx.arc(px + pw / 2, py + 3, 8, Math.PI, 2 * Math.PI); ctx.fill();
        ctx.fillStyle = '#4a3620'; ctx.fillRect(px + 6, py + ph - 8, 5, 8); ctx.fillRect(px + pw - 11, py + ph - 8, 5, 8);

        drawHealthBar(px + pw / 2, py - 10, pw, p.health, p.maxHealth, glowColor);
    }

    function drawHealthBar(cx, topY, width, health, maxHealth, color) {
        if (health == null || maxHealth == null) return;
        const w = Math.max(30, width + 10);
        const h = 4;
        const pct = Math.max(0, health / maxHealth);
        ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(cx - w / 2, topY, w, h);
        ctx.fillStyle = color; ctx.fillRect(cx - w / 2, topY, w * pct, h);
    }

    function draw() {
        ctx.fillStyle = '#0a1a0a'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (!gameStarted) return;

        ctx.save();
        ctx.translate(-camera.x, -camera.y);
        ctx.fillStyle = '#0a1a0a'; ctx.fillRect(0, 0, P.WORLD_WIDTH, P.WORLD_HEIGHT);
        ctx.fillStyle = '#0f1f0f';
        for (let i = 0; i < P.WORLD_WIDTH; i += 40) for (let j = 0; j < P.WORLD_HEIGHT; j += 40) if ((Math.floor(i / 40) + Math.floor(j / 40)) % 2 === 0) ctx.fillRect(i, j, 40, 40);

        ctx.strokeStyle = '#2a2a2a'; ctx.lineWidth = 28; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(200, 100); ctx.lineTo(1800, 100); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(100, 800); ctx.lineTo(1900, 800); ctx.stroke();
        ctx.lineWidth = 22; ctx.strokeStyle = '#1f1f1f';
        ctx.beginPath(); ctx.moveTo(500, 0); ctx.lineTo(500, 1500); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(1500, 0); ctx.lineTo(1500, 1500); ctx.stroke();

        drawObstacles();
        // Свои капканы/капканы в радиусе видимости видит и убийца (владелец), и выжившие с бонусом
        if (selfRole === R.ROLE_TYPES.KILLER || traps.length) drawTraps();

        for (const [, p] of renderPlayers) if (p.role === R.ROLE_TYPES.KILLER) drawKiller(p);
        for (const [, p] of renderPlayers) if (p.role === R.ROLE_TYPES.SURVIVOR) drawSurvivor(p);
        ctx.restore();

        drawJoystick();
        drawButtons();
        drawHud();
    }

    function drawJoystick() {
        ctx.fillStyle = 'rgba(40,40,40,0.4)'; ctx.strokeStyle = 'rgba(180,180,180,0.5)'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(joystick.baseX, joystick.baseY, joystick.baseRadius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = 'rgba(200,200,200,0.6)';
        ctx.beginPath(); ctx.arc(joystick.knobX, joystick.knobY, joystick.knobRadius, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#111'; ctx.stroke();
    }

    function drawButtonCircle(b, cooldownRemaining, cooldownTotal, disabledExtra) {
        const onCooldown = cooldownRemaining > 0;
        ctx.fillStyle = onCooldown || disabledExtra ? 'rgba(60,30,30,0.55)' : 'rgba(120,20,20,0.6)';
        ctx.strokeStyle = 'rgba(230,180,140,0.7)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#f0e0d0'; ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(b.label, b.x, b.y);
        if (onCooldown) {
            ctx.fillStyle = '#f0e0d0'; ctx.font = '11px sans-serif';
            ctx.fillText(cooldownRemaining.toFixed(1), b.x, b.y + b.r + 12);
        }
    }

    function drawButtons() {
        if (!gameStarted) return;
        if (selfRole === R.ROLE_TYPES.KILLER) {
            drawButtonCircle(buttons.m1, lastSelfInfo.m1CooldownRemaining || 0, R.KILLERS[selfCharacterId].m1.cooldown, lastSelfInfo.m1Phase);
            drawButtonCircle(buttons.q, lastSelfInfo.qCooldownRemaining || 0, R.KILLERS[selfCharacterId].q.cooldown, (lastSelfInfo.activeTrapCount || 0) >= (lastSelfInfo.maxTraps || 99));
            drawButtonCircle(buttons.e, lastSelfInfo.eCooldownRemaining || 0, R.KILLERS[selfCharacterId].e.cooldown, false);
        } else if (selfRole === R.ROLE_TYPES.SURVIVOR) {
            drawButtonCircle(buttons.f, 0, 0, lastSelfInfo.blocked);
        }
    }

    function drawHud() {
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#d4a373'; ctx.font = '16px sans-serif';
        const character = selfRole ? R.getCharacter(selfRole, selfCharacterId) : null;
        const roleLabel = character ? `${character.name} (${selfRole === R.ROLE_TYPES.KILLER ? 'Убийца' : 'Выживший'})` : '';
        ctx.fillText(roleLabel, 10, 20);
        if (selfRole === R.ROLE_TYPES.SURVIVOR && lastSelfInfo.blocked) {
            ctx.fillStyle = '#c56a6a';
            ctx.fillText('В КАПКАНЕ', 10, 40);
        }
    }

    // ---------- Игровой цикл ----------
    let lastTime = performance.now();
    function gameLoop(timestamp) {
        let dt = (timestamp - lastTime) / 1000;
        if (dt > 0.1) dt = 0.1;
        lastTime = timestamp;
        if (gameStarted) update(dt);
        draw();
        requestAnimationFrame(gameLoop);
    }

    resizeCanvas();
    requestAnimationFrame(gameLoop);
})();
