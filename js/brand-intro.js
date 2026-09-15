/* Once per tab session. No body/html scroll locking, dependencies or network waits. */
(function () {
  'use strict';
  var key = 'rfx-welcome-v1';
  var root = document.documentElement;
  var motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var navigation = performance.getEntriesByType('navigation')[0];
  // Keep deep links, history restoration and accessibility preferences immediate.
  if (motion.matches || location.hash || (navigation && navigation.type === 'back_forward') ||
      !window.HTMLDialogElement || !HTMLDialogElement.prototype.showModal) return;
  try {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
  } catch (_) {
    // Storage-disabled browsers still get the site, without a repeating intro.
    return;
  }

  var dialog;
  var finished = false;
  var closeTimer;
  var revealTimer;
  var safetyTimer;
  function cleanup() {
    finished = true;
    clearTimeout(closeTimer);
    clearTimeout(revealTimer);
    clearTimeout(safetyTimer);
    root.classList.remove('rfx-intro-active', 'rfx-intro-mounted');
    window.removeEventListener('wheel', skip);
    window.removeEventListener('touchmove', skip);
    window.removeEventListener('pagehide', cleanup);
    document.removeEventListener('visibilitychange', visibility);
    motion.removeEventListener('change', preference);
    if (dialog) {
      if (dialog.open) dialog.close();
      dialog.remove();
    }
    document.dispatchEvent(new Event('rfx:intro-finished'));
  }
  function dismiss(immediate) {
    if (finished) {
      if (immediate && dialog && dialog.open) cleanup();
      return;
    }
    finished = true;
    if (immediate || !dialog) { cleanup(); return; }
    dialog.classList.add('is-leaving');
    closeTimer = setTimeout(cleanup, 550);
  }
  function skip() { dismiss(true); }
  function visibility() { if (document.hidden) cleanup(); }
  function preference() { if (motion.matches) cleanup(); }

  root.classList.add('rfx-intro-active');
  // Independent deadline: a failed script or slow third-party embed must not trap visitors.
  safetyTimer = setTimeout(cleanup, 3500);
  window.addEventListener('pagehide', cleanup);
  document.addEventListener('visibilitychange', visibility);
  motion.addEventListener('change', preference);

  function mount() {
    if (finished) return;
    try {
      dialog = document.createElement('dialog');
      dialog.className = 'rfx-intro';
      dialog.setAttribute('aria-label', 'Welcome to Reimagine FX');
      dialog.innerHTML = '<svg class="rfx-intro-mark" viewBox="72 72 368 368" aria-hidden="true">' +
        '<g fill="none" stroke="#C7A253" stroke-width="12" stroke-linejoin="miter" stroke-linecap="butt">' +
        '<path class="rfx-intro-line" pathLength="1" d="M236 236 L96 96 L416 96 L276 236"/>' +
        '<path class="rfx-intro-line rfx-intro-line--lower" pathLength="1" d="M276 276 L416 416 L96 416 L236 276"/></g>' +
        '<polygon class="rfx-intro-center" fill="#C7A253" points="256,236 276,256 256,276 236,256"/></svg>';
      document.body.appendChild(dialog);
      // Fail open if the companion stylesheet is blocked or absent.
      if (getComputedStyle(dialog).position !== 'fixed') { cleanup(); return; }
      dialog.addEventListener('cancel', function (event) { event.preventDefault(); skip(); });
      dialog.showModal();
      root.classList.add('rfx-intro-mounted');
      window.addEventListener('wheel', skip, { passive: true });
      window.addEventListener('touchmove', skip, { passive: true });
      revealTimer = setTimeout(function () { dismiss(false); }, 1850);
    } catch (_) { cleanup(); }
  }
  // Loaded immediately after <body>: first paint contains the mark, not an empty gate.
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
