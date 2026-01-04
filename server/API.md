# API документация сервера игры

## Подключение к серверу

```javascript
const socket = io('http://localhost:8080');
```

## Авторизация

### Вход игрока

**Событие:** `player:auth`

**Запрос:**
```javascript
socket.emit('player:auth', {
  name: 'Иван',
  password: 'game'
}, (response) => {
  if (response.success) {
    console.log('Игрок авторизован:', response.player);
    console.log('Состояние игры:', response.gameState);
  } else {
    console.error('Ошибка:', response.error);
  }
});
```

**Ответ при успехе:**
```javascript
{
  success: true,
  player: {
    id: "uuid",
    displayName: "Иван #1",
    firstName: "Иван",
    antColor: "blue",
    position: { currentCell: "cell-start", ... },
    playerEnteredFinances: { ... },
    assets: { ... }
  },
  gameState: {
    status: "waiting|in_progress|finished",
    players: { ... },
    curator: { ... }
  }
}
```

### Вход куратора

**Событие:** `curator:auth`

**Запрос:**
```javascript
socket.emit('curator:auth', {
  name: 'Саидмурод',
  password: 'game'
}, (response) => {
  if (response.success) {
    console.log('Куратор авторизован:', response.curator);
    console.log('Отчет:', response.report);
  }
});
```

---

## События куратора

### Начать игру

**Событие:** `curator:start_game`

```javascript
socket.emit('curator:start_game', (response) => {
  if (response.success) {
    console.log('Игра началась');
  }
});
```

**Broadcast всем клиентам:** `game:started`

### Завершить игру

**Событие:** `curator:end_game`

```javascript
socket.emit('curator:end_game', (response) => {
  if (response.success) {
    console.log('Отчет:', response.report);
  }
});
```

**Broadcast всем клиентам:** `game:ended`

### Получить отчет

**Событие:** `curator:get_report`

```javascript
socket.emit('curator:get_report', (response) => {
  if (response.success) {
    console.log('Отчет:', response.report);
  }
});
```

---

## События игрока

### Бросить кубик

**Событие:** `player:request_roll`

```javascript
socket.emit('player:request_roll', (response) => {
  if (response.success) {
    console.log('Результат броска:', response.result); // 1-6
  }
});
```

**Broadcast всем клиентам:** `player:dice_rolled`
```javascript
socket.on('player:dice_rolled', (data) => {
  console.log(`${data.playerName} бросил кубик: ${data.result}`);
});
```

### Переместиться

**Событие:** `player:move`

```javascript
socket.emit('player:move', {
  steps: 5
}, (response) => {
  if (response.success) {
    console.log('Результат перемещения:', response.result);
    // result.cellType - тип ячейки
    // result.card - карточка (если вытянута)
    // result.action - действие ('monthly_income', 'draw_card', 'choose_path')
  }
});
```

**Broadcast всем клиентам:** `player:moved`
```javascript
socket.on('player:moved', (data) => {
  console.log(`${data.playerName} переместился на ${data.position.currentCell}`);
  console.log('Результат ячейки:', data.cellResult);
});
```

### Обновить финансовую карточку

**Событие:** `player:update_finances`

```javascript
socket.emit('player:update_finances', {
  monthlyIncome: 100,
  monthlyExpenses: 50,
  wallets: {
    charity: 10,
    dream: 20,
    savings: 10,
    investments: 60
  },
  capital: 0
}, (response) => {
  if (response.success) {
    console.log('Сравнение:', response.comparison);
    if (response.comparison.hasDiscrepancies) {
      console.warn('Есть расхождения!', response.comparison.discrepancies);
    }
  }
});
```

---

## События от сервера (для прослушивания)

### Обновление состояния игры

```javascript
socket.on('game:state_update', (state) => {
  console.log('Состояние игры обновлено:', state);
  // state.players - все игроки
  // state.status - статус игры
});
```

### Игра началась

```javascript
socket.on('game:started', (state) => {
  console.log('Игра началась!');
});
```

### Игра завершена

```javascript
socket.on('game:ended', (data) => {
  console.log(data.message);
  console.log('Отчет:', data.report);
});
```

### Бросок кубика другим игроком

```javascript
socket.on('player:dice_rolled', (data) => {
  // data.playerId
  // data.playerName
  // data.result (1-6)
});
```

### Перемещение другого игрока

```javascript
socket.on('player:moved', (data) => {
  // data.playerId
  // data.playerName
  // data.position
  // data.cellResult
});
```

---

## Специальные события для куратора

### Игрок присоединился

```javascript
socket.on('curator:player_joined', (player) => {
  console.log('Новый игрок:', player);
});
```

### Игрок покинул игру

```javascript
socket.on('curator:player_left', (data) => {
  console.log(`${data.playerName} покинул игру`);
});
```

### Обновление истории

```javascript
socket.on('curator:history_update', (historyEntry) => {
  console.log('Новое действие:', historyEntry);
});
```

### Найдено расхождение

```javascript
socket.on('curator:discrepancy_found', (data) => {
  console.warn(`У ${data.playerName} расхождение в финансах!`);
  console.log('Детали:', data.comparison);
});
```

---

## Структура данных

### Player
```javascript
{
  id: "uuid",
  displayName: "Иван #1",
  firstName: "Иван",
  lastName: null,
  antColor: "blue",
  joinedAt: "2025-12-08T16:00:00Z",
  socketId: "socket-id",
  isActive: true,
  
  position: {
    currentCell: "cell-start",
    cellIndex: 0,
    circle: "long", // "short" | "long"
    canPlayBothCircles: false
  },
  
  playerEnteredFinances: {
    monthlyIncome: 0,
    monthlyExpenses: 0,
    wallets: {
      charity: 0,
      dream: 0,
      savings: 0,
      investments: 0
    },
    capital: 0
  },
  
  assets: {
    businesses: [],
    skills: [],
    dream: null
  },
  
  activeCards: {
    news: [],
    expenses: []
  },
  
  partnerships: [],
  debts: []
}
```

### GameState
```javascript
{
  status: "waiting|in_progress|finished",
  startedAt: "2025-12-08T16:00:00Z",
  curator: {
    id: "uuid",
    name: "Саидмурод",
    connectedAt: "2025-12-08T16:00:00Z"
  },
  players: {
    "player-id": { /* Player object */ }
  },
  currentTurn: "player-id"
}
```

---

## Переменные окружения

Для развертывания на Render.com установите следующие переменные:

- `GAME_PASSWORD` - пароль для входа в игру (по умолчанию: "game")
- `PORT` - порт сервера (по умолчанию: 8080)

**Важно:** На Render.com переменные устанавливаются в разделе Environment Variables, НЕ в коде!
