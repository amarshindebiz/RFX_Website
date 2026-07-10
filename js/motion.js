/* ============================================================
   REIMAGINE FX — motion.js (v2)
   GSAP 3 + ScrollTrigger (free) via CDN. Native scrolling (no Lenis).
   Load order in each redesigned page (end of <body>):
     gsap.min.js → ScrollTrigger.min.js → shared.js → motion.js
   Then call initMotion() after nav/footer injection.

   NOTE: Lenis smooth-scroll was removed — it silently swallowed mouse-wheel
   input in production, freezing the page (and, because reveals depend on
   scrolling elements into view, blacking out everything below the hero).
   Native scroll is reliable; anchor smoothness comes from CSS
   `scroll-behavior: smooth`. A safety net force-reveals content if anything
   ever prevents the IntersectionObserver from firing.

   Guardrails:
   - html.has-motion gates all [data-reveal] hiding (no-JS = fully visible)
   - prefers-reduced-motion  → reveals shown instantly, no tilt/magnetic
   - mobile / coarse pointer → no tilt, no magnetic
   - transform/opacity only · reveals fire once · fail-safe reveal timeout
   ============================================================ */

(function () {
  'use strict';

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var mobile = window.matchMedia('(max-width: 768px), (pointer: coarse)').matches;
  var hasGSAP = typeof window.gsap !== 'undefined';
  var hasST = hasGSAP && typeof window.ScrollTrigger !== 'undefined';

  /* Flag as early as possible so CSS starts hiding [data-reveal] only when
     we are actually going to animate them. */
  if (hasGSAP && !reduced) {
    document.documentElement.classList.add('has-motion');
  }

  /* --- tiny vanilla letter-splitter (no Club SplitText needed) --- */
  function splitLetters(el) {
    var text = el.textContent;
    el.setAttribute('aria-label', text);
    el.textContent = '';
    var frag = document.createDocumentFragment();
    for (var i = 0; i < text.length; i++) {
      var span = document.createElement('span');
      span.className = 'split-char';
      span.setAttribute('aria-hidden', 'true');
      span.textContent = text[i] === ' ' ? ' ' : text[i];
      frag.appendChild(span);
    }
    el.appendChild(frag);
    return el.querySelectorAll('.split-char');
  }

  window.initMotion = function initMotion() {
    if (!hasGSAP || reduced) {
      /* Reveal everything statically and bail. */
      document.querySelectorAll('[data-reveal]').forEach(function (el) {
        el.classList.add('revealed');
      });
      return;
    }

    if (hasST) {
      gsap.registerPlugin(ScrollTrigger);
      /* Failsafe: native scrolls (keyboard paging, anchor jumps, programmatic
         scrollTo) bypass Lenis events — keep ScrollTrigger in sync anyway. */
      window.addEventListener('scroll', function () { ScrollTrigger.update(); }, { passive: true });
    }

    /* 1 ─ (Lenis smooth scroll removed — native scroll is used instead) */

    /* 2 ─ Hero split-letter entrance */
    document.querySelectorAll('[data-split]').forEach(function (el) {
      var chars = splitLetters(el);
      gsap.fromTo(chars,
        { yPercent: 110, rotateX: -40, opacity: 0 },
        {
          yPercent: 0, rotateX: 0, opacity: 1,
          duration: 1.1, ease: 'power4.out',
          stagger: 0.04, delay: parseFloat(el.dataset.splitDelay || 0.15)
        });
    });

    /* 3 ─ Scroll reveals (IntersectionObserver — immune to how the user
       scrolls: wheel, keyboard, anchor jumps, programmatic scrollTo) */
    var revealEls = document.querySelectorAll('[data-reveal]');
    if ('IntersectionObserver' in window && revealEls.length) {
      var revealIO = new IntersectionObserver(function (entries) {
        var batch = [];
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          revealIO.unobserve(entry.target);
          batch.push(entry.target);
        });
        if (!batch.length) return;
        gsap.to(batch, {
          opacity: 1, y: 0,
          duration: 0.9, ease: 'power3.out',
          stagger: 0.08, overwrite: true,
          onComplete: function () {
            batch.forEach(function (el) { el.classList.add('revealed'); });
          }
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
      revealEls.forEach(function (el) { revealIO.observe(el); });
    } else {
      revealEls.forEach(function (el) { el.classList.add('revealed'); });
    }

    /* 4 ─ Stat counters (IntersectionObserver, once) */
    var countEls = document.querySelectorAll('[data-count]');
    if ('IntersectionObserver' in window && countEls.length) {
      var countIO = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          countIO.unobserve(entry.target);
          var el = entry.target;
          var target = parseFloat(el.dataset.count);
          var suffix = el.dataset.countSuffix || '';
          var obj = { v: 0 };
          gsap.to(obj, {
            v: target, duration: 1.6, ease: 'power2.out',
            onUpdate: function () { el.textContent = Math.round(obj.v) + suffix; }
          });
        });
      }, { rootMargin: '0px 0px -10% 0px' });
      countEls.forEach(function (el) { countIO.observe(el); });
    }

    /* 5 ─ 3D tilt cards (desktop only) */
    if (!mobile) {
      document.querySelectorAll('[data-tilt]').forEach(function (card) {
        var bounds = null;
        card.style.transformStyle = 'preserve-3d';
        card.addEventListener('pointerenter', function () {
          bounds = card.getBoundingClientRect();
        });
        card.addEventListener('pointermove', function (e) {
          if (!bounds) bounds = card.getBoundingClientRect();
          var px = (e.clientX - bounds.left) / bounds.width - 0.5;
          var py = (e.clientY - bounds.top) / bounds.height - 0.5;
          gsap.to(card, {
            rotateY: px * 6, rotateX: -py * 6, scale: 1.015,
            duration: 0.4, ease: 'power2.out', transformPerspective: 900
          });
        });
        card.addEventListener('pointerleave', function () {
          bounds = null;
          gsap.to(card, { rotateY: 0, rotateX: 0, scale: 1, duration: 0.55, ease: 'power3.out' });
        });
      });

      /* 6 ─ Magnetic buttons (hero/CTA only) */
      document.querySelectorAll('[data-magnetic]').forEach(function (btn) {
        var b = null;
        btn.addEventListener('pointerenter', function () { b = btn.getBoundingClientRect(); });
        btn.addEventListener('pointermove', function (e) {
          if (!b) b = btn.getBoundingClientRect();
          var dx = (e.clientX - (b.left + b.width / 2)) / (b.width / 2);
          var dy = (e.clientY - (b.top + b.height / 2)) / (b.height / 2);
          gsap.to(btn, { x: dx * 8, y: dy * 8, duration: 0.3, ease: 'power2.out' });
        });
        btn.addEventListener('pointerleave', function () {
          b = null;
          gsap.to(btn, { x: 0, y: 0, duration: 0.5, ease: 'elastic.out(1, 0.5)' });
        });
      });
    }

    /* 7 ─ Parallax layers: [data-parallax="0.2"] moves at that fraction */
    if (hasST && !mobile) {
      document.querySelectorAll('[data-parallax]').forEach(function (el) {
        var speed = parseFloat(el.dataset.parallax) || 0.2;
        gsap.to(el, {
          yPercent: speed * 100,
          ease: 'none',
          scrollTrigger: {
            trigger: el.closest('section') || el,
            start: 'top bottom', end: 'bottom top', scrub: true
          }
        });
      });
    }

    /* 8 ─ Fail-safe: content must NEVER stay invisible. If, for any reason,
       the IntersectionObserver never fires for some elements (scroll frozen,
       observer edge case, browser quirk), force everything visible after a
       few seconds so the page can't black out. */
    setTimeout(function () {
      document.querySelectorAll('[data-reveal]:not(.revealed)').forEach(function (el) {
        gsap.set(el, { opacity: 1, y: 0 });
        el.classList.add('revealed');
      });
      /* A counter must never be left showing "0" if its tween never ran. */
      document.querySelectorAll('[data-count]').forEach(function (el) {
        if (el.textContent.trim() === '0' || el.textContent.trim() === '') {
          el.textContent = Math.round(parseFloat(el.dataset.count)) + (el.dataset.countSuffix || '');
        }
      });
    }, 3000);
  };
})();
