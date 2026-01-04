const cardService = require('../../services/CardService');
const cellsData = require('../../data/cells.json');

/**
 * Менеджер Логики Клеток (CellManager)
 * Отвечает за:
 * - Обработку попадания на клетку (Event processing)
 * - Применение эффектов (pay, skip_turn, etc.)
 * - Работу с карточками (Draw Card)
 * - Логика "Мечты" (купить свою или чужую)
 * - Навыки (Skills)
 */
class CellManager {
    constructor(gameState) {
        this.gameState = gameState;
    }

    /**
     * Обработать попадание на клетку
     * @param {string} playerId
     * @param {string} cellKey - ID клетки (например 'cell-13')
     */
    handleCell(playerId, cellKey) {
        const player = this.gameState.players[playerId];
        const board = require('../../board'); // Подгружаем доску
        const cell = board[cellKey];

        let result = {
            cellId: cellKey,
            cellType: cell.type,
            cellName: cell.name,
            action: null,
            card: null,
            moneyChange: 0
        };

        // 1. Поиск в cells.json (конкретный ID или тип)
        const cellIdNum = cellKey.replace('cell-', '');

        // ПРИОРИТЕТ: Блокировка дохода (штраф) для клеток типа money/start
        if ((cell.type === 'money' || cell.type === 'start') && player.status.incomeBlockedTurns > 0) {
            const blockData = cellsData['income_blocked_generic'];
            result.title = blockData.title;
            result.description = blockData.description_self.replace('{value}', player.status.incomeBlockedTurns);
            result.action = 'income_blocked_ack';
            result.endTurn = true; // При приземлении на клетку - ход кончается после OK
            return result;
        }

        let complexData = cellsData[cellIdNum] || cellsData[cell.type] || cellsData[cell.type + '_generic'];

        // Специальная обработка для типов которые точно должны быть в JSON
        if (!complexData) {
            if (cell.type === 'money' || cell.type === 'start') complexData = cellsData['money_generic'];
            if (cell.type === 'charity') complexData = cellsData['charity_generic'];
            if (cell.type && cell.type.startsWith('dream')) complexData = cellsData['dream_generic'];
        }

        if (complexData) {
            return this.handleComplexCell(playerId, complexData, result, cell);
        }

        // 2. Стандартные типы (карточки, развилки)
        switch (cell.type) {
            case 'chance':
            case 'news':
            case 'expenses':
            case 'kidsBusiness':
                // Карточки
                const cardType = this.mapCellTypeToCardType(cell.type);
                result.action = 'draw_card';
                result.cardType = cardType;
                break;

            case 'fork':
                result.action = 'choose_path';
                result.paths = cell.next;
                result.description = "Вы на развилке! На следующем ходу вы бросите монетку, чтобы выбрать путь.";
                result.endTurn = true; // Завершаем ход после ознакомления
                break;

            default:
                // Пустая клетка
                result.action = 'none';
                this.gameState.nextTurn();
        }

        return result;
    }

    /**
     * Маппинг типа клетки на тип колоды
     */
    mapCellTypeToCardType(cellType) {
        const mapping = {
            'chance': 'chance',
            'news': 'news',
            'expenses': 'expenses',
            'kidsBusiness': 'business',
            'business': 'business'
        };
        return mapping[cellType] || 'chance';
    }

    /**
     * Обработка сложных клеток (Директор, Хулиганы...)
     */
    handleComplexCell(playerId, complexData, result, origCell = {}) {
        const player = this.gameState.players[playerId];

        // Заполняем результат для клиента
        result.title = complexData.title;
        result.description = complexData.description_self;
        result.description_others = complexData.description_others;
        result.image = complexData.image || null;

        // --- СПЕЦИАЛЬНЫЕ ЭКШЕНЫ ИЗ JSON ---

        if (complexData.action === 'collect_income') {
            // ЛОГИКА: Сбор дохода (бывший хардкод 'money')
            const income = this.gameState.financeManager.collectBusinessIncome(playerId);
            result.action = 'monthly_income';
            result.moneyChange = income;
            result.endTurn = true; // Завершаем ход после OK

            // Интерполяция сообщения
            if (income > 0) {
                result.description = complexData.description_self.replace('{income}', income);
            } else {
                result.description = complexData.msg_no_income || "📭 У вас пока нет активных бизнесов. Доход: 0";
                result.description_others = complexData.description_others_no_income || `У игрока {player} пока нет бизнесов. Доход: 0`;
            }

        } else if (complexData.action === 'charity_bonus') {
            // ЛОГИКА: Бонус за благотворительность (использование накопленного доброго дела)
            result.endTurn = true;

            // Проверяем наличие накопленных добрых дел (привилегий)
            if (player.status.charityDonationsMade > 0) {
                // Списываем одно доброе дело
                player.status.charityDonationsMade--;
                // Даем бонус на 3 хода
                player.status.doubleDiceTurnsRemaining = 3;

                result.action = 'charity_bonus';
                result.description = `💝 Вы совершили доброе дело ранее! Теперь вы можете бросать 2 кубика (суммируя результат) в течение следующих 3 ходов. (Осталось добрых дел: ${player.status.charityDonationsMade})`;
            } else {
                result.action = 'charity_no_bonus';
                result.description = complexData.msg_no_donation || "💖 Клетка Благотворительности. Чтобы получить здесь бонус (3 хода по 2 кубика), нужно сначала совершить доброе дело по карточкам!";
            }
        }
        else if (complexData.action === 'dream_check') {
            // ЛОГИКА: Проверка мечты
            const dreamResult = this.handleDreamCell(playerId, origCell);
            if (dreamResult) {
                Object.assign(result, dreamResult);
            } else {
                result.action = 'dream_check';
                result.endTurn = true;
            }

        } else if (complexData.action === 'choice') {
            result.action = 'choice';
            result.options = complexData.options;
            // NEXT TURN НЕ вызываем, ждем выбора
        } else if (complexData.action === 'multi_effect') {
            result.action = 'multi_effect';
            result.effects = complexData.effects;
            this.processComplexEffect(playerId, complexData);
            result.endTurn = true;
        } else {
            // Простой эффект (pay, skip_turn)
            result.action = complexData.action;
            result.value = complexData.value;
            this.processComplexEffect(playerId, complexData);
            result.endTurn = true;
        }

        // История (если это не просто переход хода)
        if (result.action !== 'none') {
            this.gameState.addToHistory({
                action: 'complex_cell_visit',
                actorId: playerId,
                actorName: player.displayName,
                details: { title: result.title, message: result.description }
            });
        }

        return result;
    }

