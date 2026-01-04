console.log('📜 deckanimation.js loaded (Hybrid Restoration)');
const decks = document.querySelectorAll('.deck');
const card = document.getElementById('card');
const cardDynamicContent = document.getElementById('card-dynamic-content');
const cardTitle = document.getElementById('card-title');
const cardText = document.getElementById('card-text');
const cardExtra = document.getElementById('card-extra-info');
const cardCloseBtn = document.getElementById('card-close-btn');

let isAnimating = false;

// Helpers
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 1. Deck Click Listener
decks.forEach(deck => {
    deck.addEventListener('click', async () => {
        console.log(`🖱️ Clicked on deck: ${deck.dataset.deck}`);

        if (isAnimating) return;

        // Validation
        if (window.gameClient && window.gameClient.mustMoveFirst) {
            alert("Сначала переместите свою фигурку!");
            return;
        }

        if (typeof window.drawCardFromDeck !== 'function') {
            alert('Ошибка клиента: функция drawCardFromDeck не найдена');
            return;
        }

        try {
            if (window.deactivateMoneyCellClaim) window.deactivateMoneyCellClaim();

            // Server request - logic continues in animateCardDraw via socket
            await window.drawCardFromDeck(deck.dataset.deck);
        } catch (e) {
            console.error('Error drawing card:', e);
        }
    });
});


// 2. The Renderer (Restored Logic)
// This function is called by gameclient.js socket listener 'game:card_drawn'
window.animateCardDraw = async function (deckId, cardData, playerName, isMyTurn = false) {
    if (isMyTurn && isAnimating) return; // Prevent double trigger

    console.log(`🎬 Rendering Card Window for ${playerName}`);
    isAnimating = true;

    // Notify Unified Queue that a window is open
    if (typeof window.isEventWindowOpen !== 'undefined') {
        window.isEventWindowOpen = true;
    }

    // A. Prepare DOM
    if (cardTitle) cardTitle.innerHTML = cardData.title || 'КАРТОЧКА';

    // Explicitly hide the static close button for everyone (we use custom buttons)
    if (cardCloseBtn) cardCloseBtn.style.display = 'none';

    // Description logic
    let description = '...';
    if (isMyTurn) {
        description = cardData.processedMessage || cardData.descriptionSelf || cardData.description || cardData.text;
    } else {
        const nameToUse = playerName || 'Игрок';
        if (cardData.descriptionOthers) {
            description = cardData.descriptionOthers.replace(/{player}|{Player}/g, nameToUse);
        } else {
            description = cardData.description || cardData.text;
        }
    }
    if (cardText) cardText.innerHTML = description;

    // Extra Info (Price/Income)
    let extra = '';
    if (cardData.price || cardData.cost) extra += `Цена: ${cardData.price || cardData.cost}₸ `;
    if (cardData.income) extra += `Доход: ${cardData.income}₸ `;

    // Buttons Container
    if (cardExtra) {
        cardExtra.innerHTML = ''; // Clear old buttons

        // Show text info if any
        if (extra) {
            const extraDiv = document.createElement('div');
            extraDiv.style.marginBottom = '10px';
            extraDiv.textContent = extra;
            cardExtra.appendChild(extraDiv);
        }
    }

    // B. Show Window (Fade In - No flying)
    if (card) {
        // Reset state
        card.classList.remove('is-flying');
        card.classList.add('is-window'); // Important class for CSS visibility

        card.style.display = 'block'; // Ensure block display
        card.style.opacity = '0';

        // Center it (Hardcoded or CSS default)
        card.style.left = '50%';
        card.style.top = '50%';
        card.style.transform = 'translate(-50%, -50%)';

        // Fade In
        // Force reflow
        void card.offsetWidth;
        card.style.transition = 'opacity 0.3s ease';
        card.style.opacity = '1';

        // Content Fade In
        if (cardDynamicContent) {
            cardDynamicContent.style.opacity = '1';
            cardDynamicContent.style.pointerEvents = 'auto'; // Make clickable
        }
    }

    // C. Render Buttons (Hybrid: use local renderer for immediate feedback)
    if (isMyTurn && cardExtra) {
        renderButtonsLocally(cardData, cardExtra);
    }
    else if (!isMyTurn && cardExtra) {
        // Observer message
        const msg = document.createElement('div');
        msg.textContent = `${playerName} выбирает...`;
        msg.style.color = '#aaa';
        cardExtra.appendChild(msg);
    }

    // D. Watchdog for Cleanup
    setTimeout(() => { isAnimating = false; }, 1000);
};


// 3. Local Button Renderer (Mirrors gameclient logic but safely here)
function renderButtonsLocally(data, container) {
    // Purchase
    if (data.isPurchaseChoice) {
        createBtn(container, `Купить за ${data.purchasePrice}₸`, '#27ae60', () => {
            // Socket emit handled here for speed
            window.socket.emit('player:purchase_choice', {
                accept: true,
                price: data.purchasePrice,
                name: data.purchaseName,
                walletSource: data.walletSource,
                isAsset: data.purchaseType === 'asset'
            });
            // Close handled by server events, but we can optimistically hide
            // window.forceHideCard();
        });
        createBtn(container, 'Отказаться', '#7f8c8d', () => {
            window.socket.emit('player:purchase_choice', { accept: false, name: data.purchaseName });
            // window.forceHideCard();
        });
    }
    // Sale
    else if (data.isSaleChoice) {
        createBtn(container, `Продать за ${data.salePrice}₸`, '#2ecc71', () => {
            window.socket.emit('player:sale_choice', { accept: true, assetId: data.assetId, salePrice: data.salePrice });
        });
        createBtn(container, 'Оставить', '#95a5a6', () => {
            window.socket.emit('player:sale_choice', { accept: false });
        });
    }
    // Charity
    else if (data.isCharityChoice) {
        createBtn(container, `Помочь (-${data.charityAmount})`, '#9b59b6', () => {
            window.socket.emit('player:charity_choice', { accept: true, amount: data.charityAmount });
        });
        createBtn(container, 'Отказаться', '#95a5a6', () => {
            window.socket.emit('player:charity_choice', { accept: false });
        });
    }
    // Simple Info -> OK
    else {
        createBtn(container, 'OK', '#2980b9', () => {
            window.socket.emit('player:acknowledge_card', {});
            // Fallback finish logic
            if (window.finishTurn) window.finishTurn();
            window.forceHideCard();
        });
    }
}

function createBtn(parent, text, color, onClick) {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = `
        display: block; width: 100%; margin: 8px 0; padding: 12px;
        background: ${color}; color: white; border: none; border-radius: 5px;
        cursor: pointer; font-weight: bold; font-size: 16px;
    `;
    btn.onclick = onClick;
    parent.appendChild(btn);
}


// 4. Force Hide (Restored)
window.forceHideCard = function () {
    console.log('🔒 forceHideCard called');
    if (window.isCardModalOpen) window.isCardModalOpen = false;

    // Notify Unified Queue that window is closed
    if (typeof window.isEventWindowOpen !== 'undefined') {
        window.isEventWindowOpen = false;
    }

    if (card) {
        card.style.opacity = '0';
        card.style.pointerEvents = 'none';

        card.style.display = 'none';
        card.classList.remove('is-window');
        // Try to process next in queue if any
        if (window.processEventQueue) window.processEventQueue();
        else if (window.processNotificationQueue) window.processNotificationQueue();
    }
    isAnimating = false;
};
