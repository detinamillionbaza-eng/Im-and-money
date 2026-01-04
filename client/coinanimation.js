class CoinGame {
    constructor() {
        this.coin = document.querySelector('.coin');
        this.coinBtn = document.querySelector('.coin-btn');
        this.resultLabel = document.querySelector('.coin-result-label');

        this.isFlipping = false;

        if (this.coinBtn) {
            this.coinBtn.addEventListener('click', () => {
                if (window.requestCoinFlip) {
                    window.requestCoinFlip();
                } else {
                    console.error('requestCoinFlip not found');
                }
            });
        }
    }

    flipCoin(result, customText = null) {
        if (this.isFlipping) return;
        this.isFlipping = true;

        // Hide result label
        if (this.resultLabel) this.resultLabel.classList.remove('show');

        // Disable button
        if (this.coinBtn) this.coinBtn.style.pointerEvents = 'none';

        // 0 = Heads, 1 = Tails
        // Logic:
        // Heads: 0deg + spins (e.g. 1800deg)
        // Tails: 180deg + spins
        const spins = 10; // 5 full rotations
        const baseRotate = spins * 360;

        let targetRotate = baseRotate;
        if (result === 'tails') {
            targetRotate += 180;
        }

        // Random jitter for realism
        const jitter = Math.random() * 10 - 5;

        this.coin.style.transition = 'transform 3s cubic-bezier(0.15, 0.9, 0.3, 1)';
        this.coin.style.transform = `rotateY(${targetRotate}deg) rotateZ(${jitter}deg)`;

        // Reset
        setTimeout(() => {
            this.isFlipping = false;

            // Show result text
            if (this.resultLabel) {
                // Если передан текст (например, "НАПРАВО"), используем его. Иначе дефолт.
                const defaultText = result === 'heads' ? 'ОРЕЛ' : 'РЕШКА';
                this.resultLabel.textContent = customText || defaultText;
                this.resultLabel.classList.add('show');
            }

            if (this.coinBtn) this.coinBtn.style.pointerEvents = 'auto';

            // Reset rotation (visually seamless if possible, but hard with 3D)
            // Or just leave it there.
        }, 3000);
    }

    showCoinButton() {
        if (this.coinBtn) {
            this.coinBtn.disabled = false;
            this.coinBtn.style.opacity = 1;
            this.coinBtn.style.cursor = 'pointer';
            this.coinBtn.style.pointerEvents = 'auto';
            this.coinBtn.style.display = 'block'; // Ensure visible
        }
    }

    hideCoinButton() {
        if (this.coinBtn) {
            this.coinBtn.disabled = true;
            this.coinBtn.style.opacity = 0.5;
            this.coinBtn.style.cursor = 'not-allowed';
            this.coinBtn.style.pointerEvents = 'none';
        }
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    window.CoinGameInstance = new CoinGame();
});