    /**
     * Применение эффектов (pay, skip_turn, block_income)
     */
    processComplexEffect(playerId, data) {
        const effects = data.effects || [data];

        effects.forEach(effect => {
            if (effect.action === 'pay' || effect.action === 'pay_percent') {
                // Передаем в applyEffect (который внутри использует FinanceManager)
                this.applyEffect(playerId, effect.action, effect.value, effect);
            } else if (effect.action === 'pay_from_savings') {
                this.applyEffect(playerId, 'pay_from_savings', effect.value, effect);
            } else {
                this.applyEffect(playerId, effect.action, effect.value, effect);
            }
        });
    }

    /**
     * Общий метод применения эффекта
     */
    applyEffect(playerId, action, value, options = {}) {
        const player = this.gameState.players[playerId];
        const finance = this.gameState.financeManager;

        switch (action) {
            case 'pay':
                if (typeof value === 'string' && value.includes('%')) {
                    this.applyEffect(playerId, 'pay_percent', value, options);
                    return;
                }
                finance.spendFromWallets(playerId, Number(value), {
                    forCharity: options.forCharity,
                    forDream: options.forDream
                });
                break;

            case 'pay_percent':
                const autoFinance = this.gameState.autoFinanceCards[playerId];
                const totalCash = Object.values(autoFinance.calculatedWallets).reduce((a, b) => a + b, 0);
                const percent = parseInt(value);
                const amount = Math.round(totalCash * (percent / 100));
                finance.applyMoneyChange(playerId, -amount, {}, 'Потеря процента денег');
                break;

            case 'pay_from_savings':
                finance.applyMoneyChange(playerId, -Number(value), { savings: -Number(value) }, 'Списание со сбережений');
                break;

            case 'skip_turn':
                player.status.skippedTurns += Number(value);
                break;

            case 'block_income':
                player.status.incomeBlockedTurns += Number(value);
                break;

            case 'multi_effect':
                const effects = options.effects || (Array.isArray(value) ? value : []);
                effects.forEach(e => this.applyEffect(playerId, e.action, e.value, { ...options, ...e }));
                break;

            case 'buy_dream_asset':
                const { name, price } = options.cellData || {};
                if (name && price) {
                    // Прямой вызов каскадного списания
                    finance.cascadingSpend(playerId, price, `Покупка актива: ${name}`);

                    // Добавление в активы
                    if (!player.assets.items) player.assets.items = [];
                    player.assets.items.push({
                        id: 'asset-' + Date.now(),
                        name: name,
                        price: price,
                        type: 'asset',
                        acquiredAt: new Date().toISOString()
                    });

                    // Интерполяция сообщения из конфига (или дефолт)
                    const cellsData = require('../../data/cells.json');
                    const dreamData = cellsData['dream_generic'];
                    const template = dreamData?.messages?.asset?.success || "✅ Вы купили {name} за {price} ₸.";
                    const message = template.replace('{name}', name).replace('{price}', price);

                    // Уведомление
                    this.gameState.io.emit('game:notification', {
                        title: 'ПОКУПКА АКТИВА',
                        message: message,
                        type: 'success',
                        playerName: player.displayName
                    });
                }
                break;

            case 'decline_dream_asset':
                // Просто лог
                this.gameState.io.emit('game:notification', {
                    title: 'ОТКАЗ',
                    message: `Вы отказались от покупки актива.`,
                    type: 'info',
                    playerName: player.displayName
                });
                break;
        }

        this.gameState.addToHistory({
            action: 'effect_applied',
            actorId: playerId,
            actorName: player.displayName,
            details: { action, value, message: `Эффект: ${action}` }
        });
    }

