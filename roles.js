// roles.js
// База данных персонажей: убийцы (killer) и выжившие (survivor).
// Работает и в браузере (window.RolesModule), и в Node (require).
// Чтобы добавить нового персонажа — просто дописать объект в KILLERS или SURVIVORS,
// остальной код (server.js/engine.js) уже умеет работать с любым количеством персонажей.

(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.RolesModule = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {

    const ROLE_TYPES = { KILLER: 'killer', SURVIVOR: 'survivor' };

    // Общая физика хитбокса тела и разгона — одинаковая для всех персонажей одного типа роли.
    // Индивидуальным для персонажа остаётся только speed (задаётся в самом персонаже).
    const PHYSICS_DEFAULTS = {
        killer: { width: 32, height: 32, acceleration: 850, friction: 0.88 },
        survivor: { width: 28, height: 28, acceleration: 900, friction: 0.88 }
    };

    // Базовый радиус, на котором капканы видны выжившим без бонусных способностей
    const TRAP_BASE_VISION_RADIUS = 100;

    const KILLERS = {
        forester: {
            id: 'forester',
            name: 'Лесник',
            description: 'Бывший егерь, который остался в этом лесу навсегда. Не бежит быстрее жертвы — он просто знает лес лучше и не даёт из него выбраться.',
            health: 500,
            speed: 210,
            m1: {
                name: 'Удар топором',
                damage: 25,
                hitboxWidth: 55,
                hitboxHeight: 35,
                cooldown: 2,          // сек, после завершения удара
                telegraphTime: 0.5,   // сек до появления хитбокса ("запах")
                activeTime: 0.7       // сек, сколько хитбокс активен и приклеен к убийце
            },
            q: {
                name: 'Капкан',
                type: 'trap',
                radius: 20,            // радиус срабатывания хитбокса капкана
                slowDuration: 4,       // сек полной блокировки движения при срабатывании
                maxActive: 2,          // максимум одновременно расставленных капканов
                lifetime: 60,          // сек, через которые неиспользованный капкан исчезает
                cooldown: 8            // сек между установками нового капкана
            },
            e: {
                name: 'Чутьё',
                type: 'reveal',
                radius: 400,           // радиус обнаружения выживших
                revealDuration: 3,     // сек подсветки
                cooldown: 20           // сек перезарядки
            }
        }
    };

    const SURVIVORS = {
        sonya: {
            id: 'sonya',
            name: 'Соня',
            description: 'Бегает быстро, думает не всегда — надеется на ноги, а не на голову.',
            health: 100,
            speed: 235,
            passive: {
                type: 'adrenaline',
                name: 'Адреналин',
                speedBoostPct: 0.15,  // +15% к скорости
                duration: 2,          // сек действия ускорения после удара
                cooldown: 15          // сек, раз в сколько может сработать заново
            }
        },
        mark: {
            id: 'mark',
            name: 'Марк',
            description: 'Медленный, но внимательный — видит то, что другие проходят мимо.',
            health: 100,
            speed: 205,
            passive: {
                type: 'trap_sense',
                name: 'Чутьё на угрозу',
                // Любой персистентный объект-способность убийцы (капкан, метка, зона и т.д.)
                // виден на visionBonusPct дальше, чем обычным выжившим.
                // Не относится к мгновенным действиям вроде M1-удара.
                visionBonusPct: 0.4
            }
        }
    };

    function getCharacter(role, characterId) {
        return role === ROLE_TYPES.KILLER ? KILLERS[characterId] : SURVIVORS[characterId];
    }

    // Порядок персонажей для автоназначения при старте матча
    const KILLER_ORDER = Object.keys(KILLERS);
    const SURVIVOR_ORDER = Object.keys(SURVIVORS);

    return {
        ROLE_TYPES, PHYSICS_DEFAULTS, TRAP_BASE_VISION_RADIUS,
        KILLERS, SURVIVORS, getCharacter, KILLER_ORDER, SURVIVOR_ORDER
    };
});
