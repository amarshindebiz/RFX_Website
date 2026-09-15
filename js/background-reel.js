/* Show background footage only after the embedded player's startup UI has cleared. */
(function () {
  'use strict';
  var layer = document.querySelector('.hero-video');
  var motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (!layer || motion.matches) return;
  var player;
  var revealTimer;
  var visible = true;
  function hide() {
    clearTimeout(revealTimer);
    layer.classList.remove('is-playing');
  }
  function allowed() { return visible && !document.hidden && !motion.matches; }
  function stateChanged(event) {
    hide();
    if (event.data !== 1 || !allowed()) return;
    // controls=0 does not suppress YouTube's transient middle controls at startup.
    // Start the delay from PLAYING, never iframe load: buffering can take any length.
    revealTimer = setTimeout(function () {
      if (allowed() && player.getPlayerState() === 1) layer.classList.add('is-playing');
    }, 4000);
  }
  function sync() {
    if (!player || typeof player.getPlayerState !== 'function') return;
    if (!allowed()) { hide(); player.pauseVideo(); }
    else if (player.getPlayerState() !== 1) player.playVideo();
  }
  function createPlayer() {
    if (player || !window.YT || !window.YT.Player) return;
    player = new YT.Player('hero-reel', {
      host: 'https://www.youtube-nocookie.com',
      videoId: 'EjAiirU7lEo',
      playerVars: {
        autoplay: 1, mute: 1, controls: 0, loop: 1, playlist: 'EjAiirU7lEo',
        playsinline: 1, disablekb: 1, fs: 0, rel: 0, origin: location.origin
      },
      events: {
        onReady: function (event) {
          var frame = event.target.getIframe();
          frame.setAttribute('tabindex', '-1');
          frame.setAttribute('title', 'Reimagine FX showreel');
          event.target.mute();
          if (allowed()) event.target.playVideo();
          else event.target.pauseVideo();
        },
        onStateChange: stateChanged,
        onError: hide,
        onAutoplayBlocked: hide
      }
    });
  }
  document.addEventListener('visibilitychange', sync);
  motion.addEventListener('change', sync);
  window.addEventListener('pagehide', hide);
  window.addEventListener('pageshow', sync);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting; sync();
    }).observe(layer.closest('.hero'));
  }
  if (window.YT && window.YT.Player) createPlayer();
  else {
    var previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function () {
      if (typeof previousReady === 'function') previousReady();
      createPlayer();
    };
    var script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = hide;
    document.head.appendChild(script);
  }
})();
