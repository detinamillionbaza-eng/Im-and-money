
/* =========================================
   TUTORIAL MODAL LOGIC
   ========================================= */
document.addEventListener('DOMContentLoaded', () => {
    const tutorialModal = document.getElementById('tutorial-modal');
    const openBtnLink = document.getElementById('open-tutorial-link'); // В окне авторизации
    const openBtnGame = document.getElementById('tutorial-btn'); // В игре
    const closeBtn = document.getElementById('tutorial-close');

    // Слайдер
    const slidesContainer = document.querySelector('.tutorial-slides');
    const slides = document.querySelectorAll('.tutorial-slide');
    const dots = document.querySelectorAll('.tut-dot');
    const prevBtn = document.getElementById('tut-prev');
    const nextBtn = document.getElementById('tut-next');

    let currentSlide = 0;
    const totalSlides = slides.length;

    function updateSlider() {
        slidesContainer.style.transform = `translateX(-${currentSlide * 100}%)`;

        // Обновляем точки
        dots.forEach((dot, index) => {
            if (index === currentSlide) {
                dot.style.opacity = '1';
                dot.style.transform = 'scale(1.2)';
            } else {
                dot.style.opacity = '0.5';
                dot.style.transform = 'scale(1)';
            }
        });
    }

    function rotateSlide(dir) {
        currentSlide += dir;
        if (currentSlide < 0) currentSlide = totalSlides - 1;
        if (currentSlide >= totalSlides) currentSlide = 0;
        updateSlider();
    }

    // Слушатели открытия
    if (openBtnLink) {
        openBtnLink.addEventListener('click', () => {
            tutorialModal.classList.remove('hidden');
            currentSlide = 0;
            updateSlider();
        });
    }

    // Global function to open tutorial from other scripts (e.g. gameclient.js)
    window.openTutorial = function (slideIndex = 0) {
        if (tutorialModal) {
            tutorialModal.classList.remove('hidden');
            currentSlide = slideIndex;
            updateSlider();
        }
    };

    if (openBtnGame) {
        openBtnGame.addEventListener('click', () => {
            window.openTutorial(0);
        });
    }

    // Слушатель закрытия
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            tutorialModal.classList.add('hidden');
        });
    }

    // Навигация
    if (prevBtn) prevBtn.addEventListener('click', () => rotateSlide(-1));
    if (nextBtn) nextBtn.addEventListener('click', () => rotateSlide(1));

    // Точки
    dots.forEach(dot => {
        dot.addEventListener('click', (e) => {
            const slideIndex = parseInt(e.target.dataset.slide);
            currentSlide = slideIndex;
            updateSlider();
        });
    });

    // Инициализация
    updateSlider();

    /* =========================================
       SUPPORT DROPDOWN LOGIC
       ========================================= */
    const supportBtn = document.getElementById('tut-support-btn');
    const supportDropdown = document.getElementById('tut-support-dropdown');

    if (supportBtn && supportDropdown) {
        // Toggle menu
        supportBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Предотвращаем всплытие, чтобы клик по кнопке сразу не закрыл меню
            supportDropdown.classList.toggle('hidden');
        });

        // Закрытие при клике вне меню
        document.addEventListener('click', (e) => {
            if (!supportDropdown.classList.contains('hidden')) {
                if (!supportDropdown.contains(e.target) && e.target !== supportBtn) {
                    supportDropdown.classList.add('hidden');
                }
            }
        });

        // Предотвращаем закрытие при клике внутри самого меню
        supportDropdown.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    }

});
