const { v4: uuidv4 } = require('uuid');

/**
 * Менеджер Финансов (FinanceManager)
 * Отвечает за:
 * - Все операции с деньгами (доходы, расходы)
 * - Управление копилками (Savings, Charity, Dream, Investments)
 * - Покупку бизнесов
 * - Сбор доходов
 * - Ручное обновление финансов игроком
 */
class FinanceManager {
    constructor(gameState) {
        this.gameState = gameState;
    }

    /**
     * Применить изменение денег (с описанием и автораспределением)
     * @param {string} playerId
     * @param {number} amount - Сумма (+ или -)
     * @param {object} walletChanges - (Опционально) Конкретные изменения по кошелькам
     * @param {string} description - Описание транзакции
     */
    applyMoneyChange(playerId, amount, walletChanges = {}, description = null) {
        const autoFinance = this.gameState.autoFinanceCards[playerId];
        if (!autoFinance) return;

        // 1. Логируем в историю финансов
        if (amount > 0) {
            // ДОХОД
            autoFinance.incomeHistory.push({
                timestamp: new Date().toISOString(),
                type: description || 'one_time_income',
                amount
            });

            // Если не указано конкретное распределение, используем правило 10/20/10/60
            if (Object.keys(walletChanges).length === 0) {
                walletChanges = {
                    charity: Math.round(amount * 0.10),
                    dream: Math.round(amount * 0.20),
                    savings: Math.round(amount * 0.10),
                    investments: Math.round(amount * 0.60)
                };
                console.log(`💰 Автораспределение дохода ${amount}₴: charity=${walletChanges.charity}, dream=${walletChanges.dream}, savings=${walletChanges.savings}, investments=${walletChanges.investments}`);
            }
        } else if (amount < 0) {
            // РАСХОД
            autoFinance.expensesHistory.push({
                timestamp: new Date().toISOString(),
                type: description || 'expense',
                amount: Math.abs(amount)
            });

            // Если не указано откуда списывать - списываем с Savings
            if (Object.keys(walletChanges).length === 0) {
                walletChanges = { savings: amount };
                console.log(`💸 Автосписание расхода ${Math.abs(amount)}₴ из savings`);
            }
        }

        // 2. Применяем изменения к серверным кошелькам
        Object.keys(walletChanges).forEach(wallet => {
            if (autoFinance.calculatedWallets[wallet] !== undefined) {
                autoFinance.calculatedWallets[wallet] += walletChanges[wallet];
            }
        });

        // 3. Обновляем данные текущего хода (для автозаполнения клиентом)
        this.updateCurrentTurnData(playerId, amount, walletChanges, description);

        // 4. КРИТИЧЕСКИ ВАЖНО: Обновляем turnHistory.amount для ИСТОРИИ ХОДОВ
        const player = this.gameState.players[playerId];
        if (player && player.turnHistory && player.turnHistory.length > 0) {
            const lastTurn = player.turnHistory[player.turnHistory.length - 1];
            lastTurn.amount = (lastTurn.amount || 0) + amount;
            console.log(`📝 [turnHistory.amount] ${player.displayName}: amount обновлён на ${amount}₴ -> итого ${lastTurn.amount}₴`);
        }
    }

    /**
     * Вспомогательный метод записи данных для автозаполнения
     */
    updateCurrentTurnData(playerId, amount, walletChanges, description) {
        const player = this.gameState.players[playerId];
        if (player && player.currentTurnData) {
            // Изменения кошельков - записываем ВСЕ изменения, не только предопределённые
            Object.keys(walletChanges).forEach(wallet => {
                if (player.currentTurnData.walletChanges[wallet] === undefined) {
                    player.currentTurnData.walletChanges[wallet] = 0; // Инициализируем если нет
                }
                player.currentTurnData.walletChanges[wallet] += walletChanges[wallet];
            });

            // Запись транзакции
            const entryName = description || (amount > 0 ? 'Доход' : 'Расход');
            const entryAmount = Math.abs(amount);
            const entry = {
                id: Date.now().toString() + Math.random(),
                name: entryName,
                amount: entryAmount,
                timestamp: new Date().toISOString()
            };

            if (amount > 0) {
                player.currentTurnData.incomeEntries.push(entry);
            } else {
                player.currentTurnData.expenseEntries.push(entry);
            }

            console.log(`📝 [updateCurrentTurnData] ${player.displayName}: ${entryName} = ${amount}, wallets:`, walletChanges);
        }
    }

