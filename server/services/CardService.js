const fs = require('fs');
const path = require('path');

/**
 * Сервис для работы с игровыми карточками
 * Загружает карточки из JSON файлов и предоставляет методы для работы с ними
 */
class CardService {
    constructor() {
        this.cards = {
            news: [],
            chance: [],
            expenses: [],
            business: []
        };
        this.loadCards();
    }

    /**
     * Загрузить все карточки из JSON файлов
     */
    loadCards() {
        const cardsPath = path.join(__dirname, '../data/cards');

        try {
            this.cards.news = this.loadCardFile(path.join(cardsPath, 'news.json'));
            this.cards.chance = this.loadCardFile(path.join(cardsPath, 'chance.json'));
            this.cards.expenses = this.loadCardFile(path.join(cardsPath, 'expenses.json'));
            this.cards.business = this.loadCardFile(path.join(cardsPath, 'business.json'));

            console.log('✅ Карточки загружены:');
            console.log(`   - Новости: ${this.cards.news.length}`);
            console.log(`   - Шанс: ${this.cards.chance.length}`);
            console.log(`   - Расходы: ${this.cards.expenses.length}`);
            console.log(`   - Бизнес: ${this.cards.business.length}`);
        } catch (error) {
            console.error('❌ Ошибка загрузки карточек:', error.message);
        }
    }

    /**
     * Загрузить карточки из JSON файла
     */
    loadCardFile(filePath) {
        try {
            const data = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(data);

            // Если это массив, вернуть как есть
            if (Array.isArray(parsed)) {
                return parsed;
            }

            // Если это объект с массивом карточек
            if (parsed.cards && Array.isArray(parsed.cards)) {
                return parsed.cards;
            }

            // Если это объект с ключом типа (например, { business: [...] })
            const keys = Object.keys(parsed);
            if (keys.length === 1 && Array.isArray(parsed[keys[0]])) {
                return parsed[keys[0]];
            }

            return [];
        } catch (error) {
            console.error(`❌ Ошибка чтения файла ${filePath}:`, error.message);
            return [];
        }
    }

