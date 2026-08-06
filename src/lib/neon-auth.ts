/**
 * Neon Auth (Better Auth) session verification for /metrics.
 *
 * Replaces the shared password. What that buys: real accounts, so access can
 * be granted and revoked per person, sign-in by Google with no credential to
 * leak, and a record in neon_auth."user" of who exists — including `role` and
 * `banned`, which a shared string can never express.
 *
 * ─── Why a token and not the auth cookie ─────────────────────────────────
 *
 * Better Auth sets its session cookie on its own host, which for a Neon-hosted
 * project is *.neon.tech. A cookie scoped there is never sent to
 * studio.orbitaleap.com, so this Worker cannot read the session directly no
 * matter how it asks. The supported route is the JWT: the browser, which does
 * hold the auth cookie, asks the auth server for a token and hands that to us.
 *
 * We then verify the token ourselves rather than calling /get-session on every
 * request — one network hop per page load to a third party is a dependency on
 * their uptime for a page that otherwise only needs our database.
 *
 * ─── Ed25519, not RS256 ──────────────────────────────────────────────────
 *
 * Neon Auth signs with EdDSA over Ed25519 (confirmed from the live JWKS), so
 * the verify call differs from the RSA shape used for Cloudflare Access. The
 * structure is otherwise the same, and so is the rule: FAIL CLOSED. Unset
 * configuration, a missing token, a bad signature, a wrong issuer or an
 * expired token all mean no.
 *
 * ─── A caveat worth carrying ─────────────────────────────────────────────
 *
 * The auth server currently answers CORS by echoing whatever Origin it is
 * given, with Allow-Credentials: true — evil.example.com included. If the
 * session cookie is SameSite=None, any site could read a token out of /token
 * while someone is signed in. That is a question for Neon, not something this
 * file can fix; what it can do is keep the blast radius small, which is why
 * the token is checked for issuer and expiry and why sessions here are short.
 */

interface Jwk {
  kid: string;
  kty: string;
  crv?: string;
  x?: string;
  alg?: string;
}

export interface Identity {
  email: string;
  name: string | null;
  sub: string;
}

let cache: { url: string; keys: Map<string, CryptoKey>; at: number } | null = null;
const CACHE_MS = 60 * 60 * 1000;

const b64urlToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function keys(authUrl: string): Promise<Map<string, CryptoKey>> {
  const url = `${authUrl.replace(/\/$/, '')}/.well-known/jwks.json`;
  if (cache && cache.url === url && Date.now() - cache.at < CACHE_MS) return cache.keys;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  const { keys: jwks } = (await res.json()) as { keys: Jwk[] };

  const map = new Map<string, CryptoKey>();
  for (const jwk of jwks) {
    // Only Ed25519. An unexpected algorithm is not something to accommodate:
    // accepting whatever the server advertises is how a downgrade slips in.
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x) continue;
    map.set(
      jwk.kid,
      await crypto.subtle.importKey(
        'jwk',
        { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
        { name: 'Ed25519' },
        false,
        ['verify'],
      ),
    );
  }

  cache = { url, keys: map, at: Date.now() };
  return map;
}

/**
 * Returns who the token says this is, or null to refuse. Never throws — a
 * failure to verify is a refusal, not a 500.
 */
export async function verifyToken(
  token: string | undefined,
  authUrl: string | undefined,
): Promise<Identity | null> {
  try {
    if (!token || !authUrl) return null;

    const [h, p, s] = token.split('.');
    if (!h || !p || !s) return null;

    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    if (header.alg !== 'EdDSA') return null;

    const key = (await keys(authUrl)).get(header.kid);
    if (!key) return null;

    const ok = await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      b64urlToBytes(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!ok) return null;

    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));

    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp === 'number' && claims.exp < now) return null;
    if (typeof claims.nbf === 'number' && claims.nbf > now) return null;

    // Ties the token to OUR auth server. Without this a validly signed token
    // from any other Neon Auth project would be accepted, since the signature
    // check alone only proves "some Ed25519 key signed this".
    const base = authUrl.replace(/\/$/, '');
    if (typeof claims.iss === 'string' && !claims.iss.startsWith(base.split('/neondb')[0])) {
      return null;
    }

    const email = typeof claims.email === 'string' ? claims.email : null;
    if (!email) return null;

    return { email, name: typeof claims.name === 'string' ? claims.name : null, sub: String(claims.sub ?? '') };
  } catch {
    return null;
  }
}

export const TOKEN_COOKIE = 'ol_metrics_jwt';

/**
 * Read the token the browser parked for us.
 *
 * Deliberately NOT HttpOnly: the value is written by client script after it
 * fetches /token, and a cookie script cannot write is a cookie script cannot
 * set. That is the cost of the auth server living on another domain. It is
 * mitigated by the token being short-lived and by this page carrying no
 * user-supplied HTML for an XSS to ride in on.
 */
export function readToken(request: Request): string | undefined {
  return (request.headers.get('Cookie') ?? '')
    .match(new RegExp(`(?:^|;\\s*)${TOKEN_COOKIE}=([^;]+)`))?.[1];
}
