'use strict';
/**
 * An in-process stand-in for OpenVibe.AI. It answers POST /api/v1/generate with one run, exactly the shape the
 * real service returns: { run: { id, status, output: { text }, provenance, usage } }.
 *
 * The answer is a function of the prompt, so a test can say "this candidate scores 0.9" or "this one scores 0.2",
 * and it can read the prompt back to check that the cited material really reached the model. Every call is recorded.
 */
const http = require('http');

const DEFAULT_ANSWER = JSON.stringify({
    score: 0.9,
    reason: 'People play off this on purpose; it has a shared meaning in the cited uses.',
    title: 'The robot is offline',
    summary: 'A running joke about the robot being offline again.',
    origin: 'It starts in the first cited chat line.',
    spread: 'People say it whenever the robot drops off, as a call back to the stream.',
    examples: ['the robot is offline again', 'still the robot is offline, huh'],
});

function listen(handler) {
    return new Promise((resolve) => {
        const sockets = new Set();
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
                Promise.resolve(handler(req, raw, json)).catch((err) => json(500, { error: String(err && err.message) }));
            });
        });
        server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
        server.listen(0, '127.0.0.1', () => resolve({
            server,
            url: `http://127.0.0.1:${server.address().port}`,
            close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
        }));
    });
}

async function startAi({ answer } = {}) {
    const state = { calls: [], answer: answer || (() => DEFAULT_ANSWER), runs: 0 };

    const srv = await listen(async (req, raw, json) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/api/v1/generate' && req.method === 'POST') {
            const body = JSON.parse(raw || '{}');
            state.calls.push({ prompt: body.prompt, system: body.system, target: body.target });
            state.runs += 1;
            const text = await state.answer(body.prompt, body);
            return json(200, {
                run: {
                    id: `run_${state.runs}`,
                    status: 'succeeded',
                    output: { text: String(text) },
                    provenance: { provider: 'mock', model: 'mock-model' },
                    usage: { tokens: { input: 100, output: 50 }, cost_usd: 0.001 },
                },
            });
        }
        if (url.pathname.startsWith('/api/v1/runs/')) {
            const id = url.pathname.split('/').pop();
            return json(200, { run: { id, status: 'succeeded', output: { text: DEFAULT_ANSWER } } });
        }
        return json(404, { error: 'not found' });
    });

    return {
        url: srv.url,
        state,
        calls: state.calls,
        setAnswer(fn) { state.answer = fn; },
        close: srv.close,
    };
}

module.exports = { startAi, DEFAULT_ANSWER };
