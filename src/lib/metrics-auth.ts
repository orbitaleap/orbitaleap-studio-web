/**
 * Password gate for /metrics.
 *
 * This replaces Cloudflare Access. Access is the stronger mechanism — it never
 * puts a shared secret in anyone's hands, and it can revoke one person without
 * touching the rest — but it has to be configured before it protects anything,
 * and an application that was drafted rather than saved protects nothing at
 * all. A gate that is actually switched on beats a better one that is not.
 *
 * What that trades away is worth writing down: one password, shared, with no
 * per-person revocation and no record of who looked. If more than one person
 * ever needs this page, move to real identity rather than sharing the string.
 *
 * FAILS CLOSED. With METRICS_PASSWORD unset nobody gets in, including us. The
 * page lists names, emails and phone numbers, so a missing configuration has
 * to be a locked door rather than an open one.
 */

const COOKIE = 'ol_metrics';
const TTL_SECONDS = 7 * 24 * 60 * 60;

/** Attempts allowed per address, and over what window. */
const MAX_ATTEMPTS = 8;
const WINDOW_SECONDS = 15 * 60;

const enc = new TextEncoder();

const b64url = (b: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Compares without leaking where the mismatch was.
 *
 * A plain `===` on a secret returns as soon as two bytes differ, and the time
 * that takes is measurable over enough requests. Not a realistic threat for
 * one page behind a rate limiter, but the correct version is three lines.
 */
function equals(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  // Compare a fixed length so the loop count does not reveal the real one.
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function sign(payload: string, key: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return b64url(await crypto.subtle.sign('HMAC', k, enc.encode(payload)));
}

/**
 * The session cookie is `<expiry>.<hmac>` — no server-side store, because a
 * Worker has nowhere to keep one and the database should not be consulted to
 * render a page the database also feeds.
 *
 * The HMAC key is the password itself. That means changing the password
 * invalidates every existing session, which is the behaviour you want from a
 * password change and costs nothing to get for free.
 */
export async function createSession(password: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  return `${exp}.${await sign(`ol-metrics:${exp}`, password)}`;
}

export async function verifySession(
  request: Request,
  password: string | undefined,
): Promise<boolean> {
  if (!password) return false;
  try {
    const raw = (request.headers.get('Cookie') ?? '')
      .match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`))?.[1];
    if (!raw) return false;

    const [exp, mac] = raw.split('.');
    if (!exp || !mac) return false;
    if (Number(exp) < Math.floor(Date.now() / 1000)) return false;

    return equals(mac, await sign(`ol-metrics:${exp}`, password));
  } catch {
    return false;
  }
}

export function sessionCookie(value: string): string {
  // HttpOnly so script cannot read it, Secure so it never crosses plain HTTP,
  // SameSite=Strict because this page is never legitimately reached from
  // another site and that closes CSRF on the delete action too.
  return `${COOKIE}=${value}; Path=/metrics; Max-Age=${TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

export const clearCookie = `${COOKIE}=; Path=/metrics; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

/**
 * Attempt limiting, on the same Cache API the contact endpoint uses — no
 * binding, no namespace, nothing to provision.
 *
 * The trade is the same one documented there: the cache is per data centre, so
 * this slows down the ordinary case rather than defeating a distributed
 * attacker. Combined with a long random password that is the right balance;
 * combined with a short one it is not, which is the argument for a long one.
 *
 * The address is hashed before it becomes a key. It is never stored anywhere
 * else, and nothing about it reaches the database.
 */
export async function underAttemptLimit(request: Request): Promise<boolean> {
  try {
    const cache = (caches as any).default;
    if (!cache) return true;

    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const digest = await crypto.subtle.digest('SHA-256', enc.encode(ip));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const key = new Request(`https://metrics-login.orbitaleap.internal/${hash}`);

    const hit = await cache.match(key);
    const count = hit ? Number(await hit.text()) || 0 : 0;
    if (count >= MAX_ATTEMPTS) return false;

    await cache.put(
      key,
      new Response(String(count + 1), {
        headers: { 'Cache-Control': `max-age=${WINDOW_SECONDS}` },
      }),
    );
    return true;
  } catch {
    // Never let the limiter itself lock out a legitimate login.
    return true;
  }
}

export function checkPassword(supplied: string, actual: string | undefined): boolean {
  if (!actual) return false;      // unset config is a locked door
  if (!supplied) return false;
  return equals(supplied, actual);
}
