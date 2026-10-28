'use strict';

/**
 * Who is staff at OpenVibe.Meme: the Network role claim on the person's session (server/auth/sso.js puts `role`
 * on req.viewer, and http/principal.js puts it on req.principal). The roles are OpenVibe.Network's
 * (manifests/policy/staff-roles.json): global_mod, admin and owner are staff+; user and streamer are not.
 *
 * contracts.staff.atLeast is the one place the ranking lives, so the API and the pages cannot drift apart.
 */
const { staff } = require('openvibe-contracts');

const STAFF_MIN = 'global_mod';
const STAFF_ROLES = ['global_mod', 'admin', 'owner'];

/** Is this viewer/principal a member of staff? Anonymous, an app token and an unlisted role are not. */
function isStaff(who) {
    if (!who || typeof who !== 'object' || who.kind !== 'user') return false;
    if (typeof who.role !== 'string' || !who.role) return false;
    try { return staff.atLeast(who.role, STAFF_MIN); } catch { return false; }
}

module.exports = { isStaff, STAFF_MIN, STAFF_ROLES };
