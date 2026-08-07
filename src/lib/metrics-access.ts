/**
 * Who may open /metrics, and how that list is changed.
 *
 * Two sources, in this order:
 *
 *   1. METRICS_ALLOWED_EMAILS — a Worker variable. This is the bootstrap and
 *      the break-glass: it works before the table exists, and it still works
 *      if somebody removes themselves from the table by accident. It cannot
 *      be edited from the page, which is the point of it.
 *
 *   2. metrics_access — a table, managed from the page itself.
 *
 * Being in neon_auth."user" is deliberately NOT sufficient. That only proves
 * an account exists, and while public sign-up is open anyone can create one.
 * Access is something we grant, not something a stranger can take.
 */

import { neon } from '@neondatabase/serverless';

type Sql = ReturnType<typeof neon>;

const client = (cs: string | undefined): Sql | null => {
  if (!cs) return null;
  try { return neon(cs); } catch { return null; }
};

const norm = (e: string) => e.trim().toLowerCase();

function fromEnv(allowList: string | undefined): string[] {
  if (!allowList) return [];
  return allowList.split(/[,\s]+/).map(norm).filter(Boolean);
}

/**
 * FAILS CLOSED. If neither source yields the address, the answer is no — and
 * an unreachable database is not a reason to let somebody in.
 */
export async function hasAccess(
  email: string,
  allowList: string | undefined,
  connectionString: string | undefined,
): Promise<boolean> {
  const who = norm(email);
  if (!who) return false;

  if (fromEnv(allowList).includes(who)) return true;

  const sql = client(connectionString);
  if (!sql) return false;
  try {
    const r = await sql`SELECT 1 FROM metrics_access WHERE email = ${who} LIMIT 1`;
    return Array.isArray(r) && r.length > 0;
  } catch {
    // No table yet, or no database. Either way: not a reason to admit anyone.
    return false;
  }
}

export interface AccessRow {
  email: string;
  created_at: string;
  created_by: string | null;
  /** True when the address is pinned by the env var and cannot be revoked here. */
  fixed?: boolean;
}

export async function listAccess(
  allowList: string | undefined,
  connectionString: string | undefined,
): Promise<AccessRow[]> {
  const pinned = fromEnv(allowList).map((email) => ({
    email, created_at: '', created_by: 'configuración', fixed: true,
  }));

  const sql = client(connectionString);
  if (!sql) return pinned;
  try {
    const rows = (await sql`
      SELECT email, created_at, created_by FROM metrics_access ORDER BY created_at ASC
    `) as unknown as AccessRow[];
    // The env var wins if an address appears in both, since it cannot be revoked.
    const seen = new Set(pinned.map((p) => p.email));
    return [...pinned, ...rows.filter((r) => !seen.has(norm(r.email)))];
  } catch {
    return pinned;
  }
}

export async function grantAccess(
  email: string,
  by: string,
  connectionString: string | undefined,
): Promise<{ ok: boolean; message: string }> {
  const who = norm(email);
  if (!/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(who)) {
    return { ok: false, message: 'Ese correo no tiene un formato válido.' };
  }
  const sql = client(connectionString);
  if (!sql) return { ok: false, message: 'Sin conexión a la base de datos.' };
  try {
    await sql`
      INSERT INTO metrics_access (email, created_by) VALUES (${who}, ${by})
      ON CONFLICT (email) DO NOTHING
    `;
    return { ok: true, message: `${who} ya tiene acceso.` };
  } catch {
    return { ok: false, message: 'No se pudo conceder el acceso.' };
  }
}

export async function revokeAccess(
  email: string,
  actor: string,
  allowList: string | undefined,
  connectionString: string | undefined,
): Promise<{ ok: boolean; message: string }> {
  const who = norm(email);

  // Removing your own access locks you out of the page you are standing on.
  if (who === norm(actor)) {
    return { ok: false, message: 'No puedes quitarte el acceso a ti mismo.' };
  }
  if (fromEnv(allowList).includes(who)) {
    return { ok: false, message: 'Ese acceso está fijado en la configuración.' };
  }

  const sql = client(connectionString);
  if (!sql) return { ok: false, message: 'Sin conexión a la base de datos.' };
  try {
    const r = await sql`DELETE FROM metrics_access WHERE email = ${who} RETURNING email`;
    return Array.isArray(r) && r.length
      ? { ok: true, message: `Acceso retirado a ${who}.` }
      : { ok: false, message: 'Ese correo no estaba en la lista.' };
  } catch {
    return { ok: false, message: 'No se pudo retirar el acceso.' };
  }
}

/**
 * Sends a password-reset email.
 *
 * This is how a password gets set, including the first one: an account created
 * in the Neon console has a name and an email but no credential, so there is
 * nothing to sign in with until someone sets one. Rather than inventing a way
 * to write the hash — Better Auth owns that format, and reimplementing it
 * would break silently on their next change — this uses their own flow. The
 * person clicks the link in the mail and chooses their own password, which is
 * also the only version where the granter never sees it.
 *
 * The endpoint answers identically whether or not the address exists, so this
 * cannot be used to find out who has an account. That is their design and it
 * is the right one; the message below matches it rather than pretending to
 * know more.
 */
export async function sendPasswordReset(
  email: string,
  authUrl: string | undefined,
  redirectTo: string,
): Promise<{ ok: boolean; message: string }> {
  if (!authUrl) return { ok: false, message: 'Falta NEON_AUTH_URL.' };
  const who = norm(email);
  try {
    const res = await fetch(`${authUrl.replace(/\/$/, '')}/request-password-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://studio.orbitaleap.com' },
      body: JSON.stringify({ email: who, redirectTo }),
    });
    return res.ok
      ? { ok: true, message: `Correo enviado a ${who} para establecer su contraseña.` }
      : { ok: false, message: 'No se pudo enviar el correo.' };
  } catch {
    return { ok: false, message: 'No se pudo contactar con el servidor de acceso.' };
  }
}

/**
 * Creates the sign-in credential, then grants access.
 *
 * The account is created through the auth server rather than by writing to
 * neon_auth."user" directly: the password hash format is Better Auth's to
 * define, and reimplementing it would be a silent breakage waiting for their
 * next change. This call is made server-side from the Worker, so the password
 * never travels to the browser of the person doing the granting.
 *
 * An address that already has an account is not an error — that is the normal
 * path for someone who registered but was never granted access.
 */
export async function createUser(
  opts: { email: string; password: string; name: string; by: string },
  authUrl: string | undefined,
  connectionString: string | undefined,
): Promise<{ ok: boolean; message: string }> {
  if (!authUrl) return { ok: false, message: 'Falta NEON_AUTH_URL.' };
  if (opts.password.length < 12) {
    return { ok: false, message: 'La contraseña debe tener al menos 12 caracteres.' };
  }

  const who = norm(opts.email);
  try {
    const res = await fetch(`${authUrl.replace(/\/$/, '')}/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://studio.orbitaleap.com' },
      body: JSON.stringify({ name: opts.name || who, email: who, password: opts.password }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
      const exists = res.status === 422 || /exist/i.test(body.code ?? body.message ?? '');
      if (!exists) {
        return { ok: false, message: body.message || 'No se pudo crear la cuenta.' };
      }
      // Already registered — fall through and grant access to the existing one.
    }
  } catch {
    return { ok: false, message: 'No se pudo contactar con el servidor de acceso.' };
  }

  const granted = await grantAccess(who, opts.by, connectionString);
  return granted.ok
    ? { ok: true, message: `Cuenta lista para ${who}.` }
    : granted;
}