    /**
     * Собрать доход от всех бизнесов игрока
     * Вызывается при проходе клетки "Деньги"
     */
    collectBusinessIncome(playerId) {
        const player = this.gameState.players[playerId];
        if (!player) return 0;

        let totalIncome = 0;

        // Считаем сумму дохода от всех бизнесов
        if (player.assets.businesses && player.assets.businesses.length > 0) {
            player.assets.businesses.forEach(business => {
                const monthlyIncome = Number(business.monthlyIncome) || 0;
                totalIncome += monthlyIncome;
            });
        }

        // TODO: Сюда можно добавить доход от навыков, если они пассивные

        // Если доход есть - распределяем
        if (totalIncome > 0) {
            this.distributeMonthlyIncome(playerId, totalIncome);

            this.gameState.addToHistory({
                action: 'business_income_collected',
                actorId: playerId,
                actorName: player.displayName,
                details: {
                    totalIncome,
                    businessCount: player.assets.businesses?.length || 0,
                    message: `💰 ${player.displayName} собрал доход: ${totalIncome} монет`
                }
            });
        }

        return totalIncome;
    }

    /**
     * Распределить месячный доход (стандартное правило)
     */
    distributeMonthlyIncome(playerId, income) {
        const player = this.gameState.players[playerId];
        const autoFinance = this.gameState.autoFinanceCards[playerId];

        // Проверка блокировки дохода (штраф)
        if (player.status.incomeBlockedTurns > 0) {
            console.log(`🛑 Доход заблокирован для ${player.displayName} (осталось: ${player.status.incomeBlockedTurns})`);

            this.gameState.addToHistory({
                action: 'income_blocked',
                actorId: playerId,
                actorName: player.displayName,
                details: { message: `Зарплата не начислена из-за штрафа (осталось: ${player.status.incomeBlockedTurns})` }
            });
            return;
        }

        // Правило: 10/20/10/60
        const distribution = {
            charity: Math.round(income * 0.1),
            dream: Math.round(income * 0.2),
            savings: Math.round(income * 0.1),
            investments: Math.round(income * 0.6)
        };

        // Пишем сразу в кошельки
        autoFinance.calculatedWallets.charity += distribution.charity;
        autoFinance.calculatedWallets.dream += distribution.dream;
        autoFinance.calculatedWallets.savings += distribution.savings;
        autoFinance.calculatedWallets.investments += distribution.investments;

        // Логируем
        autoFinance.incomeHistory.push({
            timestamp: new Date().toISOString(),
            type: 'monthly_salary',
            amount: income,
            distribution
        });

        // Записываем для автозаполнения
        this.updateCurrentTurnData(playerId, income, distribution, 'Месячный доход');

        this.gameState.addToHistory({
            action: 'monthly_income_distributed',
            actorId: playerId,
            actorName: player.displayName,
            details: { message: `Получен доход: ${income} соляров` }
        });
    }

    /**
     * Умное списание денег с приоритетами
     * @param {number} amount - Сумма списания (положительная)
     * @param {object} options - Флаги (forBusiness, forCharity, forDream)
     */
    spendFromWallets(playerId, amount, options = {}) {
        const autoFinance = this.gameState.autoFinanceCards[playerId];
        const wallets = autoFinance.calculatedWallets;
        let remaining = amount;

        // 1. Специфичные кошельки (если указано)
        if (options.forCharity) {
            if (wallets.charity >= remaining) { wallets.charity -= remaining; return true; }
            return false;
        }
        if (options.forDream) {
            if (wallets.dream >= remaining) { wallets.dream -= remaining; return true; }
            return false;
        }

        // 2. Покупка БИЗНЕСА (Приоритет: Инвестиции -> Сбережения)
        if (options.forBusiness) {
            if (wallets.investments >= remaining) {
                wallets.investments -= remaining;
                return true;
            } else {
                remaining -= wallets.investments;
                wallets.investments = 0;
            }
            if (wallets.savings >= remaining) {
                wallets.savings -= remaining;
                return true;
            } else {
                remaining -= wallets.savings;
                wallets.savings = 0;
            }
            return remaining <= 0;
        }

        // 3. ОБЫЧНЫЙ РАСХОД (Приоритет: Сбережения -> Инвестиции)
        if (wallets.savings >= remaining) {
            wallets.savings -= remaining;
            this.recordExpense(playerId, amount, 'savings');
            return true;
        } else {
            remaining -= wallets.savings;
            wallets.savings = 0;
        }

        if (wallets.investments >= remaining) {
            wallets.investments -= remaining;
            this.recordExpense(playerId, amount, 'investments');
            return true;
        } else {
            remaining -= wallets.investments;
            wallets.investments = 0;
        }

        // Если денег не хватило - записываем долг
        if (remaining > 0) {
            this.gameState.players[playerId].debts.push({
                amount: remaining,
                reason: 'expense_shortfall',
                timestamp: new Date().toISOString()
            });
            console.log(`⚠️ Не хватило ${remaining} монет. Записан долг.`);
        }

        // Записываем смешанный расход
        this.recordExpense(playerId, amount - remaining, 'mixed');
        return true;
    }

