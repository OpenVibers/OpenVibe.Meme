'use strict';
// The browser check (11-15) found two pages that scrolled sideways at 768 px: /browse, whose five filter columns need
// about 900 px, and the home hero, whose last sticker was placed at left 82% of a narrow stage. Real Chrome with real
// scrollbars and the real meme.css: neither scrolls sideways at 768 or 900 px, and the sticker stays on its stage.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const h = require('openvibe-shared/browser-harness');
if (process.env.OV_SKIP_BROWSER === '1' || !h.findChrome()) { console.log('overflow-768-chrome: skipped (no Chrome)'); process.exit(0); }

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'meme.css'), 'utf8');
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>t</title>
<link rel="stylesheet" href="/meme.css"><style>body{margin:0;font:16px system-ui}.box{max-width:1120px;margin:0 auto;padding:0 16px}</style></head><body><div class="box">
<div class="mm-tree" style="width:300px;margin:0"><span class="mm-node mm-node-root"><b>A meme's origin</b></span>
<span class="mm-sticker mm-s1">origin</span><span class="mm-sticker mm-s2">remix</span><span class="mm-sticker mm-s3">history</span></div>
<form class="mm-browse-filters mm-card"><label class="mm-field"><span>Search</span><input type="search" placeholder="Try a meme name or phrase"></label>
<label class="mm-field"><span>Collection</span><select><option>All collections</option></select></label>
<label class="mm-field"><span>Type</span><select><option>Internet memes</option></select></label>
<label class="mm-field"><span>Order</span><select><option>Recently added</option></select></label><button class="mm-btn" type="submit">Find memes</button></form>
<div style="height:2000px"></div></div></body></html>`;
const server = http.createServer((req, res) => {
    if (req.url === '/meme.css') { res.writeHead(200, { 'content-type': 'text/css' }); return res.end(css); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(page);
});
(async () => {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-768-'));
    const browser = await h.launch({ tmpDir });
    try {
        for (const width of [768, 900, 1280]) {
            const p = await h.openPage(browser, await browser.newContext(), { width, height: 800 });
            await p.goto(`http://127.0.0.1:${server.address().port}/`, { maxMs: 8000 });
            const r = await p.evaluate(`(() => {
                const x0 = window.scrollX; window.scrollTo(100000, window.scrollY); const sx = window.scrollX; window.scrollTo(x0, window.scrollY);
                const stage = document.querySelector('.mm-tree').getBoundingClientRect(), s3 = document.querySelector('.mm-s3').getBoundingClientRect();
                return { sx, stageRight: stage.right, s3Right: s3.right, button: document.querySelector('.mm-browse-filters .mm-btn').getBoundingClientRect().right, client: document.documentElement.clientWidth };
            })()`);
            assert.strictEqual(r.sx, 0, `${width} px: no sideways scroll (button right ${r.button}, client ${r.client})`);
            assert.ok(r.s3Right <= r.stageRight + 6, `${width} px: the last sticker stays on its stage (${r.s3Right} > ${r.stageRight})`);
        }
        console.log('overflow-768-chrome: /browse and the hero do not scroll sideways at 768, 900 or 1280 px');
    } finally { await browser.close(); server.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exit(1); });
