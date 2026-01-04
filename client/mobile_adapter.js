
window.addEventListener('load', () => {
    checkLayout();
    window.addEventListener('resize', checkLayout);
    setInterval(checkLayout, 1000);
});

let isMobileActive = false;

// List of all modals to move
const MODAL_IDS = [
    'curator-auth-modal',
    'curator-panel-modal',
    'game-over-modal',
    'tutorial-modal',
    'auth-modal',
    'finance-modal',
    'history-modal',
    'diceResultModal',     // Often dynamic or hidden
    'server-data-modal',   // Nested usually, but if top level check
    'observer-card-modal'  // If exists
];

function checkLayout() {
    const isMobile = window.innerWidth <= 1200;

    if (isMobile) {
        if (!isMobileActive) {
            activateMobile();
        }
        updateMobileScale();
    } else {
        if (isMobileActive) {
            restoreDesktop();
        }
    }
}

function activateMobile() {
    let wrapper = document.getElementById('mobile-wrapper');
    if (!wrapper) {
        wrapper = document.createElement('div');
        wrapper.id = 'mobile-wrapper';
        document.body.appendChild(wrapper);
    }

    const chat = document.getElementById('chat-panel');
    const input = document.querySelector('#players-chat-panel') || document.getElementById('players-chat-panel');
    const gameCont = document.getElementById('gameContainer');

    // Move Main Elements
    if (chat) wrapper.appendChild(chat);
    if (input) wrapper.appendChild(input);
    if (gameCont) wrapper.appendChild(gameCont);

    // Move Modals
    MODAL_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            wrapper.appendChild(el);
            // Add a marker class for CSS targeting if needed, though ID is enough
            el.classList.add('mobile-moved-modal');
        }
    });

    isMobileActive = true;
}

function restoreDesktop() {
    const wrapper = document.getElementById('mobile-wrapper');
    if (!wrapper) return;

    const chat = document.getElementById('chat-panel');
    const input = document.querySelector('#players-chat-panel') || document.getElementById('players-chat-panel');
    const gameCont = document.getElementById('gameContainer');

    // Restore Main Elements
    if (gameCont) document.body.appendChild(gameCont);
    if (chat) document.body.appendChild(chat);
    if (input) document.body.appendChild(input);

    // Restore Modals
    MODAL_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            document.body.appendChild(el);
            el.classList.remove('mobile-moved-modal');
            el.removeAttribute('style'); // Cleanup inline styles
        }
    });

    wrapper.remove();

    resetStyles([chat, input, gameCont]);
    const board = document.getElementById('fullhd');
    if (board) board.style.cssText = '';

    isMobileActive = false;
}

function updateMobileScale() {
    if (!isMobileActive) return;

    const gameCont = document.getElementById('gameContainer');
    const board = document.getElementById('fullhd');

    if (!gameCont || !board) return;

    // Determine layout metrics
    const windowW = window.innerWidth;
    const windowH = window.innerHeight;

    // Input Height
    const inputPanel = document.querySelector('#players-chat-panel');
    const inputH = inputPanel ? inputPanel.offsetHeight : 60;

    // Chat Panel (Flexes, but has min height)
    // We don't limit board by chat height anymore, chat takes remainder.
    // BUT we need to limit board height to be sane?
    // User wants "input and board bottom anchor". 
    // Chat fills top.

    // Safety check: Don't let chat disappear. 
    const minChatH = windowH * 0.15;
    const maxBoardH = windowH - inputH - minChatH;

    // Scale Logic
    const baseW = 1023;
    const baseH = 650;

    // Scale based on Width (primary) and constrained Height
    const scaleX = windowW / baseW;
    const scaleY = maxBoardH / baseH;
    const scale = Math.min(scaleX, scaleY);

    const finalH = baseH * scale;

    // Apply strict height to container
    gameCont.style.height = `${finalH}px`;
    gameCont.style.width = '100%';

    // Scale Board
    board.style.transformOrigin = 'top left';
    board.style.transform = `scale(${scale})`;

    // Center logic
    const finalW = baseW * scale;
    const offsetLeft = (windowW - finalW) / 2;

    board.style.position = 'absolute';
    board.style.left = `${offsetLeft}px`;
    board.style.top = '0px';
    board.style.margin = '0';
}

function resetStyles(elements) {
    elements.forEach(el => {
        if (el) el.removeAttribute('style');
    });
}
