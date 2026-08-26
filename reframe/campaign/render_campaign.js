const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');
const sharp = require('sharp');

const root = __dirname;
const exportsDir = path.join(root, 'exports');
const url = pathToFileURL(path.join(root, 'campaign.html')).href;

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

async function contactSheet(files, output, columns, thumbWidth) {
  const gap = 16;
  const items = [];
  let cellHeight = 0;
  for (const file of files) {
    const metadata = await sharp(file).metadata();
    const height = Math.round(metadata.height * thumbWidth / metadata.width);
    cellHeight = Math.max(cellHeight, height);
    items.push({ file, width: thumbWidth, height });
  }
  const rows = Math.ceil(items.length / columns);
  const width = columns * thumbWidth + (columns + 1) * gap;
  const height = rows * cellHeight + (rows + 1) * gap;
  const composites = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const input = await sharp(item.file).resize(item.width, item.height).jpeg({ quality: 92 }).toBuffer();
    composites.push({ input, left: gap + (index % columns) * (thumbWidth + gap), top: gap + Math.floor(index / columns) * (cellHeight + gap) });
  }
  await sharp({ create: { width, height, channels: 3, background: '#111418' } }).composite(composites).jpeg({ quality: 92 }).toFile(output);
}

async function main() {
  fs.mkdirSync(exportsDir, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1500 }, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'networkidle' });
  const artboards = page.locator('[data-asset]');
  const records = [];
  for (let index = 0; index < await artboards.count(); index += 1) {
    const artboard = artboards.nth(index);
    const name = await artboard.getAttribute('data-asset');
    const output = path.join(exportsDir, name + '.png');
    await artboard.screenshot({ path: output });
    const metadata = await sharp(output).metadata();
    records.push({ file: 'exports/' + path.basename(output), width: metadata.width, height: metadata.height, bytes: fs.statSync(output).size, sha256: sha256(output) });
  }
  await browser.close();

  const carouselNames = ['carousel-01-cover.png', 'carousel-02-presets.png', 'carousel-03-guides.png', 'carousel-04-camera.png', 'carousel-05-batch.png', 'carousel-06-renderers.png', 'carousel-07-cta.png'];
  const gumroadNames = ['gumroad-01-cover.png', 'gumroad-02-delivery.png', 'gumroad-03-presets.png', 'gumroad-thumbnail.png'];
  await contactSheet(carouselNames.map((name) => path.join(exportsDir, name)), path.join(exportsDir, 'instagram-contact-sheet.jpg'), 4, 250);
  await contactSheet(gumroadNames.map((name) => path.join(exportsDir, name)), path.join(exportsDir, 'gumroad-contact-sheet.jpg'), 2, 500);

  const manifest = {
    product: 'Reframe',
    version: '1.1.0',
    generated: '2026-08-26',
    source_policy: 'Supplied screenshots are embedded unchanged: no drawn overlays, filters, rotation, or crop inside the image bounds.',
    background_prompt: 'Subtle dark graphite campaign texture with restrained teal and warm red light; no text, UI, logos, grids, borders, or guide lines.',
    assets: records
  };
  fs.writeFileSync(path.join(root, 'export-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error) + '\n');
  process.exitCode = 1;
});
