class PlayerGame {
    constructor() {
        this.currentCellIndex = 0;
        this.path = this.buildPath(); // now synchronous lookup
        this.ant = null;
        this.isMyTurn = false;
        this.targetCellIndex = -1;
        this.boundMouseDown = null; // for cleanup
        this.currentSteps = 0;

        // Error indicator
        this.errorIndicator = document.createElement('div');
        this.errorIndicator.className = 'error-indicator';
        document.body.appendChild(this.errorIndicator);
    }

    setPlayerAnt(element) {
        if (this.ant && this.boundMouseDown) {
            this.ant.removeEventListener('mousedown', this.boundMouseDown);
        }
        this.ant = element;
        this.initDragAndDrop();
        console.log('🐜 Player figure updated in PlayerGame');
    }

    buildPath() {
        const path = [];
        const find = (cls) => document.querySelector(`.${cls}`);

        // Try to find Start cell. If not found, warn.
        // Assuming strict naming: cell-start, cell-1...
        const start = find('cell-start');
        if (start) path.push(start);
        else console.warn('Missing .cell-start');

        for (let i = 1; i <= 8; i++) {
            const c = find(`cell-${i}`);
            if (c) path.push(c);
        }

        const fork1 = find('cell-fork1');
        if (fork1) path.push(fork1);

        for (let i = 9; i <= 18; i++) {
            const c = find(`cell-${i}`);
            if (c) path.push(c);
        }

        const fork = find('cell-fork');
        if (fork) path.push(fork);

        for (let i = 19; i <= 55; i++) {
            const c = find(`cell-${i}`);
            if (c) path.push(c);
        }

        return path;
    }

    enableMove(steps, prediction = null) {
        if (!this.ant) {
            console.error('Player figure not set!');
            return;
        }

        // Clean slate: Remove ANY existing highlights first
        document.querySelectorAll('.valid-target').forEach(el => {
            el.classList.remove('valid-target');
            // Cloning to strip listeners? No, just rely on our track.
            // But if we missed cleanup, listener might persist.
            // Better to be safe: valid-target implies we added listener.
            // But we can't easily remove anonymous/bound listeners if we lost ref.
            // We'll rely on class removal for visuals.
            // Listeners check isMyTurn so they are harmless if isMyTurn=false.
        });

        this.currentSteps = steps;
        this.isMyTurn = true;

        let targetCell;

        if (prediction && prediction.targetCell) {
            // Use server prediction (Essential for forks and correct path)
            targetCell = document.querySelector(`.${prediction.targetCell}`);
            console.log(`Using server prediction: ${prediction.targetCell}`);
        } else {
            // Fallback (Legacy linear logic - unreliable for forks)
            this.targetCellIndex = this.currentCellIndex + steps;
            if (this.targetCellIndex >= this.path.length) {
                this.targetCellIndex = this.targetCellIndex % this.path.length;
            }
            targetCell = this.path[this.targetCellIndex];
        }
        if (targetCell) {
            targetCell.classList.add('valid-target');
            this.activeHighlightedCell = targetCell; // Track it explicitly

            // Click listener on TARGET cell
            this.boundClickListener = (e) => this.handleCellClick(e, targetCell);
            targetCell.addEventListener('click', this.boundClickListener);

            // Touch support for mobile - tap on cell to move
            this.boundTouchListener = (e) => {
                e.preventDefault();
                this.handleCellClick(e, targetCell);
            };
            targetCell.addEventListener('touchstart', this.boundTouchListener, { passive: false });

            // Drag enable
            this.ant.classList.add('draggable');
            this.ant.style.cursor = 'grab';
        }

        console.log(`Move enabled. Steps: ${steps}, Target Index: ${this.targetCellIndex}`);
    }

    handleCellClick(e, targetCell) {
        if (!this.isMyTurn) return;
        this.successMove(targetCell);
    }

    successMove(targetCell) {
        // Use the global strict positioner
        window.positionPlayerOnCell(this.ant, targetCell, 0);

        this.cleanupTurn();

        // Unlock decks
        if (window.gameClient) {
            window.gameClient.mustMoveFirst = false;
            console.log('🔓 Decks unlocked: move complete');
        }

        // Notify server
        if (window.sendMoveRequest && this.currentSteps) {
            window.sendMoveRequest(this.currentSteps);
        }
    }

    cleanupTurn() {
        if (this.activeHighlightedCell) {
            this.activeHighlightedCell.classList.remove('valid-target');
            if (this.boundClickListener) {
                this.activeHighlightedCell.removeEventListener('click', this.boundClickListener);
            }
            if (this.boundTouchListener) {
                this.activeHighlightedCell.removeEventListener('touchstart', this.boundTouchListener);
            }
            this.activeHighlightedCell = null;
        }

        // Also try legacy path for safety (in case we mixed modes)
        const legacyCell = this.path[this.targetCellIndex];
        if (legacyCell) legacyCell.classList.remove('valid-target');

        if (this.ant) {
            this.ant.classList.remove('draggable');
            this.ant.style.cursor = 'default';
        }
        // Update index if prediction based?
        // We probably should sync index based on targetCell ID?
        // But the game relies on server position anyway.
        // We'll leave index management for now as it's less critical than visual.

        this.isMyTurn = false;
    }

