/**
 * Cloudflare Access, verified rather than assumed.
 *
 * Access puts a signed JWT in `Cf-Access-Jwt-Assertion` on every request it
 * lets through. The tempting check is "is that header present?" — and it is
 * wrong. Cloudflare only overwrites the header on routes an Access
 * application actually covers; on any route it does not cover, a header the
 * client invented is passed straight through. So a presence check protects
 * the dashboard only while the Access policy is correctly configured, and
 * silently protects nothing the moment it is not — which is exactly the
 * moment you need it to hold.
 *
 * This verifies the signature against the team's published keys and checks
 * the audience tag, so a forged header fails whatever is configured upstream.
 *
 * FAIL CLOSED. If the team domain or audience tag is unset, or the token is
 * missing, expired, or does not verify, nobody gets in — including us. That
 * is deliberate: this page lists names, emails and phone numbers, and the
 * failure mode of a misconfiguration must be a locked door rather than an
 * open one.
 */

interface Jwk {
  kid: string;
  kty: string;
  alg: string;
  n: string;
  e: string;
}

export interface AccessIdentity {
  email: string;
}

/** Per-isolate cache. The certs rotate slowly; refetching per request is waste. */
let cachedKeys: { url: string; keys: CryptoKey[]; kids: string[]; at: number } | null = null;
const CACHE_MS = 60 * 60 * 1000;

// Backed by a plain ArrayBuffer on purpose: a bare `new Uint8Array(n)` is
// typed over ArrayBufferLike, which WebCrypto's BufferSource will not accept.
const b64urlToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function publicKeys(teamDomain: string): Promise<{ keys: CryptoKey[]; kids: string[] }> {
  const url = `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`;
  if (cachedKeys && cachedKeys.url === url && Date.now() - cachedKeys.at < CACHE_MS) {
    return { keys: cachedKeys.keys, kids: cachedKeys.kids };
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Access certs unavailable (${res.status})`);
  const { keys } = (await res.json()) as { keys: Jwk[] };

  const imported = await Promise.all(
    keys.map((jwk) =>
      crypto.subtle.importKey(
        'jwk',
        { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      ),
    ),
  );

  cachedKeys = { url, keys: imported, kids: keys.map((k) => k.kid), at: Date.now() };
  return { keys: imported, kids: cachedKeys.kids };
}

/**
 * Returns the identity Access vouched for, or null if the request should be
 * refused. Never throws — a failure to verify is a refusal, not a 500.
 */
export async function verifyAccess(
  request: Request,
  teamDomain: string | undefined,
  audience: string | undefined,
): Promise<AccessIdentity | null> {
  try {
    if (!teamDomain || !audience) return null;

    const token =
      request.headers.get('Cf-Access-Jwt-Assertion') ||
      // Access also sets a cookie; the header is the documented path, this is
      // the fallback for a direct browser navigation that lost it.
      (request.headers.get('Cookie') ?? '').match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
    if (!token) return null;

    const [headerB64, payloadB64, sigB64] = token.split('.');
    if (!headerB64 || !payloadB64 || !sigB64) return null;

    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(headerB64)));
    if (header.alg !== 'RS256') return null;

    const { keys, kids } = await publicKeys(teamDomain);
    const idx = kids.indexOf(header.kid);
    if (idx === -1) return null;

    const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      keys[idx],
      b64urlToBytes(sigB64),
      signed,
    );
    if (!ok) return null;

    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)));

    // The audience tag is what ties this token to THIS application. Without
    // it, a valid token for any other app on the same team would be accepted.
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(audience)) return null;

    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp === 'number' && claims.exp < now) return null;
    if (typeof claims.nbf === 'number' && claims.nbf > now) return null;

    return { email: typeof claims.email === 'string' ? claims.email : 'desconocido' };
  } catch {
    return null;
  }
}
