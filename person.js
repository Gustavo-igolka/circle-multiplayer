// person.js
// Общий модуль для описания персонажа (Маньяк или Выживший) и его физики.
// Работает и в браузере (<script src="/shared/person.js">), и в Node (require).

(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.PersonModule = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {

    const WORLD_WIDTH = 2000;
    const WORLD_HEIGHT = 1500;

    const ROLES = {
        MANIAC: 'maniac',
        SURVIVOR: 'survivor'
    };

    // Параметры движения по роли
    const ROLE_CONFIG = {
        maniac: { width: 32, height: 32, speed: 195, acceleration: 850, friction: 0.88 },
        survivor: { width: 28, height: 28, speed: 220, acceleration: 900, friction: 0.88 }
    };

    const KILL_RADIUS = 30;

    function createPerson(id, name, role) {
        const cfg = ROLE_CONFIG[role] || ROLE_CONFIG.survivor;
        return {
            id,
            name,
            role,
            x: WORLD_WIDTH / 2 + (Math.random() * 100 - 50),
            y: WORLD_HEIGHT / 2 + (Math.random() * 100 - 50),
            width: cfg.width,
            height: cfg.height,
            vx: 0, vy: 0,
            speed: cfg.speed,
            acceleration: cfg.acceleration,
            friction: cfg.friction,
            facing: 'down',
            alive: true // для выживших: false = пойман
        };
    }

    // Препятствия — дома и деревья (те же координаты, что были в исходном index.html)
    function generateObstacles() {
        const obstacles = [];
        const houses = [
            { x: 400, y: 300, w: 90, h: 70 },
            { x: 1200, y: 200, w: 100, h: 80 },
            { x: 800, y: 900, w: 85, h: 75 },
            { x: 1500, y: 1000, w: 95, h: 80 },
            { x: 300, y: 1100, w: 90, h: 70 },
            { x: 1600, y: 400, w: 80, h: 75 },
            { x: 500, y: 700, w: 100, h: 80 },
            { x: 1100, y: 600, w: 85, h: 70 }
        ];
        houses.forEach(h => obstacles.push(h));

        const treePositions = [
            { x: 200, y: 150 }, { x: 600, y: 120 }, { x: 1000, y: 180 }, { x: 1400, y: 150 },
            { x: 1800, y: 250 }, { x: 150, y: 500 }, { x: 350, y: 600 }, { x: 700, y: 550 },
            { x: 1300, y: 500 }, { x: 1700, y: 650 }, { x: 100, y: 900 }, { x: 600, y: 1000 },
            { x: 1000, y: 1050 }, { x: 1400, y: 900 }, { x: 1800, y: 1100 }, { x: 1600, y: 1300 },
            { x: 900, y: 300 }, { x: 450, y: 450 }, { x: 1200, y: 1100 }, { x: 200, y: 1300 },
            { x: 800, y: 1300 }, { x: 1600, y: 800 }, { x: 500, y: 1250 }, { x: 1300, y: 1300 }
        ];
        treePositions.forEach(pos => {
            obstacles.push({
                x: pos.x - 18, y: pos.y - 18,
                w: 36, h: 36,
                isTree: true,
                centerX: pos.x, centerY: pos.y,
                radius: 18
            });
        });
        return obstacles;
    }

    // Разрешение столкновений с препятствиями (мутирует rect)
    function resolveCollision(rect, obstacles) {
        for (const obs of obstacles) {
            if (obs.isTree) {
                const distX = rect.x + rect.w / 2 - obs.centerX;
                const distY = rect.y + rect.h / 2 - obs.centerY;
                const distance = Math.sqrt(distX * distX + distY * distY);
                const minDist = obs.radius + rect.w / 2;
                if (distance < minDist) {
                    if (distance === 0) {
                        rect.y = obs.centerY - minDist;
                        continue;
                    }
                    const angle = Math.atan2(distY, distX);
                    const overlap = minDist - distance;
                    rect.x += Math.cos(angle) * overlap;
                    rect.y += Math.sin(angle) * overlap;
                }
            } else {
                if (rect.x < obs.x + obs.w && rect.x + rect.w > obs.x &&
                    rect.y < obs.y + obs.h && rect.y + rect.h > obs.y) {
                    const overlapLeft = (rect.x + rect.w) - obs.x;
                    const overlapRight = (obs.x + obs.w) - rect.x;
                    const overlapTop = (rect.y + rect.h) - obs.y;
                    const overlapBottom = (obs.y + obs.h) - rect.y;
                    const minOverlapX = Math.min(overlapLeft, overlapRight);
                    const minOverlapY = Math.min(overlapTop, overlapBottom);
                    if (minOverlapX < minOverlapY) {
                        rect.x = overlapLeft < overlapRight ? obs.x - rect.w : obs.x + obs.w;
                    } else {
                        rect.y = overlapTop < overlapBottom ? obs.y - rect.h : obs.y + obs.h;
                    }
                }
            }
        }
    }

    // input: { dx, dy } нормализованный вектор направления (-1..1)
    // Обновляет скорость, направление взгляда, позицию и коллизии персонажа за deltaTime секунд.
    function stepPerson(person, input, deltaTime, obstacles) {
        if (!person.alive) return;

        const dx = input ? input.dx : 0;
        const dy = input ? input.dy : 0;

        if (dx !== 0 || dy !== 0) {
            person.vx += dx * person.acceleration * deltaTime;
            person.vy += dy * person.acceleration * deltaTime;
            const spd = Math.hypot(person.vx, person.vy);
            if (spd > person.speed) {
                person.vx = (person.vx / spd) * person.speed;
                person.vy = (person.vy / spd) * person.speed;
            }
            if (Math.abs(dx) > Math.abs(dy)) person.facing = dx > 0 ? 'right' : 'left';
            else person.facing = dy > 0 ? 'down' : 'up';
        } else {
            person.vx *= person.friction;
            person.vy *= person.friction;
            if (Math.abs(person.vx) < 0.5) person.vx = 0;
            if (Math.abs(person.vy) < 0.5) person.vy = 0;
        }

        const newX = person.x + person.vx * deltaTime;
        const newY = person.y + person.vy * deltaTime;
        const rect = { x: newX, y: newY, w: person.width, h: person.height };
        resolveCollision(rect, obstacles);
        person.x = Math.max(0, Math.min(WORLD_WIDTH - person.width, rect.x));
        person.y = Math.max(0, Math.min(WORLD_HEIGHT - person.height, rect.y));
        if (person.x <= 0 || person.x >= WORLD_WIDTH - person.width) person.vx = 0;
        if (person.y <= 0 || person.y >= WORLD_HEIGHT - person.height) person.vy = 0;
    }

    function distance(a, b) {
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    return {
        WORLD_WIDTH,
        WORLD_HEIGHT,
        ROLES,
        ROLE_CONFIG,
        KILL_RADIUS,
        createPerson,
        generateObstacles,
        resolveCollision,
        stepPerson,
        distance
    };
});
