/**
 * Reading and writing the leads table on Neon.
 *
 * The HTTP driver, not a pooled TCP client: a Worker has no long-lived
 * process to pool connections in, and a serverless function that opens one
 * per request is how a Postgres instance runs out of them. `neon()` issues a
 * single fetch per statement, which is exactly the shape of this workload.
 *
 * Every function here treats a missing connection string or a broken query as
 * a normal state rather than an error. DATABASE_URL is unset until someone
 * adds it, and more importantly: recording a lead must never be able to stop
 * one being delivered. The email is what the business runs on; this table is
 * for counting. A lead that is delivered but not counted is a gap in a chart,
 * while a lead that is counted but not delivered is a lost customer.
 */

import { neon } from '@neondatabase/serverless';

export interface LeadRow {
  id: number;
  created_at: string;
  form: string;
  channel: string | null;
  detail: string | null;
  landing: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  message: string | null;
  consent_at: string | null;
}

export interface NewLead {
  form: string;
  channel: string;
  detail: string;
  landing: string;
  country: string;
  region: string;
  city: string;
  name: string;
  email: string;
  phone: string;
  company: string;
  message: string;
  consentAt: string;
}

/**
 * How long a lead is kept. Deleted on write rather than on a schedule: the
 * table only grows when something is inserted, so that is the only moment it
 * can need trimming, and it saves a cron nobody would remember to check.
 */
const RETENTION = "24 months";

type Sql = ReturnType<typeof neon>;

/** null when there is no connection string — a normal state, not a failure. */
function client(connectionString: string | undefined): Sql | null {
  if (!connectionString) return null;
  try {
    return neon(connectionString);
  } catch {
    return null;
  }
}

export async function recordLead(connectionString: string | undefined, lead: NewLead): Promise<void> {
  const sql = client(connectionString);
  if (!sql) return;

  await sql`
    INSERT INTO leads
      (form, channel, detail, landing, country, region, city,
       name, email, phone, company, message, consent_at)
    VALUES
      (${lead.form}, ${lead.channel || null}, ${lead.detail || null}, ${lead.landing || null},
       ${lead.country || null}, ${lead.region || null}, ${lead.city || null},
       ${lead.name}, ${lead.email}, ${lead.phone || null}, ${lead.company || null},
       ${lead.message || null}, ${lead.consentAt || null})
  `;

  // Bound and cast, rather than interpolated into an INTERVAL literal.
  // Postgres rejects a placeholder inside `INTERVAL '…'`, but it accepts one
  // cast to interval — which keeps this a parameterised query and keeps the
  // driver's tagged-template form, the only one its types expose.
  await sql`DELETE FROM leads WHERE created_at < now() - ${RETENTION}::interval`;
}

export interface Metrics {
  total: number;
  last7: number;
  last30: number;
  byChannel: { label: string; n: number }[];
  byForm: { label: string; n: number }[];
  byLanding: { label: string; n: number }[];
  daily: { day: string; n: number }[];
  recent: LeadRow[];
}

const EMPTY: Metrics = {
  total: 0, last7: 0, last30: 0,
  byChannel: [], byForm: [], byLanding: [], daily: [], recent: [],
};

export async function readMetrics(connectionString: string | undefined): Promise<Metrics | null> {
  // null, not EMPTY: the dashboard needs to tell "not connected yet" apart
  // from "connected, nothing in it", because the fix differs.
  const sql = client(connectionString);
  if (!sql) return null;

  try {
    const num = (v: unknown) => Number(v ?? 0);

    const [totals, byChannel, byForm, byLanding, daily, recent] = await Promise.all([
      sql`
        SELECT
          COUNT(*)                                                            AS total,
          COUNT(*) FILTER (WHERE created_at >= now() - INTERVAL '7 days')     AS last7,
          COUNT(*) FILTER (WHERE created_at >= now() - INTERVAL '30 days')    AS last30
        FROM leads
      `,
      sql`SELECT COALESCE(channel, 'Sin registrar') AS label, COUNT(*) AS n
            FROM leads GROUP BY 1 ORDER BY n DESC LIMIT 12`,
      sql`SELECT COALESCE(form, 'Sin registrar') AS label, COUNT(*) AS n
            FROM leads GROUP BY 1 ORDER BY n DESC LIMIT 12`,
      sql`SELECT COALESCE(landing, 'Sin registrar') AS label, COUNT(*) AS n
            FROM leads GROUP BY 1 ORDER BY n DESC LIMIT 12`,
      sql`SELECT to_char(created_at AT TIME ZONE 'Europe/Madrid', 'YYYY-MM-DD') AS day,
                 COUNT(*) AS n
            FROM leads
           WHERE created_at >= now() - INTERVAL '30 days'
           GROUP BY 1 ORDER BY 1 ASC`,
      sql`SELECT * FROM leads ORDER BY created_at DESC LIMIT 50`,
    ]);

    const rows = <T,>(r: unknown): T[] => (Array.isArray(r) ? (r as T[]) : []);
    const t = rows<Record<string, unknown>>(totals)[0] ?? {};

    return {
      total: num(t.total),
      last7: num(t.last7),
      last30: num(t.last30),
      byChannel: rows<{ label: string; n: unknown }>(byChannel).map((r) => ({ label: r.label, n: num(r.n) })),
      byForm: rows<{ label: string; n: unknown }>(byForm).map((r) => ({ label: r.label, n: num(r.n) })),
      byLanding: rows<{ label: string; n: unknown }>(byLanding).map((r) => ({ label: r.label, n: num(r.n) })),
      daily: rows<{ day: string; n: unknown }>(daily).map((r) => ({ day: r.day, n: num(r.n) })),
      recent: rows<LeadRow>(recent),
    };
  } catch {
    // A connection string that points at a database without the migration
    // applied lands here. An empty dashboard beats a 500.
    return EMPTY;
  }
}

/** For an erasure request. Returns whether a row actually went. */
export async function deleteLead(connectionString: string | undefined, id: number): Promise<boolean> {
  const sql = client(connectionString);
  if (!sql || !Number.isInteger(id)) return false;
  try {
    const res = await sql`DELETE FROM leads WHERE id = ${id} RETURNING id`;
    return Array.isArray(res) && res.length > 0;
  } catch {
    return false;
  }
}
