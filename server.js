// server.js
// Простой мультиплеерный сервер: каждый подключившийся клиент получает кружок-игрока,
// который может ходить по клеточной карте (grid). Синхронизация в реальном времени через WebSocket.

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

// --- Настройки карты ---
const GRID_WIDTH = 20;
const GRID_HEIGHT = 15;

// --- Состояние игры ---
const players = new Map(); // id -> { id, x, y, color, name }
let nextId = 1;

const COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f1c40f',
  '#9b59b6', '#e67e22', '#1abc9c', '#fd79a8'
];

function randomEmptyCell() {
  let x, y, occupied;
  do {
    x = Math.floor(Math.random() * GRID_WIDTH);
    y = Math.floor(Math.random() * GRID_HEIGHT);
    occupied = [...players.values()].some(p => p.x === x && p.y === y);
  } while (occupied);
  return { x, y };
}

// --- Простой статический сервер для index.html (чтобы не поднимать отдельно) ---
const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : 'text/plain';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

function broadcastState() {
  const state = {
    type: 'state',
    players: [...players.values()],
    grid: { width: GRID_WIDTH, height: GRID_HEIGHT }
  };
  const msg = JSON.stringify(state);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

wss.on('connection', (ws) => {
  const id = nextId++;
  const { x, y } = randomEmptyCell();
  const color = COLORS[id % COLORS.length];
  const player = { id, x, y, color, name: `Игрок ${id}` };
  players.set(id, player);

  console.log(`Игрок ${id} подключился (${players.size} онлайн)`);

  // Сообщаем новому клиенту его id и параметры карты
  ws.send(JSON.stringify({ type: 'welcome', id, grid: { width: GRID_WIDTH, height: GRID_HEIGHT } }));
  broadcastState();

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === 'move') {
      const p = players.get(id);
      if (!p) return;

      let { x: nx, y: ny } = p;
      if (data.dir === 'up') ny -= 1;
      else if (data.dir === 'down') ny += 1;
      else if (data.dir === 'left') nx -= 1;
      else if (data.dir === 'right') nx += 1;
      else return;

      // Границы карты
      if (nx < 0 || nx >= GRID_WIDTH || ny < 0 || ny >= GRID_HEIGHT) return;

      // Клетка занята другим игроком — не пускаем
      const occupied = [...players.values()].some(pl => pl.id !== id && pl.x === nx && pl.y === ny);
      if (occupied) return;

      p.x = nx;
      p.y = ny;
      broadcastState();
    }
  });

  ws.on('close', () => {
    players.delete(id);
    console.log(`Игрок ${id} отключился (${players.size} онлайн)`);
    broadcastState();
  });
});

server.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});
