/* Run against a static server: RFX_TEST_URL=http://127.0.0.1:4177 node tests/brand-experience.cjs */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const base = process.env.RFX_TEST_URL || 'http://127.0.0.1:4177';
const output = process.env.RFX_QA_OUTPUT || path.join(require('node:os').tmpdir(), 'rfx-brand-qa');
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}) });
  try {
    for (const [width, height] of [[1440, 900], [390, 844], [320, 740], [768, 1024], [844, 390]]) {
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      console.log('START viewport', width, height);
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(base, { waitUntil: 'commit' });
      await page.locator('.rfx-intro[open]').waitFor({ timeout: 8000 }).catch(async error => {
        console.log('INTRO FAILURE', await page.evaluate(() => ({ root: document.documentElement.className, storage: sessionStorage.getItem('rfx-welcome-v1'), dialog: document.querySelector('.rfx-intro')?.outerHTML, ready: document.readyState, hidden: document.hidden })), errors);
        throw error;
      });
      const intro = await page.locator('.rfx-intro').evaluate(el => ({ background: getComputedStyle(el).backgroundColor, modal: el.matches(':modal') }));
      assert.equal(intro.background, 'rgb(0, 0, 0)'); assert(intro.modal);
      assert.equal(await page.locator('.rfx-intro button').count(), 0);
      if (width === 1440) {
        await page.waitForTimeout(1000);
        await page.screenshot({ path: path.join(output, 'welcome-drawing.png') });
      }
      await page.locator('.rfx-intro').waitFor({ state: 'detached', timeout: 5000 });
      await page.waitForLoadState('domcontentloaded');
      await page.evaluate(() => document.fonts.ready);
      const geometry = await page.locator('.hero-title').evaluate(el => {
        const range = document.createRange(); range.selectNodeContents(el);
        const rect = el.getBoundingClientRect(); const style = getComputedStyle(el);
        return { left: rect.left, right: rect.right, lines: range.getClientRects().length,
          font: style.fontFamily, fontReady: document.fonts.check('500 48px "Cormorant Garamond"'),
          animation: style.animationName, transform: style.transform, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.equal(geometry.lines, 1); assert(geometry.left >= 0 && geometry.right <= width + 1);
      assert(geometry.fontReady); assert(geometry.font.includes('Cormorant')); assert(!geometry.overflow);
      assert.equal(geometry.animation, 'none'); assert.equal(geometry.transform, 'none');
      const motion = await page.locator('.hero-logo').evaluate(el => {
        const animations = el.getAnimations({ subtree: true });
        animations.forEach(a => a.pause());
        function sample(time) {
          animations.forEach(a => { a.currentTime = time; });
          return [...el.querySelectorAll('path, polygon')].map(node => {
            const style = getComputedStyle(node);
            return [style.strokeDashoffset, style.opacity, style.transform];
          });
        }
        const result = { draw: sample(750), holdStart: sample(1700), holdEnd: sample(10650), repeat: sample(11750) };
        animations.forEach(a => { a.currentTime = 2000; a.play(); });
        return result;
      });
      assert(Number.parseFloat(motion.draw[0][0]) > 0 && Number.parseFloat(motion.draw[0][0]) < 1);
      assert.deepEqual(motion.holdStart, motion.holdEnd, 'Logo must stay fully still for nine seconds');
      assert.deepEqual(motion.draw, motion.repeat, 'Drawing must repeat each cycle');
      assert.equal(motion.holdStart[0][0], '0px');
      assert.equal(motion.holdStart[2][1], '1');
      await page.screenshot({ path: path.join(output, `homepage-${width}.png`) });
      assert.equal(await page.locator('.hero-motion-toggle').count(), 0);
      if (width < 500) {
        await page.locator('#hamburger').click();
        assert.equal(await page.locator('#hamburger').getAttribute('aria-expanded'), 'true');
        await page.keyboard.press('Escape');
      }
      await page.mouse.move(width / 2, height / 2); await page.mouse.wheel(0, 700); await page.waitForTimeout(400);
      assert(await page.evaluate(() => scrollY) > 100);
      await page.goto(base + '/products/', { waitUntil: 'domcontentloaded' });
      assert.equal(await page.locator('.rfx-intro').count(), 0);
      await page.goBack({ waitUntil: 'domcontentloaded' });
      assert.equal(await page.locator('.rfx-intro').count(), 0);
      assert.equal(errors.length, 0, errors.join('\n'));
      console.log('PASS viewport', width, height, JSON.stringify(geometry));
      await context.close();
    }

    for (const action of ['escape', 'wheel', 'touch', 'motion-change']) {
      const context = await browser.newContext(); const page = await context.newPage();
      await page.goto(base + '/products/', { waitUntil: 'commit' });
      await page.locator('.rfx-intro[open]').waitFor();
      if (action === 'escape') await page.keyboard.press('Escape');
      if (action === 'wheel') await page.mouse.wheel(0, 600);
      if (action === 'touch') await page.evaluate(() => window.dispatchEvent(new Event('touchmove')));
      if (action === 'motion-change') await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.locator('.rfx-intro').waitFor({ state: 'detached', timeout: 1000 });
      assert.equal(await page.locator('html.rfx-intro-active').count(), 0);
      await page.waitForLoadState('domcontentloaded');
      await page.mouse.wheel(0, 600); await page.waitForTimeout(300);
      assert(await page.evaluate(() => scrollY) > 100);
      console.log('PASS dismiss', action); await context.close();
    }

    for (const mode of ['reduced', 'no-js', 'storage-blocked', 'css-blocked', 'script-blocked', 'font-blocked', 'hash']) {
      const context = await browser.newContext({ viewport: { width: 320, height: 740 },
        javaScriptEnabled: mode !== 'no-js', reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference' });
      if (mode === 'storage-blocked') await context.addInitScript(() => { Storage.prototype.setItem = () => { throw new Error('Blocked'); }; });
      if (mode === 'css-blocked') await context.route('**/css/brand-experience.css', route => route.abort());
      if (mode === 'script-blocked') await context.route('**/js/brand-intro.js', route => route.abort());
      if (mode === 'font-blocked') await context.route('**/*.woff2', route => route.abort());
      const page = await context.newPage();
      await page.goto(base + (mode === 'hash' ? '/#main' : '/'), { waitUntil: 'domcontentloaded' });
      if (mode === 'font-blocked') await page.waitForTimeout(2600);
      assert.equal(await page.locator('.rfx-intro').count(), 0);
      assert(await page.locator('.hero-title').isVisible());
      const bounds = await page.locator('.hero-title').boundingBox();
      assert(bounds.x >= 0 && bounds.x + bounds.width <= 321, 'Fallback title must fit');
      if (mode === 'reduced') {
        assert.equal(await page.locator('.hero-logo-line').first().evaluate(el => getComputedStyle(el).animationName), 'none');
        assert(!(await page.locator('.hero-motion-toggle').isVisible()));
      }
      await page.mouse.wheel(0, 600); await page.waitForTimeout(300);
      assert(await page.evaluate(() => scrollY) > 100);
      console.log('PASS resilience', mode); await context.close();
    }

    for (const route of ['/about/', '/light-target/', '/area-light-maps-pro/', '/focus-picker/', '/smart-organizer/', '/nuke-diagnostic/', '/reframe/', '/viewport/']) {
      const context = await browser.newContext(); const page = await context.newPage();
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.goto(base + route, { waitUntil: 'commit' });
      await page.locator('.rfx-intro[open]').waitFor();
      await page.keyboard.press('Escape');
      await page.waitForLoadState('domcontentloaded');
      assert(await page.locator('.nav-logo, .rfx-studio-home').first().isVisible());
      assert.equal(errors.length, 0, errors.join('\n'));
      console.log('PASS landing', route); await context.close();
    }
    const slowContext = await browser.newContext(); const slowPage = await slowContext.newPage();
    await slowContext.route('**/gsap.min.js', async route => {
      await new Promise(resolve => setTimeout(resolve, 6000));
      await route.fulfill({ body: '', contentType: 'application/javascript' });
    });
    await slowPage.goto(base, { waitUntil: 'commit' });
    await slowPage.locator('.rfx-intro[open]').waitFor();
    await slowPage.locator('.rfx-intro').waitFor({ state: 'detached', timeout: 4000 });
    assert.equal(await slowPage.locator('html.rfx-intro-active').count(), 0);
    console.log('PASS intro releases without third-party scripts');
    await slowPage.waitForLoadState('domcontentloaded');
    await slowContext.close();
    console.log('ALL BRAND CHECKS PASSED', output);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
