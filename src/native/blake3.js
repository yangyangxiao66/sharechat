// Minimal BLAKE3 (default hash mode, 32-byte output) for inputs up to one
// 1024-byte chunk — enough for hashing a working-directory path the way Grok
// Build names long session directories. Node's crypto has no BLAKE3.
const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const PERM = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];
const CHUNK_START = 1, CHUNK_END = 2, ROOT = 8;

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

function g(s, a, b, c, d, x, y) {
  s[a] = (s[a] + s[b] + x) >>> 0; s[d] = rotr(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0;     s[b] = rotr(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b] + y) >>> 0; s[d] = rotr(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0;     s[b] = rotr(s[b] ^ s[c], 7);
}

function compress(cv, m, blockLen, flags) {
  const s = [...cv, IV[0], IV[1], IV[2], IV[3], 0, 0, blockLen, flags];
  let w = m.slice();
  for (let r = 0; r < 7; r++) {
    g(s, 0, 4, 8, 12, w[0], w[1]);  g(s, 1, 5, 9, 13, w[2], w[3]);
    g(s, 2, 6, 10, 14, w[4], w[5]); g(s, 3, 7, 11, 15, w[6], w[7]);
    g(s, 0, 5, 10, 15, w[8], w[9]); g(s, 1, 6, 11, 12, w[10], w[11]);
    g(s, 2, 7, 8, 13, w[12], w[13]); g(s, 3, 4, 9, 14, w[14], w[15]);
    w = PERM.map((i) => w[i]);
  }
  return s.slice(0, 8).map((v, i) => (v ^ s[i + 8]) >>> 0);
}

export function blake3Hex(input) {
  const bytes = Buffer.from(input, 'utf8');
  if (bytes.length > 1024) throw new Error('blake3Hex: input longer than one chunk');
  const blocks = Math.max(1, Math.ceil(bytes.length / 64));
  let cv = IV;
  for (let b = 0; b < blocks; b++) {
    const block = Buffer.alloc(64);
    bytes.copy(block, 0, b * 64, Math.min(bytes.length, (b + 1) * 64));
    const words = Array.from({ length: 16 }, (_, i) => block.readUInt32LE(i * 4));
    const len = Math.min(64, bytes.length - b * 64);
    let flags = 0;
    if (b === 0) flags |= CHUNK_START;
    if (b === blocks - 1) flags |= CHUNK_END | ROOT;
    cv = compress(cv, words, Math.max(0, len), flags);
  }
  const out = Buffer.alloc(32);
  cv.forEach((v, i) => out.writeUInt32LE(v, i * 4));
  return out.toString('hex');
}
