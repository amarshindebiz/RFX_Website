/* ============================================================
   REIMAGINE FX — shared nav + footer (v2)
   - 6-item nav: Home · Products (mega) · Work (drop) · Training · About · Contact (pill)
   - Supports BOTH injection patterns:
       document.getElementById('nav-placeholder').outerHTML = buildNav('X')
       document.getElementById('nav').innerHTML = buildNav('X')   (viewport/mayaviewer)
   - activePage mapping keeps untouched pages highlighting correctly:
       'Viewport' / 'Maya Viewer' -> Products · 'Portfolio' / 'Reel' -> Work
   ============================================================ */

const SOCIAL_LINKS = {
  instagram: 'https://www.instagram.com/reimaginefx',
  youtube:   'https://www.youtube.com/@reimaginefx',
  facebook:  'https://www.facebook.com/OfficialRfx',
  x:         'https://x.com/Reimagine_Fx',
  vimeo:     'https://vimeo.com/reimaginefx',
  discord:   'https://discord.gg/cjGQJzZzp'
};

const SOCIAL_ICONS = {
  instagram: `<svg viewBox="0 0 24 24"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>`,
  youtube:   `<svg viewBox="0 0 24 24"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>`,
  facebook:  `<svg viewBox="0 0 24 24"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>`,
  x:         `<svg viewBox="0 0 24 24"><path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/></svg>`,
  vimeo:     `<svg viewBox="0 0 24 24"><path d="M23.977 6.416c-.105 2.338-1.739 5.543-4.894 9.609-3.268 4.247-6.026 6.37-8.29 6.37-1.409 0-2.578-1.294-3.553-3.881L5.322 11.4C4.603 8.816 3.834 7.522 3.01 7.522c-.179 0-.806.378-1.881 1.132L0 7.197a315.065 315.065 0 003.501-3.122C5.08 2.701 6.266 1.984 7.055 1.91c1.867-.18 3.016 1.1 3.447 3.838.465 2.953.789 4.789.971 5.507.539 2.45 1.131 3.674 1.776 3.674.502 0 1.256-.796 2.265-2.385 1.004-1.589 1.54-2.797 1.612-3.628.144-1.371-.395-2.061-1.614-2.061-.574 0-1.167.121-1.777.391 1.186-3.868 3.434-5.757 6.762-5.637 2.473.06 3.628 1.664 3.484 4.807z"/></svg>`,
  discord:   `<svg viewBox="0 0 24 24"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057.101 18.079.11 18.1.12 18.12a19.93 19.93 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>`
};

const CHEVRON_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/* Which top-level item is active for a given page tag (old labels still work) */
function _activeKey(activePage) {
  const map = {
    home: 'home',
    about: 'about',
    training: 'training',
    contact: 'contact',
    products: 'products',
    viewport: 'products',
    'maya viewer': 'products',
    mayaviewer: 'products',
    portfolio: 'work',
    reel: 'work',
    work: 'work'
  };
  return map[String(activePage || '').toLowerCase()] || '';
}

function buildNav(activePage) {
  const active = _activeKey(activePage);
  const cls = k => (active === k ? 'active' : '');

  const drawerSocials = ['instagram', 'youtube', 'discord', 'vimeo'].map(k =>
    `<a href="${SOCIAL_LINKS[k]}" target="_blank" rel="noopener" aria-label="${k}">${SOCIAL_ICONS[k]}</a>`
  ).join('');

  return `
  <nav class="site-nav">
    <a href="/" class="nav-logo"><img src="/logo.png" alt="Reimagine FX" style="height:28px;width:auto;display:inline-block !important;">REIMAGINE FX</a>
    <ul class="nav-links" id="navLinks">
      <li><a href="/" class="${cls('home')}">Home</a></li>

      <li class="nav-item nav-item--mega">
        <div class="nav-row">
          <a href="/products" class="${cls('products')}">Products</a>
          <button class="nav-chevron" aria-expanded="false" aria-label="Open products menu">${CHEVRON_SVG}</button>
        </div>
        <div class="nav-mega">
          <div class="nav-mega-grid">
            <a class="mega-cat" href="/products/#maya" style="--acc:#64D2A3">
              <span class="mega-cat-name">Maya Plugins</span>
              <span class="mega-cat-desc">Smart Organizer · Area Light Maps Pro · Focus Picker · Light Target</span>
            </a>
            <a class="mega-cat" href="/products/#nuke" style="--acc:#FF9670">
              <span class="mega-cat-name">Nuke Plugins</span>
              <span class="mega-cat-desc">Nuke Diagnostic Suite — comp health, colorspace &amp; performance</span>
            </a>
            <a class="mega-cat" href="/products/#apps" style="--acc:#7BB4FF">
              <span class="mega-cat-name">iOS Apps</span>
              <span class="mega-cat-desc">Viewport — 3D viewer · Maya Viewer — scene review</span>
            </a>
            <a class="mega-cat" href="/products/#bundles" style="--acc:#FF6B4A">
              <span class="mega-cat-name">Bundles &amp; Assets</span>
              <span class="mega-cat-desc">RFX Vault · Terrains &amp; Landscapes · HDRI Studio Kit</span>
            </a>
            <div class="mega-cat mega-cat--soon" style="--acc:#9B8CFF">
              <span class="mega-cat-name">RFX Hub <span class="badge" style="--acc:#9B8CFF">Coming soon</span></span>
              <span class="mega-cat-desc">One desktop app to install &amp; manage every RFX tool</span>
            </div>
          </div>
          <div class="nav-mega-foot">
            <a href="/products">Browse all products →</a>
            <a href="https://reimagine-fx.gumroad.com/" target="_blank" rel="noopener">Gumroad Shop ↗</a>
          </div>
        </div>
      </li>

      <li class="nav-item nav-item--drop">
        <div class="nav-row">
          <a href="/portfolio" class="${cls('work')}">Work</a>
          <button class="nav-chevron" aria-expanded="false" aria-label="Open work menu">${CHEVRON_SVG}</button>
        </div>
        <div class="nav-drop">
          <a href="/portfolio">Portfolio</a>
          <a href="/reel">Showreel</a>
        </div>
      </li>

      <li><a href="/training" class="${cls('training')}">Training</a></li>
      <li><a href="/about" class="${cls('about')}">About</a></li>
      <li><a href="/contact" class="nav-cta-pill ${cls('contact')}">Contact</a></li>

      <li class="drawer-socials">${drawerSocials}</li>
    </ul>
    <button class="nav-hamburger" id="hamburger" aria-label="Menu" aria-expanded="false">
      <span></span><span></span><span></span>
    </button>
  </nav>`;
}

