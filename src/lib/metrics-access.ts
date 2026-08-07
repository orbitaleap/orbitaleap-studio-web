/**
 * Who may open /metrics.
 *
 * One source of truth: neon_auth."user". If an account exists there and is not
 * banned, it gets in. Accounts are created either in the Neon Auth console or
 * from the module on this page, and both write to the same table, so there is
 * nothing to keep in sync and no second list to forget about.
 *
 * ─── The load-bearing setting ────────────────────────────────────────────
 *
 * This design assumes public sign-up is CLOSED. With `disableSignUp: false`
 * anyone can create an account against the auth server with one request — no
 * browser, no form, nothing this site can refuse — and under the rule above
 * that account would then be allowed in. Existence only means "we created
 * this" while nobody else is able to create one.
 *
 * So: set disableSignUp to true in the Neon Auth console. It is not a
 * hardening step to do later, it is the thing standing between a stranger and
 * a page listing customers' names, emails and phone numbers.
 *
 * The page says so, loudly, whenever it detects sign-up is still open.
 */

import { neon } from '@neondatabase/serverless';

type Sql = ReturnType<typeof neon>;

const client = (cs: string | undefined): Sql | null => {
  if (!cs) return null;
  try { return neon(cs); } catch { return null; }
};

const norm = (e: string) => e.trim().toLowerCase();

/**
 * FAILS CLOSED. No database, no row, or a banned row all mean no — and an
 * unreachable database is not a reason to let somebody in.
 */
export async function hasAccess(
  email: string,
  connectionString: string | undefined,
): Promise<boolean> {
  const who = norm(email);
  if (!who) return false;
  const sql = client(connectionString);
  if (!sql) return false;
  try {
    const r = await sql`
      SELECT 1 FROM neon_auth."user"
       WHERE lower(email) = ${who}
         AND ("banned" IS NULL OR "banned" = false)
       LIMIT 1`;
    return Array.isArray(r) && r.length > 0;
  } catch {
    return false;
  }
}

export interface UserRow {
  id: string;
  name: string | null;
  email: string;
  createdAt: string;
  banned: boolean | null;
}

export async function listUsers(connectionString: string | undefined): Promise<UserRow[]> {
  const sql = client(connectionString);
  if (!sql) return [];
  try {
    return (await sql`
      SELECT id, name, email, "createdAt", "banned"
        FROM neon_auth."user" ORDER BY "createdAt" ASC
    `) as unknown as UserRow[];
  } catch {
    return [];
  }
}

/** True when anyone on the internet can still create themselves an account. */
export async function signUpIsOpen(connectionString: string | undefined): Promise<boolean> {
  const sql = client(connectionString);
  if (!sql) return false;
  try {
    const r = (await sql`SELECT email_and_password FROM neon_auth.project_config LIMIT 1`) as any[];
    const cfg = r?.[0]?.email_and_password;
    const parsed = typeof cfg === 'string' ? JSON.parse(cfg) : cfg;
    return parsed?.disableSignUp === false;
  } catch {
    return false;
  }
}

/**
 * Removes an account outright rather than banning it.
 *
 * Banning would leave the row in place and the person listed forever; for a
 * three-person dashboard, gone means gone. Sessions and credentials go first
 * because they reference the user — deleting in the other order fails on the
 * foreign key, and deleting the user while a session survives would leave a
 * live token pointing at nothing.
 */
export async function removeUser(
  email: string,
  actor: string,
  connectionString: string | undefined,
): Promise<{ ok: boolean; message: string }> {
  const who = norm(email);
  if (who === norm(actor)) {
    return { ok: false, message: 'No puedes eliminar tu propia cuenta.' };
  }
  const sql = client(connectionString);
  if (!sql) return { ok: false, message: 'Sin conexión a la base de datos.' };
  try {
    const found = (await sql`SELECT id FROM neon_auth."user" WHERE lower(email) = ${who}`) as any[];
    if (!found.length) return { ok: false, message: 'Esa cuenta no existe.' };
    const id = found[0].id;
    await sql`DELETE FROM neon_auth."session" WHERE "userId" = ${id}`;
    await sql`DELETE FROM neon_auth."account" WHERE "userId" = ${id}`;
    await sql`DELETE FROM neon_auth."user" WHERE id = ${id}`;
    return { ok: true, message: `Cuenta de ${who} eliminada.` };
  } catch {
    return { ok: false, message: 'No se pudo eliminar la cuenta.' };
  }
}

