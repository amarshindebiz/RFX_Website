/* ============================================================
   REIMAGINE FX — motion.js (v2)
   GSAP 3 + ScrollTrigger (free) + Lenis smooth scroll via CDN.
   Load order in each redesigned page (end of <body>):
     gsap.min.js → ScrollTrigger.min.js → lenis.min.js → shared.js → motion.js
   Then call initMotion() after nav/footer injection.

   Guardrails:
   - html.has-motion gates all [data-reveal] hiding (no-JS = fully visible)
   - prefers-reduced-motion  → reveals shown instantly, no Lenis/tilt/magnetic
   - mobile / coarse pointer → no Lenis, no tilt, no magnetic
   - transform/opacity only · reveals are once:true (no persistent listeners)
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

    if (hasST) gsap.registerPlugin(ScrollTrigger);

    /* 1 ─ Lenis smooth scroll (desktop, fine pointer only) */
    if (!mobile && typeof window.Lenis !== 'undefined') {
      var lenis = new Lenis({ lerp: 0.1, smoothWheel: true });
      lenis.on('scroll', function () { if (hasST) ScrollTrigger.update(); });
      gsap.ticker.add(function (time) { lenis.raf(time * 1000); });
      gsap.ticker.lagSmoothing(0);
      /* Anchor links play nice with Lenis */
      document.querySelectorAll('a[href^="#"]').forEach(function (a) {
        a.addEventListener('click', function (e) {
          var id = a.getAttribute('href');
          if (id.length > 1 && document.querySelector(id)) {
            e.preventDefault();
            lenis.scrollTo(id, { offset: -80 });
          }
        });
      });
      window._lenis = lenis;
    }

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

    /* 3 ─ Scroll reveals (batched, once) */
    if (hasST) {
      ScrollTrigger.batch('[data-reveal]', {
        start: 'top 88%',
        once: true,
        onEnter: function (batch) {
          gsap.to(batch, {
            opacity: 1, y: 0,
            duration: 0.9, ease: 'power3.out',
            stagger: 0.08,
            onComplete: function () {
              batch.forEach(function (el) { el.classList.add('revealed'); });
            }
          });
        }
      });
      /* Elements already above the fold on load */
      ScrollTrigger.refresh();
    } else {
      document.querySelectorAll('[data-reveal]').forEach(function (el) {
        el.classList.add('revealed');
      });
    }

    /* 4 ─ Stat counters */
    if (hasST) {
      document.querySelectorAll('[data-count]').forEach(function (el) {
        var target = parseFloat(el.dataset.count);
        var suffix = el.dataset.countSuffix || '';
        var obj = { v: 0 };
        ScrollTrigger.create({
          trigger: el, start: 'top 85%', once: true,
          onEnter: function () {
            gsap.to(obj, {
              v: target, duration: 1.6, ease: 'power2.out',
              onUpdate: function () { el.textContent = Math.round(obj.v) + suffix; }
            });
          }
        });
      });
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
  };
})();
