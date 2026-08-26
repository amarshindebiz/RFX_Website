const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const siteRoot = path.resolve(__dirname, '..', '..');
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const mime = { '.css': 'text/css', '.html': 'text/html', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp' };

function serve() {
  return http.createServer((request, response) => {
    const requestPath = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    let filePath = path.resolve(siteRoot, '.' + requestPath);
    if (!filePath.startsWith(siteRoot)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': mime[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(response);
  });
}

async function inspectPage(browser, url, viewport, screenshotPath) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  const response = await page.goto(url, { waitUntil: 'networkidle' });
  assert.strictEqual(response.status(), 200);
  assert.deepStrictEqual(errors, []);
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += window.innerHeight) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(250);
  const brokenImages = await page.locator('img').evaluateAll((images) => images.filter((image) => !image.complete || image.naturalWidth === 0).map((image) => image.getAttribute('src')));
  const releaseBroken = brokenImages.filter((source) => source && (source.includes('/reframe/') || source.includes('/products/product-reframe')));
  assert.deepStrictEqual(releaseBroken, [], 'Broken Reframe images: ' + releaseBroken.join(', '));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, 'Horizontal overflow: ' + overflow);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await page.close();
}

async function main() {
  const server = serve();
  await new Promise((resolve) => server.listen(8765, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  try {
    const reframeUrl = 'http://127.0.0.1:8765/reframe/';
    const productsUrl = 'http://127.0.0.1:8765/products/';
    await inspectPage(browser, reframeUrl, { width: 1440, height: 1000 }, path.join(siteRoot, 'reframe', 'landing-v1.1-desktop.png'));
    await inspectPage(browser, reframeUrl, { width: 390, height: 844 }, path.join(siteRoot, 'reframe', 'landing-v1.1-mobile.png'));
    await inspectPage(browser, productsUrl, { width: 1440, height: 1000 }, path.join(siteRoot, 'reframe', 'products-v1.1-preview.png'));

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(reframeUrl, { waitUntil: 'networkidle' });
    assert.strictEqual(await page.locator('h1').innerText(), 'One scene.\nEvery format.');
    assert.ok((await page.locator('body').innerText()).includes('Arnold + Redshift'));
    assert.ok((await page.locator('body').innerText()).includes('Version 1.1.0'));
    assert.strictEqual(await page.locator('a[href="https://reimagine-fx.gumroad.com/l/reframev1"]').count(), 2);
    assert.strictEqual(await page.locator('meta[name="robots"]').getAttribute('content'), 'index, follow');
    await page.goto(productsUrl, { waitUntil: 'networkidle' });
    const card = page.locator('[data-landing="/reframe/"]');
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const cardText = await card.innerText();
    assert.ok(cardText.includes('Arnold or Redshift'));
    await card.screenshot({ path: path.join(siteRoot, 'reframe', 'product-card-v1.1.png') });
    await page.close();

    const expectedDimensions = { 'gumroad-01-cover.png': [1280, 720], 'gumroad-thumbnail.png': [1200, 1200] };
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'export-manifest.json'), 'utf8'));
    assert.strictEqual(manifest.assets.length, 14);
    for (const asset of manifest.assets) {
      const expected = expectedDimensions[path.basename(asset.file)];
      if (expected) assert.deepStrictEqual([asset.width, asset.height], expected);
      assert.ok(fs.existsSync(path.join(__dirname, asset.file)));
    }
    process.stdout.write('PASS: 3 responsive pages, 0 console errors, 0 broken images, 0 horizontal overflow, CTA/schema/campaign assertions passed.\n');
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error) + '\n');
  process.exitCode = 1;
});
