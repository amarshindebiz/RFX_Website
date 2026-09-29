/* ============================================================
   REIMAGINE FX · about.js (About page v3)
   - EN/DE toggle (strings in about-de.js), remembered per visitor
   - stat counters, viewfinder timecode
   - editing-timeline career story: CSS sticky + native scroll.
     Nothing hijacks the wheel; the playhead only reads scroll position.
   - AI Lab card glow, classified file effects, software filter
   Load after shared.js/motion.js and about-de.js.
   ============================================================ */
(function () {
  'use strict';

  var doc = document;
  var root = doc.documentElement;
  var DE = window.RFX_ABOUT_DE || {};
  var reducedMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  var NAV_H = 68;
  var lang = 'en';
  var langEpoch = 0;
  var listeners = [];

  var UI = {
    en: {
      tools: '{n} tools', skillsPlus: '+{n} skills', origins: 'Origins', now: 'Now', ch: 'CH',
      denied: 'Access denied. Check back after launch.',
      clipAria: '{when}: {title}. Jump to this chapter.'
    },
    de: {
      tools: '{n} Programme', skillsPlus: '+{n} Skills', origins: 'Ursprünge', now: 'Heute', ch: 'KAP',
      denied: 'Zugriff verweigert. Nach dem Launch wieder vorbeischauen.',
      clipAria: '{when}: {title}. Zu diesem Kapitel springen.'
    }
  };
  function ui(key, n) {
    var s = (UI[lang] && UI[lang][key]) || UI.en[key] || '';
    return n == null ? s : s.replace('{n}', n);
  }
  function store(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }
  function recall(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function each(list, fn) { Array.prototype.forEach.call(list, fn); }
  function text(el) { return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; }
  function onLang(fn) { listeners.push(fn); }
  function motionOK() { return !reducedMQ.matches && root.classList.contains('has-motion'); }

  /* ---------------------------------------------------------------
     1. Language
     --------------------------------------------------------------- */
  var i18nNodes = [].slice.call(doc.querySelectorAll('[data-i18n]'));
  var attrNodes = [].slice.call(doc.querySelectorAll('[data-i18n-attr]'));
  var metaDesc = doc.querySelector('meta[name="description"]');
  var EN = {};

  function attrPairs(el) {
    return el.getAttribute('data-i18n-attr').split(';').map(function (s) {
      var i = s.indexOf(':');
      return { attr: s.slice(0, i).trim(), key: s.slice(i + 1).trim() };
    });
  }
  i18nNodes.forEach(function (el) {
    var k = el.getAttribute('data-i18n');
    if (!(k in EN)) EN[k] = el.innerHTML;
  });
  attrNodes.forEach(function (el) {
    attrPairs(el).forEach(function (p) { if (!(p.key in EN)) EN[p.key] = el.getAttribute(p.attr) || ''; });
  });
  EN['meta.title'] = doc.title;
  EN['meta.desc'] = metaDesc ? metaDesc.getAttribute('content') : '';

  function tr(k) { return (lang === 'de' && DE[k] != null) ? DE[k] : EN[k]; }

  var langBtns = [].slice.call(doc.querySelectorAll('.ab-lang-btn'));
  function setLang(next, persist) {
    lang = next === 'de' ? 'de' : 'en';
    i18nNodes.forEach(function (el) {
      var v = tr(el.getAttribute('data-i18n'));
      if (v != null && el.innerHTML !== v) el.innerHTML = v;
    });
    attrNodes.forEach(function (el) {
      attrPairs(el).forEach(function (p) { var v = tr(p.key); if (v != null) el.setAttribute(p.attr, v); });
    });
    doc.title = tr('meta.title');
    if (metaDesc) metaDesc.setAttribute('content', tr('meta.desc'));
    root.setAttribute('lang', lang);
    langBtns.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-lang') === lang)); });
    if (persist) store('rfx-lang', lang);
    langEpoch++;
    listeners.forEach(function (fn) { try { fn(lang); } catch (e) { /* keep other modules alive */ } });
  }
  langBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      var l = b.getAttribute('data-lang');
      if (l !== lang) setLang(l, true);
    });
  });

  /* ---------------------------------------------------------------
     2. Stat counters (own counter: decimals + DE number format)
     --------------------------------------------------------------- */
  (function initStats() {
    var els = [].slice.call(doc.querySelectorAll('[data-stat]'));
    if (!els.length) return;
    function fmt(el, v) {
      var dec = +(el.getAttribute('data-dec') || 0);
      var s;
      if (el.hasAttribute('data-group')) s = Math.round(v).toLocaleString(lang === 'de' ? 'de-DE' : 'en-US');
      else s = dec ? v.toFixed(dec) : String(Math.round(v));
      if (dec && lang === 'de') s = s.replace('.', ',');
      var suf = (lang === 'de' && el.hasAttribute('data-suf-de')) ? el.getAttribute('data-suf-de') : (el.getAttribute('data-suf') || '');
      return s + suf;
    }
    function finish(el) { el._done = true; el.textContent = fmt(el, +el.getAttribute('data-stat')); }
    onLang(function () { els.forEach(function (el) { if (el._done) finish(el); }); });

    if (!('IntersectionObserver' in window) || !motionOK()) { els.forEach(finish); return; }
    els.forEach(function (el) { el.textContent = fmt(el, 0); });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        io.unobserve(en.target);
        var el = en.target, target = +el.getAttribute('data-stat'), t0 = performance.now(), dur = 1500;
        (function step(now) {
          if (el._done) return;
          var p = clamp((now - t0) / dur, 0, 1);
          el.textContent = fmt(el, target * (1 - Math.pow(1 - p, 3)));
          if (p < 1) requestAnimationFrame(step); else finish(el);
        })(t0);
      });
    }, { rootMargin: '0px 0px -8% 0px' });
    els.forEach(function (el) { io.observe(el); });
    /* Fail-safe: a number must never be left at 0. */
    setTimeout(function () { els.forEach(function (el) { if (!el._done) finish(el); }); }, 4000);
  })();

  /* ---------------------------------------------------------------
     3. Viewfinder timecode (25 fps), paused off-screen / hidden tab
     --------------------------------------------------------------- */
  (function initViewfinder() {
    var tc = doc.getElementById('vf-tc');
    if (!tc || reducedMQ.matches) return;
    var frames = 0, timer = null, visible = true;
    function render() {
      var s = Math.floor(frames / 25);
      tc.textContent = '01:' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60) + ':' + pad(frames % 25);
    }
    function sync() {
      var run = visible && !doc.hidden;
      if (run && !timer) timer = setInterval(function () { frames++; render(); }, 40);
      else if (!run && timer) { clearInterval(timer); timer = null; }
    }
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (e) { visible = e[0].isIntersecting; sync(); }).observe(tc.parentNode);
    }
    doc.addEventListener('visibilitychange', sync);
    sync();
  })();

  /* ---------------------------------------------------------------
     4. Editing timeline
     --------------------------------------------------------------- */
  var ICON_EYE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>';
  var ICON_SPK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6h3l4-3v10l-4-3H2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  function D(d) { return '<path class="d" pathLength="1" d="' + d + '"/>'; }
  function C(cx, cy, r) { return '<circle class="d" pathLength="1" cx="' + cx + '" cy="' + cy + '" r="' + r + '"/>'; }
  function R(x, y, w, h, rx) { return '<rect class="d" pathLength="1" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + (rx || 0) + '"/>'; }
  function SVG(vb, body) { return '<svg viewBox="' + vb + '" aria-hidden="true" focusable="false">' + body + '</svg>'; }
  var ICONS = {
    origins: SVG('0 0 300 100',
      D('M16 44c0-9 7-15 16-14l8 2h16l8-2c9-1 16 5 16 14l4 20c2 9-8 15-15 8l-7-7H34l-7 7c-7 7-17 1-15-8z') +
      D('M31 45v12M25 51h12') + C(63, 47, 3.2) + C(71, 54, 3.2) +
      D('M88 58h10M94 54l4 4-4 4') +
      D('M112 38h14l6-9h24l6 9h14a6 6 0 0 1 6 6v32a6 6 0 0 1-6 6h-64a6 6 0 0 1-6-6V44a6 6 0 0 1 6-6z') +
      C(144, 60, 15) + C(144, 60, 7) +
      D('M192 58h10M198 54l4 4-4 4') +
      D('M216 56h72v32a4 4 0 0 1-4 4h-64a4 4 0 0 1-4-4z') + D('M216 54L284 38L282 29L214 45Z') +
      D('M228 42L235 50M245 38L252 46M262 34L269 42') + D('M226 72h52M226 80h36')),
    design: SVG('0 0 120 120',
      D('M16 92C36 30 84 30 104 92') + D('M16 92L38 34M104 92L82 34') +
      R(11, 87, 10, 10) + R(99, 87, 10, 10) + C(38, 34, 4) + C(82, 34, 4) +
      D('M60 14l8 20-8 12-8-12z') + D('M60 24v12')),
    vfx: SVG('0 0 120 120',
      R(12, 20, 62, 44, 3) + R(46, 52, 62, 44, 3) +
      D('M56 88C62 66 84 62 98 72') + C(56, 88, 2.6) + C(98, 72, 2.6) +
      C(30, 40, 8) + D('M30 28v6M30 46v6M18 40h6M36 40h6')),
    cube: SVG('0 0 120 120',
      D('M60 14L98 36V80L60 102L22 80V36Z') + D('M22 36L60 58L98 36M60 58V102') +
      C(60, 58, 3) + D('M104 18l6-6M108 30h8M92 10V2')),
    aikya: SVG('72 72 368 368',
      D('M236 236 L96 96 L416 96 L276 236') + D('M276 276 L416 416 L96 416 L236 276') +
      '<polygon class="f" points="256,236 276,256 256,276 236,256"/>'),
    flame: SVG('0 0 120 120',
      D('M60 106C36 104 28 80 42 60C44 72 52 76 56 70C50 52 60 32 76 20C74 40 92 50 92 74C92 94 80 106 60 106Z') +
      D('M60 98C50 96 48 84 54 76C56 84 62 84 64 80C70 86 70 96 60 98Z') +
      D('M30 38l-6-6M98 30l6-8M102 58l8-2M22 64l-8 2M86 12l2-6')),
    motion: SVG('0 0 120 120',
      D('M10 88C36 88 42 30 66 30S96 70 112 40') +
      D('M10 81L17 88L10 95L3 88Z') + D('M66 23L73 30L66 37L59 30Z') + D('M112 33L119 40L112 47L105 40Z') +
      C(40, 58, 2) + C(88, 50, 2)),
    teach: SVG('0 0 120 120',
      R(14, 18, 92, 60, 12) + D('M52 34L76 48L52 62Z') +
      D('M14 98H24L28 90L33 106L38 92L43 102L48 96L53 98H62L66 88L71 108L76 94L81 100L86 98H106')),
    agents: SVG('0 0 120 120',
      C(60, 60, 11) + C(22, 28, 7) + C(98, 28, 7) + C(22, 92, 7) + C(98, 92, 7) + C(60, 12, 5) +
      D('M28 33L51 53M92 33L69 53M28 87L51 67M92 87L69 67M60 17V49') +
      '<circle class="f" cx="60" cy="60" r="4"/>'),
    chip: SVG('0 0 120 120',
      R(30, 30, 60, 60, 5) +
      D('M44 30V18M60 30V18M76 30V18M44 90V102M60 90V102M76 90V102M30 44H18M30 60H18M30 76H18M90 44H102M90 60H102M90 76H102') +
      D('M52 58V52A8 8 0 0 1 68 52V58') + R(48, 58, 24, 18, 2) +
      '<circle class="f" cx="60" cy="67" r="2.2"/>')
  };

  (function initTimeline() {
    var sec = doc.getElementById('timeline');
    if (!sec) return;
    var scroller = doc.getElementById('tl-scroller');
    var stage = doc.getElementById('tl-stage');
    var tracksEl = doc.getElementById('tl-tracks');
    var rulerEl = doc.getElementById('tl-ruler');
    var playhead = doc.getElementById('tl-playhead');
    var phTag = doc.getElementById('tl-ph-tag');
    var inspCard = doc.getElementById('tl-insp-card');
    var monIco = doc.getElementById('mon-ico');
    var monYear = doc.getElementById('mon-year');
    var monTL = doc.getElementById('mon-tl');
    var monTR = doc.getElementById('mon-tr');
    var monBR = doc.getElementById('mon-br');
    var monTC = doc.getElementById('mon-tc');
    var countN = doc.getElementById('tl-count-n');
    var countT = doc.getElementById('tl-count-t');
    var barFill = doc.getElementById('tl-bar-fill');
    var viewWrap = sec.querySelector('.tl-view');
    var viewBtns = [].slice.call(sec.querySelectorAll('.tl-view-btn'));
    var chapters = [].slice.call(sec.querySelectorAll('.tl-ch'));
    var N = chapters.length;
    if (!N || !scroller || !stage) return;

    /* Axis: an undated "Origins" zone (0-12%), then 8% per year from 2016. */
    var ORIGIN_END = 12, PER_YEAR = 8, NOW_T = 2026.75;
    function xOf(t) { return clamp(ORIGIN_END + (t - 2016) * PER_YEAR, 0, 100); }
    function num(v) { return v === 'now' ? NOW_T : parseFloat(v); }

    var data = chapters.map(function (li, i) {
      var s = li.getAttribute('data-start');
      var at = li.getAttribute('data-at');
      var x1 = s === 'origins' ? 0.5 : xOf(num(s));
      var x2 = s === 'origins' ? ORIGIN_END - 0.6 : xOf(num(li.getAttribute('data-end')));
      return {
        li: li, i: i,
        track: li.getAttribute('data-track'),
        start: s,
        x1: x1, x2: x2,
        x: at === 'origins' ? ORIGIN_END / 2 : xOf(parseFloat(at)),
        icon: li.getAttribute('data-icon'),
        skills: li.querySelectorAll('.chip:not(.chip-x)').length
      };
    });
    var totalSkills = 0;
    var cumSkills = data.map(function (d) { totalSkills += d.skills; return totalSkills; });

    /* Ruler */
    var rh = '<span class="tl-tick tl-tick--origins" style="left:' + (ORIGIN_END / 2) + '%" data-ui="origins"></span>';
    for (var y = 2016; y <= 2026; y++) rh += '<span class="tl-tick" style="left:' + xOf(y) + '%">' + y + '</span>';
    rh += '<span class="tl-tick tl-tick--now" style="left:' + xOf(NOW_T) + '%" data-ui="now"></span>';
    rulerEl.innerHTML = rh;

    /* Tracks: V3 / V2 / V1 on top, A1 below, like any NLE */
    var laneLines = '<i class="tl-lane-origin" style="left:' + ORIGIN_END + '%"></i>';
    for (y = 2017; y <= 2026; y++) laneLines += '<i style="left:' + xOf(y) + '%"></i>';
    var TRACKS = [['v3', 'V3', ICON_EYE], ['v2', 'V2', ICON_EYE], ['v1', 'V1', ICON_EYE], ['a1', 'A1', ICON_SPK]];
    tracksEl.innerHTML = '';
    TRACKS.forEach(function (tk) {
      var row = doc.createElement('div');
      row.className = 'tl-row';
      row.setAttribute('data-track', tk[0]);
      row.innerHTML = '<div class="tl-hdr" aria-hidden="true">' + tk[2] + '<span>' + tk[1] + '</span></div><div class="tl-lane">' + laneLines + '</div>';
      var lane = row.lastChild;
      data.forEach(function (d) {
        if (d.track !== tk[0]) return;
        var b = doc.createElement('button');
        b.type = 'button';
        b.className = 'tl-clip';
        b.setAttribute('data-track', d.track);
        b.setAttribute('aria-controls', 'tl-inspector');
        b.style.setProperty('--l', d.x1.toFixed(2));
        b.style.setProperty('--w', Math.max(0.5, d.x2 - d.x1).toFixed(2));
        b.innerHTML = '<span class="tl-clip-label"></span>';
        b.style.setProperty('--k', d.i);
        b.tabIndex = d.i === 0 ? 0 : -1;
        b.addEventListener('click', function () { go(d.i); });
        b.addEventListener('keydown', function (e) { onClipKey(e, d.i); });
        lane.appendChild(b);
        d.clip = b;
      });
      tracksEl.appendChild(row);
    });

    function labelClips() {
      data.forEach(function (d) {
        var short = (lang === 'de' && d.li.hasAttribute('data-short-de')) ? d.li.getAttribute('data-short-de') : d.li.getAttribute('data-short');
        d.clip.querySelector('.tl-clip-label').textContent = short;
        var when = text(d.li.querySelector('.tl-when'));
        var title = text(d.li.querySelector('.tl-title'));
        d.clip.setAttribute('aria-label', ui('clipAria').replace('{when}', when).replace('{title}', title));
        d.clip.title = title;
      });
      each(rulerEl.querySelectorAll('[data-ui]'), function (el) { el.textContent = ui(el.getAttribute('data-ui')); });
    }

    /* Render one chapter into the monitor + inspector */
    var active = -1;
    function render(i) {
      var d = data[i];
      var card = d.li.querySelector('.tl-card');
      inspCard.innerHTML = card ? card.innerHTML : '';
      each(inspCard.querySelectorAll('[data-i18n]'), function (el) { el.removeAttribute('data-i18n'); });
      var chipsUl = inspCard.querySelector('.chips');
      if (chipsUl && d.skills) chipsUl.insertAdjacentHTML('afterbegin', '<li class="chip chip-plus">' + ui('skillsPlus', d.skills) + '</li>');
      each(inspCard.querySelectorAll('.chip'), function (c, k) { c.style.setProperty('--i', k); });
      inspCard.classList.remove('is-in');
      void inspCard.offsetWidth; /* restart the entrance animation */
      inspCard.classList.add('is-in');
      inspCard.scrollTop = 0;

      monIco.setAttribute('data-icon', d.icon);
      monIco.innerHTML = ICONS[d.icon] || '';
      each(monIco.querySelectorAll('.d, .f'), function (el, k) { el.style.setProperty('--i', k); });
      if (d.track === 'v3') monYear.innerHTML = '20<i class="mon-redact"></i>';
      else monYear.textContent = d.start === 'origins' ? '' : String(parseInt(d.start, 10));
      monTL.textContent = d.track.toUpperCase() + ' · ' + text(d.li.querySelector('.tl-title'));
      monTR.textContent = text(d.li.querySelector('.tl-when'));
      monBR.textContent = ui('ch') + ' ' + pad(i + 1) + ' / ' + pad(N);

      data.forEach(function (o, k) {
        o.clip.classList.toggle('is-active', k === i);
        o.clip.classList.toggle('is-past', k < i);
        if (k === i) o.clip.setAttribute('aria-current', 'step'); else o.clip.removeAttribute('aria-current');
        o.clip.tabIndex = k === i ? 0 : -1;
      });
      countN.textContent = cumSkills[i];
      countT.textContent = totalSkills;
      barFill.style.width = (cumSkills[i] / totalSkills * 100).toFixed(1) + '%';
    }

    /* Scroll mapping: N equal segments; hold on each chapter, then glide */
    var mode = null, laneW = 0, stageH = 0, total = 1;
    var HOLD = 0.5;
    function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
    function measure() {
      stageH = stage.offsetHeight || (window.innerHeight - NAV_H);
      var seg = Math.max(260, Math.round(window.innerHeight * 0.6));
      scroller.style.height = (stageH + seg * N) + 'px';
      total = Math.max(1, scroller.offsetHeight - stageH);
      var lane = tracksEl.querySelector('.tl-lane');
      laneW = lane ? lane.clientWidth : 0;
    }
    function progress() {
      return clamp((NAV_H - scroller.getBoundingClientRect().top) / total, 0, 1);
    }
    /* The wipe-in plays once, the first time the stage comes into view.
       update() runs on load and on every scroll, so it can't be missed. */
    var live = !motionOK();
    if (!live) stage.classList.add('is-armed');
    function update() {
      if (mode !== 'timeline') return;
      if (!live && scroller.getBoundingClientRect().top < window.innerHeight * 0.85) {
        live = true;
        stage.classList.add('is-live');
        /* fail-safe: clips can never stay wiped out if an animation stalls */
        setTimeout(function () { stage.classList.add('is-settled'); }, 2500);
      }
      var p = progress();
      var f = p * N;
      var i = Math.min(N - 1, Math.floor(f));
      var local = f - i;
      var x = data[i].x;
      if (i < N - 1 && local > HOLD) {
        x = data[i].x + (data[i + 1].x - data[i].x) * ease((local - HOLD) / (1 - HOLD));
        /* hand over to the next chapter halfway through the glide, so the
           highlighted clip always matches where the playhead is */
        if (local > (1 + HOLD) / 2) i += 1;
      }
      playhead.style.transform = 'translate3d(' + (laneW * x / 100).toFixed(1) + 'px,0,0)';
      phTag.textContent = x < ORIGIN_END ? ui('origins') : String(Math.min(2026, Math.floor(2016 + (x - ORIGIN_END) / PER_YEAR + 1e-6)));
      var fr = Math.round(p * 60 * 25), s = Math.floor(fr / 25);
      monTC.textContent = '01:' + pad(Math.floor(s / 60)) + ':' + pad(s % 60) + ':' + pad(fr % 25);
      if (i !== active) { active = i; render(i); }
    }

    var ticking = false;
    window.addEventListener('scroll', function () {
      if (mode !== 'timeline') return;
      if (doc.hidden) { update(); return; } /* rAF is paused in background tabs */
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(function () { ticking = false; update(); });
      }
    }, { passive: true });

    /* Jump to a chapter: scroll the page to its segment (no hijack) */
    function go(i) {
      i = clamp(i, 0, N - 1);
      /* smooth scrolling stalls in background tabs, so jump instantly there
         ('instant' beats the page-wide CSS scroll-behavior: smooth) */
      var behavior = (reducedMQ.matches || doc.hidden) ? 'instant' : 'smooth';
      if (mode !== 'timeline') {
        try { data[i].li.scrollIntoView({ behavior: behavior, block: 'start' }); } catch (e) { data[i].li.scrollIntoView(true); }
        return;
      }
      var top = Math.round(scroller.getBoundingClientRect().top + window.pageYOffset - NAV_H + ((i + 0.06) / N) * total);
      try { window.scrollTo({ top: top, behavior: behavior }); } catch (e) { window.scrollTo(0, top); }
    }
    function onClipKey(e, from) {
      var k = e.key, n = null;
      if (k === 'ArrowRight' || k === 'ArrowDown') n = from + 1;
      else if (k === 'ArrowLeft' || k === 'ArrowUp') n = from - 1;
      else if (k === 'Home') n = 0;
      else if (k === 'End') n = N - 1;
      if (n === null) return;
      e.preventDefault();
      n = clamp(n, 0, N - 1);
      data.forEach(function (d, j) { d.clip.tabIndex = j === n ? 0 : -1; });
      try { data[n].clip.focus({ preventScroll: true }); } catch (err) { data[n].clip.focus(); }
      go(n);
    }

    /* View mode: timeline on roomy desktops, list everywhere else */
    var pref = recall('rfx-about-view');
    function canTimeline() { return window.innerWidth >= 1025 && window.innerHeight >= 620; }
    function wantMode() {
      if (!canTimeline()) return 'list';
      if (pref === 'list' || pref === 'timeline') return pref;
      return reducedMQ.matches ? 'list' : 'timeline';
    }
    function applyMode() {
      var m = wantMode();
      if (viewWrap) viewWrap.hidden = !canTimeline();
      viewBtns.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-view-set') === m)); });
      if (m === mode) {
        if (m === 'timeline') { measure(); update(); }
        return;
      }
      mode = m;
      sec.setAttribute('data-view', m);
      if (m === 'timeline') {
        measure();
        active = -1;
        update();
      } else {
        scroller.style.height = '';
      }
    }
    viewBtns.forEach(function (b) {
      b.addEventListener('click', function () {
        pref = b.getAttribute('data-view-set');
        store('rfx-about-view', pref);
        var before = sec.getBoundingClientRect().top;
        applyMode();
        /* keep the section heading where the visitor was looking */
        window.scrollBy(0, sec.getBoundingClientRect().top - before);
      });
    });

    var rt;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(applyMode, 150);
    });
    onLang(function () {
      labelClips();
      if (mode === 'timeline' && active >= 0) render(active);
      update();
    });

    labelClips();
    applyMode();
    if (mode === 'timeline' && active < 0) render(0);
  })();

  /* ---------------------------------------------------------------
     5. AI Lab: cursor-following glow (fine pointers only)
     --------------------------------------------------------------- */
  (function initLabGlow() {
    if (window.matchMedia('(hover: none), (pointer: coarse)').matches) return;
    each(doc.querySelectorAll('.lab-card'), function (card) {
      card.addEventListener('pointermove', function (e) {
        var r = card.getBoundingClientRect();
        card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
        card.style.setProperty('--my', (e.clientY - r.top) + 'px');
      });
    });
  })();

  /* ---------------------------------------------------------------
     6. Classified file: decrypt-in lines, stamp, access denied.
     Redaction bars are decoration only; no hidden text exists behind them.
     --------------------------------------------------------------- */
  (function initClassified() {
    var file = doc.getElementById('cl-file');
    if (!file) return;
    var btn = doc.getElementById('cl-btn');
    var toast = doc.getElementById('cl-toast');
    var lines = [].slice.call(file.querySelectorAll('.cl-line'));
    var GLYPHS = '█▓▒░<>/\\#%&@$*+=';

    function scramble(el, delay) {
      var epoch = langEpoch;
      setTimeout(function () {
        if (epoch !== langEpoch) return;
        var final = el.textContent, len = final.length, dur = 900, t0 = performance.now();
        (function frame(now) {
          if (epoch !== langEpoch) return;
          var p = clamp((now - t0) / dur, 0, 1), n = Math.floor(p * len), out = final.slice(0, n);
          for (var k = n; k < len; k++) out += final.charAt(k) === ' ' ? ' ' : GLYPHS.charAt((Math.random() * GLYPHS.length) | 0);
          el.textContent = out;
          if (p < 1) requestAnimationFrame(frame); else el.textContent = final;
        })(t0);
        /* fail-safe if rAF stalls (background tab) */
        setTimeout(function () { if (epoch === langEpoch) el.textContent = final; }, dur + 600);
      }, delay);
    }

    if ('IntersectionObserver' in window && motionOK()) {
      file.classList.add('is-armed');
      var io = new IntersectionObserver(function (en) {
        if (!en[0].isIntersecting) return;
        io.disconnect();
        file.setAttribute('aria-busy', 'true');
        lines.forEach(function (el, k) { scramble(el, 200 + k * 220); });
        setTimeout(function () { file.removeAttribute('aria-busy'); }, 200 + lines.length * 220 + 1600);
        setTimeout(function () { file.classList.add('is-stamped'); }, 650);
      }, { threshold: 0.3 });
      io.observe(file);
    }

    var tt;
    if (btn && toast) {
      btn.addEventListener('click', function () {
        toast.textContent = ui('denied');
        btn.classList.remove('is-denied');
        void btn.offsetWidth;
        btn.classList.add('is-denied');
        clearTimeout(tt);
        tt = setTimeout(function () { toast.textContent = ''; }, 4500);
      });
      onLang(function () { if (toast.textContent) toast.textContent = ui('denied'); });
    }
  })();

  /* ---------------------------------------------------------------
     7. Software filter
     --------------------------------------------------------------- */
  (function initSoftware() {
    var grid = doc.getElementById('ars-grid');
    if (!grid) return;
    var items = [].slice.call(grid.querySelectorAll('.ars-item'));
    var btns = [].slice.call(doc.querySelectorAll('.ars-f'));
    var count = doc.getElementById('ars-count');
    var current = 'all';
    function apply(f, animate) {
      current = f;
      var n = 0;
      items.forEach(function (it) {
        var show = f === 'all' || (' ' + it.getAttribute('data-cat') + ' ').indexOf(' ' + f + ' ') > -1;
        it.hidden = !show;
        if (!show) return;
        n++;
        if (animate) {
          it.classList.remove('is-in');
          void it.offsetWidth;
          it.style.animationDelay = (Math.min(n, 14) * 22) + 'ms';
          it.classList.add('is-in');
        }
      });
      btns.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-filter') === f)); });
      if (count) count.textContent = ui('tools', n);
    }
    btns.forEach(function (b) {
      b.addEventListener('click', function () { apply(b.getAttribute('data-filter'), !reducedMQ.matches); });
    });
    onLang(function () { apply(current, false); });
    apply('all', false);
  })();

  /* ---------------------------------------------------------------
     8. Initial language: ?lang=de|en wins, then the visitor's choice
     --------------------------------------------------------------- */
  var q = /[?&]lang=(de|en)\b/i.exec(window.location.search);
  var initial = q ? q[1].toLowerCase() : recall('rfx-lang');
  if (initial === 'de') setLang('de', false);
})();
