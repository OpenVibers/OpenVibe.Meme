'use strict';

/**
 * OpenVibe.Media's object API v2 for Meme's namespace (`meme`): upload a trend picture or a rendered meme, and
 * resolve a `med_…` id to its public `/o/<id>` URL. A service token with `media.object.upload` and
 * `media.object.read` for that namespace is required; without `OV_MEDIA_INTERNAL_URL` and the Network client
 * secret the store is off and a caller keeps the source URL instead.
 */
const { serviceAuth } = require('openvibe-contracts');
const { createObjectsClient, mediaUrls } = require('openvibe-sdk/media');

function createMediaStore({ config, fetchImpl = globalThis.fetch, objects = null, log = console } = {}) {
    const urls = mediaUrls(config.media && config.media.publicUrl ? config.media.publicUrl : undefined);
    const enabled = Boolean(objects || (config.media && config.media.url && config.oauth && config.oauth.clientSecret));
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
        client = createObjectsClient({ app: config.media.namespace, baseUrl: config.media.url, tokenClient, fetch: fetchImpl });
    }

    /** { media_id, url } or null when Media is not configured or the upload failed. */
    async function upload(bytes, { mimeType = 'application/octet-stream', filename = null, visibility = 'public', metadata = null } = {}) {
        if (!enabled || !client || !bytes || !bytes.length) return null;
        try {
            const obj = await client.upload(bytes, { kind: 'file', visibility, mimeType, filename: filename || undefined, metadata: metadata || undefined });
            return { media_id: obj.id, url: obj.public_url || obj.url || urls.absolute(`/o/${encodeURIComponent(obj.id)}`) };
        } catch (err) {
            log.warn(`[OpenVibe.Meme] Media upload failed: ${err && err.message ? err.message.slice(0, 200) : err}`);
            return null;
        }
    }

    return { enabled, upload, url: (id) => (id ? urls.absolute(`/o/${encodeURIComponent(id)}`) : null), objects: client };
}

module.exports = { createMediaStore };
