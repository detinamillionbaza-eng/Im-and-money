class DiceGame {
    constructor() {
        this.dice = document.querySelector('.dice');
        this.rollBtn = document.querySelector('.roll-btn');
        this.modal = document.getElementById('diceResultModal');
        this.modalText = document.getElementById('diceResultText');
        this.modalBtn = document.getElementById('diceResultOk');

        this.isRolling = false;

        if (this.rollBtn) {
            this.rollBtn.addEventListener('click', () => {
                if (window.requestDiceRoll) {
                    window.requestDiceRoll();
                } else {
                    console.error('requestDiceRoll not found');
                }
            });
        }

        if (this.modalBtn) {
            this.modalBtn.addEventListener('click', () => this.closeModal());
            // Touch support for mobile
            this.modalBtn.addEventListener('touchstart', (e) => {
                e.preventDefault();
                this.closeModal();
            }, { passive: false });
        }
    }

    showDiceAnimation(result, isMyTurn = false, prediction = null, isPartial = false) {
        if (this.isRolling) {
            console.warn('⚠️ Dice already rolling, ignoring request');
            return;
        }

        if (!this.dice) {
            console.error('❌ Dice element not found');
            // Fallback: show result immediately if dice is missing
            this.showResult(result, isPartial);
            return;
        }

        this.isRolling = true;
        this.isMyTurn = isMyTurn; // Store for showResult
        this.currentPrediction = prediction; // Store prediction
        this.isPartial = isPartial; // Store partial state

        // Hide button during roll if desired, or just disable
        if (this.rollBtn) this.rollBtn.style.pointerEvents = 'none';

        // Result passed from server
        // Calculate rotation to show the correct face (if partial or single, result is 1-6)
        // If it's NOT partial and we are in double dice mode, result might be up to 12.
        // For the visual dice, we just use (result % 6) or something if > 6, but better to keep it 1-6 for first roll.

        let displayResult = result;
        if (!isPartial && result > 6) {
            // It's the SUM. For animation, we show the second die value? 
            // Actually, server sends SUM on second roll. Let's just show some face.
            displayResult = (result % 6) || 6;
        }

        let rotateX = 0;
        let rotateY = 0;
        const spins = 2;
        const baseRotate = spins * 360;

        switch (displayResult) {
            case 1: rotateX = 0; rotateY = 0; break;
            case 6: rotateX = 180; rotateY = 0; break;
            case 2: rotateX = 0; rotateY = -90; break;
            case 5: rotateX = 0; rotateY = 90; break;
            case 3: rotateX = -90; rotateY = 0; break;
            case 4: rotateX = 90; rotateY = 0; break;
            default: rotateX = 0; rotateY = 0;
        }

        this.dice.style.transition = 'transform 2s cubic-bezier(0.1, 0.9, 0.2, 1)';
        this.dice.style.transform = `rotateX(${baseRotate + rotateX}deg) rotateY(${baseRotate + rotateY}deg)`;

        // Wait for animation to finish
        setTimeout(() => {
            this.isRolling = false;
            this.showResult(result, isPartial);
        }, 2000);
    }

    showResult(result, isPartial) {
        if (isPartial) {
            this.modalText.textContent = `Выпало ${result}. ${this.isMyTurn ? 'У вас есть еще один бросок! Нажмите на кубик снова.' : 'Игрок делает второй бросок...'}`;
        } else {
            this.modalText.textContent = `Выпало ${result}. ${this.isMyTurn ? 'Сделайте ход и нажмите на колоду!' : 'Игрок делает ход...'}`;
        }

        // Hide button if not my turn OR if it's partial (we want them to click the main roll button again, not the modal OK)
        if (this.modalBtn) {
            if (this.isMyTurn && !isPartial) {
                this.modalBtn.style.display = 'block';
            } else {
                this.modalBtn.style.display = 'none';
            }
        }

        this.modal.classList.add('show');

        // Store result for player movement
        this.currentResult = result;

        // If it's partial, we don't enable movement yet
        if (this.isMyTurn && !isPartial && window.gameClient) {
            window.gameClient.mustMoveFirst = true;
            console.log('🔒 Decks locked: must move figure first');
        }

        // Auto-close modal for partial roll after 1.5s so they can click again
        if (isPartial) {
            setTimeout(() => {
                this.closeModal();
            }, 1500);
        }
    }

    closeModal() {
        this.modal.classList.remove('show');

        // If my turn, I control the close for everyone
        if (this.isMyTurn) {
            if (window.sendCloseWindowSignal) {
                window.sendCloseWindowSignal();
            }
        }

        // Trigger player movement logic ONLY for full roll
        if (this.isMyTurn && window.PlayerGameInstance && !this.isPartial) {
            window.PlayerGameInstance.enableMove(this.currentResult, this.currentPrediction);
        }
    }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.DiceGameInstance = new DiceGame();
});
