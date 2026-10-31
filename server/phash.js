'use strict';

/**
 * A perceptual hash for "is this the same picture again?" (M3's new-template detection).
 *
 * dHash: shrink to 9×8 grayscale and record whether each pixel is darker than its right neighbour. Two pictures
 * of the same template survive re-encoding, a caption change and a small crop; a different picture does not.
 * sharp does the decoding (it is already the image library OpenVibe.Vision uses); no ImageMagick binary.
 */
const sharp = require('sharp');

const PHASH_RE = /^[0-9a-f]{16}$/;

/** image bytes → a 16-hex-character dHash, or null when the bytes are not a decodable image. */
async function dHash(bytes, { sharpImpl = sharp } = {}) {
    if (!bytes || !bytes.length) return null;
    try {
        const { data } = await sharpImpl(bytes, { failOn: 'none' })
            .rotate()
            .resize(9, 8, { fit: 'fill' })
            .grayscale()
            .raw()
            .toBuffer({ resolveWithObject: true });
        let bits = '';
        for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
                bits += data[y * 9 + x] < data[y * 9 + x + 1] ? '1' : '0';
            }
        }
        return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
    } catch {
        return null;
    }
}

/** Hamming distance between two dHashes (0 = the same picture), or 64 when either is not a hash. */
function hamming(a, b) {
    if (!PHASH_RE.test(String(a || '')) || !PHASH_RE.test(String(b || ''))) return 64;
    let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
    let count = 0;
    while (x) { count += Number(x & 1n); x >>= 1n; }
    return count;
}

module.exports = { dHash, hamming, PHASH_RE };