/**
 * Sends a password-reset email.
 *
 * This is how a password gets set, including the first one: an account created
 * in the Neon console has a name and an email but no credential, so there is
 * nothing to sign in with until someone sets one. Rather than writing the hash
 * ourselves — Better Auth owns that format and reimplementing it would break
 * silently on their next change — this uses their own flow, which also means
 * whoever created the account never sees the password.
 *
 * redirectTo is the production URL rather than the current origin: the auth
 * server validates it against its trusted origins and rejects 127.0.0.1, so
 * deriving it locally made every reset fail with nothing to explain why.
 */
export async function sendPasswordReset(
  email: string,
  authUrl: string | undefined,
): Promise<{ ok: boolean; message: string }> {
  if (!authUrl) return { ok: false, message: 'Falta NEON_AUTH_URL.' };
  const who = norm(email);
  try {
    const res = await fetch(`${authUrl.replace(/\/$/, '')}/request-password-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://studio.orbitaleap.com' },
      body: JSON.stringify({ email: who, redirectTo: 'https://studio.orbitaleap.com/metrics' }),
    });
    return res.ok
      ? { ok: true, message: `Correo enviado a ${who} para establecer su contraseña.` }
      : { ok: false, message: 'No se pudo enviar el correo.' };
  } catch {
    return { ok: false, message: 'No se pudo contactar con el servidor de acceso.' };
  }
}

/**
 * Creates an account, then emails the person to set their own password.
 *
 * Goes through the auth server rather than inserting into neon_auth."user"
 * directly: an account with no credential row cannot sign in, and Better Auth
 * owns how those are written. A password is generated here only because the
 * endpoint requires one — it is never shown to anyone and is replaced by
 * whatever the person chooses from the email.
 *
 * If sign-up is disabled on the project this call is refused, which is correct
 * and is why the message points at the console instead.
 */
export async function createUser(
  opts: { email: string; name: string },
  authUrl: string | undefined,
): Promise<{ ok: boolean; message: string }> {
  if (!authUrl) return { ok: false, message: 'Falta NEON_AUTH_URL.' };
  const who = norm(opts.email);

  // 32 random bytes, discarded immediately. The real password is the one the
  // person sets from the email below.
  const scratch = [...crypto.getRandomValues(new Uint8Array(24))]
    .map((b) => b.toString(36)).join('').slice(0, 32);

  try {
    const res = await fetch(`${authUrl.replace(/\/$/, '')}/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://studio.orbitaleap.com' },
      body: JSON.stringify({ name: opts.name || who, email: who, password: scratch }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
      if (res.status === 422 || /exist/i.test(body.code ?? '')) {
        return { ok: false, message: 'Esa cuenta ya existe.' };
      }
      if (/disabled|not allowed/i.test(body.message ?? body.code ?? '')) {
        return {
          ok: false,
          message: 'El registro está cerrado. Crea la cuenta en la consola de Neon Auth.',
        };
      }
      return { ok: false, message: body.message || 'No se pudo crear la cuenta.' };
    }
  } catch {
    return { ok: false, message: 'No se pudo contactar con el servidor de acceso.' };
  }

  const sent = await sendPasswordReset(who, authUrl);
  return sent.ok
    ? { ok: true, message: `Cuenta creada. ${sent.message}` }
    : { ok: true, message: `Cuenta creada para ${who}, pero no se pudo enviar el correo.` };
}
