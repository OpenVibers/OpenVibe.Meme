'use strict';

/**
 * OpenVibe.Media object API v2 for the generator's PNG (namespace `meme`, object kind file). A service token with
 * media.object.upload/read for that namespace is required; without OV_MEDIA_INTERNAL_URL and the Network client
 * secret the generator answers 503 meme.media_unavailable rather than handing back a picture nobody stored.
 */
const { serviceAuth } = require('openvibe-contracts');
const { createObjectsClient, mediaUrls } = require('openvibe-sdk/media');

function createGenerateMedia({ config, fetchImpl = globalThis.fetch, log = console, objects = null }) {
    const cfg = config.generate || {};
    const urls = mediaUrls();
    const enabled = Boolean(objects || (cfg.mediaUrl && config.oauth && config.oauth.clientSecret));
    let client = objects;
    if (!client && enabled) {
        const tokenClient = serviceAuth.createTokenClient({
            tokenUrl: `${config.networkInternalUrl}/oauth/token`,
            clientId: config.oauth.clientId,
            clientSecret: config.oauth.clientSecret,
            audience: 'openvibe.media',
            scope: 'media.object.upload media.object.read',
            fetchImpl,
        });
        client = createObjectsClient({ app: cfg.mediaNamespace || 'meme', baseUrl: cfg.mediaUrl, tokenClient, fetch: fetchImpl });
    }

    /** → { media_id, url } or null. */
    async function uploadPng(png, { filename = 'meme.png', metadata = null } = {}) {
        if (!enabled || !client || !png || !png.length) return null;
        try {
            const obj = await client.upload(png, { kind: 'file', visibility: 'public', mimeType: 'image/png', filename, metadata: metadata || undefined });
            return { media_id: obj.id, url: obj.public_url || obj.url || urls.absolute(`/o/${encodeURIComponent(obj.id)}`) };
        } catch (err) {
            log.warn(`[OpenVibe.Meme] Media upload failed: ${err && err.message ? err.message.slice(0, 200) : err}`);
            return null;
        }
    }

    return { enabled, uploadPng, url: (id) => (id ? urls.absolute(`/o/${encodeURIComponent(id)}`) : null) };
}

module.exports = { createGenerateMedia };
