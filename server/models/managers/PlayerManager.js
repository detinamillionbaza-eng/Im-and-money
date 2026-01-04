const { v4: uuidv4 } = require('uuid');
const board = require('../../board');

/**
 * Менеджер Игроков (PlayerManager)
 * Отвечает за:
 * - Добавление новых игроков
 * - Подключение куратора
 * - Управление списком игроков (удаление, статус хоста)
 * - Выбор цвета фишки
 */
class PlayerManager {
    constructor(gameState) {
        this.gameState = gameState;
    }

    /**
     * Добавить игрока в игру
     * @param {object} playerData - Данные игрока (name, socketId)
     * @returns {object} Созданный объект игрока
     */
    addPlayer(playerData) {
        // Генерируем уникальный ID
        const playerId = uuidv4();
        // Номер игрока для отображения (Игрок #1, Игрок #2...)
        const playerNumber = Object.keys(this.gameState.players).length + 1;

        // Создаем структуру игрока
        this.gameState.players[playerId] = {
            id: playerId,
            displayName: playerData.name,
            firstName: playerData.name,
            lastName: playerData.lastName || null,
            antColor: this.getAvailableAntColor(), // Назначаем свободный цвет
            joinedAt: new Date().toISOString(),
            socketId: playerData.socketId,
            isActive: true,
            playerNumber: playerNumber, // Порядковый номер (нужен для передачи хоста)

            // Статус игрока (пропуски ходов, блокировки)
            status: {
                skippedTurns: 0,       // Сколько ходов нужно пропустить
                incomeBlockedTurns: 0, // На сколько кругов заблокирован доход
                doubleDiceTurnsRemaining: 0, // Сколько ходов можно бросать 2 кубика
                charityDonationsMade: 0,     // Накопленные добрые дела (привилегии)
                pendingDoubleRoll: null,    // Первый бросок при двойном кубике
                activeBuffs: [],       // Активные положительные эффекты
                isManuallyUpdatedThisTurn: false, // Флаг ручного ввода в текущем ходу
                activeBuffs: [],       // Активные положительные эффекты
                isManuallyUpdatedThisTurn: false, // Флаг ручного ввода в текущем ходу
                isAutofilledThisTurn: false      // Флаг автозаполнения в текущем ходу
            },

            // Права доступа (управляются куратором)
            permissions: {
                canSeeAutofill: true, // Видна ли кнопка автозаполнения
                canSeeActual: true    // Видна ли кнопка фактической карточки
            },

            position: {
                currentCell: 'cell-start',
                currentCellType: board && board['cell-start'] ? board['cell-start'].type : 'start',
                cellIndex: 0,
                circle: 'long',
                canPlayBothCircles: false
            },

            // Финансы (ручной ввод игрока)
            playerEnteredFinances: {
                monthlyIncome: 0,
                monthlyExpenses: 0,
                wallets: {
                    charity: 0,
                    dream: 0,
                    savings: 100,  // Стартовый капитал
                    investments: 0
                },
                // Ручные записи истории
                incomeEntries: [],
                expenseEntries: [],
                capital: 100
            },

            // Временное хранилище данных текущего хода (для автозаполнения)
            currentTurnData: {
                incomeEntries: [],
                expenseEntries: [],
                walletChanges: {
                    savings: 0,
                    investments: 0,
                    charity: 0,
                    dream: 0
                }
            },

            // История ходов (для таблицы в UI)
            turnHistory: [],

            // Активы
            assets: {
                businesses: [],
                items: [],
                skills: [],
                dream: null
            },

            // Активные карточки (новости/расходы, влияющие на игрока)
            activeCards: {
                news: [],
                expenses: []
            },

            partnerships: [],
            debts: [],
            dream: null, // Выбранная мечта (объект)

            isSleeping: false         // Флаг тайм-аута (спящий игрок)
        };

        // Инициализируем авто-финансы для этого игрока (через FinanceManager, если он есть, или здесь)
        // Для простоты инициализируем структуру здесь, т.к. GameState хранит данные
        this.gameState.autoFinanceCards[playerId] = {
            calculatedMonthlyIncome: 0,
            calculatedMonthlyExpenses: 0,
            calculatedWallets: {
                charity: 0,
                dream: 0,
                savings: 100, // СТАРТОВЫЙ КАПИТАЛ
                investments: 0
            },
            incomeHistory: [],
            expensesHistory: [],
            calculatedCapital: 100,
            calculatedBusinessCashFlow: 0,
            discrepancies: {
                hasDiscrepancies: false,
                details: []
            }
        };

        // Лог подключения
        this.gameState.addToHistory({
            action: 'player_joined',
            actorId: playerId,
            actorName: this.gameState.players[playerId].displayName,
            details: { message: `Игрок ${this.gameState.players[playerId].displayName} присоединился` }
        });

        // Назначаем Хоста (первый зашедший)
        if (!this.gameState.hostPlayerId) {
            this.gameState.hostPlayerId = playerId;
            console.log(`👑 ${this.gameState.players[playerId].displayName} назначен хостом игры`);
        }

        console.log(`👤 Игрок добавлен: ${this.gameState.players[playerId].displayName}`);

        return this.gameState.players[playerId];
    }