    /**
     * Обработка клетки МЕЧТА
     */
    handleDreamCell(playerId, cell) {
        const player = this.gameState.players[playerId];
        const autoFinance = this.gameState.autoFinanceCards[playerId];
        const cellsData = require('../../data/cells.json');
        const dreamData = cellsData['dream_generic'];

        const price = cell.price || 0;
        const dreamName = cell.name.replace(/^Мечта\s+/i, '');

        // 1. Если мечта не выбрана
        if (!player.dream) {
            return {
                action: 'dream_none',
                title: dreamData.title,
                description: dreamData.messages.no_dream.self + "<br><br><small>" + dreamData.messages.reminder + "</small>",
                description_others: dreamData.messages.no_dream.others.replace('{player}', player.displayName),
                endTurn: true
            };
        }

        // 2. Это моя мечта?
        const isMyDream = (player.dream && cell.type === player.dream.id);

        if (isMyDream) {
            const dreamWallet = autoFinance.calculatedWallets.dream || 0;

            if (dreamWallet >= price) {
                // АВТОМАТИЧЕСКАЯ ПОКУПКА
                this.gameState.financeManager.applyMoneyChange(playerId, -price, { dream: -price }, `Достижение мечты: ${dreamName}`);

                // Добавляем в активы (как мечту)
                player.assets.dream = cell.name;
                // Также добавим в общие айтемы для консистентности если нужно
                if (!player.assets.items) player.assets.items = [];
                player.assets.items.push({
                    id: 'dream-' + Date.now(),
                    name: cell.name,
                    price: price,
                    type: 'dream'
                });

                // Уведомление для других
                this.gameState.io.emit('game:notification', {
                    title: 'МЕЧТА ИСПОЛНЕНА!',
                    message: dreamData.messages.own.others_success.replace('{player}', player.displayName).replace('{name}', dreamName),
                    type: 'success'
                });

                return {
                    action: 'dream_fulfilled', // Триггер для конфетти на фронте
                    title: 'ПОЗДРАВЛЯЕМ!',
                    description: dreamData.messages.own.success.replace('{name}', dreamName) + "<br><br><strong>" + dreamData.messages.reminder + "</strong>",
                    endTurn: true
                };
            } else {
                // Не хватает
                return {
                    action: 'dream_fail',
                    title: dreamData.title,
                    description: dreamData.messages.own.fail.replace('{current}', dreamWallet).replace('{price}', price) + "<br><br><small>" + dreamData.messages.reminder + "</small>",
                    description_others: dreamData.messages.own.others_fail.replace('{player}', player.displayName),
                    endTurn: true
                };
            }

        } else {
            // 3. ЧУЖАЯ мечта -> Предложение купить как актив
            const totalCash = Object.values(autoFinance.calculatedWallets).reduce((a, b) => a + b, 0);

            if (totalCash >= price) {
                // Можем предложить
                return {
                    action: 'choice',
                    title: dreamData.title,
                    description: dreamData.messages.asset.offer.replace('{name}', cell.name).replace('{price}', price),
                    description_others: dreamData.messages.asset.others_offer.replace('{player}', player.displayName).replace('{name}', cell.name),
                    options: [
                        {
                            text: `Купить (${price} ₸)`,
                            action: 'buy_dream_asset',
                            cellData: { name: cell.name, price: price }
                        },
                        {
                            text: "Отказаться",
                            action: 'decline_dream_asset'
                        }
                    ]
                };
            } else {
                // Денег нет совсем
                return {
                    action: 'dream_check_fail',
                    title: dreamData.title,
                    description: dreamData.messages.asset.fail.replace('{name}', cell.name) + "<br><br><small>" + dreamData.messages.reminder + "</small>",
                    endTurn: true
                };
            }
        }
    }

    /**
     * Вытянуть карту (через CardService)
     */
    drawCard(playerId, cardType) {
        // 1. Тянем карту
        const card = cardService.drawCard(this.gameState.decks, cardType);
        if (!card) return null;

        // 2. Обрабатываем логику (валидация, эффекты, история) через CardService
        // Теперь CellManager выступает просто как фасад/координатор
        const clientCard = cardService.processCard(card, playerId, this.gameState);

        return clientCard;
    }

    /**
     * Методы для работы с навыками (Skills)
     */
    addSkill(playerId, skillName) {
        const player = this.gameState.players[playerId];
        if (!player) return false;
        return cardService.addSkill(player, skillName);
    }

    hasSkill(playerId, skillName) {
        const player = this.gameState.players[playerId];
        if (!player) return false;
        return cardService.hasSkill(player, skillName);
    }

    getSkillDisplayName(skillId) {
        return cardService.getSkillDisplayName(skillId);
    }
}

module.exports = CellManager;
