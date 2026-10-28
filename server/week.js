'use strict';

/**
 * Meme of the week: ISO-8601 weeks in UTC, `YYYY-Www`. Monday 00:00 UTC is the start and the next Monday 00:00
 * UTC is the end, so a vote never straddles a week at midnight in one zone and not another. `weekBounds` answers
 * the instants the database compares against; a week label with the wrong number of days or W00/W54 is refused.
 */
const WEEK_RE = /^(\d{4})-W(0[1-9]|[1-4][0-9]|5[0-3])$/;

function utcDay(d) {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** The Monday of the ISO week containing `date` (00:00:00.000 UTC). */
function mondayOf(date) {
    const d = utcDay(date instanceof Date ? date : new Date(date));
    const day = d.getUTCDay() || 7;                 // Sunday 0 → 7
    d.setUTCDate(d.getUTCDate() - (day - 1));
    return d;
}

/** The ISO week label of an instant. */
function isoWeek(date = new Date()) {
    const d = utcDay(date instanceof Date ? date : new Date(date));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);         // the Thursday decides the week's year
    const isoYear = d.getUTCFullYear();
    const yearStart = new Date(Date.UTC(isoYear, 0, 1));
    const week = Math.ceil((((d - yearStart) / 86_400_000) + 1) / 7);
    return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** { start, end } as ISO instants for a label; null when it is not a real ISO week. */
function weekBounds(week) {
    const m = WEEK_RE.exec(String(week || ''));
    if (!m) return null;
    const year = Number(m[1]);
    const number = Number(m[2]);
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const start = mondayOf(jan4);
    start.setUTCDate(start.getUTCDate() + (number - 1) * 7);
    // A label in week 53 of a year that has 52 weeks is not a real week.
    const check = isoWeek(start);
    if (check !== `${m[1]}-W${m[2]}`) return null;
    const end = new Date(start.getTime() + 7 * 86_400_000);
    return { start: start.toISOString(), end: end.toISOString(), startDate: start, endDate: end };
}

/** The current week's label and bounds. */
function currentWeek(now = Date.now()) {
    const week = isoWeek(new Date(now));
    return { week, ...weekBounds(week) };
}

module.exports = { WEEK_RE, isoWeek, weekBounds, currentWeek, mondayOf };