function buildFooter() {
  const socialsHTML = ['instagram', 'youtube', 'facebook', 'x', 'vimeo', 'discord'].map(k =>
    `<a href="${SOCIAL_LINKS[k]}" target="_blank" rel="noopener" class="footer-social" aria-label="${k}">${SOCIAL_ICONS[k]}</a>`
  ).join('');

  const year = new Date().getFullYear();

  return `
  <footer>
    <div class="footer-grid">
      <div>
        <div class="footer-logo"><img src="/logo.png" alt="Reimagine FX" style="height:32px;width:auto;display:inline-block !important;">REIMAGINE FX</div>
        <p class="footer-tagline">Crafting Worlds.<br>Compositing Reality.</p>
        <div class="footer-socials">${socialsHTML}</div>
      </div>
      <div class="footer-col">
        <h4>Products</h4>
        <ul>
          <li><a href="/products/#maya">Maya Plugins</a></li>
          <li><a href="/products/#nuke">Nuke Plugins</a></li>
          <li><a href="/products/#apps">iOS Apps</a></li>
          <li><a href="/products/#bundles">Bundles &amp; Assets</a></li>
          <li><a href="/products">RFX Hub <span class="footer-soon">Soon</span></a></li>
          <li><a href="https://reimagine-fx.gumroad.com/" target="_blank" rel="noopener">Gumroad Shop ↗</a></li>
        </ul>
      </div>
      <div class="footer-col">
        <h4>Studio</h4>
        <ul>
          <li><a href="/portfolio">Portfolio</a></li>
          <li><a href="/reel">Showreel</a></li>
          <li><a href="/training">Training</a></li>
          <li><a href="/about">About</a></li>
          <li><a href="/contact">Contact</a></li>
        </ul>
      </div>
      <div class="footer-col">
        <h4>Connect</h4>
        <ul>
          <li><a href="${SOCIAL_LINKS.youtube}" target="_blank" rel="noopener">YouTube</a></li>
          <li><a href="${SOCIAL_LINKS.instagram}" target="_blank" rel="noopener">Instagram</a></li>
          <li><a href="${SOCIAL_LINKS.discord}" target="_blank" rel="noopener">Discord</a></li>
          <li><a href="${SOCIAL_LINKS.vimeo}" target="_blank" rel="noopener">Vimeo</a></li>
          <li><a href="https://www.skillshare.com/user/reimagine" target="_blank" rel="noopener">Skillshare</a></li>
        </ul>
      </div>
    </div>
    <div class="footer-bottom">
      <p class="footer-copy">© ${year} Reimagine FX · Amar Shinde · All rights reserved</p>
      <p class="footer-copy">Built for creators, by a creator</p>
    </div>
  </footer>`;
}

function initNav() {
  /* Use querySelector('nav') — never getElementById('nav'): the viewport/mayaviewer
     pages wrap the injected markup in <div id="nav">, which would shadow it. */
  const nav = document.querySelector('nav');
  const hamburger = document.getElementById('hamburger');
  const navLinks = document.getElementById('navLinks');

  if (hamburger && navLinks) {
    hamburger.addEventListener('click', () => {
      const open = navLinks.classList.toggle('open');
      hamburger.classList.toggle('open', open);
      hamburger.setAttribute('aria-expanded', String(open));
      document.body.style.overflow = open ? 'hidden' : '';
    });
  }

  /* Chevron accordions (mobile) + keyboard toggle (desktop focus-within) */
  document.querySelectorAll('.nav-chevron').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const li = btn.closest('li');
      const isOpen = li.classList.contains('submenu-open');
      document.querySelectorAll('.nav-links li.submenu-open').forEach(other => {
        other.classList.remove('submenu-open');
        const b = other.querySelector('.nav-chevron');
        if (b) b.setAttribute('aria-expanded', 'false');
      });
      li.classList.toggle('submenu-open', !isOpen);
      btn.setAttribute('aria-expanded', String(!isOpen));
    });
  });

  /* Close drawer on Escape */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && navLinks && navLinks.classList.contains('open')) {
      navLinks.classList.remove('open');
      if (hamburger) {
        hamburger.classList.remove('open');
        hamburger.setAttribute('aria-expanded', 'false');
      }
      document.body.style.overflow = '';
    }
  });

  /* Scroll state via class (v1 set inline styles) */
  if (nav) {
    const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 50);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
}
