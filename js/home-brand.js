(function () {
  'use strict';
  var hero = document.querySelector('.hero');
  var toggle = document.querySelector('.hero-motion-toggle');
  if (!hero || !toggle) return;
  var paused = false;
  var inView = true;
  var motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  function update() {
    hero.toggleAttribute('data-logo-paused', paused || !inView || document.hidden || motion.matches);
    toggle.hidden = motion.matches;
    toggle.setAttribute('aria-pressed', String(paused));
    toggle.querySelector('span').textContent = paused ? 'Resume logo motion' : 'Pause logo motion';
  }
  toggle.addEventListener('click', function () { paused = !paused; update(); });
  document.addEventListener('visibilitychange', update);
  motion.addEventListener('change', update);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) { inView = entries[0].isIntersecting; update(); }).observe(hero);
  }
  update();
})();
