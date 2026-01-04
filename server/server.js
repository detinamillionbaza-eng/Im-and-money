require('dotenv').config();
const http = require('http');
const { Server } = require('socket.io');
const gameState = require('./models/GameState');
const board = require('./board');
const cellsData = require('./data/cells.json');

// Конфигурация
const PORT = process.env.PORT || 8080;
const GAME_PASSWORD = process.env.GAME_PASSWORD || 'game';

// Создать HTTP сервер
const server = http.createServer((req, res) => {
    // Обработка /ping для UptimeRobot и Render Health Check
    if (req.method === 'GET' && req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('pong');
        return;
    }

    // Для всех остальных запросов (если сервер не раздает статику)
    res.writeHead(404);
    res.end();
});

// Создать Socket.IO сервер
const io = new Server(server, {
    cors: {
        origin: "*", // В продакшене указать конкретный домен
        methods: ["GET", "POST"]
    }
});

console.log('🚀 Сервер запускается...');
console.log(`📝 Пароль игры: ${GAME_PASSWORD}`);

// Хелпер для логов
const broadcastGameLog = (logData) => {
    io.emit('game:log', logData);
};

// === ТАЙМЕРА ХОДА (3 минуты) ===
const TURN_TIMEOUT_MS = 3 * 60 * 1000; // 3 минуты
const turnTimers = {}; // { playerId: timerId }

// Функция установки таймера на ход
function startTurnTimer(playerId) {
    // Очищаем предыдущий таймер если есть
    if (turnTimers[playerId]) {
        clearTimeout(turnTimers[playerId]);
    }

    turnTimers[playerId] = setTimeout(() => {
        const player = gameState.players[playerId];
        if (player && gameState.currentPlayer === playerId) {
            // Время вышло - помечаем игрока как спящего
            player.isSleeping = true;
            console.log(`💤 ${player.displayName} уснул (таймаут 3 минуты)`);

            io.emit('game:log', {
                text: `💤 ${player.displayName} уснул - время хода истекло!`,
                type: 'warning'
            });

            io.emit('game:player_sleeping', { playerId, playerName: player.displayName });

            // Передаём ход следующему
            triggerNextTurn();

            // Скрываем карточку у всех
            io.emit('game:card_hide');
        }
    }, TURN_TIMEOUT_MS);

    console.log(`⏱️ Таймер хода запущен для ${gameState.players[playerId]?.displayName} (3 мин)`);
}

// Функция отмены таймера
function clearTurnTimer(playerId) {
    if (turnTimers[playerId]) {
        clearTimeout(turnTimers[playerId]);
        delete turnTimers[playerId];
    }
}

// Внедряем логгер в GameState
gameState.setLogger(broadcastGameLog);

/**
 * ПЕРЕДАТЬ ХОД (с проверкой на интерактивный пропуск)
 */
function triggerNextTurn() {
    const nextPlayerId = gameState.nextTurn();
    const nextPlayer = gameState.players[nextPlayerId];

    if (nextPlayer && nextPlayer.status.skippedTurns > 0) {
        console.log(`⏩ [Interactive Skip] Triggering modal for ${nextPlayer.displayName}`);
        const skipData = cellsData['skip_turn_generic'];

        // Личное событие игроку через его socketId
        // Используем io.to(socketId) чтобы достучаться до конкретного игрока
        io.to(nextPlayer.socketId).emit('game:cell_event', {
            title: skipData.title,
            description: skipData.description_self.replace('{value}', nextPlayer.status.skippedTurns),
            action: 'interactive_skip',
            endTurn: true // По нажатию OK будет вызван finishTurn (или спец событие)
        });

        // Уведомление остальным
        const msgOthers = skipData.description_others
            .replace('{player}', nextPlayer.displayName)
            .replace('{value}', nextPlayer.status.skippedTurns);

        // Рассылаем всем кроме этого игрока? Или просто всем?
        // Notification обычно всем. Но у нас Unified Queue, так что всем норм.
        io.emit('game:notification', {
            title: skipData.title,
            message: msgOthers,
            playerName: nextPlayer.displayName,
            type: 'info'
        });
    }

    io.emit('game:state_update', gameState.getState());
}

/**
 * Подключение клиента
 */
