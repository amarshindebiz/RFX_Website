(function () {
  'use strict';
  var hero = document.querySelector('.hero');
  if (!hero) return;
  var inView = true;
  var motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  function update() {
    hero.toggleAttribute('data-logo-paused', !inView || document.hidden || motion.matches);
  }
  document.addEventListener('visibilitychange', update);
  motion.addEventListener('change', update);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) { inView = entries[0].isIntersecting; update(); }).observe(hero);
  }
  update();
})();
