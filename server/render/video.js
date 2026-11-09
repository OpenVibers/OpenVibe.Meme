'use strict';

const { spawn } = require('child_process');

const FORMATS = Object.freeze({
    gif: ['-f', 'image2pipe', '-framerate', '12', '-loop', '1', '-i', 'pipe:0', '-t', '2', '-an', '-f', 'gif', 'pipe:1'],
    mp4: ['-f', 'image2pipe', '-framerate', '24', '-loop', '1', '-i', 'pipe:0', '-t', '3', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'],
});

function renderStillVideo(png, format, { timeoutMs = 15000, maxBytes = 24 * 1024 * 1024, executable = process.env.FFMPEG_PATH || 'ffmpeg' } = {}) {
    const args = FORMATS[format];
    if (!args) return Promise.reject(new TypeError('format must be gif or mp4'));
    return new Promise((resolve, reject) => {
        let child;
        try { child = spawn(executable, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['pipe', 'pipe', 'ignore'] }); }
        catch (error) { reject(error); return; }
        const chunks = [];
        let size = 0, settled = false;
        const finish = (err, result) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(result); };
        const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('render timed out')); }, timeoutMs);
        child.stdout.on('data', (buf) => {
            size += buf.length;
            if (size > maxBytes) { child.kill('SIGKILL'); finish(new Error('render output too large')); return; }
            chunks.push(buf);
        });
        child.on('error', (error) => finish(error));
        child.on('close', (code) => code === 0 && size ? finish(null, Buffer.concat(chunks)) : finish(new Error('ffmpeg could not encode this meme')));
        child.stdin.on('error', () => {});
        child.stdin.end(png);
    });
}

module.exports = { renderStillVideo, FORMATS };
