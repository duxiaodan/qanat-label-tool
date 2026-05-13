// crypto.js — PBKDF2-HMAC-SHA256 key derivation + AES-256-GCM blob encryption.
//
// Byte-compatible with scripts/jason_corona/build_label_tool_site.py:
//   - derive_key  == deriveKey  (PBKDF2-HMAC-SHA256, 32-byte key, UTF-8 passcode)
//   - encrypt_blob == encryptBlob (nonce(12) || ciphertext+tag(16))
//
// Pure ES module: uses only WebCrypto on the standard `crypto` global
// (`globalThis.crypto.subtle`) — present in browsers and in Node >= 18.

const enc = new TextEncoder();

/** UTF-8 sentinel that build_site stores (encrypted) in crypto.json's "check". */
const SENTINEL_BYTES = enc.encode('qanat-label-tool-ok');

function _subtle() {
  return globalThis.crypto.subtle;
}

async function _pbkdf2KeyMaterial(passcode) {
  return _subtle().importKey('raw', enc.encode(passcode), { name: 'PBKDF2' }, false, [
    'deriveBits',
    'deriveKey',
  ]);
}

/**
 * PBKDF2-HMAC-SHA256 -> nBytes raw bytes, as a lowercase hex string.
 * @param {string} passcode
 * @param {Uint8Array|ArrayBuffer} saltBytes
 * @param {number} iterations
 * @param {number} [nBytes=32]
 * @returns {Promise<string>}
 */
export async function deriveBitsHex(passcode, saltBytes, iterations, nBytes = 32) {
  const km = await _pbkdf2KeyMaterial(passcode);
  const bits = await _subtle().deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
    km,
    nBytes * 8,
  );
  const u8 = new Uint8Array(bits);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
  return s;
}

/**
 * Derive an AES-GCM 256 CryptoKey via PBKDF2-HMAC-SHA256.
 * @param {string} passcode
 * @param {Uint8Array|ArrayBuffer} saltBytes
 * @param {number} [iterations=200000]
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKey(passcode, saltBytes, iterations = 200000) {
  const km = await _pbkdf2KeyMaterial(passcode);
  return _subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
    km,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * AES-256-GCM encrypt -> Uint8Array nonce(12) || ciphertext+tag(16).
 * @param {CryptoKey} key
 * @param {Uint8Array|ArrayBuffer} plaintextBytes
 * @returns {Promise<Uint8Array>}
 */
export async function encryptBlob(key, plaintextBytes) {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await _subtle().encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintextBytes);
  const ctU8 = new Uint8Array(ct);
  const out = new Uint8Array(nonce.length + ctU8.length);
  out.set(nonce, 0);
  out.set(ctU8, nonce.length);
  return out;
}

/**
 * AES-256-GCM decrypt of a nonce(12)||ct+tag(16) blob. Rejects on tamper/wrong key.
 * @param {CryptoKey} key
 * @param {Uint8Array} blobBytes
 * @returns {Promise<Uint8Array>}
 */
export async function decryptBlob(key, blobBytes) {
  const blob = blobBytes instanceof Uint8Array ? blobBytes : new Uint8Array(blobBytes);
  if (blob.length < 12 + 16) throw new Error('blob too short');
  const nonce = blob.slice(0, 12);
  const ct = blob.slice(12);
  const pt = await _subtle().decrypt({ name: 'AES-GCM', iv: nonce }, key, ct);
  return new Uint8Array(pt);
}

function _b64ToBytes(b64) {
  // Works in both browsers (atob) and Node (Buffer).
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function _bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Verify a passcode against a crypto.json descriptor by decrypting its `check`
 * blob and comparing to the SENTINEL bytes.
 * @param {{salt:string, iterations:number, check:string}} cryptoJson
 * @param {string} passcode
 * @returns {Promise<boolean>}
 */
export async function verifyPasscode(cryptoJson, passcode) {
  try {
    const salt = _b64ToBytes(cryptoJson.salt);
    const check = _b64ToBytes(cryptoJson.check);
    const key = await deriveKey(passcode, salt, cryptoJson.iterations);
    const pt = await decryptBlob(key, check);
    return _bytesEqual(pt, SENTINEL_BYTES);
  } catch (e) {
    return false;
  }
}
