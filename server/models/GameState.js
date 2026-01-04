const { v4: uuidv4 } = require('uuid');

// Импорт менеджеров (Новая структура)
const PlayerManager = require('./managers/PlayerManager');
const TurnManager = require('./managers/TurnManager');
const MovementManager = require('./managers/MovementManager');
const FinanceManager = require('./managers/FinanceManager');
const CellManager = require('./managers/CellManager');

class GameState {
    constructor() {
        this.reset();

        // Инструменты
        this.io = null;   // Socket.io instance
        this.logger = null; // Функция обратного вызова для логов

        // Инициализация менеджеров
        this.playerManager = new PlayerManager(this);
        this.turnManager = new TurnManager(this);
        this.movementManager = new MovementManager(this);
        this.financeManager = new FinanceManager(this);
        this.cellManager = new CellManager(this);
    }

    /**
     * Полный сброс состояния игры
     */
    reset() {
        this.status = 'waiting'; // waiting, in_progress, finished
        this.players = {};
        this.hostPlayerId = null;
        this.curator = {
            id: null,
            name: 'Куратор',
            connectedAt: null,
            socketId: null
        };
        this.gameHistory = [];
        this.startedAt = null;
        this.finishedAt = null;
        this.currentTurn = null;
        this.decks = {
            chance: [],
            news: [],
            expenses: [],
            business: []
        };
        this.autoFinanceCards = {};
        this.allowPlayerGameControl = true; // Разрешить игрокам (хосту) начинать/завершать игру

        console.log('🔄 Состояние игры сброшено');
    }

    // =========================================================
    // БАЗОВЫЕ МЕТОДЫ (Core)
    // =========================================================

    setIO(io) {
        this.io = io;
    }

    setLogger(callback) {
        this.logger = callback;
    }

    getState() {
        return {
            status: this.status,
            startedAt: this.startedAt,
            curator: this.curator,
            players: this.players,
            currentTurn: this.currentTurn,
            hostPlayerId: this.hostPlayerId,
            allowPlayerGameControl: this.allowPlayerGameControl
        };
    }

    /**
     * Централизованная запись в историю
     * Используется всеми менеджерами через this.gameState.addToHistory
     */
    addToHistory(entry) {
        this.gameHistory.push({
            id: uuidv4(),
            timestamp: new Date().toISOString(),
            ...entry
        });

        // Отправка лога клиентам (через callback server.js)
        if (this.logger && entry.details && entry.details.message) {
            let logText = entry.details.message;
            let isAlert = false;

            // Специальные форматы сообщений
            if (entry.action === 'turn_skipped') {
                logText = `🚫 ${entry.actorName} пропускает ход (осталось: ${entry.details.remainingSkips})`;
                isAlert = true;
            } else if (entry.action === 'income_blocked') {
                logText = `🛑 ${entry.actorName} лишен зарплаты (штраф)`;
                isAlert = true;
            }

            this.logger({
                text: logText,
                type: 'system',
                playerId: entry.actorId,
                isAlert: isAlert
            });
        }
    }

    // =========================================================
    // ДЕЛЕГИРОВАНИЕ МЕТОДОВ (Facade Pattern)
    // Эти методы вызываются из server.js
    // =========================================================

    // --- Player Management ---
    addPlayer(data) { return this.playerManager.addPlayer(data); }
    removePlayer(id) { return this.playerManager.removePlayer(id); }
    connectCurator(data) { return this.playerManager.connectCurator(data); }
    isHost(id) { return this.playerManager.isHost(id); }
    getHostPlayerId() { return this.playerManager.getHostPlayerId(); }
    getAvailableAntColor() { return this.playerManager.getAvailableAntColor(); }

    // --- Turn Management ---
    startGame() { return this.turnManager.startGame(); }
    nextTurn() { return this.turnManager.nextTurn(); }
    rollDice(id) { return this.turnManager.rollDice(id); }
    endGame() { return this.turnManager.endGame(); }
    generateReport() { return this.turnManager.generateReport(); }
    calculateGameDuration() { return this.turnManager.calculateGameDuration(); }
    calculateStatistics() { return this.turnManager.calculateStatistics(); }

    // --- Movement Management ---
    movePlayer(id, steps) { return this.movementManager.movePlayer(id, steps); }
    predictMove(id, steps) { return this.movementManager.predictMove(id, steps); }
    setForkDirection(id, dir) { return this.movementManager.setForkDirection(id, dir); }

    // --- Cell & Logic Management ---
    handleCell(id, cellKey) { return this.cellManager.handleCell(id, cellKey); }
    drawCard(id, type) { return this.cellManager.drawCard(id, type); }
    addSkill(id, skill) { return this.cellManager.addSkill(id, skill); }
    hasSkill(id, skill) { return this.cellManager.hasSkill(id, skill); }
    applyEffect(id, action, val, opt) { return this.cellManager.applyEffect(id, action, val, opt); }
    mapCellTypeToCardType(type) { return this.cellManager.mapCellTypeToCardType(type); }
    // Proxy for convenience if used externally
    getSkillDisplayName(skillId) {
        return this.cellManager ? this.cellManager.getSkillDisplayName(skillId) : skillId;
    }

    // --- Finance Management ---
    // Важно: методы должны быть доступны
    collectBusinessIncome(id) { return this.financeManager.collectBusinessIncome(id); }
    buyBusiness(id, data) { return this.financeManager.buyBusiness(id, data); }
    selectDream(id, data) { return this.financeManager.selectDream(id, data); }
    applyMoneyChange(id, amt, chg, desc) { return this.financeManager.applyMoneyChange(id, amt, chg, desc); }
    updatePlayerFinances(id, data) { return this.financeManager.updatePlayerFinances(id, data); }
    compareFinances(id) { return this.financeManager.compareFinances(id); }
    spendFromWallets(id, amt, opt) { return this.financeManager.spendFromWallets(id, amt, opt); }
    recordExpense(id, amt, src) { return this.financeManager.recordExpense(id, amt, src); }
    distributeMonthlyIncome(id, inc) { return this.financeManager.distributeMonthlyIncome(id, inc); }
}

// Экспортируем синглтон, как и раньше
module.exports = new GameState();