    showError(x, y) {
        this.errorIndicator.style.left = `${x}px`;
        this.errorIndicator.style.top = `${y}px`;
        this.errorIndicator.classList.add('show');
        setTimeout(() => this.errorIndicator.classList.remove('show'), 1000);
    }

    initDragAndDrop() {
        if (!this.ant) return;

        let startX, startY, initialLeft, initialTop;

        const onDragStart = (e) => {
            if (!this.isMyTurn) return;

            // Unified event source
            const evt = e.touches ? e.touches[0] : e;

            // Prevent default on touch to stop scrolling, but allow mouse default
            if (e.touches) e.preventDefault();

            startX = evt.clientX;
            startY = evt.clientY;

            initialLeft = this.ant.offsetLeft;
            initialTop = this.ant.offsetTop;

            this.ant.classList.add('dragging');
            this.ant.style.cursor = 'grabbing';
            this.ant.style.zIndex = 3000;

            if (e.touches) {
                document.addEventListener('touchmove', onDragMove, { passive: false });
                document.addEventListener('touchend', onDragEnd);
            } else {
                document.addEventListener('mousemove', onDragMove);
                document.addEventListener('mouseup', onDragEnd);
            }
        };

        const onDragMove = (e) => {
            const evt = e.touches ? e.touches[0] : e;
            if (e.touches) e.preventDefault(); // Stop scroll

            let scale = 1;
            const container = document.querySelector('.game-container'); // Класс, латинская c
            const fullhd = document.getElementById('fullhd');

            const getScale = (el) => {
                if (!el) return 1;
                const style = window.getComputedStyle(el);
                const transform = style.transform || style.webkitTransform || style.mozTransform;
                if (transform && transform !== 'none') {
                    // Primitive parse for scale or matrix scaleX
                    const values = transform.split('(')[1].split(')')[0].split(',');
                    return parseFloat(values[0]);
                }
                return 1;
            };

            scale = getScale(container) * getScale(fullhd);
            // Safety check for scale to prevent division by zero or huge jumps
            if (scale < 0.1) scale = 0.1;

            const dx = (evt.clientX - startX) / scale;
            const dy = (evt.clientY - startY) / scale;

            this.ant.style.left = `${initialLeft + dx}px`;
            this.ant.style.top = `${initialTop + dy}px`;
        };

        const onDragEnd = (e) => {
            if (e.touches) {
                document.removeEventListener('touchmove', onDragMove);
                document.removeEventListener('touchend', onDragEnd);
            } else {
                document.removeEventListener('mousemove', onDragMove);
                document.removeEventListener('mouseup', onDragEnd);
            }

            this.ant.classList.remove('dragging');
            this.ant.style.cursor = 'grab';
            this.ant.style.zIndex = 100;

            const targetCell = this.path[this.targetCellIndex];
            if (!targetCell) return;

            const targetRect = targetCell.getBoundingClientRect();

            // For touchend, changedTouches has the info
            const evt = e.changedTouches ? e.changedTouches[0] : e;
            const mouseX = evt.clientX;
            const mouseY = evt.clientY;

            const hitMargin = 30; // Increased margin for easier mobile drop
            if (mouseX >= targetRect.left - hitMargin &&
                mouseX <= targetRect.right + hitMargin &&
                mouseY >= targetRect.top - hitMargin &&
                mouseY <= targetRect.bottom + hitMargin) {

                console.log('🎯 Dropped on target!');
                this.successMove(targetCell);

            } else {
                console.log('❌ Missed target');
                this.showError(mouseX, mouseY);

                this.ant.style.transition = 'all 0.3s ease-out';
                this.ant.style.left = `${initialLeft}px`;
                this.ant.style.top = `${initialTop}px`;

                setTimeout(() => {
                    this.ant.style.transition = '';
                }, 300);
            }
        };

        // Remove old listeners to be safe
        if (this.boundDragStart) {
            this.ant.removeEventListener('mousedown', this.boundDragStart);
            this.ant.removeEventListener('touchstart', this.boundDragStart);
        }

        this.boundDragStart = onDragStart;
        this.ant.addEventListener('mousedown', onDragStart);
        this.ant.addEventListener('touchstart', onDragStart, { passive: false });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.PlayerGameInstance = new PlayerGame();
    console.log('✅ PlayerGame initialized (Strict Mode)');
});