    /**
     * Удалить игрока (при отключении)
     * @param {string} playerId 
     */
    removePlayer(playerId) {
        const player = this.gameState.players[playerId];
        if (player) {
            const wasHost = (this.gameState.hostPlayerId === playerId);

            this.gameState.addToHistory({
                action: 'player_disconnected',
                actorId: playerId,
                actorName: player.displayName,
                details: { message: 'Игрок отключился' }
            });

            console.log(`❌ Игрок отключился: ${player.displayName}`);

            // Удаляем данные
            delete this.gameState.players[playerId];
            delete this.gameState.autoFinanceCards[playerId];

            // Если ушел хост - передаем корону следующему
            if (wasHost) {
                const remainingPlayers = Object.values(this.gameState.players);
                if (remainingPlayers.length > 0) {
                    // Ищем игрока с минимальным номером (самого старого из оставшихся)
                    const nextHost = remainingPlayers.reduce((min, p) =>
                        (p.playerNumber < min.playerNumber) ? p : min
                    );
                    this.gameState.hostPlayerId = nextHost.id;
                    console.log(`👑 Хост передан: ${nextHost.displayName}`);
                } else {
                    this.gameState.hostPlayerId = null;
                }
            }
        }
    }

    /**
     * Подключить куратора
     */
    connectCurator(curatorData) {
        this.gameState.curator = {
            id: curatorData.id || uuidv4(),
            name: curatorData.name,
            connectedAt: new Date().toISOString(),
            socketId: curatorData.socketId
        };

        this.gameState.addToHistory({
            action: 'curator_connected',
            actorId: this.gameState.curator.id,
            actorName: this.gameState.curator.name,
            details: { message: 'Куратор подключился к игре' }
        });

        console.log(`👨‍🏫 Куратор подключен: ${this.gameState.curator.name}`);
        return this.gameState.curator;
    }

    /**
     * Получить доступный цвет муравья
     * Ищет цвет, который еще не занят активными игроками
     */
    getAvailableAntColor() {
        const colors = ['blue', 'red', 'green', 'yellow', 'purple', 'orange'];
        const usedColors = Object.values(this.gameState.players)
            .filter(p => p.isActive)
            .map(p => p.antColor);
        return colors.find(c => !usedColors.includes(c)) || 'blue';
    }

    /**
     * Проверка: является ли игрок хостом
     */
    isHost(playerId) {
        return this.gameState.hostPlayerId === playerId;
    }

    getHostPlayerId() {
        return this.gameState.hostPlayerId;
    }
}

module.exports = PlayerManager;
