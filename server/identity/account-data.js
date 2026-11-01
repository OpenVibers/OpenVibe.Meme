'use strict';

/**
 * Account export and deletion → Meme (ADR-033; openvibe-sdk/account-data). The rows a person owns are their weekly
 * votes, their saved captions and the reports they filed. An entry is the network's, not a person's, so it is not
 * exported or erased with an account; a caption, report, analysis or research job is deleted
 * outright. A saved deep-dive entry is the network's published record and stays.
 *
 * The database stores bare usr_ ids in the subject columns. A vote is one row per week; a caption is text lines on a
 * template; a report is a takedown/correction request and is never a secret.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const TABLES = [
    { table: 'meme_analyses', subject: 'subject', value: (usr) => usr, file: 'analyses.json', erase: 'delete' },
    { table: 'meme_research', subject: 'subject', value: (usr) => usr, file: 'research.json', erase: 'delete' },
    { table: 'meme_person_usage', subject: 'subject', value: (usr) => usr, file: 'ai-usage.json', erase: 'delete' },
    { table: 'meme_votes', subject: 'subject', value: (usr) => usr, file: 'votes.json', erase: 'delete' },
    { table: 'meme_captions', subject: 'subject', value: (usr) => usr, file: 'captions.json', erase: 'delete' },
    { table: 'meme_reports', subject: 'subject', value: (usr) => usr, file: 'reports.json', erase: 'delete' },
];

function create({ db, log = console } = {}) {
    return createAccountData({
        db,
        service: 'meme',
        tables: TABLES,
        note: "Entries are the network's meme record; only your votes, captions, reports, analyses and research jobs are here.",
        log,
    });
}

module.exports = { create, TABLES, TOPICS };