    /**
     * Перемешать колоду карточек (Fisher-Yates shuffle)
     */
    shuffleDeck(deck) {
        if (!deck || !Array.isArray(deck)) return [];
        const shuffled = [...deck];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    /**
     * Создать перемешанные колоды для новой игры
     */
    createGameDecks() {
        return {
            news: this.shuffleDeck(this.cards.news),
            chance: this.shuffleDeck(this.cards.chance),
            expenses: this.shuffleDeck(this.cards.expenses),
            business: this.shuffleDeck(this.cards.business)
        };
    }

    /**
     * Вытянуть карточку из колоды
     */
    drawCard(deck, cardType) {
        if (!deck || !this.cards[cardType]) {
            console.error(`❌ Ошибка: колода типа ${cardType} не существует`);
            return null;
        }

        if (!deck[cardType] || deck[cardType].length === 0) {
            console.warn(`⚠️ Колода ${cardType} пуста, перемешиваем заново`);
            deck[cardType] = this.shuffleDeck(this.cards[cardType]);
        }

        return deck[cardType].shift();
    }

    /**
     * Интерполяция сообщения с параметрами
     */
    interpolateMessage(template, params) {
        if (!template) return '';
        let message = template;
        Object.keys(params).forEach(key => {
            const regex = new RegExp(`{${key}}`, 'g');
            message = message.replace(regex, params[key]);
        });
        return message;
    }

    /**
     * Применить эффект карточки к игроку
     */
    applyCardEffect(card, playerState, gameState) {
        const effects = {
            moneyChange: card.amountChange || 0,
            walletChanges: {},
            businessAdded: null,
            skillAdded: null,
            assetAdded: null,
            message: '',
            playerMessages: card.playerMessages || {},
            otherPlayerMessages: card.otherPlayerMessages || {},
            hasButtons: card.hasButtons || false,
            type: card.type,
            subtype: card.subtype,
            buff: card.buff || null,
            requiresSkill: card.requiredSkill || null,
            requiresAsset: card.requiredAsset || null,
            price: card.price || 0,
            monthlyIncome: card.monthlyIncome || 0,
            oneTimeIncome: card.oneTimeIncome || 0
        };

        // Базовые параметры для интерполяции
        const params = {
            Player: playerState ? playerState.displayName : 'Игрок',
            CardName: card.title || 'Карточка',
            Amount: Math.abs(card.amountChange || card.price || card.oneTimeIncome || 0),
            Price: card.price || 0,
            Income: card.monthlyIncome || card.oneTimeIncome || 0,
            AssetName: card.assetName || card.businessName || card.skillName || ''
        };

        // === ГЛАВНАЯ ЛОГИКА: Используем standardized type и subtype ===
        const type = card.type;
        const subtype = card.subtype;

        // Определяем, нужна ли покупка
        if (card.hasButtons) {
            if (type === 'business') {
                effects.isPurchaseChoice = true;
                effects.purchaseType = 'business';
                effects.purchaseName = card.businessName;
                effects.purchasePrice = card.price;
                effects.purchaseIncome = card.monthlyIncome;
            } else if (type === 'asset' && subtype === 'offer') {
                effects.isPurchaseChoice = true;
                effects.purchaseType = 'asset';
                effects.purchaseName = card.assetName;
                effects.purchasePrice = card.price;
            } else if (type === 'skill' && subtype === 'offer') {
                effects.isPurchaseChoice = true;
                effects.purchaseType = 'skill';
                effects.purchaseName = card.skillName;
                effects.purchasePrice = card.price;
                effects.skillGranted = card.skillName; // Название навыка для покупки берем из skillName
            } else if (type === 'charity') {
                effects.isCharityChoice = true;
                effects.charityAmount = Math.abs(card.amountChange) || 0;
            } else if (type === 'asset' && subtype === 'demand') {
                effects.isSaleChoice = true;
                effects.offerAssetName = card.requiredAsset;
                effects.salePrice = card.price;

                // Проверяем наличие актива у игрока
                let asset = null;
                if (playerState && playerState.assets && playerState.assets.items) {
                    asset = playerState.assets.items.find(a => a.name === effects.offerAssetName);
                }

                if (asset) {
                    effects.assetId = asset.id;
                } else {
                    // === FIX: Immediate Failure if Asset Missing ===
                    effects.assetCheckFailed = true;
                    effects.alertMessage = `У вас нет актива: ${effects.offerAssetName}`;
                }
            }

            // Для выбора покупки/продажи начальное сообщение - это описание карточки
            effects.message = card.descriptionSelf;
        } else {
            // Если кнопок нет, эффект применяется сразу (например, доход или расход)
            // ВАЖНО: message оставляем как descriptionSelf для модального окна
            effects.message = card.descriptionSelf;

            // А результат записываем в alertMessage для уведомления
            const template = effects.playerMessages.success || card.descriptionSelf;
            // Если шаблона успеха нет, то alertMessage будет равен описанию (дублирование, но не критично)
            // Но лучше если success явно задан.
            if (effects.playerMessages.success) {
                effects.alertMessage = this.interpolateMessage(effects.playerMessages.success, params);
            } else {
                // Если нет спец сообщения об успехе, можно оставить пустым или сгенерировать дефолтное
                // effects.alertMessage = ...
                // Пока оставим null, если нет явного success message,
                // но для moneyChange лучше сгенерировать
                if (effects.moneyChange !== 0) {
                    const action = effects.moneyChange > 0 ? 'Получено' : 'Потрачено';
                    effects.alertMessage = `${action} ${Math.abs(effects.moneyChange)} ₸`;
                }
            }

            // Определяем кошелек для расхода
            if (effects.moneyChange < 0) {
                effects.walletChanges.savings = effects.moneyChange;
            }
        }

        // Если это buff (может быть как с кнопками, так и без)
        if (card.buff) {
            effects.buff = card.buff;
            console.log(`✨ Карточка: бафф ${card.buff.type}`);
        }

        // Fallback если сообщение пустое
        if (!effects.message) {
            effects.message = card.descriptionSelf || card.title || 'Карточка применена';
        }

        return effects;
    }

    /**
     * Получить информацию о карточке по ID
     */
    getCardById(cardType, cardId) {
        const deck = this.cards[cardType];
        if (!deck) return null;

        return deck.find(card => card.id === cardId || card.nr === cardId);
    }
    /**
     * Обработать логику выпавшей карты (валидация, применение эффектов, история)
     * @param {Object} card - объект карты
     * @param {string} playerId - ID игрока
     * @param {Object} gameState - состояние игры (нужно для доступа к FinanceManager и другим игрокам)
     * @returns {Object} clientCard - объект для отправки клиенту
     */
    processCard(card, playerId, gameState) {
        const player = gameState.players[playerId];

        // Применяем эффект карты (получаем декларативный объект эффектов)
        const effects = this.applyCardEffect(card, player, gameState);

        // === ПРОЦЕССИНГ ЭФФЕКТОВ ===

        // 1. Проверка требований (Навык / Актив)
        let requirementMet = true;

        if (effects.requiresSkill) {
            if (!this.hasSkill(player, effects.requiresSkill)) {
                requirementMet = false;
                effects.moneyChange = 0; // Доход не начисляется
                effects.skillCheckFailed = true;

                // Используем сообщение из карточки (missing) или дефолт
                const missingMsg = effects.playerMessages?.missing || `У вас нет навыка: ${this.getSkillDisplayName(effects.requiresSkill)}`;
                effects.alertMessage = `❌ ${missingMsg}`; // NEW: Для системного алерта
                effects.message = null; // Очищаем основное сообщение, чтобы в модалке показалось descriptionSelf
            }
        }

        if (effects.requiresAsset && requirementMet) {
            const hasAsset = player.assets.items.some(i => i.name === effects.requiresAsset);
            if (!hasAsset) {
                requirementMet = false;
                effects.moneyChange = 0;
                effects.assetCheckFailed = true;

                const missingMsg = effects.playerMessages?.missing || `У вас нет актива: ${effects.requiresAsset}`;
                effects.alertMessage = `❌ ${missingMsg}`;
                effects.message = null;
            }
        }

        // 2. Обработка НОВОСТЕЙ (могут влиять на всех)
        const cardType = effects.type || 'chance';
        if (cardType === 'news' && !effects.hasButtons && requirementMet) {
            // Если это массовый эффект новости (например, доход всем с навыком)
            if (effects.requiresSkill) {
                const skillName = this.getSkillDisplayName(effects.requiresSkill);
                Object.keys(gameState.players).forEach(pid => {
                    const p = gameState.players[pid];
                    if (this.hasSkill(p, effects.requiresSkill) && pid !== playerId) {
                        gameState.financeManager.applyMoneyChange(pid, effects.moneyChange, { investments: effects.moneyChange }, `Событие: ${effects.message}`);
                    }
                });
            }
        }

        // 3. Применение финансовых изменений (если нет выбора действия)
        if (!effects.hasButtons && requirementMet && effects.moneyChange !== 0) {
            const desc = card.title || 'Событие';
            gameState.financeManager.applyMoneyChange(playerId, effects.moneyChange, effects.walletChanges, desc);

            // Если это карточка благотворительности (обязательная), начисляем привилегию
            if (cardType === 'charity' && effects.moneyChange < 0) {
                player.status.charityDonationsMade = (player.status.charityDonationsMade || 0) + 1;
                console.log(`💝 Обязательное доброе дело записано игроку ${player.displayName}`);
            }
        }

        // 4. Добавление навыка (если это безусловный подарок, не выбор)
        if (effects.skillGranted && !effects.hasButtons && requirementMet) {
            const added = this.addSkill(player, effects.skillGranted);
            if (added) {
                const addedMsg = `📚 Получен навык: ${this.getSkillDisplayName(effects.skillGranted)}`;
                effects.alertMessage = effects.alertMessage ? `${effects.alertMessage}. ${addedMsg}` : addedMsg;
            }
        }

        // 5. Запись в историю
        gameState.addToHistory({
            action: 'card_drawn',
            actorId: playerId,
            actorName: player.displayName,
            details: {
                cardType,
                cardId: card.nr || card.id,
                message: effects.alertMessage || effects.message,
                type: effects.type
            }
        });

        // === ПОДГОТОВКА ОБЪЕКТА ДЛЯ КЛИЕНТА ===
        const clientCard = {
            ...card,
            id: card.id || card.nr,
            processedMessage: effects.message,     // Будет null при провале, сработает fallback на descriptionSelf
            alertMessage: effects.alertMessage,    // NEW: Сообщение для алерта
            moneyChange: effects.moneyChange,
            isPurchaseChoice: effects.isPurchaseChoice || false,
            isSaleChoice: effects.isSaleChoice || false,
            isCharityChoice: effects.isCharityChoice || false,
            purchaseType: effects.purchaseType,
            purchaseName: effects.purchaseName,
            purchasePrice: effects.purchasePrice,
            purchaseIncome: effects.purchaseIncome,
            salePrice: effects.salePrice,
            charityAmount: effects.charityAmount, // NEW: Сумма пожертвования
            skillGranted: effects.skillGranted,   // NEW: Навык для покупки
            offerAssetName: effects.offerAssetName,
            assetId: effects.assetId,
            requirementMet: requirementMet,
            skillCheckFailed: effects.skillCheckFailed || false,
            assetCheckFailed: effects.assetCheckFailed || false
        };

        return clientCard;
    }

    /**
     * Helper: Add skill to player
     */
    addSkill(player, skillName) {
        if (!player.assets.skills) player.assets.skills = []; // Safety check
        if (!player.assets.skills.includes(skillName)) {
            player.assets.skills.push(skillName);
            return true;
        }
        return false;
    }

    /**
     * Helper: Check if player has skill
     */
    hasSkill(player, skillName) {
        return player.assets && player.assets.skills && player.assets.skills.includes(skillName);
    }

    /**
     * Helper: Get Display Name for Skill
     */
    getSkillDisplayName(skillId) {
        const skillNames = {
            'translator_german': 'Переводчик (Немецкий)',
            'translator_french': 'Переводчик (Французский)',
            'translator_chinese': 'Переводчик (Китайский)',
            'translator_english': 'Переводчик (Английский)',
            'computer_repair': 'Ремонт компьютеров',
            'designer': 'Дизайнер',
            'smm': 'SMM-специалист',
            'web_designer': 'Веб-дизайнер',
            'investor': 'Инвестор',
            'programmer': 'Программист',
            'copywriter': 'Копирайтер',
            'tutor': 'Репетитор',
            'hand_made': 'Мастер ручной работы',
            'delivery': 'Курьер',
            'video_editor': 'Видеомонтажер',
            'stylist': 'Стилист',
            'fitness_trainer': 'Фитнес-тренер',
            // Добавьте другие навыки по мере необходимости
        };
        return skillNames[skillId] || skillId;
    }
}

module.exports = new CardService();
