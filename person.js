// person.js
// Физика и создание персонажа. Характеристики (здоровье/скорость/способности)
// берутся из roles.js по связке (role, characterId).
// Работает и в браузере, и в Node.

(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./roles.js'));
    } else {
        root.PersonModule = factory(root.RolesModule);
    }
})(typeof self !== 'undefined' ? self : this, function (Roles) {

    const WORLD_WIDTH = 2000;
    const WORLD_HEIGHT = 1500;

    function createPerson(id, name, role, characterId) {
        const character = Roles.getCharacter(role, characterId);
        const phys = Roles.PHYSICS_DEFAULTS[role];
        return {
            id, name, role, characterId,
            x: WORLD_WIDTH / 2 + (Math.random() * 100 - 50),
            y: WORLD_HEIGHT / 2 + (Math.random() * 100 - 50),
            width: phys.width,
            height: phys.height,
            vx: 0, vy: 0,
            speed: character.speed,
            acceleration: phys.acceleration,
            friction: phys.friction,
            facing: 'down',
            health: character.health,
            maxHealth: character.health,
            alive: true
        };
    }

    // Препятствия — дома и деревья
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

    function resolveCollision(rect, obstacles) {
        for (const obs of obstacles) {
            if (obs.isTree) {
                const distX = rect.x + rect.w / 2 - obs.centerX;
                const distY = rect.y + rect.h / 2 - obs.centerY;
                const distance = Math.sqrt(distX * distX + distY * distY);
                const minDist = obs.radius + rect.w / 2;
                if (distance < minDist) {
                    if (distance === 0) { rect.y = obs.centerY - minDist; continue; }
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

    // input: { dx, dy } нормализованное направление.
    // options: { speedMultiplier = 1, frozen = false } — для пассивок/капканов.
    function stepPerson(person, input, deltaTime, obstacles, options) {
        options = options || {};
        const speedMultiplier = options.speedMultiplier || 1;
        const frozen = !!options.frozen;

        if (!person.alive) return;

        const dx = (!frozen && input) ? input.dx : 0;
        const dy = (!frozen && input) ? input.dy : 0;
        const effectiveSpeed = person.speed * speedMultiplier;

        if (dx !== 0 || dy !== 0) {
            person.vx += dx * person.acceleration * deltaTime;
            person.vy += dy * person.acceleration * deltaTime;
            const spd = Math.hypot(person.vx, person.vy);
            if (spd > effectiveSpeed) {
                person.vx = (person.vx / spd) * effectiveSpeed;
                person.vy = (person.vy / spd) * effectiveSpeed;
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

    // Прямоугольник M1-удара перед персонажем, по направлению facing
    function getAttackHitbox(person, hitboxWidth, hitboxHeight) {
        const cx = person.x + person.width / 2;
        const cy = person.y + person.height / 2;
        switch (person.facing) {
            case 'left': return { x: cx - person.width / 2 - hitboxWidth, y: cy - hitboxHeight / 2, w: hitboxWidth, h: hitboxHeight };
            case 'right': return { x: cx + person.width / 2, y: cy - hitboxHeight / 2, w: hitboxWidth, h: hitboxHeight };
            case 'up': return { x: cx - hitboxHeight / 2, y: cy - person.height / 2 - hitboxWidth, w: hitboxHeight, h: hitboxWidth };
            default: return { x: cx - hitboxHeight / 2, y: cy + person.height / 2, w: hitboxHeight, h: hitboxWidth };
        }
    }

    function rectsOverlap(a, b) {
        return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    }

    return {
        WORLD_WIDTH, WORLD_HEIGHT,
        createPerson, generateObstacles, resolveCollision, stepPerson,
        distance, getAttackHitbox, rectsOverlap
    };
});
