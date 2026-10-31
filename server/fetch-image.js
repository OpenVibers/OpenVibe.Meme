'use strict';

/**
 * Fetch one public picture with the guards a server-side fetch needs: http(s) only, no credentials in the URL,
 * no loopback/private/link-local host, manual redirects (each hop checked), a byte cap and a timeout. This is
 * deliberately small: Meme reads a picture to hash or analyse it, and never crawls a site.
 */
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

async function fetchImage(rawUrl, { fetchImpl = globalThis.fetch, maxBytes = 8 * 1024 * 1024, timeoutMs = 8000, redirects = 3 } = {}) {
    let url = publicHttpUrl(rawUrl);
    if (!url) return { error: 'url_not_public' };
    for (let hop = 0; hop <= redirects; hop++) {
        let res;
        try {
            res = await fetchImpl(url, {
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

module.exports = { fetchImage, publicHttpUrl };