io.on('connection', (socket) => {
    console.log(`🔌 Новое подключение: ${socket.id}`);

    let playerId = null;
    let isCurator = false;

    /**
     * АВТОРИЗАЦИЯ: Вход игрока
     */
    socket.on('player:auth', (data, callback) => {
        const { name, password } = data;

        // Настройки паролей
        const CURATOR_PASSWORD = process.env.CURATOR_PASSWORD || 'curator';

        // 1. ПРОВЕРКА: ЭТО КУРАТОР?
        if (password === CURATOR_PASSWORD) {
            try {
                // Подключить куратора
                const curator = gameState.connectCurator({
                    name,
                    socketId: socket.id
                });
                isCurator = true;
                console.log(`✅ Куратор (невидимка) авторизован: ${curator.name}`);

                callback({
                    success: true,
                    role: 'curator', // Маркер роли для клиента
                    curator,
                    gameState: gameState.getState(),
                    report: gameState.generateReport()
                });
                return;
            } catch (error) {
                console.error('❌ Ошибка авторизации куратора:', error.message);
                callback({ success: false, error: error.message });
                return;
            }
        }

        // 2. ПРОВЕРКА: ЭТО ИГРОК?
        if (password !== GAME_PASSWORD) {
            console.warn(`⛔ Неверный пароль от ${name}`);
            callback({
                success: false,
                error: 'Неверный пароль'
            });
            return;
        }

        try {
            // Проверка статуса игры
            if (gameState.status === 'finished') {
                callback({
                    success: false,
                    error: 'Игра завершена. Дождитесь новой игры.'
                });
                return;
            }

            // 1. РЕГИСТРАЦИЯ ИГРОКА (СЕРВЕР)
            // Здесь мы добавляем данные нового игрока в глобальное состояние (GameState)
            // Мы сохраняем его имя, socketId для связи и назначаем начальную позицию.
            const player = gameState.addPlayer({
                name,
                socketId: socket.id
            });

            playerId = player.id;

            console.log(`✅ Игрок авторизован: ${player.displayName}`);

            // Отправить данные игроку
            callback({
                success: true,
                player,
                gameState: gameState.getState()
            });

            // 2. УВЕДОМЛЕНИЕ ВСЕХ (СЕРВЕР)
            // После успешного добавления, мы отправляем событие 'game:state_update' 
            // ВСЕМ подключенным клиентам (io.emit). Это заставит их фронтенд перерисоваться
            // и показать новую фигурку.
            io.emit('game:state_update', gameState.getState());

            // Уведомить куратора
            if (gameState.curator.socketId) {
                io.to(gameState.curator.socketId).emit('curator:player_joined', player);
            }

        } catch (error) {
            console.error('❌ Ошибка авторизации игрока:', error.message);
            callback({
                success: false,
                error: error.message
            });
        }
    });

    /**
     * АВТОРИЗАЦИЯ: Вход куратора
     */
    socket.on('curator:auth', (data, callback) => {
        const { name, password } = data;
        const CURATOR_PASSWORD = process.env.CURATOR_PASSWORD || 'curator';

        // Проверка пароля
        if (password !== CURATOR_PASSWORD) {
            console.warn(`⛔ Неверный пароль куратора от ${name}`);
            callback({
                success: false,
                error: 'Неверный пароль куратора'
            });
            return;
        }

        try {
            // Подключить куратора
            const curator = gameState.connectCurator({
                name,
                socketId: socket.id
            });

            isCurator = true;

            console.log(`✅ Куратор авторизован: ${curator.name}`);

            callback({
                success: true,
                role: 'curator', // ДОБАВЛЕНО: унифицированный формат
                curator,
                gameState: gameState.getState(),
                report: gameState.generateReport()
            });

        } catch (error) {
            console.error('❌ Ошибка авторизации куратора:', error.message);
            callback({
                success: false,
                error: error.message
            });
        }
    });

    /**
     * Начать игру (может любой игрок)
     */
    socket.on('curator:start_game', (callback) => {
        // Проверка: разрешено ли игрокам управлять?
        const isHost = playerId && gameState.isHost(playerId);
        if (!isCurator && !isHost) {
            return callback?.({ success: false, error: 'Только куратор или хост может начать игру' });
        }

        if (!isCurator && isHost && !gameState.allowPlayerGameControl) {
            return callback?.({ success: false, error: 'Куратор запретил игрокам управлять началом игры' });
        }

        try {
            const result = gameState.startGame();

            console.log('🎮 Игра начата');

            callback({ success: true, result });

            // Уведомить всех
            io.emit('game:started', gameState.getState());
            io.emit('game:state_update', gameState.getState()); // Ensure button sync

        } catch (error) {
            console.error('❌ Ошибка начала игры:', error.message);
            callback({ success: false, error: error.message });
        }
    });

    /**
     * Завершить игру (куратор или хост)
     */
    socket.on('curator:end_game', (callback) => {
        // Разрешаем завершить игру куратору ИЛИ хосту
        const isHost = playerId && gameState.isHost(playerId);

        if (!isCurator && !isHost) {
            callback({ success: false, error: 'Только куратор или хост может завершить игру' });
            return;
        }

        if (!isCurator && isHost && !gameState.allowPlayerGameControl) {
            callback({ success: false, error: 'Куратор запретил игрокам завершать игру' });
            return;
        }

        try {
            const report = gameState.endGame();
            const endedBy = isCurator ? 'Куратор' : gameState.players[playerId]?.displayName || 'Хост';

            console.log(`🏁 ${endedBy} завершил игру. Подсчет победителей...`);

            // --- WINNER CALCULATION START ---
            const winners = Object.values(gameState.players).map(p => {
                const autoCard = gameState.autoFinanceCards[p.id] || {};
                const wallets = autoCard.calculatedWallets || {};

                const totalMoney = (wallets.charity || 0) +
                    (wallets.dream || 0) +
                    (wallets.savings || 0) +
                    (wallets.investments || 0);

                const dreamAchieved = p.dream && p.dream.isAchieved;

                return {
                    id: p.id,
                    name: p.displayName,
                    firstName: p.firstName,
                    dreamAchieved: !!dreamAchieved,
                    totalMoney: totalMoney,
                    dreamTitle: p.dream ? p.dream.title : 'Без мечты',
                    rank: 0 // Placeholder
                };
            });

            winners.sort((a, b) => {
                if (a.dreamAchieved !== b.dreamAchieved) {
                    return a.dreamAchieved ? -1 : 1;
                }
                return b.totalMoney - a.totalMoney;
            });

            winners.forEach((w, index) => w.rank = index + 1);
            // --- WINNER CALCULATION END ---

            callback({ success: true, report });

            // Send GAME OVER event instead of disconnecting
            io.emit('game:game_over', { winners });

            // Sync buttons! (Game status should now be 'finished' or similar)
            io.emit('game:state_update', gameState.getState());

            console.log('✅ Событие game:game_over отправлено. Ожидание действий куратора/хоста.');

        } catch (error) {
            console.error('❌ Ошибка завершения игры:', error.message);
            callback({ success: false, error: error.message });
        }
    });

    /**
     * КУРАТОР: Скрыть кнопку управления у всех игроков
     */
    socket.on('curator:hide_game_controls', (callback) => {
        if (!isCurator) return callback?.({ success: false, error: 'Доступ закрыт' });

        gameState.allowPlayerGameControl = false;
        console.log('🚫 Куратор СКРЫЛ кнопку управления игрой у всех игроков');

        // Отправляем ПРЯМОЕ событие скрытия ВСЕМ
        io.emit('game:hide_controls');
        io.emit('game:state_update', gameState.getState());
        io.emit('game:hide_controls');
        io.emit('game:state_update', gameState.getState());
        callback?.({ success: true });
    });

    /**
     * КУРАТОР: Изменить права конкретного игрока (скрыть/показать кнопки)
     */
    socket.on('curator:toggle_permission', (data, callback) => {
        if (!isCurator) return callback?.({ success: false, error: 'Доступ закрыт' });

        const { playerId, permission, value } = data;
        const player = gameState.players[playerId];

        if (player && player.permissions) {
            player.permissions[permission] = value;
            console.log(`🔧 Правки прав для ${player.displayName}: ${permission} = ${value}`);

            // Отправляем обновление всем (для куратора и других UI)
            io.emit('game:state_update', gameState.getState());

            // Личное уведомление игроку
            if (player.socketId) {
                io.to(player.socketId).emit('player:permissions_update', player.permissions);
            }

            callback?.({ success: true });
        } else {
            callback?.({ success: false, error: 'Игрок не найден' });
        }
    });

    /**
     * КУРАТОР: Сохранить/Исправить финансы игрока
     */
    socket.on('curator:save_player_finances', (data, callback) => {
        if (!isCurator) return callback?.({ success: false, error: 'Доступ закрыт' });

        const { targetPlayerId, incomeEntries, expenseEntries, monthlyIncome, monthlyExpenses, wallets } = data;
        const player = gameState.players[targetPlayerId];

        if (!player) return callback?.({ success: false, error: 'Игрок не найден' });

        console.log(`💂 Куратор исправляет данные игрока ${player.displayName}...`);

        // 1. Обновляем ручные записи (доходы/расходы)
        // Имитируем логику player:update_manual_entries
        if (player.currentTurnData) {
            player.currentTurnData.incomeEntries = incomeEntries || [];
            player.currentTurnData.expenseEntries = expenseEntries || [];
        }

        // Обновляем общий объект ручных данных
        gameState.financeManager.updatePlayerFinances(targetPlayerId, {
            incomeEntries,
            expenseEntries,
            monthlyIncome,
            monthlyExpenses
        });

        // 2. Обновляем кошельки
        // Имитируем логику player:update_wallets
        // Важно: Ручные кошельки хранятся в playerEnteredFinances, а не в calculatedWallets
        // Но updatePlayerFinances выше уже обновляет playerEnteredFinances (частично)
        // Нам нужно обновить именно wallets внутри playerEnteredFinances
        if (wallets) {
            const result = gameState.financeManager.updatePlayerFinances(targetPlayerId, { wallets });
            // result содержит сравнение (discrepancies), можно его вернуть куратору для инфо
            console.log(`💂 Куратор обновил кошельки ${player.displayName}. Расхождения: ${result.hasDiscrepancies ? 'ЕСТЬ' : 'НЕТ'}`);
        }

        // 3. Отправляем обновления
        io.emit('game:state_update', gameState.getState());

        callback?.({ success: true });
    });

    /**
     * КУРАТОР: Показать кнопку управления у всех игроков
     */
    socket.on('curator:show_game_controls', (callback) => {
        if (!isCurator) return callback?.({ success: false, error: 'Доступ закрыт' });

        gameState.allowPlayerGameControl = true;
        console.log('✅ Куратор ПОКАЗАЛ кнопку управления игрой у всех игроков');

        // Отправляем ПРЯМОЕ событие показа ВСЕМ
        io.emit('game:show_controls');
        io.emit('game:state_update', gameState.getState());
        callback?.({ success: true });
    });

    /**
     * ИГРОК: Запрос на бросок кубика
     */
    socket.on('player:request_roll', (callback) => {
        if (!playerId) return;

        // Проверка статуса игры
        if (gameState.status !== 'in_progress') {
            if (callback) callback({ success: false, error: 'Игра не начата' });
            return;
        }

        // Проверка очереди
        // Проверка очереди
        if (gameState.currentTurn !== playerId) {
            console.log(`🚫 Игрок ${playerId} пытался бросить кубик не в свой ход`);
            if (callback) callback({ success: false, error: 'Сейчас не ваш ход' });
            return;
        }

        const player = gameState.players[playerId];

        // === ВАЖНО: Игрок обязан выбрать мечту перед началом игры (первым ходом) ===
        if (!player.dream) {
            if (callback) callback({ success: false, error: '⛔ Выберите МЕЧТУ в финансовой карточке перед тем, как ходить!' });
            return;
        }

        // === БЛОКИРОВКА: Игрок должен заполнить карточку после хода ===
        // Пропускаем проверку на первом ходу (когда turnHistory пуста)
        if (player.turnHistory.length > 0 && !player.cardFilledThisTurn) {
            if (callback) callback({ success: false, error: '⛔ Заполните финансовую карточку перед следующим ходом! (Нажмите "Подтвердить" в карточке)' });
            return;
        }

        // Сбросить флаг для следующего хода
        player.cardFilledThisTurn = false;

        // КРИТИЧЕСКИ ВАЖНО: Сбрасываем currentTurnData ЗДЕСЬ, при броске кубика
        // Это гарантирует что игрок успел нажать автозаполнение ПЕРЕД началом нового хода
        console.log(`🧹 Очищаем currentTurnData для ${player.displayName} перед новым ходом`);
        player.currentTurnData = {
            incomeEntries: [],
            expenseEntries: [],
            walletChanges: {
                savings: 0,
                investments: 0,
                charity: 0,
                dream: 0
            }
        };

        // Проверка: Если на развилке, нужно сперва монетку?
        // Assuming global 'board' is available in context or via gameState
        if (board[player.position.currentCell].type === 'fork') {
            if (player.forkDirection === null || player.forkDirection === undefined) {
                if (callback) callback({ success: false, error: 'Сначала подбросьте монетку!' });
                return;
            }
        }

        try {
            const rollData = gameState.rollDice(playerId);
            const { result, isPartial, isDoubleDice } = rollData;

            // Предсказать движение только если это финальный бросок
            let prediction = null;
            if (!isPartial) {
                prediction = gameState.predictMove(playerId, result);
            }

            callback({ success: true, result, isPartial });

            // Уведомить всех о броске
            io.emit('player:dice_rolled', {
                playerId,
                playerName: gameState.players[playerId].displayName,
                result,
                isPartial,
                isDoubleDice,
                prediction
            });

            // LOG
            io.emit('game:log', {
                text: `${gameState.players[playerId].displayName} выбросил 🎲 ${result}`,
                type: 'system'
            });

            // === ЗАПУСК ТАЙМЕРА ХОДА (3 минуты) ===
            startTurnTimer(playerId);

            // Задержка перед ходом (анимация)
            // Клиент сам запросит move или мы ждем?
            // "игрок нажал на клетку, фигурка переместилась" -> Клиент шлет player:move.

        } catch (error) {
            console.error('❌ Ошибка броска:', error.message);
            if (callback) callback({ success: false, error: error.message });
        }
    });

    /**
     * ИГРОК: Подтверждение броска (OK)
     */
    socket.on('player:confirm_dice', (callback) => {
        // Уведомляем всех закрыть модалку
        io.emit('game:hide_dice_modal');
        if (callback) callback({ success: true });
    });

    /**
     * ИГРОК: Переместиться
     */
    socket.on('player:move', (data, callback) => {
        if (!playerId) {
            callback({ success: false, error: 'Не авторизован' });
            return;
        }

        const { steps } = data;

        if (gameState.currentTurn !== playerId) {
            callback({ success: false, error: 'Сейчас не ваш ход' });
            return;
        }

        try {
            const result = gameState.movePlayer(playerId, steps);

            console.log(`🚶 ${gameState.players[playerId].displayName} переместился`);

            // === ОТМЕНЯЕМ ТАЙМЕР ХОДА ===
            clearTurnTimer(playerId);

            callback({ success: true, result });

            // 1. Уведомить ВСЕХ о перемещении (только анимация и позиция)
            io.emit('player:moved', {
                playerId,
                playerName: gameState.players[playerId].displayName,
                position: gameState.players[playerId].position,
                cellResult: result, // Восстановлено для логики развилок
                passedMoneyCells: result.passedMoneyCells || [] // Клетки "Деньги" через которые прошел игрок
            });

            // LOG перемещения
            io.emit('game:log', {
                text: `${gameState.players[playerId].displayName} переместился на ${result.cellName || 'новую клетку'}`,
                type: 'system'
            });

            // === ЗАПИСЬ В ИСТОРИЮ ХОДОВ (turnHistory) ===
            const player = gameState.players[playerId];
            // ВАЖНО: Всегда берем 'steps' из броска, а не из результата хода
            player.turnHistory.push({
                turnNumber: player.turnHistory.length + 1,
                dice: player.status.pendingDoubleRoll !== null ? `${player.status.pendingDoubleRoll} + ${steps}` : steps,
                cellKey: player.position.currentCell,
                cellName: result.cellName || 'Клетка',
                cardTitle: '-',
                cardDescription: '-',
                result: 0, // Изначально финансовый результат 0
                amount: 0
            });

            // 2. ОБРАБОТКА ЭФФЕКТОВ КЛЕТКИ (Data-driven)

            // Если в результате есть действие (action) или описание (description), отправляем событие
            if (result.action && result.action !== 'none' && result.action !== 'draw_card') {
                const player = gameState.players[playerId];

                // Подготавливаем описание для других (если есть в результате)
                let descOthers = result.description_others || result.description || '';
                if (descOthers) {
                    descOthers = descOthers.replace('{player}', player.displayName).replace('{Player}', player.displayName);
                }

                // A. Личное событие игроку (с выбором или действием)
                socket.emit('game:cell_event', {
                    title: result.title || result.cellName,
                    description: result.description || '',
                    action: result.action,
                    value: result.value,
                    options: result.options,
                    effects: result.effects,
                    img: result.image || null,
                    endTurn: result.endTurn, // Передаем флаг завершения хода
                    // Доп данные для покупки (если это мечта-товар)
                    purchasePrice: result.price,
                    purchaseName: result.name,
                    isAssetPurchase: result.isAsset,
                    walletSource: result.walletSource
                });

                // === ВАЖНО: Сохраняем опции для последующего выбора (player:choice_made) ===
                if (result.action === 'choice' && result.options) {
                    player.currentChoiceOptions = result.options;
                }

                // B. Публичное уведомление остальным (если есть описание)
                if (descOthers) {
                    socket.broadcast.emit('game:notification', {
                        title: result.title || result.cellName,
                        message: descOthers,
                        playerName: player.displayName,
                        type: 'info'
                    });
                }

                console.log(`📍 Event processing for ${result.cellId}: ${result.action}`);
            } else if (result.action === 'draw_card') {
                // Карточки обрабатываются клиентом - он должен нажать на колоду
            }

            // Обновить состояние
            io.emit('game:state_update', gameState.getState());

            // Обновить куратора
            if (gameState.curator.socketId) {
                io.to(gameState.curator.socketId).emit('curator:history_update',
                    gameState.gameHistory[gameState.gameHistory.length - 1]
                );
            }

        } catch (error) {
            console.error('❌ Ошибка перемещения:', error.message);
            callback({ success: false, error: error.message });
        }
    });

    /**
     * ИГРОК: Сделал выбор (Choice)
     */
    socket.on('player:choice_made', (data, callback) => {
        if (!playerId || gameState.currentTurn !== playerId) return;

        const { optionIndex, cellId } = data;
        const player = gameState.players[playerId];

        // 1. Сначала ищем в динамических опциях текущего хода
        let selectedOption = null;
        if (player.currentChoiceOptions && player.currentChoiceOptions[optionIndex]) {
            selectedOption = player.currentChoiceOptions[optionIndex];
        } else {
            // 2. Иначе ищем в статическом JSON
            const cellData = cellsData[cellId] || cellsData[cellId.replace('cell-', '')];
            if (cellData && cellData.action === 'choice' && cellData.options[optionIndex]) {
                selectedOption = cellData.options[optionIndex];
            }
        }

        if (!selectedOption) {
            callback({ success: false, error: 'Invalid choice' });
            return;
        }

        // Проверка средств, если действие - оплата
        if (selectedOption.action === 'pay') {
            const autoFinance = gameState.autoFinanceCards[playerId];
            const currentSavings = autoFinance?.calculatedWallets?.savings || 0;
            const price = Number(selectedOption.value) || 0;

            if (currentSavings < price) {
                console.log(`❌ ${player.displayName} не хватает денег для выбора: ${selectedOption.text}`);
                callback({ success: false, error: 'Недостаточно денег в сбережениях для этого выбора' });

                // Уведомляем игрока
                socket.emit('game:notification', {
                    title: 'НЕДОСТАТОЧНО СРЕДСТВ',
                    message: `У вас только ${currentSavings}₸, а нужно ${price}₸. Придется выбрать другой вариант!`,
                    type: 'error'
                });
                return;
            }
        }

        console.log(`🤔 ${player.displayName} выбрал: ${selectedOption.text}`);

        try {
            // Применяем эффект (передаем всю опцию как opt для контекста)
            gameState.applyEffect(playerId, selectedOption.action, selectedOption.value, selectedOption);

            // Очищаем опции после выбора
            player.currentChoiceOptions = null;

            // === ЗАПИСЬ ВЫБОРА В ИСТОРИЮ ХОДОВ ===
            if (player.turnHistory.length > 0) {
                const lastTurn = player.turnHistory[player.turnHistory.length - 1];
                lastTurn.result = `Выбор: ${selectedOption.text}`;
                if (selectedOption.action === 'pay') {
                    lastTurn.amount = -(Number(selectedOption.value) || 0);
                }
            }

            // Сообщение в чат
            io.emit('game:chat_message', {
                sender: 'Система',
                message: `${player.displayName} выбрал: ${selectedOption.text}`,
                timestamp: new Date().toISOString(),
                isSystem: true
            });

            // Определяем заголовок уведомления (защита от undefined)
            const cellIdClean = cellId ? cellId.replace('cell-', '') : '';
            const cellData = cellsData[cellId] || cellsData[cellIdClean] || {};
            const notificationTitle = cellData.title || selectedOption.title || 'ВЫБОР';

            // Уведомление всем игрокам (4 секунды)
            io.emit('game:notification', {
                title: notificationTitle,
                message: `${player.displayName} выбрал: ${selectedOption.text}`,
                playerName: player.displayName,
                type: 'info'
            });

            // АВТОМАТИЧЕСКАЯ ПЕРЕДАЧА ХОДА ПОСЛЕ ВЫБОРА

            // 1. Сначала закрываем окно вопроса у всех
            io.emit('game:close_active_window');

            // 2. Затем передаем ход
            triggerNextTurn();

            callback({ success: true });

        } catch (e) {
            console.error('Error applying choice:', e);
            callback({ success: false, error: e.message });
        }
    });

    /**
     * ИГРОК: Завершить ход (явно)
     */
    socket.on('player:finish_turn', (callback) => {
        if (!playerId || gameState.currentTurn !== playerId) return;

        const player = gameState.players[playerId];
        console.log(`🏁 ${player.displayName} завершает ход`);

        // Если игрок был под арестом (активен сейчас только для нажатия OK)
        if (player.status.skippedTurns > 0) {
            player.status.skippedTurns--;
            console.log(`📉 ${player.displayName} пропустил ход. Осталось: ${player.status.skippedTurns}`);

            gameState.addToHistory({
                action: 'turn_skipped',
                actorId: playerId,
                actorName: player.displayName,
                details: { remainingSkips: player.status.skippedTurns, message: `Пропустил ход (осталось: ${player.status.skippedTurns})` }
            });
        }

        // Закрываем окна (на всякий случай)
        io.emit('game:close_active_window');

        triggerNextTurn();

        if (callback) callback({ success: true });
    });

    /**
     * ИГРОК: Запросить карманные деньги (за прохождение через клетку "Деньги")
     */
    socket.on('player:claim_pocket_money', (data, callback) => {
        if (!playerId || gameState.currentTurn !== playerId) {
            if (callback) callback({ success: false, error: 'Сейчас не ваш ход' });
            return;
        }

        const { cellKey } = data;
        const player = gameState.players[playerId];

        if (!player || !player.passedMoneyCells) {
            if (callback) callback({ success: false, error: 'Нет доступных клеток для получения денег' });
            return;
        }

        // Проверяем, что клетка была пройдена
        const cellIndex = player.passedMoneyCells.indexOf(cellKey);
        if (cellIndex === -1) {
            if (callback) callback({ success: false, error: 'Эта клетка не была пройдена или уже оплачена' });
            return;
        }

        // Удаляем клетку из списка
        player.passedMoneyCells.splice(cellIndex, 1);

        // ПРИОРИТЕТ: Блокировка дохода (штраф)
        if (player.status.incomeBlockedTurns > 0) {
            console.log(`🛑 [Interactive Block] Showing modal for ${player.displayName}`);
            const blockData = cellsData['income_blocked_generic'];

            // Показываем модалку игроку
            socket.emit('game:cell_event', {
                title: blockData.title,
                description: blockData.description_self.replace('{value}', player.status.incomeBlockedTurns),
                action: 'income_blocked_ack', // Специальный экшен для подтверждения
                endTurn: false // При сборе денег через проход ход не кончается
            });

            // Уведомление остальным
            const msgOthers = blockData.description_others
                .replace('{player}', player.displayName)
                .replace('{value}', player.status.incomeBlockedTurns);

            socket.broadcast.emit('game:notification', {
                title: blockData.title,
                message: msgOthers,
                playerName: player.displayName,
                type: 'info'
            });

            if (callback) callback({
                success: true,
                blocked: true,
                remainingCells: player.passedMoneyCells
            });
            return;
        }

        // Расчет дохода (через FinanceManager для согласованности)
        const income = gameState.financeManager.collectBusinessIncome(playerId);

        if (income > 0) {
            // ОБНОВЛЯЕМ ИСТОРИЮ ( Table UI)
            if (player.turnHistory && player.turnHistory.length > 0) {
                const lastTurn = player.turnHistory[player.turnHistory.length - 1];
                lastTurn.result = (lastTurn.result || 0) + income;
                lastTurn.amount = (lastTurn.amount || 0) + income;
            }

            // Уведомление всем (типа 'success' в Unified Queue)
            io.emit('game:notification', {
                title: 'ДЕНЬГИ',
                message: `💰 ${player.displayName} получил ${income} монеты от бизнесов!`,
                playerName: player.displayName,
                type: 'success',
                endTurn: false // При проходе ход НЕ заканчивается
            });
        } else {
            // Если нет бизнесов
            io.emit('game:notification', {
                title: 'ДЕНЬГИ',
                message: `📭 У игрока ${player.displayName} пока нет бизнесов. Доход: 0`,
                playerName: player.displayName,
                type: 'info',
                endTurn: false
            });
        }

        // Обновляем состояние
        io.emit('game:state_update', gameState.getState());

        if (callback) callback({
            success: true,
            amount: income,
            remainingCells: player.passedMoneyCells
        });
    });

    /**
     * ИГРОК: Подтверждение блокировки дохода (OK)
     */
    socket.on('player:acknowledge_income_block', (callback) => {
        if (!playerId || gameState.currentTurn !== playerId) return;

        const player = gameState.players[playerId];
        if (player.status.incomeBlockedTurns > 0) {
            player.status.incomeBlockedTurns--;
            console.log(`📉 ${player.displayName} подтвердил блокировку дохода. Осталось штрафов: ${player.status.incomeBlockedTurns}`);

            gameState.addToHistory({
                action: 'income_blocked_ack',
                actorId: playerId,
                actorName: player.displayName,
                details: { remainingPenalties: player.status.incomeBlockedTurns, message: `Подтвердил блокировку дохода (осталось: ${player.status.incomeBlockedTurns})` }
            });
        }

        // Закрываем окно у всех
        io.emit('game:close_active_window');

        // Если это было на клетке (endTurn: true), передаем ход.
        // Но при claim_pocket_money мы endTurn не ставили.
        // А если игрок ВСТАЛ на клетку? Там тоже будет этот экшн.

        // Как нам понять, нужно ли передавать ход?
        // Если это был последний экшен хода.
        // Проще всего проверить: если игрок сейчас на клетке money/start И нет больше passedMoneyCells
        const currentCell = player.position.currentCell;
        const cellData = board[currentCell];
        const onMoneyCell = (cellData.type === 'money' || cellData.type === 'start');

        if (onMoneyCell && (!player.passedMoneyCells || player.passedMoneyCells.length === 0)) {
            // Если он стоит на клетке денег и больше нет "проходных", то заканчиваем
            triggerNextTurn();
        } else {
            io.emit('game:state_update', gameState.getState());
        }

        if (callback) callback({ success: true });
    });



    /**
     * ИГРОК: Закрыть глобальное окно (у всех)
     */
    socket.on('player:close_window', (data) => {
        // Проверяем, что это активный игрок командует
        if (gameState.currentTurn === playerId) {
            io.emit('game:close_all_windows');
        }
    });

    /**
     * ИГРОК: Обновить финансовую карточку
     */
    /**
     * ИГРОК: Обновить финансовую карточку (LEGACY/COMPATIBILITY)
     */
    socket.on('player:update_finances', (data, callback) => {
        // ... (Keep existing logic if needed, or redirect)
        if (!playerId) return callback({ success: false, error: 'Auth' });
        try {
            const comparison = gameState.updatePlayerFinances(playerId, data);
            callback({ success: true, comparison });
        } catch (e) {
            callback({ success: false, error: e.message });
        }
    });

    /**
     * === NEW: PURE MANUAL DATA HANDLERS ===
     */

    /**
     * ИГРОК: Обновить значения копилок (Ручной ввод)
     */
    socket.on('player:update_wallets', (wallets, callback) => {
        if (!playerId || !gameState.players[playerId]) return;

        const player = gameState.players[playerId];

        // АНТИ-ЧИТ: Если уже было автозаполнение - ручные правки запрещены
        if (player.status.isAutofilledThisTurn) {
            return callback?.({
                success: false,
                error: '⚠️ ВНИМАНИЕ: Один ход можно записать лишь один раз. Вы уже использовали автозаполнение. Ручной ввод заблокирован до конца хода.'
            });
        }

        // Валидация и защита типов
        player.playerEnteredFinances.wallets = {
            charity: Number(wallets.charity) || 0,
            dream: Number(wallets.dream) || 0,
            savings: Number(wallets.savings) || 0,
            investments: Number(wallets.investments) || 0
        };

        console.log(`📝 ${player.displayName} обновил ручные копилки.`);

        // Помечаем, что игрок вносил данные вручную (Анти-чит)
        player.status.isManuallyUpdatedThisTurn = true;

        // Можно запустить проверку расхождений здесь или отложить
        if (callback) callback({ success: true });
    });

    /**
     * ИГРОК: Добавить запись дохода (Ручной ввод)
     */
    socket.on('player:add_income', (entry, callback) => {
        if (!playerId || !gameState.players[playerId]) return;
        const player = gameState.players[playerId];

        // АНТИ-ЧИТ
        if (player.status.isAutofilledThisTurn) {
            return callback?.({
                success: false,
                error: '⚠️ ВНИМАНИЕ: По правилам игры один ход можно записать лишь раз. Вы уже автозаполнили данные. Ручной ввод запрещен.'
            });
        }

        const newEntry = {
            id: Date.now().toString(),
            name: entry.name || 'Доход',
            amount: Number(entry.amount) || 0,
            timestamp: new Date().toISOString()
        };

        player.playerEnteredFinances.incomeEntries.push(newEntry);
        console.log(`📝 ${player.displayName} добавил ручной доход: ${newEntry.name}`);

        // Помечаем ручной ввод (Анти-чит)
        player.status.isManuallyUpdatedThisTurn = true;

        if (callback) callback({ success: true, entry: newEntry });
    });

    /**
     * ИГРОК: Добавить запись расхода (Ручной ввод)
     */
    socket.on('player:add_expense', (entry, callback) => {
        if (!playerId || !gameState.players[playerId]) return;
        const player = gameState.players[playerId];

        // АНТИ-ЧИТ
        if (player.status.isAutofilledThisTurn) {
            return callback?.({
                success: false,
                error: '⚠️ ВНИМАНИЕ: По правилам игры один ход можно записать лишь раз. Вы уже автозаполнили данные. Ручной ввод запрещен.'
            });
        }

        const newEntry = {
            id: Date.now().toString(),
            name: entry.name || 'Расход',
            amount: Number(entry.amount) || 0,
            timestamp: new Date().toISOString()
        };

        player.playerEnteredFinances.expenseEntries.push(newEntry);
        console.log(`📝 ${player.displayName} добавил ручной расход: ${newEntry.name}`);

        // Помечаем ручной ввод (Анти-чит)
        player.status.isManuallyUpdatedThisTurn = true;

        if (callback) callback({ success: true, entry: newEntry });
    });

    /**
     * ИГРОК: Автозаполнение текущего хода
     */
    socket.on('player:autofill_current_turn', (data, callback) => {
        if (!playerId || !gameState.players[playerId]) {
            callback({ success: false, error: 'Игрок не найден' });
            return;
        }

        const player = gameState.players[playerId];
        const currentTurn = player.currentTurnData;

        // ЗАЩИТА ОТ ОБМАНА (Анти-чит): Если уже вносил вручную ИЛИ уже автозаполнял
        if (player.status.isAutofilledThisTurn) {
            callback({ success: false, error: 'Вы уже автозаполнили данные в этом ходу.' });
            return;
        }

        if (player.status.isManuallyUpdatedThisTurn) {
            callback({
                success: false,
                error: '⚠️ ВНИМАНИЕ: По правилам игры один ход можно записать лишь один раз. Вы уже вносили данные вручную. \n\nКуратор имеет доступ к истории ваших действий. Если куратор заметит несовпадение или попытку обмана — он может удалить вас из игры или обнулить достижения.'
            });
            return;
        }

        if (!currentTurn) {
            callback({ success: false, error: 'Нет данных текущего хода' });
            return;
        }

        // Подробное логирование для отладки
        console.log(`📋 [AUTOFILL DEBUG] Игрок: ${player.displayName}`);
        console.log(`📋 [AUTOFILL DEBUG] currentTurnData:`, JSON.stringify(currentTurn, null, 2));

        try {
            let addedIncome = 0;
            let addedExpenses = 0;

            // Копируем записи доходов
            if (currentTurn.incomeEntries && currentTurn.incomeEntries.length > 0) {
                currentTurn.incomeEntries.forEach(entry => {
                    player.playerEnteredFinances.incomeEntries.push({
                        ...entry,
                        id: Date.now().toString() + Math.random() // Новый ID
                    });
                    addedIncome += entry.amount;
                });
            }

            // Копируем записи расходов
            if (currentTurn.expenseEntries && currentTurn.expenseEntries.length > 0) {
                currentTurn.expenseEntries.forEach(entry => {
                    player.playerEnteredFinances.expenseEntries.push({
                        ...entry,
                        id: Date.now().toString() + Math.random() // Новый ID
                    });
                    addedExpenses += entry.amount;
                });
            }

            // Прибавляем изменения копилок
            if (currentTurn.walletChanges) {
                for (const [wallet, change] of Object.entries(currentTurn.walletChanges)) {
                    if (player.playerEnteredFinances.wallets[wallet] !== undefined) {
                        player.playerEnteredFinances.wallets[wallet] += change;
                    }
                }
            }

            // Устанавливаем флаг защиты
            player.status.isAutofilledThisTurn = true;

            console.log(`⚡ ${player.displayName} автозаполнил текущий ход: +${addedIncome}₴ доходов, +${addedExpenses}₴ расходов`);

            // Обновляем состояние
            io.emit('game:state_update', gameState.getState());

            callback({
                success: true,
                addedIncome,
                addedExpenses,
                incomeCount: currentTurn.incomeEntries.length,
                expenseCount: currentTurn.expenseEntries.length,
                hasWalletChanges: Object.keys(currentTurn.walletChanges || {}).length > 0,
                walletUpdates: currentTurn.walletChanges || {}
            });

        } catch (error) {
            console.error('❌ Ошибка автозаполнения:', error.message);
            callback({ success: false, error: error.message });
        }
    });

    /**
     * ИГРОК: Выбрать мечту
     */
    socket.on('player:select_dream', (data, callback) => {
        if (!playerId) {
            callback({ success: false, error: 'Не авторизован' });
            return;
        }

        try {
            const { id, price, name } = data;
            const dream = gameState.selectDream(playerId, { id, price, name });

            callback({ success: true, dream });

            // Уведомить всех (чтобы в логах появилось)
            io.emit('game:log', {
                text: `${gameState.players[playerId].displayName} выбрал мечту: ${name}`,
                type: 'system'
            });

            // Обновить состояние
            io.emit('game:state_update', gameState.getState());

        } catch (error) {
            console.error('❌ Ошибка выбора мечты:', error.message);
            callback({ success: false, error: error.message });
        }
    });

    /**
     * ИГРОК: Купить бизнес
     */
    socket.on('player:buy_business', (data, callback) => {
        if (!playerId) {
            callback({ success: false, error: 'Не авторизован' });
            return;
        }

        try {
            const result = gameState.buyBusiness(playerId, data);

            if (result.success) {
                callback({ success: true, business: result.business });

                // Уведомить всех
                io.emit('game:log', {
                    text: `🏢 ${gameState.players[playerId].displayName} купил бизнес: ${data.name}`,
                    type: 'action'
                });

                // Обновить состояние
                io.emit('game:state_update', gameState.getState());
            } else {
                callback({ success: false, error: result.error });
            }
        } catch (error) {
            console.error('❌ Ошибка покупки бизнеса:', error.message);
            callback({ success: false, error: error.message });
        }
    });

    /**
     * ИГРОК: Вытянуть карточку из колоды (напрямую)
     */
    socket.on('player:draw_card_from_deck', (data, callback) => {
        if (!playerId) return callback({ success: false, error: 'Не авторизован' });

        // ВАЛИДАЦИЯ: Только активный игрок в свой ход может тянуть карту
        if (gameState.currentTurn !== playerId) {
            console.warn(`🚫 Игрок ${gameState.players[playerId]?.displayName} пытается тянуть карту вне своего хода!`);
            return callback({ success: false, error: 'Сейчас не ваш ход' });
        }

        const player = gameState.players[playerId];
        const { deckId } = data;

        // Если игрок решил тянуть карту, он теряет возможность забрать карманные деньги
        if (player.passedMoneyCells && player.passedMoneyCells.length > 0) {
            console.log(`💔 ${player.displayName} упустил карманные деньги, вытянув карту.`);
            player.passedMoneyCells = [];
            io.emit('game:state_update', gameState.getState());
        }

        let cardType = 'chance';

        // Маппинг ID колод на типы карточек
        switch (String(deckId)) {
            case '1': cardType = 'expenses'; break;
            case '2': cardType = 'business'; break;
            case '3': cardType = 'news'; break;
            case '4': cardType = 'chance'; break;
            default:
                callback({ success: false, error: 'Неизвестная колода' });
                return;
        }

        // ВАЛИДАЦИЯ: Проверяем, стоит ли игрок на клетке этого типа
        // (Исключение: kidsBusiness на доске = business колоде)
        const playerCellType = gameState.players[playerId].position.currentCellType;

        let valid = false;
        if (playerCellType === cardType) valid = true;

        // Маппинг для KidsBusiness -> Business
        if (playerCellType === 'kidsBusiness' && cardType === 'business') valid = true;

        if (!valid) {
            console.warn(`🛑 Игрок ${gameState.players[playerId].displayName} пытается взять карту ${cardType}, но стоит на ${playerCellType}`);
            callback({ success: false, error: 'Вы не стоите на клетке этого типа!' });
            return;
        }

        try {
            const card = gameState.drawCard(playerId, cardType);

            if (!card) {
                callback({ success: false, error: 'Не удалось вытянуть карточку' });
                return;
            }

            // === REMOVED SPECIAL LOGIC: News #29 (Phone Auto Sell) ===
            // This is now handled generically by gameState.drawCard() which checks offer_asset_name
            // for ALL news cards and sets appropriate flags (isSaleChoice or assetCheckFailed).


            // Store last drawn card for context in choice handlers
            gameState.players[playerId].lastDrawnCard = card;

            // === ЗАПИСЬ КАРТЫ В ИСТОРИЮ ХОДОВ (turnHistory) ===
            const player = gameState.players[playerId];
            if (player.turnHistory.length > 0) {
                const lastTurn = player.turnHistory[player.turnHistory.length - 1];
                // Обновляем существующую запись хода
                lastTurn.cardTitle = card.title || cardType.toUpperCase();
                lastTurn.cardDescription = card.description || '-';

                // Если карта дала деньги мгновенно (alertMessage с суммой или card.amount)
                if (card.amount) {
                    lastTurn.result = (lastTurn.result || 0) + card.amount;
                    lastTurn.amount = (lastTurn.amount || 0) + card.amount; // ИСПРАВЛЕНИЕ: также обновляем amount
                }
            }

            console.log(`🃏 ${gameState.players[playerId].displayName} вытянул из колоды ${cardType}`);

            // Отправляем ответ инициатору (чтобы он знал, что успешно)
            callback({ success: true, card });

            // === ПРОВЕРКА ПРОВАЛА УСЛОВИЙ (НЕТ НАВЫКА / АКТИВА) ===
            // Если условия не выполнены - НЕ показываем карту, а сразу уведомление и след. ход
            if (card.skillCheckFailed || card.assetCheckFailed) {
                // Уведомление об ошибке
                if (card.alertMessage) {
                    io.emit('game:notification', {
                        title: card.title || 'ТРЕБОВАНИЕ НЕ ВЫПОЛНЕНО',
                        message: card.alertMessage, // "❌ У вас нет навыка..."
                        type: 'error',
                        playerName: gameState.players[playerId].displayName,
                        endTurn: true // Wait for user to click OK to finish turn
                    });
                    // Лог для истории
                    io.emit('game:log', {
                        text: `${gameState.players[playerId].displayName}: ${card.alertMessage}`,
                        type: 'system'
                    });
                } else {
                    // Fallback if no alert message but check failed? Should end turn anyway.
                    // But usually json has message. If not, silently next turn?
                    gameState.nextTurn();
                    io.emit('game:state_update', gameState.getState());
                }

                // Прерываем выполнение, чтобы не было game:card_drawn
                return;
            }

            // Если нет провала, но есть alertMessage (ну просто результат, например "Получено 500")
            // Мы его тоже покажем, но карту все равно покажем (так как это успех)
            if (card.alertMessage) {
                io.emit('game:notification', {
                    title: card.title || 'СОБЫТИЕ',
                    message: card.alertMessage,
                    type: 'success', // или info, но обычно если мы тут - это успех
                    playerName: gameState.players[playerId].displayName
                });
            }

            // === УСЛОВИЯ ВЫПОЛНЕНЫ: ПОКАЗЫВАЕМ КАРТУ ===
            // ГЛАВНОЕ: Уведомляем ВСЕХ игроков, чтобы проиграть анимацию
            io.emit('game:card_drawn', {
                playerId,
                playerName: gameState.players[playerId].displayName,
                deckId,
                card
            });

            // Standard Log (условия выполнены)
            io.emit('game:log', {
                text: `${gameState.players[playerId].displayName} вытянул карту: ${card.text || card.title}`,
                type: 'system'
            });

            // Обновить состояние
            io.emit('game:state_update', gameState.getState());

        } catch (error) {
            console.error('❌ Ошибка вытягивания карты:', error.message);
            callback({ success: false, error: error.message });
        }
    });


    // =========================================================================
    // БЛАГОТВОРИТЕЛЬНОСТЬ - Выбор игрока
    // =========================================================================



    // =========================================================================
    // ПОКУПКА БИЗНЕСА/НАВЫКА - Выбор игрока
    // =========================================================================

    // Хелпер для интерполяции сообщений
    const interpolateMessage = (template, params) => {
        if (!template) return '';
        let message = template;
        Object.keys(params).forEach(key => {
            const regex = new RegExp(`{${key}}`, 'g');
            message = message.replace(regex, params[key]);
        });
        return message;
    };

    /**
     * ИГРОК: Подтвердить или отклонить покупку бизнеса/курса
     */
    socket.on('player:purchase_choice', (data, callback) => {
        if (!playerId) return callback?.({ success: false, error: 'Не авторизован' });

        try {
            // 1. Сразу закрываем окно выбора (Unified Queue rule)
            io.emit('game:close_active_window');

            const player = gameState.players[playerId];
            const { accept } = data;
            const lastCard = player.lastDrawnCard || {};

            // Получаем данные из последней вытянутой карты (для безопасности и надежности)
            const name = lastCard.purchaseName || lastCard.businessName || lastCard.skillName || lastCard.assetName || lastCard.title || 'Товар';
            const price = lastCard.purchasePrice || lastCard.price || 0;
            const income = lastCard.purchaseIncome || lastCard.monthlyIncome || 0;
            const skill = lastCard.skillGranted || lastCard.skillName;
            const isAsset = lastCard.isPurchaseChoice && lastCard.purchaseType === 'asset';
            const purchaseType = lastCard.purchaseType;

            const playerMessages = lastCard.playerMessages || {};
            const otherPlayerMessages = lastCard.otherPlayerMessages || {};

            // Параметры для интерполяции
            const params = {
                Player: player.displayName,
                CardName: name || lastCard.name || lastCard.title || 'Товар',
                Amount: price || 0,
                Income: income || 0
            };

            if (accept) {
                // Записываем в историю ТОЛЬКО после успешной покупки (ниже по коду)
                // Игрок согласился купить
                const walletType = data.walletSource || 'savings'; // По умолчанию сбережения
                const currentBalance = gameState.autoFinanceCards[playerId]?.calculatedWallets?.[walletType] || 0;

                if (currentBalance >= price) {
                    // Хватает средств
                    const walletChanges = {};
                    walletChanges[walletType] = -price;

                    // Используем applyMoneyChange чтобы записать в History расходов сервера
                    gameState.applyMoneyChange(playerId, -price, walletChanges, `Покупка: ${name}`);

                    // === LOGIC FOR SKILL PURCHASE ===
                    if (purchaseType === 'skill' || (skill && !isAsset)) {
                        // Это ПОКУПКА НАВЫКА (Курсы и т.д.)
                        const skillId = skill;
                        if (skillId) {
                            const added = gameState.addSkill(playerId, skillId);

                            // История хода
                            gameState.addToHistory({
                                action: 'skill_bought',
                                actorId: playerId,
                                actorName: player.displayName,
                                details: {
                                    message: `Куплен навык: ${name}`,
                                    skill: name
                                },
                                amount: -price
                            });

                            // Сообщение
                            const template = playerMessages.success || otherPlayerMessages.success || `🎓 {Player} прошел обучение и получил навык "{CardName}" за {Amount}₴!`;
                            const message = interpolateMessage(template, params);

                            io.emit('game:log', { text: message, type: 'success' });
                            io.emit('game:notification', {
                                title: 'НОВЫЙ НАВЫК',
                                message: message,
                                playerName: player.displayName,
                                type: 'success',
                                endTurn: true
                            });
                        }
                    } else if (isAsset) {
                        // Это АКТИВ (вещь, можно продать)
                        player.assets.items.push({
                            id: `item_${Date.now()}`,
                            name: name,
                            price: price,
                            acquiredAt: new Date().toISOString()
                        });

                        // История хода (-сумма)
                        gameState.addToHistory({
                            action: 'purchase',
                            actorId: playerId,
                            actorName: player.displayName,
                            details: { message: `Куплен актив: ${name}`, item: name },
                            amount: -price
                        });

                        // Сообщение
                        const template = playerMessages.success || otherPlayerMessages.success || `📦 {Player} приобрел "{CardName}" за {Amount}₴!`;
                        const message = interpolateMessage(template, params);

                        io.emit('game:log', { text: message, type: 'success' });

                        // Уведомление
                        io.emit('game:notification', {
                            title: 'НОВАЯ ПОКУПКА',
                            message: message,
                            playerName: player.displayName,
                            type: 'success',
                            endTurn: true
                        });

                    } else {
                        // Это БИЗНЕС (приносит доход)
                        let incomeAmount = income;
                        if (typeof incomeAmount === 'string') {
                            incomeAmount = parseInt(incomeAmount) || 0;
                        }

                        player.assets.businesses.push({
                            id: `business_${Date.now()}`,
                            name: name,
                            price: price,
                            monthlyIncome: incomeAmount,  // Используем название из JSON
                            acquiredAt: new Date().toISOString()
                        });

                        // Обновляем авто-доход
                        if (gameState.autoFinanceCards[playerId]) {
                            gameState.autoFinanceCards[playerId].calculatedMonthlyIncome += (incomeAmount || 0);
                            gameState.autoFinanceCards[playerId].calculatedBusinessCashFlow += (incomeAmount || 0);
                        }

                        // История хода (-сумма)
                        gameState.addToHistory({
                            action: 'business_bought',
                            actorId: playerId,
                            actorName: player.displayName,
                            details: {
                                message: `Куплен бизнес: ${name}. Доход: ${incomeAmount}₴/мес`,
                                business: name,
                                income: incomeAmount
                            },
                            amount: -price
                        });

                        // Если это курс с навыком - добавляем навык
                        if (skill) {
                            gameState.addSkill(playerId, skill);
                        }

                        // Сообщение
                        const template = playerMessages.success || otherPlayerMessages.success || `🏢 {Player} купил бизнес: {CardName}!`;
                        const message = interpolateMessage(template, params);

                        io.emit('game:log', { text: message, type: 'success' });

                        // Уведомление
                        io.emit('game:notification', {
                            title: 'НОВЫЙ БИЗНЕС',
                            message: message,
                            playerName: player.displayName,
                            playerId: player.id,
                            endTurn: true
                        });
                    }

                    // ОБНОВЛЯЕМ ТЕКУЩУЮ ИСТОРИЮ (не пушим новую!)
                    if (player.turnHistory && player.turnHistory.length > 0) {
                        const lastTurn = player.turnHistory[player.turnHistory.length - 1];
                        lastTurn.cardTitle = isAsset ? 'Покупка Актива' : (purchaseType === 'skill' ? 'Обучение' : 'Покупка Бизнеса');
                        lastTurn.cardDescription = name;
                    }

                    console.log(`✅ ${player.displayName} купил ${name} за ${price}₴`);
                    callback?.({ success: true, purchased: true, newBalance: currentBalance - price });

                } else {
                    // Не хватает средств - отправляем уведомление
                    const errorMessage = `❌ Недостаточно средств в копилке "${walletType}". Требуется ${price}₴, доступно ${currentBalance}₴.`;

                    io.emit('game:notification', {
                        title: 'ОШИБКА ПОКУПКИ',
                        message: errorMessage,
                        type: 'error',
                        playerName: player.displayName,
                        playerId: player.id,
                        endTurn: true // Also end turn on error? Yes
                    });

                    callback?.({ success: false, error: errorMessage });
                }
            } else {
                // Игрок отказался
                gameState.addToHistory({
                    action: 'purchase_declined',
                    actorId: playerId,
                    actorName: player.displayName,
                    details: { message: `Отказался от покупки: ${name}`, item: name }
                });

                const template = playerMessages.decline || otherPlayerMessages.decline || `Игрок {Player} отказался от покупки {CardName}.`;
                const message = interpolateMessage(template, params);

                // NOTIFICATION FOR DECLINE
                io.emit('game:notification', {
                    title: 'ОТКАЗ',
                    message: message,
                    playerName: player.displayName,
                    playerId: player.id,
                    type: 'info',
                    endTurn: true
                });
                io.emit('game:log', { text: message, type: 'info' });

                console.log(`${player.displayName} отказался от покупки ${name}`);
                callback?.({ success: true, purchased: false });
            }

            // REMOVED: gameState.nextTurn();
            // REMOVED: io.emit('game:card_hide');
            // Rely on client Close Window -> finishTurn logic.

            // Обновить состояние
            io.emit('game:state_update', gameState.getState());

        } catch (error) {
            console.error('❌ Ошибка покупки:', error.message);
            callback?.({ success: false, error: error.message });
        }
    });

    /**
     * ИГРОК: Выбор продажи актива (Продать / Оставить)
     */
    socket.on('player:sale_choice', (data, callback) => {
        if (!playerId) return callback?.({ success: false, error: 'Не авторизован' });
        // Проверка очереди может быть мягкой для асинхронных действий, но здесь это ход игрока
        if (gameState.currentTurn !== playerId) return callback?.({ success: false, error: 'Не ваш ход' });

        try {
            io.emit('game:close_active_window');

            const player = gameState.players[playerId];
            const { accept, assetId, salePrice } = data;

            // Если игрок согласился продать
            if (accept) {
                // 1. Ищем актив
                const assetIndex = player.assets.items.findIndex(a => a.id === assetId || a.name === assetId); // Fallback to name check

                if (assetIndex === -1) {
                    return callback?.({ success: false, error: 'Актив не найден или уже продан' });
                }

                const assetName = player.assets.items[assetIndex].name;
                const price = Number(salePrice) || 0;

                // 2. Удаляем актив
                player.assets.items.splice(assetIndex, 1);

                // 3. Начисляем инком
                // Распределяем доход (10/20/10/60)
                const walletChanges = {
                    charity: Math.round(price * 0.1),
                    dream: Math.round(price * 0.2),
                    savings: Math.round(price * 0.1),
                    investments: Math.round(price * 0.6)
                };

                gameState.applyMoneyChange(playerId, price, walletChanges, `Продажа актива: ${assetName}`);

                // 4. История и Уведомления
                gameState.addToHistory({
                    action: 'asset_sold',
                    actorId: playerId,
                    actorName: player.displayName,
                    details: {
                        message: `Продал актив: ${assetName} за ${price}₴`,
                        asset: assetName,
                        price: price
                    },
                    amount: price
                });

                io.emit('game:notification', {
                    title: 'ПРОДАЖА',
                    message: `${player.displayName} продал "${assetName}" за ${price}₴!`,
                    playerName: player.displayName,
                    type: 'success',
                    endTurn: true
                });

                io.emit('game:log', { text: `${player.displayName} продал ${assetName} за ${price}₴`, type: 'success' });

                console.log(`✅ ${player.displayName} продал ${assetName}`);
                callback?.({ success: true, sold: true });

            } else {
                // Отказ
                gameState.addToHistory({
                    action: 'sale_declined',
                    actorId: playerId,
                    actorName: player.displayName,
                    details: { message: `Отказался продавать актив` }
                });

                io.emit('game:notification', {
                    title: 'ОТКАЗ',
                    message: `${player.displayName} решил оставить вещь себе.`,
                    playerName: player.displayName,
                    type: 'info',
                    endTurn: true
                });

                callback?.({ success: true, sold: false });
            }

            io.emit('game:state_update', gameState.getState());

        } catch (e) {
            console.error('Ошибка продажи:', e);
            callback?.({ success: false, error: e.message });
        }
    });

    /**
     * ИГРОК: Выбор благотворительности (Помочь / Отказаться)
     */
    socket.on('player:charity_choice', (data, callback) => {
        if (!playerId) return callback?.({ success: false, error: 'Не авторизован' });
        if (gameState.currentTurn !== playerId) return callback?.({ success: false, error: 'Не ваш ход' });

        try {
            // 1. Сразу закрываем окно выбора
            io.emit('game:close_active_window');

            const player = gameState.players[playerId];
            const autoFinance = gameState.autoFinanceCards[playerId];
            const wallets = autoFinance.calculatedWallets;
            const lastCard = player.lastDrawnCard || {};
            const playerMessages = lastCard.playerMessages || {};
            const otherPlayerMessages = lastCard.otherPlayerMessages || {};
            const { accept, amount } = data;
            const donationAmount = amount || Math.abs(lastCard.value) || 0;

            const params = {
                Player: player.displayName,
                Amount: donationAmount
            };

            if (accept) {
                // Все типы благотворительности (платные и бесплатные помощи) записываются как доброе дело
                const donationPrice = donationAmount || 0;

                if (wallets.charity >= donationPrice) {
                    // Списываем деньги если есть цена
                    if (donationPrice > 0) {
                        wallets.charity -= donationPrice;
                        autoFinance.expensesHistory.push({
                            timestamp: new Date().toISOString(),
                            type: 'charity_donation',
                            amount: donationPrice
                        });
                    }

                    // Начисляем доброе дело (привилегию)
                    player.status.charityDonationsMade = (player.status.charityDonationsMade || 0) + 1;

                    // === UPDATE TURN HISTORY ===
                    if (player.turnHistory && player.turnHistory.length > 0) {
                        const lastTurn = player.turnHistory[player.turnHistory.length - 1];
                        lastTurn.result = donationPrice > 0 ? 'Благотворительность (платно)' : 'Доброе дело (помощь)';
                        lastTurn.amount = -donationPrice;
                    }

                    // Сообщение
                    const template = playerMessages.success || otherPlayerMessages.success || `💝 {Player} совершил доброе дело! Оно сохранено для активации бонуса в клетке Благотворительности.`;
                    const message = interpolateMessage(template, params);

                    io.emit('game:log', { text: message, type: 'success' });
                    io.emit('game:notification', {
                        title: 'ДОБРОЕ ДЕЛО',
                        message: message,
                        playerName: player.displayName,
                        playerId: player.id,
                        type: 'success',
                        endTurn: true
                    });

                    callback?.({ success: true, donated: true });
                } else {
                    const message = `⚠️ Недостаточно средств в копилке Благотворительности (${wallets.charity}₴ из ${donationAmount}₴)`;
                    socket.emit('game:notification', {
                        title: 'ОШИБКА',
                        message: message,
                        type: 'error',
                        endTurn: true // Fail to donate -> End turn? Or let them try again? Assuming end turn for now or just close.
                        // Actually if funds fail, maybe let them decline? But the UI is closed.
                        // So end turn is safest to avoid stuck state.
                    });
                    callback?.({ success: false, error: message });
                }
            } else {
                io.emit('game:notification', {
                    title: 'ОТКАЗ',
                    message: message,
                    playerName: player.displayName,
                    playerId: player.id,
                    type: 'info',
                    endTurn: true
                });
                console.log(`${player.displayName} отказался от пожертвования`);
                callback?.({ success: true, donated: false });
            }

            // REMOVED: gameState.nextTurn();
            // REMOVED: io.emit('game:card_hide');

            io.emit('game:state_update', gameState.getState());
        } catch (error) {
            console.error('❌ Ошибка благотворительности:', error.message);
            callback?.({ success: false, error: error.message });
        }
    });

    /**
     * ИГРОК: Выбор продажи актива (Продать / Оставить)
     */
    socket.on('player:sale_choice', (data, callback) => {
        if (!playerId) return callback?.({ success: false, error: 'Не авторизован' });
        if (gameState.currentTurn !== playerId) return callback?.({ success: false, error: 'Не ваш ход' });

        const { accept, assetId, salePrice } = data;
        const player = gameState.players[playerId];
        const lastCard = player.lastDrawnCard || {};
        const playerMessages = lastCard.playerMessages || {};
        const otherPlayerMessages = lastCard.otherPlayerMessages || {};

        try {
            // 1. Сразу закрываем окно выбора
            io.emit('game:close_active_window');

            if (accept) {
                // Игрок согласился продать
                // 1. Проверяем наличие актива
                const assetIndex = player.assets.items.findIndex(item => item.id === assetId);
                // Note: For News #29 'sale_choice', the assetId might come from client selection if we implemented that UI.
                // If specific assetId is missing, we might need robust finding by name (TODO), 
                // but for now relying on client sending correct assetId (or if News logic is improved later).

                if (assetIndex === -1) {
                    return callback?.({ success: false, error: 'Актив не найден (возможно, уже продан)' });
                }

                const assetName = player.assets.items[assetIndex].name;

                // 2. Удаляем актив
                player.assets.items.splice(assetIndex, 1);

                // 3. Начисляем деньги (автораспределение по правилам дохода)
                const price = Number(salePrice) || 0;
                gameState.applyMoneyChange(playerId, price);

                const template = playerMessages.success || otherPlayerMessages.success || `💰 {Player} продал "{CardName}" за ${price}¢!`;
                const message = template.replace('{Player}', player.displayName).replace('{CardName}', assetName);

                io.emit('game:log', { text: message, type: 'success' });

                // Уведомление всем
                io.emit('game:notification', {
                    title: 'ПРОДАЖА АКТИВА',
                    message: message,
                    playerName: player.displayName,
                    playerId: player.id,
                    type: 'success',
                    endTurn: true
                });

                console.log(`💰 ${player.displayName} продал ${assetName} за ${price}¢`);
                callback?.({ success: true, sold: true });

            } else {
                // Игрок отказался продавать
                const template = playerMessages.decline || otherPlayerMessages.decline || `${player.displayName} решил оставить актив себе.`;
                const message = template.replace('{Player}', player.displayName).replace('{CardName}', lastCard.offerAssetName || lastCard.requiredAsset || 'актив');

                io.emit('game:log', { text: message, type: 'info' });

                // Уведомление всем
                io.emit('game:notification', {
                    title: 'ОТКАЗ ОТ ПРОДАЖИ',
                    message: message,
                    playerName: player.displayName,
                    playerId: player.id,
                    type: 'info',
                    endTurn: true
                });

                console.log(`${player.displayName} отказался продавать актив`);
                callback?.({ success: true, sold: false });
            }

            // REMOVED: gameState.nextTurn();
            // REMOVED: io.emit('game:card_hide');

            // Обновить состояние
            io.emit('game:state_update', gameState.getState());

        } catch (error) {
            console.error('❌ Ошибка продажи актива:', error.message);
            callback?.({ success: false, error: error.message });
        }
    });








    /**
     * ИГРОК: Запросить карманные деньги (за проход клетки Деньги)
     */
    socket.on('player:claim_pocket_money', (data, callback) => {
        if (!playerId) return callback?.({ success: false, error: 'Не авторизован' });
        if (gameState.currentTurn !== playerId) return callback?.({ success: false, error: 'Не ваш ход' });

        const { cellKey } = data;
        const player = gameState.players[playerId];

        // Проверяем, есть ли эта клетка в списке пройденных
        if (!player.passedMoneyCells || !player.passedMoneyCells.includes(cellKey)) {
            return callback?.({ success: false, error: 'Эта клетка недоступна для получения денег' });
        }

        try {
            // ИСПРАВЛЕНИЕ: Логика "Деньги за круг" = "Сбор дохода от бизнесов"
            // Используем ту же логику, что и при попадании на клетку
            const income = gameState.collectBusinessIncome(playerId);

            // Удаляем клетку из списка (чтобы нельзя было получить дважды)
            player.passedMoneyCells = player.passedMoneyCells.filter(c => c !== cellKey);

            if (income > 0) {
                // Доход успешно собран (распределение и история уже внутри collectBusinessIncome)
                callback?.({ success: true, amount: income });
            } else {
                // Нет бизнесов - нет дохода
                callback?.({ success: false, error: 'У вас нет активных бизнесов для получения дохода.' });

                socket.emit('game:notification', {
                    title: 'НЕТ ДОХОДА',
                    message: 'У вас пока нет бизнесов, чтобы собирать доход за круг.',
                    type: 'info',
                    playerName: player.displayName
                });
            }

            io.emit('game:state_update', gameState.getState());

        } catch (error) {
            console.error('Ошибка получения карманных денег:', error);
            callback?.({ success: false, error: error.message });
        }
    });

    /**
     * ИГРОК: Закрыл окно (Крестик)
     * Синхронизация закрытия модалок у всех
     */
    socket.on('player:close_window', (data, callback) => {
        // Только активный игрок может командовать закрытием
        if (gameState.currentTurn === playerId) {
            io.emit('game:card_hide');
        }
    });

    /**
     * ИГРОК: Подтвердил прочтение карточки (ОК)
     * Используется для карточек без выбора (новости, просто доход и т.д.)
     */
    socket.on('player:acknowledge_card', (data, callback) => {
        if (!playerId) return callback?.({ success: false, error: 'Не авторизован' });
        if (gameState.currentTurn !== playerId) return callback?.({ success: false, error: 'Не ваш ход' });

        try {
            // Просто передаем ход
            gameState.nextTurn();

            // Скрываем карточку у ВСЕХ
            io.emit('game:card_hide');

            // Обновляем состояние
            io.emit('game:state_update', gameState.getState());

            callback?.({ success: true });
        } catch (error) {
            console.error('❌ Ошибка подтверждения карточки:', error.message);
            callback?.({ success: false, error: error.message });
        }
    });

    // =========================================================================
    // СПЯЩИЙ ИГРОК - Пробуждение
    // =========================================================================

    /**
     * ИГРОК: Проснуться и вернуться в игру
     */
    socket.on('player:wake_up', (data, callback) => {
        if (!playerId) return callback?.({ success: false, error: 'Не авторизован' });

        try {
            const player = gameState.players[playerId];

            if (!player.isSleeping) {
                callback?.({ success: false, error: 'Вы не спите' });
                return;
            }

            // Просыпаемся!
            player.isSleeping = false;

            io.emit('game:log', {
                text: `☀️ ${player.displayName} проснулся и вернулся в игру!`,
                type: 'success'
            });

            io.emit('game:player_awake', { playerId, playerName: player.displayName });

            console.log(`☀️ ${player.displayName} проснулся!`);
            callback?.({ success: true });

            // Обновить состояние
            io.emit('game:state_update', gameState.getState());

        } catch (error) {
            console.error('❌ Ошибка пробуждения:', error.message);
            callback?.({ success: false, error: error.message });
        }
    });

    // =========================================================================
    // ФИНАНСОВАЯ КАРТОЧКА - Синхронизация данных
    // =========================================================================

    /**
     * ИГРОК: Обновить значения копилок (ручной ввод)
     */
    socket.on('player:update_wallets', (data, callback) => {
        if (!playerId) return callback?.({ success: false, error: 'Не авторизован' });

        try {
            const player = gameState.players[playerId];
            const { charity, dream, savings, investments } = data;

            // Обновить ручные записи игрока
            player.playerEnteredFinances.wallets = {
                charity: Number(charity) || 0,
                dream: Number(dream) || 0,
                savings: Number(savings) || 0,
                investments: Number(investments) || 0
            };

            // Пересчитать капитал
            player.playerEnteredFinances.capital =
                player.playerEnteredFinances.wallets.charity +
                player.playerEnteredFinances.wallets.dream +
                player.playerEnteredFinances.wallets.savings +
                player.playerEnteredFinances.wallets.investments;

            console.log(`💰 ${player.displayName} обновил копилки:`, player.playerEnteredFinances.wallets);

            callback?.({ success: true, wallets: player.playerEnteredFinances.wallets });

            // Broadcast update
            io.emit('game:state_update', gameState.getState());
        } catch (error) {
            console.error('❌ Ошибка обновления копилок:', error.message);
            callback?.({ success: false, error: error.message });
        }
    });

    /**
     * ИГРОК: Закрыть активное окно (Синхронизация)
     */
    socket.on('player:close_window', (data, callback) => {
        if (!playerId) return;

        // Только активный игрок может закрывать окна для всех
        // (Или тот, чья очередь сейчас что-то делать)
        if (gameState.currentTurn === playerId) {
            console.log(`🔒 ${gameState.players[playerId].displayName} закрывает окна для всех`);
            io.emit('game:close_active_window');
            callback?.({ success: true });
        } else {
            // Если это личная информация?
            // Пока строгий режим: только активный управляет потоком
            callback?.({ success: false, error: 'Только активный игрок может закрыть окно' });
        }
    });

    /**
     * ИГРОК: Завершить ход (Явный)
     */
    socket.on('player:finish_turn', (data, callback) => {
        if (!playerId) return;
        if (gameState.currentTurn === playerId) {
            console.log(`🏁 ${gameState.players[playerId].displayName} завершает ход вручную`);
            io.emit('game:close_active_window'); // Закрыть все окна
            gameState.nextTurn();
            io.emit('game:state_update', gameState.getState());
            callback?.({ success: true });
        }
    });

    /**
     * ИГРОК: Добавить запись дохода
     */
    socket.on('player:add_income', (data, callback) => {
        if (!playerId) return callback?.({ success: false, error: 'Не авторизован' });

        try {
            const player = gameState.players[playerId];
            const { name, amount } = data;

            const entry = {
                id: uuidv4(),
                name: name || 'Доход',
                amount: Number(amount) || 0,
                timestamp: new Date().toISOString()
            };

            player.playerEnteredFinances.incomeEntries.push(entry);
            player.playerEnteredFinances.monthlyIncome += entry.amount;

            console.log(`📈 ${player.displayName} добавил доход: ${entry.name} (+${entry.amount})`);

            callback?.({ success: true, entry });
            io.emit('game:state_update', gameState.getState());
        } catch (error) {
            callback?.({ success: false, error: error.message });
        }
    });

    /**
     * ИГРОК: Добавить запись расхода
     */
    socket.on('player:add_expense', (data, callback) => {
        if (!playerId) return callback?.({ success: false, error: 'Не авторизован' });

        try {
            const player = gameState.players[playerId];
            const { name, amount } = data;

            const entry = {
                id: uuidv4(),
                name: name || 'Расход',
                amount: Number(amount) || 0,
                timestamp: new Date().toISOString()
            };

            player.playerEnteredFinances.expenseEntries.push(entry);
            player.playerEnteredFinances.monthlyExpenses += entry.amount;

            console.log(`📉 ${player.displayName} добавил расход: ${entry.name} (-${entry.amount})`);

            callback?.({ success: true, entry });
            io.emit('game:state_update', gameState.getState());
        } catch (error) {
            callback?.({ success: false, error: error.message });
        }
    });

    /**
     * ИГРОК: Обновить (редактировать) список ручных записей (Bulk Update)
     */
    socket.on('player:update_manual_entries', (data, callback) => {
        if (!playerId) return callback?.({ success: false, error: 'Auth' });

        try {
            const player = gameState.players[playerId];
            if (data.incomeEntries) {
                player.playerEnteredFinances.incomeEntries = data.incomeEntries;
            }
            if (data.expenseEntries) {
                player.playerEnteredFinances.expenseEntries = data.expenseEntries;
            }
            // Также обновляем суммарные значения, которые посчитал клиент (или пересчитываем тут)
            if (typeof data.monthlyIncome === 'number') player.playerEnteredFinances.monthlyIncome = data.monthlyIncome;
            if (typeof data.monthlyExpenses === 'number') player.playerEnteredFinances.monthlyExpenses = data.monthlyExpenses;

            console.log(`💾 ${player.displayName} сохранил ручные записи (${data.incomeEntries?.length} д., ${data.expenseEntries?.length} р.)`);

            callback?.({ success: true });
        } catch (e) {
            console.error(e);
            callback?.({ success: false, error: e.message });
        }
    });

    /**
     * ИГРОК: Получить полные данные финансов
     */
    /**
     * ИГРОК: Получить полные данные финансов
     */
    socket.on('player:get_finance_data', (data, callback) => {
        // Handle arguments: data could be the callback if no data sent
        const cb = (typeof data === 'function') ? data : callback;
        const params = (typeof data === 'object' && data !== null) ? data : {};

        if (!playerId && !isCurator) return cb?.({ success: false, error: 'Не авторизован' });

        try {
            // Determine target player
            let targetId = playerId;

            // Curator can inspect anyone
            if (isCurator && params.targetPlayerId) {
                targetId = params.targetPlayerId;
            }

            const player = gameState.players[targetId];
            if (!player) return cb?.({ success: false, error: 'Игрок не найден' });

            const autoFinance = gameState.autoFinanceCards[targetId] || {};

            // Преобразуем навыки из ID в объекты с именами для UI
            const skillsWithNames = (player.assets.skills || []).map(skillId => ({
                id: skillId,
                name: gameState.getSkillDisplayName(skillId),
                level: 'Базовый'
            }));

            // Создаем копию assets для отправки
            const assetsToSend = {
                ...player.assets,
                skills: skillsWithNames
            };

            cb?.({
                success: true,
                manual: player.playerEnteredFinances,
                auto: autoFinance,
                assets: assetsToSend,
                turnHistory: player.turnHistory,
                dream: player.dream,
                isInspection: (targetId !== playerId) // Flag to UI that this is inspection
            });
        } catch (error) {
            cb?.({ success: false, error: error.message });
        }
    });

    /**
     * ИГРОК: Подтвердить заполнение карточки (разблокировать следующий ход)
     */
    socket.on('player:confirm_card', (callback) => {
        if (!playerId) return callback?.({ success: false, error: 'Не авторизован' });

        try {
            const player = gameState.players[playerId];
            player.cardFilledThisTurn = true;

            console.log(`✅ ${player.displayName} подтвердил заполнение карточки`);

            callback?.({ success: true, message: 'Карточка подтверждена! Можно ходить.' });
            io.emit('game:state_update', gameState.getState());
        } catch (error) {
            callback?.({ success: false, error: error.message });
        }
    });

    /**
     * КУРАТОР: Завершить игру (Подсчет итогов)
     */
    socket.on('curator:end_game', (callback) => {
        // Allow ONLY Curator OR the Game Host (if allowed)
        if (!isCurator) {
            // Check if it's the host player
            if (!playerId || gameState.hostPlayerId !== playerId) {
                return callback({ success: false, error: 'Только куратор или хост могут завершить игру' });
            }
            // Could also check gameState.allowPlayerGameControl here if strict
        }

        try {
            console.log('🏁 Куратор инициировал завершение игры. Подсчет итогов...');

            const winners = Object.values(gameState.players).map(p => {
                // Calculate Total Money (Wallets + potentially cash if we tracked it separately, but wallet-invest is usually the main score)
                // Assuming 'status' properties or 'assets' hold the score.
                // For simplicity, let's sum up wallets from the last known state or use what's in 'p'.
                // Ideally, we trust what's in p.turnHistory or similar, BUT
                // We likely don't have the live wallet values in `gameState.players` unless synchronized.
                // However, `financeManager` updates `gameState.players[id].assets` logic?
                // Let's rely on what we have. 

                // Note: The prompt says "All money in all wallets". 
                // We need to ensure we have that data. 
                // Since `player:update_wallets` updates `gameState.autoFinanceCards` (maybe?), let's look there.
                const autoCard = gameState.autoFinanceCards[p.id] || {};
                const wallets = autoCard.calculatedWallets || {};

                const totalMoney = (wallets.charity || 0) +
                    (wallets.dream || 0) +
                    (wallets.savings || 0) +
                    (wallets.investments || 0);

                // Dream Achieved? 
                const dreamAchieved = p.dream && p.dream.isAchieved; // Assuming this flag exists

                return {
                    id: p.id,
                    name: p.displayName,
                    firstName: p.firstName,
                    dreamAchieved: !!dreamAchieved,
                    totalMoney: totalMoney,
                    dreamTitle: p.dream ? p.dream.title : 'Без мечты'
                };
            });

            // SORTING RULES:
            // 1. Dream Achieved (True > False)
            // 2. Total Money (Desc)
            winners.sort((a, b) => {
                if (a.dreamAchieved !== b.dreamAchieved) {
                    return a.dreamAchieved ? -1 : 1;
                }
                return b.totalMoney - a.totalMoney;
            });

            // Assign ranks
            winners.forEach((w, index) => w.rank = index + 1);

            // Broadcast Game Over
            io.emit('game:game_over', { winners });

            callback({ success: true });

        } catch (error) {
            console.error('Error ending game:', error);
            callback({ success: false, error: error.message });
        }
    });

    /**
     * КУРАТОР: Принудительный сброс (после модалки)
     */
    socket.on('curator:force_reset', (callback) => {
        if (!isCurator) return callback({ success: false, error: 'Только куратор' });

        console.log('💥 Куратор выполнил полный сброс игры.');
        gameState.reset();
        io.emit('game:auto_reset', { message: 'ИГРА ОКОНЧЕНА' });
        io.emit('game:state_update', gameState.getState());

        callback({ success: true });
    });

    /**
     * КУРАТОР: Запрос отчета
     */
    socket.on('curator:get_report', (callback) => {
        if (!isCurator) {
            callback({ success: false, error: 'Только куратор может запросить отчет' });
            return;
        }

        try {
            const report = gameState.generateReport();
            callback({ success: true, report });
        } catch (error) {
            console.error('❌ Ошибка генерации отчета:', error.message);
            callback({ success: false, error: error.message });
        }
    });

    /**
     * ИГРОК: Бросить монетку (на развилке)
     */
    socket.on('player:flip_coin', (callback) => {
        if (!playerId) return callback({ success: false, error: 'Не авторизован' });
        if (gameState.currentTurn !== playerId) return callback({ success: false, error: 'Не ваш ход' });

        const player = gameState.players[playerId];
        // Note: board is defined in scope
        const cell = board[player.position.currentCell];

        if (!cell || (cell.type !== 'fork')) {
            return callback({ success: false, error: 'Вы не на развилке' });
        }

        try {
            // 1. Logic 50/50
            const isHeads = Math.random() < 0.5;
            const result = isHeads ? 'heads' : 'tails';

            // 2. Set direction in state (Heads->0, Tails->1)
            const outcome = gameState.setForkDirection(playerId, result);
            const directionText = (outcome.direction === 0) ? 'НАПРАВО' : 'НАЛЕВО';

            // 3. Emit event to ALL clients for animation
            io.emit('player:coin_flipped', {
                playerId,
                playerName: player.displayName,
                result,       // 'heads' | 'tails' 
                directionText, // 'НАПРАВО' | 'НАЛЕВО'
                directionIndex: outcome.direction
            });

            // LOG
            io.emit('game:log', {
                text: `${gameState.players[playerId].displayName} подбросил монетку: ${result === 'heads' ? 'Орел' : 'Решка'} -> ${directionText}`,
                type: 'system'
            });

            // 4. Update Game State (so buttons unlock on client)
            io.emit('game:state_update', gameState.getState());

            if (callback) callback({ success: true, result, directionText });
        } catch (error) {
            console.error('❌ Error flipping coin:', error);
            if (callback) callback({ success: false, error: error.message });
        }
    });
    /**
     * ЧАТ: Отправка сообщения игроком
     */
    socket.on('player:send_chat_message', (data) => {
        if (!playerId) return;

        const { text } = data;
        const player = gameState.players[playerId];

        if (!player || !text) return;

        // Отправляем всем (включая отправителя)
        io.emit('chat:broadcast', {
            playerId: player.id,
            playerName: player.displayName,
            antColor: player.antColor,
            text,
            timestamp: new Date().toISOString()
        });
    });

    /**
     * Отключение клиента
     */
    socket.on('disconnect', () => {
        console.log(`🔌 Отключение: ${socket.id}`);

        if (playerId) {
            const playerName = gameState.players[playerId]?.displayName;

            // Очистить таймер хода, если он был
            clearTurnTimer(playerId);

            gameState.removePlayer(playerId);

            // Уведомить всех
            io.emit('game:state_update', gameState.getState());

            // Уведомить куратора
            if (gameState.curator.socketId) {
                io.to(gameState.curator.socketId).emit('curator:player_left', {
                    playerId,
                    playerName
                });
            }

            // === АВТО-СБРОС: Если все игроки покинули игру ===
            const remainingPlayers = Object.keys(gameState.players).length;
            console.log(`👥 Осталось игроков: ${remainingPlayers}`);

            if (remainingPlayers === 0 && gameState.status !== 'waiting') {
                console.log('🔄 Все игроки покинули игру. Автоматический сброс...');

                // Сбросить состояние игры
                gameState.reset();

                // Уведомить всех (включая куратора) о сбросе
                io.emit('game:auto_reset', {
                    message: 'Игра автоматически сброшена - все игроки покинули комнату.'
                });

                io.emit('game:state_update', gameState.getState());

                console.log('✅ Игра сброшена. Готова к новой игре.');
            }
        }
    });

});

/**
 * Запуск сервера
 */
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Сервер запущен на порту ${PORT}`);
    console.log(`🌐 http://0.0.0.0:${PORT}`);
    console.log('');
    console.log('События клиент → сервер:');
    console.log('  - player:auth');
    console.log('  - curator:auth');
    console.log('  - curator:start_game');
    console.log('  - curator:end_game');
    console.log('  - player:request_roll');
    console.log('  - player:move');
    console.log('  - player:update_finances');
    console.log('  - curator:get_report');
    console.log('');
    console.log('События сервер → клиент:');
    console.log('  - game:state_update');
    console.log('  - game:started');
    console.log('  - game:ended');
    console.log('  - player:dice_rolled');
    console.log('  - player:moved');
    console.log('');
});

// Обработка ошибок
process.on('uncaughtException', (error) => {
    console.error('❌ Необработанная ошибка:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('❌ Необработанное отклонение промиса:', error);
});
