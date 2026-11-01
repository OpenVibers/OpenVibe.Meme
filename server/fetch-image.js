'use strict';

/**
 * Fetch one public picture with the guards a server-side fetch needs: http(s) only, no credentials in the URL,
 * no loopback/private/link-local host, manual redirects (each hop checked), a byte cap and a timeout. This is
 * deliberately small: Meme reads a picture to hash or analyse it, and never crawls a site.
 *
 * On the real network (no fetchImpl, or the global fetch) every hop goes through openvibe-shared/egress: the name is
 * resolved by its safe lookup, which refuses unless every address is public, and the socket connects to the address
 * that was checked, so a name that points inside (or switches to inside between two lookups) is refused. A fetchImpl
 * the tests inject is used as given.
 */
const http = require('http');
const https = require('https');
const egress = require('openvibe-shared/egress');
const PRIVATE_V4 = [
    [/^10\./, '10/8'], [/^127\./, 'loopback'], [/^169\.254\./, 'link-local'], [/^0\./, 'this network'],
    [/^172\.(1[6-9]|2\d|3[01])\./, '172.16/12'], [/^192\.168\./, '192.168/16'], [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, '100.64/10'],
];
const HOST_RE = /^[a-z0-9.-]+$/;

function publicHttpUrl(raw) {
    let u;
    try { u = new URL(String(raw)); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    if (u.port && u.port !== '80' && u.port !== '443') return null;
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null;
    if (host.includes(':') || host.startsWith('[')) return null; // literal IPv6: refuse rather than parse every form
    if (!HOST_RE.test(host)) return null;
    if (/^\d+(\.\d+){3}$/.test(host)) {
        const parts = host.split('.').map(Number);
        if (parts.some((n) => n < 0 || n > 255)) return null;
        if (PRIVATE_V4.some(([re]) => re.test(host))) return null;
    }
    return u.toString();
}

/**
 * One GET on the real network through the egress guard, shaped like the bit of fetch's Response this file reads
 * (status, ok, headers.get, arrayBuffer). The body is cut off past maxBytes.
 */
function guardedFetch(url, { headers = {}, signal, maxBytes = 8 * 1024 * 1024 } = {}) {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const req = lib.request({
            hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'GET',
            servername: u.hostname, lookup: egress.safeLookup, headers, signal,
        }, (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (c) => { size += c.length; if (size > maxBytes + 1) { req.destroy(); return; } chunks.push(c); });
            res.on('end', () => {
                const body = Buffer.concat(chunks);
                resolve({
                    status: res.statusCode || 0,
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    headers: { get: (name) => { const v = res.headers[String(name).toLowerCase()]; return v == null ? null : String(v); } },
                    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
                });
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
    });
}

async function fetchImage(rawUrl, { fetchImpl = null, maxBytes = 8 * 1024 * 1024, timeoutMs = 8000, redirects = 3 } = {}) {
    // The real network goes through the egress guard; a test's own fetch is used as given.
    const real = !fetchImpl || fetchImpl === globalThis.fetch;
    const get = real ? (u, opts) => guardedFetch(u, { ...opts, maxBytes }) : fetchImpl;
    let url = publicHttpUrl(rawUrl);
    if (!url) return { error: 'url_not_public' };
    for (let hop = 0; hop <= redirects; hop++) {
        let res;
        try {
            res = await get(url, {
                redirect: 'manual',
                headers: { Accept: 'image/*', 'User-Agent': 'OpenVibe.Meme/0.2 (+https://openvibe.meme)' },
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (err) {
            return { error: 'unreachable', detail: err && err.message ? err.message.slice(0, 200) : 'fetch failed' };
        }
        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location');
            if (!loc) return { error: 'redirect_without_location' };
            url = publicHttpUrl(new URL(loc, url).toString());
            if (!url) return { error: 'url_not_public' };
            continue;
        }
        if (res.status === 404 || res.status === 410) return { error: 'gone', status: res.status };
        if (!res.ok) return { error: 'http_error', status: res.status };
        const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!type.startsWith('image/')) return { error: 'not_an_image', type };
        const length = Number(res.headers.get('content-length') || 0);
        if (length > maxBytes) return { error: 'too_large', bytes: length };
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > maxBytes) return { error: 'too_large', bytes: buf.length };
        return { bytes: buf, mime: type, url, status: res.status };
    }
    return { error: 'too_many_redirects' };
}

module.exports = { fetchImage, publicHttpUrl, guardedFetch };
