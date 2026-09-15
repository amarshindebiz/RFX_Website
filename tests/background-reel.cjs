const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const base = process.env.RFX_TEST_URL || 'http://127.0.0.1:4181';
const output = process.env.RFX_QA_OUTPUT || path.join(require('node:os').tmpdir(), 'rfx-reel-qa');
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}) });
  try {
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });
      const page = await context.newPage();
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(() => sessionStorage.setItem('rfx-welcome-v1', '1'));
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      assert.equal(await page.locator('.hero-video').evaluate(el => getComputedStyle(el).opacity), '0');
      let visibleSamples = 0;
      for (let i = 0; i < 32; i++) {
        await page.waitForTimeout(400);
        const exposed = await page.locator('.hero-video').evaluate(el => Number(getComputedStyle(el).opacity) > 0);
        if (!exposed) continue;
        visibleSamples++;
        const frame = page.frames().find(f => f.url().includes('youtube-nocookie.com/embed/'));
        assert(frame, 'Actual player frame must exist');
        const controls = await frame.locator('button.player-control-play-pause-icon, button.player-middle-controls-prev-next-button').evaluateAll(els => els.filter(el => {
          if (!el.getClientRects().length) return false;
          for (let node = el; node; node = node.parentElement) {
            const s = getComputedStyle(node);
            if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
          }
          return true;
        }).map(el => el.getAttribute('aria-label')));
        assert.deepEqual(controls, [], 'Player controls must not appear through the background');
      }
      assert(visibleSamples > 2, 'Footage must actually become visible');
      await page.screenshot({ path: path.join(output, `reel-clean-${width}.png`) });
      const frame = page.frames().find(f => f.url().includes('youtube-nocookie.com/embed/'));
      assert(await frame.locator('video').evaluate(el => el.currentTime > 2 && !el.paused));
      await frame.locator('video').evaluate(el => el.pause());
      await page.waitForTimeout(250);
      assert.equal(await page.locator('.hero-video').evaluate(el => getComputedStyle(el).opacity), '0');
      assert.equal(errors.length, 0, errors.join('\n'));
      console.log('PASS clean playback and pause fallback', width, visibleSamples);
      await context.close();
    }
    for (const mode of ['reduced', 'api-blocked']) {
      const context = await browser.newContext({ reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference' });
      if (mode === 'api-blocked') await context.route('**/iframe_api', route => route.abort());
      const page = await context.newPage();
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2700);
      assert.equal(await page.locator('.hero-video iframe').count(), 0);
      assert(await page.locator('.hero-title').isVisible());
      await page.mouse.wheel(0, 600); await page.waitForTimeout(400);
      assert(await page.evaluate(() => scrollY) > 100);
      console.log('PASS fallback', mode); await context.close();
    }
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
