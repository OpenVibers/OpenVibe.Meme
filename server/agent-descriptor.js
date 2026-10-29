'use strict';
// What openvibe.meme tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this site really serves: the JSON API under /api/v1, the developers page that
// documents it, and the app's own per-address limits. No OpenAPI document or MCP endpoint is published.
module.exports = {
    id: 'meme',
    name: 'OpenVibe.Meme',
    purpose: 'The open meme database, rebuilt with AI: every entry cites the moment it happened, follows its later uses, and people vote for meme of the week.',
    home: 'https://openvibe.meme',
    site: 'openvibe.meme',
    api: '/api/v1',
    docs: '/developers',
    policy: {
        auth: ['none', 'Network OIDC'],
        rateLimit: '300 page requests a minute per address; 240 API requests a minute; sign-in limited to 60 attempts per 15 minutes',
    },
};
