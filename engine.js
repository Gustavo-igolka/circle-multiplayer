// engine.js
// Клиентская часть: сеть (socket.io), рендер на canvas, управление (клавиатура + джойстик),
// адаптация под экран телефона, переключение музыки.
// Зависит от shared/person.js (глобальный PersonModule) и socket.io-client (глобальный io),
// оба подключены в index.html до этого файла.

(function () {
    const P = window.PersonModule;
    const socket = io();

    const canvas = document.getElementById('gameCanvas');
    const ctx = canvas.getContext('2d');

    // ---------- Адаптация canvas под экран телефона/ПК ----------
    // Внутреннее разрешение мира рисуем в фиксированных координатах игры,
    // а сам canvas растягиваем под реальный размер экрана, сохраняя пропорции.
    function resizeCanvas() {
        const isPortrait = window.innerHeight > window.innerWidth;
        const targetW = isPortrait ? Math.min(window.innerWidth, 900) : Math.min(window.innerWidth, 1000);
        const targetH = isPortrait ? Math.min(window.innerHeight * 0.7, 900) : Math.min(window.innerHeight, 750);
        canvas.width = Math.floor(targetW);
        canvas.height = Math.floor(targetH);
        camera.width = canvas.width;
        camera.height = canvas.height;
        updateJoystickBase();
    }
    window.addEventListener('resize', resizeCanvas);
    window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 200));

    const camera = { x: 0, y: 0, width: 800, height: 600 };

    // ---------- Состояние игры ----------
    let selfId = null;
    let selfRole = null;
    let obstacles = [];
    let gameStarted = false;
    let roomCode = null;

    // Локальные сущности для рендера (сглаженные/предсказанные копии людей с сервера)
    const renderPlayers = new Map(); // id -> { x,y,facing,role,alive,name }
    let localPredicted = null; // предсказанная позиция себя для отзывчивого управления

    // ---------- Ввод: клавиатура ----------
    const keys = {
        ArrowUp: false, ArrowDown: false, ArrowLeft: false, ArrowRight: false,
        KeyW: false, KeyS: false, KeyA: false, KeyD: false
    };
    window.addEventListener('keydown', (e) => {
        if (e.code in keys) { e.preventDefault(); keys[e.code] = true; }
    });
    window.addEventListener('keyup', (e) => {
        if (e.code in keys) { e.preventDefault(); keys[e.code] = false; }
    });

    // ---------- Ввод: джойстик (телефон) ----------
    const joystick = {
        active: false, touchId: null,
        baseX: 100, baseY: 460, baseRadius: 55,
        knobX: 100, knobY: 460, knobRadius: 25,
        maxDist: 40, dx: 0, dy: 0
    };
    function updateJoystickBase() {
        joystick.baseX = 90;
        joystick.baseY = canvas.height - 110;
        joystick.knobX = joystick.baseX;
        joystick.knobY = joystick.baseY;
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
        const fdx = joystick.knobX - joystick.baseX;
        const fdy = joystick.knobY - joystick.baseY;
        const fdist = Math.hypot(fdx, fdy);
        if (fdist > 1) { joystick.dx = fdx / joystick.maxDist; joystick.dy = fdy / joystick.maxDist; }
        else { joystick.dx = 0; joystick.dy = 0; }
    }
    function handleTouchStart(e) {
        e.preventDefault();
        for (const touch of e.changedTouches) {
            const { x, y } = getCanvasCoords(touch.clientX, touch.clientY);
            if (Math.hypot(x - joystick.baseX, y - joystick.baseY) <= joystick.baseRadius && !joystick.active) {
                joystick.active = true;
                joystick.touchId = touch.identifier;
                joystick.knobX = x; joystick.knobY = y;
                clampKnob();
                break;
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
                break;
            }
        }
    }
    function handleTouchEnd(e) {
        e.preventDefault();
        if (!joystick.active) return;
        for (const touch of e.changedTouches) {
            if (touch.identifier === joystick.touchId) {
                joystick.active = false; joystick.touchId = null;
                joystick.knobX = joystick.baseX; joystick.knobY = joystick.baseY;
                joystick.dx = 0; joystick.dy = 0;
                break;
            }
        }
    }
    canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
    canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
    canvas.addEventListener('touchend', handleTouchEnd);
    canvas.addEventListener('touchcancel', handleTouchEnd);

    function getInputDirection() {
        if (joystick.active && (joystick.dx !== 0 || joystick.dy !== 0)) {
            return { dx: joystick.dx, dy: joystick.dy };
        }
        let dx = 0, dy = 0;
        if (keys.ArrowUp || keys.KeyW) dy -= 1;
        if (keys.ArrowDown || keys.KeyS) dy += 1;
        if (keys.ArrowLeft || keys.KeyA) dx -= 1;
        if (keys.ArrowRight || keys.KeyD) dx += 1;
        if (dx !== 0 || dy !== 0) {
            const len = Math.hypot(dx, dy);
            dx /= len; dy /= len;
        }
        return { dx, dy };
    }

    // ---------- Сеть: отправка ввода ----------
    let lastSentInput = { dx: 0, dy: 0 };
    setInterval(() => {
        const input = getInputDirection();
        // отправляем при изменении и раз в 150мс как "heartbeat" на случай потери пакета
        socket.emit('input', input);
        lastSentInput = input;
    }, 100);

    // ---------- Музыка ----------
    const bgMusic = document.getElementById('bgMusic');
    const chaseMusic = document.getElementById('chaseMusic');
    let isChasing = false;
    bgMusic.volume = 0.3;
    chaseMusic.volume = 0.5;
    function updateMusic() {
        if (!gameStarted || !localPredicted) return;
        let dist = Infinity;
        if (selfRole === P.ROLES.SURVIVOR) {
            for (const rp of renderPlayers.values()) {
                if (rp.role === P.ROLES.MANIAC) dist = Math.hypot(rp.x - localPredicted.x, rp.y - localPredicted.y);
            }
        } else {
            // Маньяк слышит "погоню", когда рядом живой выживший
            for (const rp of renderPlayers.values()) {
                if (rp.role === P.ROLES.SURVIVOR && rp.alive) {
                    const d = Math.hypot(rp.x - localPredicted.x, rp.y - localPredicted.y);
                    if (d < dist) dist = d;
                }
            }
        }
        const chaseRadius = 350;
        if (dist < chaseRadius && !isChasing) {
            isChasing = true;
            bgMusic.pause();
            chaseMusic.currentTime = 0;
            chaseMusic.play().catch(() => {});
        } else if (dist >= chaseRadius && isChasing) {
            isChasing = false;
            chaseMusic.pause();
            bgMusic.currentTime = 0;
            bgMusic.play().catch(() => {});
        }
    }

    // ---------- Лобби / сеть ----------
    const lobbyOverlay = document.getElementById('lobbyOverlay');
    const nameInput = document.getElementById('playerName');
    const roomCodeInput = document.getElementById('roomCode');
    const createBtn = document.getElementById('createBtn');
    const joinBtn = document.getElementById('joinBtn');
    const startBtn = document.getElementById('startGameBtn');
    const playersListEl = document.getElementById('playersList');
    const roomCodeDisplay = document.getElementById('roomCodeDisplay');
    const statusMsg = document.getElementById('statusMsg');

    createBtn.onclick = () => {
        socket.emit('createRoom', { name: nameInput.value.trim() || 'Игрок' });
        bgMusic.play().catch(() => {});
    };
    joinBtn.onclick = () => {
        const code = roomCodeInput.value.trim();
        if (!code) { statusMsg.textContent = 'Введите код комнаты'; return; }
        socket.emit('joinRoom', { name: nameInput.value.trim() || 'Игрок', code });
        bgMusic.play().catch(() => {});
    };
    startBtn.onclick = () => socket.emit('startGame');

    socket.on('joined', ({ code }) => {
        roomCode = code;
        roomCodeDisplay.textContent = `Код комнаты: ${code}`;
        statusMsg.textContent = '';
    });
    socket.on('errorMsg', (msg) => { statusMsg.textContent = msg; });
    socket.on('lobbyUpdate', ({ players, canStart }) => {
        playersListEl.innerHTML = players.length
            ? players.map(p => `<div>👤 ${p.name}</div>`).join('')
            : '<div style="color:#555;">Ожидание игроков...</div>';
        startBtn.style.display = canStart ? 'block' : 'none';
    });

    socket.on('gameStart', (data) => {
        selfId = socket.id;
        obstacles = data.obstacles;
        const self = data.players.find(p => p.id === selfId);
        selfRole = self ? self.role : P.ROLES.SURVIVOR;
        camera.width = canvas.width; camera.height = canvas.height;
        lobbyOverlay.style.display = 'none';
        gameStarted = true;
        localPredicted = null;
        renderPlayers.clear();
    });

    socket.on('state', (data) => {
        for (const p of data.players) {
            if (p.id === selfId) {
                if (!localPredicted) {
                    localPredicted = { x: p.x, y: p.y, facing: p.facing, vx: 0, vy: 0,
                        width: P.ROLE_CONFIG[selfRole].width, height: P.ROLE_CONFIG[selfRole].height,
                        speed: P.ROLE_CONFIG[selfRole].speed, acceleration: P.ROLE_CONFIG[selfRole].acceleration,
                        friction: P.ROLE_CONFIG[selfRole].friction, alive: true };
                }
                // Мягкая коррекция предсказанной позиции к авторитетной серверной (лечит рассинхрон/пинг)
                localPredicted.x += (p.x - localPredicted.x) * 0.2;
                localPredicted.y += (p.y - localPredicted.y) * 0.2;
                localPredicted.alive = p.alive;
                renderPlayers.set(p.id, { x: localPredicted.x, y: localPredicted.y, facing: p.facing, role: p.role, alive: p.alive, name: 'Вы', targetX: p.x, targetY: p.y });
            } else {
                const prev = renderPlayers.get(p.id);
                renderPlayers.set(p.id, {
                    x: prev ? prev.x : p.x, y: prev ? prev.y : p.y,
                    facing: p.facing, role: p.role, alive: p.alive,
                    targetX: p.x, targetY: p.y
                });
            }
        }
    });

    socket.on('playerLeft', ({ id }) => renderPlayers.delete(id));

    socket.on('gameOver', ({ winner, reason }) => {
        gameStarted = false;
        statusMsg.textContent = winner === 'maniac' ? `Маньяк победил: ${reason}` : `Выжившие спаслись: ${reason}`;
        lobbyOverlay.style.display = 'flex';
        startBtn.style.display = 'none';
        bgMusic.pause(); chaseMusic.pause();
    });

    // ---------- Обновление (предсказание + сглаживание) ----------
    function update(dt) {
        if (!localPredicted) return;
        if (localPredicted.alive !== false) {
            const input = getInputDirection();
            P.stepPerson(localPredicted, input, dt, obstacles);
        }
        // Плавно подтягиваем остальных игроков к их последней серверной позиции
        const lerp = 1 - Math.pow(0.001, dt); // ~экспоненциальное сглаживание, устойчиво к колебаниям пинга
        for (const [id, rp] of renderPlayers) {
            if (id === selfId) { rp.x = localPredicted.x; rp.y = localPredicted.y; continue; }
            rp.x += (rp.targetX - rp.x) * lerp;
            rp.y += (rp.targetY - rp.y) * lerp;
        }
        camera.x = localPredicted.x + localPredicted.width / 2 - camera.width / 2;
        camera.y = localPredicted.y + localPredicted.height / 2 - camera.height / 2;
        updateMusic();
    }

    // ---------- Рендер ----------
    function drawObstacles() {
        for (const obs of obstacles) {
            if (obs.isTree) {
                ctx.fillStyle = '#1a1410';
                ctx.fillRect(obs.centerX - 4, obs.centerY - 2, 8, 15);
                ctx.fillStyle = '#0d1a0d';
                ctx.beginPath(); ctx.arc(obs.centerX, obs.centerY - 6, obs.radius, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = '#0a120a';
                ctx.beginPath(); ctx.arc(obs.centerX - 4, obs.centerY - 10, obs.radius * 0.7, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = '#050d05';
                ctx.beginPath(); ctx.arc(obs.centerX + 5, obs.centerY - 8, obs.radius * 0.6, 0, Math.PI * 2); ctx.fill();
            } else {
                ctx.fillStyle = '#1a1410';
                ctx.fillRect(obs.x, obs.y, obs.w, obs.h);
                ctx.fillStyle = '#0d0a08';
                ctx.fillRect(obs.x + 3, obs.y + 3, obs.w - 6, obs.h - 6);
                ctx.fillStyle = '#2a1f15';
                ctx.beginPath(); ctx.moveTo(obs.x - 8, obs.y); ctx.lineTo(obs.x + obs.w / 2, obs.y - 22); ctx.lineTo(obs.x + obs.w + 8, obs.y); ctx.fill();
            }
        }
    }

    function drawManiac(m) {
        const mx = m.x, my = m.y, mw = P.ROLE_CONFIG.maniac.width, mh = P.ROLE_CONFIG.maniac.height;
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.beginPath(); ctx.ellipse(mx + mw / 2, my + mh - 2, mw / 2, 4, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#4a1010';
        ctx.fillRect(mx + 4, my + 6, mw - 8, mh - 12);
        ctx.fillStyle = '#8b0000';
        ctx.beginPath(); ctx.arc(mx + mw / 2, my + 6, 9, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#000';
        ctx.beginPath(); ctx.arc(mx + mw / 2 - 3, my + 5, 1.5, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(mx + mw / 2 + 3, my + 5, 1.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#2a0a0a';
        ctx.beginPath(); ctx.moveTo(mx + mw / 2 - 6, my); ctx.lineTo(mx + mw / 2 - 10, my - 10); ctx.lineTo(mx + mw / 2 - 2, my - 2); ctx.fill();
        ctx.beginPath(); ctx.moveTo(mx + mw / 2 + 6, my); ctx.lineTo(mx + mw / 2 + 10, my - 10); ctx.lineTo(mx + mw / 2 + 2, my - 2); ctx.fill();
    }

    function drawSurvivor(p, glowColor) {
        if (p.alive === false) return; // пойманных выживших не рисуем
        const pw = P.ROLE_CONFIG.survivor.width, ph = P.ROLE_CONFIG.survivor.height;
        const px = p.x, py = p.y;
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.beginPath(); ctx.ellipse(px + pw / 2, py + ph - 2, pw / 2, 4, 0, 0, Math.PI * 2); ctx.fill();
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = 20;
        ctx.fillStyle = glowColor;
        ctx.fillRect(px + 4, py + 6, pw - 8, ph - 12);
        ctx.shadowBlur = 0;
        ctx.shadowColor = 'transparent';
        ctx.fillStyle = '#f5d6a8';
        ctx.beginPath(); ctx.arc(px + pw / 2, py + 6, 8, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#4a2c0a';
        ctx.beginPath(); ctx.arc(px + pw / 2, py + 3, 8, Math.PI, 2 * Math.PI); ctx.fill();
        ctx.fillStyle = '#4a3620';
        ctx.fillRect(px + 6, py + ph - 8, 5, 8);
        ctx.fillRect(px + pw - 11, py + ph - 8, 5, 8);
    }

    const SURVIVOR_COLORS = ['#aaccff', '#c9aaff', '#aaffcf'];
    function colorForId(id, index) {
        return SURVIVOR_COLORS[index % SURVIVOR_COLORS.length];
    }

    function draw() {
        ctx.fillStyle = '#0a1a0a';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (!gameStarted) return;

        ctx.save();
        ctx.translate(-camera.x, -camera.y);

        ctx.fillStyle = '#0a1a0a';
        ctx.fillRect(0, 0, P.WORLD_WIDTH, P.WORLD_HEIGHT);
        ctx.fillStyle = '#0f1f0f';
        for (let i = 0; i < P.WORLD_WIDTH; i += 40)
            for (let j = 0; j < P.WORLD_HEIGHT; j += 40)
                if ((Math.floor(i / 40) + Math.floor(j / 40)) % 2 === 0) ctx.fillRect(i, j, 40, 40);

        ctx.strokeStyle = '#2a2a2a'; ctx.lineWidth = 28; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(200, 100); ctx.lineTo(1800, 100); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(100, 800); ctx.lineTo(1900, 800); ctx.stroke();
        ctx.lineWidth = 22; ctx.strokeStyle = '#1f1f1f';
        ctx.beginPath(); ctx.moveTo(500, 0); ctx.lineTo(500, 1500); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(1500, 0); ctx.lineTo(1500, 1500); ctx.stroke();

        drawObstacles();

        let survivorIdx = 0;
        for (const [id, p] of renderPlayers) {
            if (p.role === P.ROLES.MANIAC) drawManiac(p);
        }
        for (const [id, p] of renderPlayers) {
            if (p.role === P.ROLES.SURVIVOR) {
                drawSurvivor(p, colorForId(id, survivorIdx));
                survivorIdx++;
            }
        }
        ctx.restore();

        // Джойстик поверх всего
        ctx.fillStyle = 'rgba(40,40,40,0.4)';
        ctx.strokeStyle = 'rgba(180,180,180,0.5)';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(joystick.baseX, joystick.baseY, joystick.baseRadius, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = 'rgba(200,200,200,0.6)';
        ctx.beginPath(); ctx.arc(joystick.knobX, joystick.knobY, joystick.knobRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#111'; ctx.stroke();

        // Таймер / роль
        ctx.fillStyle = '#d4a373';
        ctx.font = '16px sans-serif';
        ctx.fillText(selfRole === P.ROLES.MANIAC ? 'Вы: МАНЬЯК' : 'Вы: Выживший', 10, 20);
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
