'use strict';
const { renderMeme } = require('./render-png');
/** Fixed Pics origin; credentials never follow a redirect or a user-supplied URL. */
async function loadPicture(ctx, req, slug) {
    if (!/^[2-9a-km-zA-HJ-NP-Z]{8}$/.test(String(slug || ''))) throw Object.assign(new Error('No such picture'), { status: 404 });
    const token = ctx.sso.client.extractToken(req);
    const fetchImpl = ctx.fetchImpl || globalThis.fetch;
    // The Pics address is configuration, and it is a fixed origin: no redirect is followed, no credential is sent
    // anywhere else.
    const base = String((ctx.config && ctx.config.pics && ctx.config.pics.url) || 'https://openvibe.pics').replace(/\/+$/, '');
    const get = (suffix) => fetchImpl(`${base}/api/v1/images/${slug}${suffix}`, { redirect: 'error', headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000) });
    const metadata = await get('');
    if (!metadata.ok) throw Object.assign(new Error('Picture unavailable'), { status: metadata.status === 404 ? 404 : 502 });
    const picture = await metadata.json();
    if (picture.bytes > 20 * 1024 * 1024) throw Object.assign(new Error('Picture too large'), { status: 413 });
    const res = await get('/bytes');
    if (!res.ok) throw Object.assign(new Error('Picture unavailable'), { status: 404 });
    const chunks=[];let size=0;
    for await (const chunk of res.body) { size+=chunk.length; if(size>20*1024*1024)throw Object.assign(new Error('Picture too large'),{status:413});chunks.push(chunk); }
    return { ...picture, buffer: Buffer.concat(chunks) };
}
async function renderPicture(picture, lines) {
    const w = 1000, h = Math.max(300, Math.min(2000, Math.round(w * picture.height / picture.width)));
    const box = (y) => ({ x: 30, y, w: 940, h: Math.floor(h * .23), size: 70, color: '#ffffff', outline: '#000000', outline_width: 4, align: 'center', font: 'DejaVuSans-Bold' });
    return renderMeme({ template: { image_buffer: picture.buffer, layout: { width:w,height:h,boxes:[box(20),box(Math.floor(h*.74))] } }, lines });
}
module.exports = { loadPicture, renderPicture };
