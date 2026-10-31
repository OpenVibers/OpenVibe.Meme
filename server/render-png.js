'use strict';

/**
 * The M6 renderer: a template's own layout + bundled open fonts (DejaVu Sans/Bold, Bitstream Vera licence in
 * server/assets/fonts) → a real PNG. Text is converted to outlines with opentype.js, wrapped to each box, shrunk
 * until it fits, stroked in the outline colour and filled, then composited over the template artwork by sharp.
 * No system font, no ImageMagick and no browser are involved.
 */
const fs = require('fs');
const path = require('path');
const opentype = require('opentype.js');
const sharp = require('sharp');

const FONT_DIR = path.join(__dirname, 'assets', 'fonts');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const FONT_FILES = Object.freeze({ 'DejaVuSans': 'DejaVuSans.ttf', 'DejaVuSans-Bold': 'DejaVuSans-Bold.ttf' });
const cache = new Map();

function fontFor(name) {
    const key = FONT_FILES[name] ? name : 'DejaVuSans-Bold';
    if (!cache.has(key)) cache.set(key, opentype.loadSync(path.join(FONT_DIR, FONT_FILES[key])));
    return cache.get(key);
}

const escapeXml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Greedy word wrap, and hard splits for a word longer than the box. */
function wrapText(font, text, size, maxWidth) {
    const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    const lines = [];
    let line = '';
    const fits = (s) => font.getAdvanceWidth(s, size) <= maxWidth;
    for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (fits(next)) { line = next; continue; }
        if (line) { lines.push(line); line = ''; }
        if (fits(word)) { line = word; continue; }
        let piece = '';
        for (const ch of word) {
            if (fits(piece + ch)) { piece += ch; } else { if (piece) lines.push(piece); piece = ch; }
        }
        line = piece;
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
}

/** Shrink the font until the wrapped text fits the box, then truncate as a last resort. */
function fitLines(font, text, box) {
    const start = Math.max(8, Math.floor(Number(box.size) || 24));
    for (let size = start; size >= 8; size--) {
        const lineHeight = Math.floor(size * 1.16);
        const maxLines = Math.max(1, Math.floor((Number(box.h) || 40) / lineHeight));
        const lines = wrapText(font, text, size, Number(box.w) || 100);
        if (lines.length <= maxLines && lines.every((l) => font.getAdvanceWidth(l, size) <= (Number(box.w) || 100))) {
            return { size, lineHeight, lines };
        }
    }
    const size = 8;
    const lineHeight = Math.floor(size * 1.16);
    const maxLines = Math.max(1, Math.floor((Number(box.h) || 40) / lineHeight));
    const lines = wrapText(font, text, size, Number(box.w) || 100).slice(0, maxLines);
    if (lines.length === maxLines) {
        let last = lines[lines.length - 1];
        while (last.length > 1 && font.getAdvanceWidth(`${last}…`, size) > (Number(box.w) || 100)) last = last.slice(0, -1);
        lines[lines.length - 1] = `${last}…`;
    }
    return { size, lineHeight, lines };
}

function fallbackLayout(boxCount) {
    const n = Math.min(8, Math.max(1, Number(boxCount) || 1));
    const height = Math.floor(280 / n);
    return {
        width: 440, height: 280,
        boxes: Array.from({ length: n }, (_, i) => ({
            x: 20, y: i * height + 8, w: 400, h: height - 16, font: 'DejaVuSans-Bold', size: 22,
            color: '#ffffff', outline: '#000000', outline_width: 2, align: 'center', valign: 'middle', uppercase: true, wrap: true,
        })),
    };
}

function textSvg(layout, lines) {
    const boxes = Array.isArray(layout.boxes) ? layout.boxes : [];
    const parts = [];
    boxes.forEach((box, i) => {
        const raw = String(lines[i] == null ? '' : lines[i]);
        const text = box.uppercase ? raw.toUpperCase() : raw;
        const font = fontFor(box.font);
        const { size, lineHeight, lines: wrapped } = fitLines(font, text, box);
        const total = wrapped.length * lineHeight;
        let baseline = Number(box.y) + (Number(box.h) - total) / 2 + size * 0.82;
        if (box.valign === 'top') baseline = Number(box.y) + size * 0.82;
        if (box.valign === 'bottom') baseline = Number(box.y) + Number(box.h) - total + size * 0.82;
        for (const line of wrapped) {
            const width = font.getAdvanceWidth(line, size);
            let x = Number(box.x);
            if (box.align === 'center') x = Number(box.x) + (Number(box.w) - width) / 2;
            else if (box.align === 'right') x = Number(box.x) + Number(box.w) - width;
            const d = font.getPath(line, x, baseline, size).toPathData(2);
            const stroke = Number(box.outline_width) > 0 && box.outline;
            if (stroke) parts.push(`<path d="${d}" fill="none" stroke="${escapeXml(box.outline)}" stroke-width="${Number(box.outline_width)}" stroke-linejoin="round" stroke-linecap="round"/>`);
            parts.push(`<path d="${d}" fill="${escapeXml(box.color || '#ffffff')}"/>`);
            baseline += lineHeight;
        }
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">${parts.join('')}</svg>`;
}

async function backgroundOf(template, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
    const url = String(template.image_url || '');
    if (url.startsWith('/img/')) return fs.readFileSync(path.join(PUBLIC_DIR, url.replace(/^\/+/, '')));
    if (/^https?:\/\//i.test(url)) {
        const res = await fetchImpl(url, { headers: { Accept: 'image/*' }, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`template artwork answered ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
    }
    throw new Error('template has no usable artwork');
}

/** → { png, width, height, lines } */
async function renderMeme({ template, lines = [], fetchImpl = globalThis.fetch, maxPixels = 1600 } = {}) {
    const layout = template && template.layout && typeof template.layout === 'object' ? template.layout : fallbackLayout(template ? template.box_count : 1);
    const width = Math.min(maxPixels, Math.max(64, Number(layout.width) || 440));
    const height = Math.max(64, Math.round(width * ((Number(layout.height) || 280) / (Number(layout.width) || 440))));
    const scaled = { ...layout, width, height, boxes: (layout.boxes || []).map((b) => ({
        ...b,
        x: (Number(b.x) || 0) * (width / (Number(layout.width) || 440)),
        y: (Number(b.y) || 0) * (height / (Number(layout.height) || 280)),
        w: (Number(b.w) || 0) * (width / (Number(layout.width) || 440)),
        h: (Number(b.h) || 0) * (height / (Number(layout.height) || 280)),
        size: (Number(b.size) || 24) * (width / (Number(layout.width) || 440)),
    })) };
    const background = await backgroundOf(template, { fetchImpl });
    const base = await sharp(background, { density: 144 }).resize(width, height, { fit: 'fill' }).png().toBuffer();
    const overlay = Buffer.from(textSvg(scaled, lines));
    const png = await sharp(base).composite([{ input: overlay, top: 0, left: 0 }]).png().toBuffer();
    return { png, width, height, lines: (scaled.boxes || []).length };
}

module.exports = { renderMeme, textSvg, wrapText, fitLines, fallbackLayout, fontFor, FONT_FILES };