    /**
     * Списание средств с каскадной логикой (для покупки активов):
     * 1. Инвестиции (Investments)
     * 2. Остаток распределяется поровну между остальными кошельками
     */
    cascadingSpend(playerId, amount, description = 'Покупка актива') {
        const autoFinance = this.gameState.autoFinanceCards[playerId];
        const wallets = autoFinance.calculatedWallets;
        let remaining = amount;

        // 1. Сначала Инвестиции
        if (wallets.investments >= remaining) {
            wallets.investments -= remaining;
            remaining = 0;
        } else {
            remaining -= wallets.investments;
            wallets.investments = 0;
        }

        // 2. Остальное поровну с других (Charity, Dream, Savings)
        if (remaining > 0) {
            const others = ['charity', 'dream', 'savings'];
            const share = Math.floor(remaining / others.length);
            const extra = remaining % others.length;

            others.forEach((w, index) => {
                const toDeduct = share + (index < extra ? 1 : 0);
                wallets[w] -= toDeduct;
            });
            remaining = 0;
        }

        this.recordExpense(playerId, amount, 'cascading');
        return true;
    }

    /**
     * Записать расход в историю
     */
    recordExpense(playerId, amount, source) {
        const autoFinance = this.gameState.autoFinanceCards[playerId];
        autoFinance.expensesHistory.push({
            timestamp: new Date().toISOString(),
            type: 'expense',
            amount,
            source
        });
        // Также обновляем currentTurnData
        const walletChanges = {};
        if (source !== 'mixed' && source !== 'cascading') {
            walletChanges[source] = -Math.abs(amount);
        }
        this.updateCurrentTurnData(playerId, -Math.abs(amount), walletChanges, 'Расход');
    }

    /**
     * Покупка бизнеса
     */
    buyBusiness(playerId, businessData) {
        const player = this.gameState.players[playerId];
        const autoFinance = this.gameState.autoFinanceCards[playerId];

        // Проверка средств (Investments + Savings)
        const totalAvailable = autoFinance.calculatedWallets.investments + autoFinance.calculatedWallets.savings;
        if (totalAvailable < businessData.price) {
            return { success: false, error: 'Недостаточно средств' };
        }

        // Списываем
        this.spendFromWallets(playerId, businessData.price, { forBusiness: true });

        // Парсим доход (приоритет monthlyIncome)
        let incomeAmount = businessData.monthlyIncome !== undefined ? businessData.monthlyIncome : (businessData.income !== undefined ? businessData.income : (businessData.cashflow || 0));
        if (typeof incomeAmount === 'string') incomeAmount = parseInt(incomeAmount) || 0;

        // Добавляем актив
        const newBusiness = {
            id: uuidv4(),
            name: businessData.name,
            price: businessData.price,
            monthlyIncome: incomeAmount,  // Используем название из JSON
            acquiredAt: new Date().toISOString()
        };
        player.assets.businesses.push(newBusiness);

        // Увеличиваем общий cashflow
        autoFinance.calculatedBusinessCashFlow += incomeAmount;
        autoFinance.calculatedMonthlyIncome += incomeAmount;

        this.gameState.addToHistory({
            action: 'business_purchased',
            actorId: playerId,
            actorName: player.displayName,
            details: {
                message: `🏢 ${player.displayName} купил бизнес: ${businessData.name} за ${businessData.price}₸`
            },
            amount: -businessData.price
        });

        return { success: true, business: newBusiness };
    }

    /**
     * Выбрать мечту
     */
    selectDream(playerId, dreamData) {
        const player = this.gameState.players[playerId];
        if (player.dream) throw new Error('Мечта уже выбрана');

        player.dream = {
            id: dreamData.id,
            price: parseInt(dreamData.price),
            name: dreamData.name
        };

        this.gameState.addToHistory({
            action: 'dream_selected',
            actorId: playerId,
            actorName: player.displayName,
            details: {
                message: `${player.displayName} выбрал мечту: ${player.dream.name} (${player.dream.price} ₸)`
            }
        });
        return player.dream;
    }

    /**
     * Сравнение введенных данных с серверными (для режима проверки)
     */
    compareFinances(playerId) {
        const player = this.gameState.players[playerId];
        const autoFinance = this.gameState.autoFinanceCards[playerId];
        const entered = player.playerEnteredFinances;

        const discrepancies = [];

        Object.keys(entered.wallets).forEach(wallet => {
            const enteredAmount = entered.wallets[wallet];
            const calculatedAmount = autoFinance.calculatedWallets[wallet];

            if (enteredAmount !== calculatedAmount) {
                discrepancies.push({
                    field: `wallets.${wallet}`,
                    entered: enteredAmount,
                    expected: calculatedAmount,
                    difference: enteredAmount - calculatedAmount
                });
            }
        });

        return {
            hasDiscrepancies: discrepancies.length > 0,
            discrepancies,
            entered: entered.wallets,
            expected: autoFinance.calculatedWallets
        };
    }

    /**
     * Обновить ручные финансы (данные от клиента)
     */
    updatePlayerFinances(playerId, financesData) {
        const player = this.gameState.players[playerId];
        player.playerEnteredFinances = {
            ...player.playerEnteredFinances,
            ...financesData
        };
        return this.compareFinances(playerId);
    }
}

module.exports = FinanceManager;
