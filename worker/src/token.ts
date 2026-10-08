// Device tokens look like "v1.<deviceId>.<base64url HMAC-SHA256(deviceId)>".
const PREFIX = "v1";
const encoder = new TextEncoder();

function b64url(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function signDeviceToken(deviceId: string, secret: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(deviceId));
  return `${PREFIX}.${deviceId}.${b64url(sig)}`;
}

/** Returns the device id if the token is authentic, otherwise null. */
export async function verifyDeviceToken(token: string, secret: string): Promise<string | null> {
  const [prefix, deviceId, sig, ...rest] = token.split(".");
  if (prefix !== PREFIX || !deviceId || !sig || rest.length) return null;
  if (!/^[0-9a-f-]{36}$/.test(deviceId)) return null;
  const sigBytes = fromB64url(sig);
  if (!sigBytes) return null;
  const ok = await crypto.subtle.verify("HMAC", await key(secret), sigBytes, encoder.encode(deviceId));
  return ok ? deviceId : null;
}

/** Constant-time string comparison for shared secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) return false;
  return crypto.subtle.timingSafeEqual(ab, bb);
}
