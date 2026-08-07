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
  site: string | null;
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
  /** Full URL the form was submitted from, e.g. https://orbitaleap.com/. */
  site: string;
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
      (form, site, channel, detail, landing, country, region, city,
       name, email, phone, company, message, consent_at)
    VALUES
      (${lead.form}, ${lead.site || null}, ${lead.channel || null}, ${lead.detail || null}, ${lead.landing || null},
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
  bySite: { label: string; n: number }[];
  byPage: { label: string; n: number }[];
  daily: { day: string; n: number }[];
  recent: LeadRow[];
  /** Every host ever seen, filtered or not — this populates the site picker. */
  sites: string[];
}

const EMPTY: Metrics = {
  total: 0, last7: 0, last30: 0,
  byChannel: [], byForm: [], byLanding: [], bySite: [], byPage: [],
  daily: [], recent: [], sites: [],
};

/**
 * Reads the dashboard's figures, optionally narrowed to one host.
 *
 * The host is derived in SQL — `split_part(site, '/', 3)` is the host of
 * 'https://host/path' — rather than stored in its own column, so a row can
 * never end up claiming a host its URL disagrees with.
 *
 * `site` is an exact host match rather than a prefix, so orbitaleap.com and
 * www.orbitaleap.com stay separate buckets — which is the point, since telling
 * them apart is how we find out whether the www duplicate is still taking
 * traffic. An empty string means every site, and rows written before the
 * column existed (site IS NULL) only appear in that unfiltered view.
 */
export async function readMetrics(
  connectionString: string | undefined,
  site = '',
): Promise<Metrics | null> {
  // null, not EMPTY: the dashboard needs to tell "not connected yet" apart
  // from "connected, nothing in it", because the fix differs.
  const sql = client(connectionString);
  if (!sql) return null;

  try {
    const num = (v: unknown) => Number(v ?? 0);

    // Passed as a parameter and compared in SQL rather than concatenated into
    // the query: an empty string selects everything, and the value still goes
    // through the driver's placeholder rather than into the statement text.
    const s = site;

    const [totals, byChannel, byForm, byLanding, bySite, byPage, daily, recent, sites] =
      await Promise.all([
        sql`
          SELECT
            COUNT(*)                                                            AS total,
            COUNT(*) FILTER (WHERE created_at >= now() - INTERVAL '7 days')     AS last7,
            COUNT(*) FILTER (WHERE created_at >= now() - INTERVAL '30 days')    AS last30
          FROM leads
           WHERE (${s} = '' OR split_part(site, '/', 3) = ${s})
        `,
        sql`SELECT COALESCE(channel, 'Sin registrar') AS label, COUNT(*) AS n
              FROM leads WHERE (${s} = '' OR split_part(site, '/', 3) = ${s})
             GROUP BY 1 ORDER BY n DESC LIMIT 12`,
        sql`SELECT COALESCE(form, 'Sin registrar') AS label, COUNT(*) AS n
              FROM leads WHERE (${s} = '' OR split_part(site, '/', 3) = ${s})
             GROUP BY 1 ORDER BY n DESC LIMIT 12`,
        sql`SELECT COALESCE(landing, 'Sin registrar') AS label, COUNT(*) AS n
              FROM leads WHERE (${s} = '' OR split_part(site, '/', 3) = ${s})
             GROUP BY 1 ORDER BY n DESC LIMIT 12`,
        sql`SELECT COALESCE(NULLIF(split_part(site, '/', 3), ''), 'Sin registrar') AS label,
                   COUNT(*) AS n
              FROM leads WHERE (${s} = '' OR split_part(site, '/', 3) = ${s})
             GROUP BY 1 ORDER BY n DESC LIMIT 12`,
        // The path, not the whole URL: the host is already its own breakdown
        // and repeating it on every row would push the path off the card.
        sql`SELECT COALESCE(NULLIF(regexp_replace(site, '^https?://[^/]*', ''), ''), 'Sin registrar') AS label,
                   COUNT(*) AS n
              FROM leads WHERE (${s} = '' OR split_part(site, '/', 3) = ${s})
             GROUP BY 1 ORDER BY n DESC LIMIT 12`,
        sql`SELECT to_char(created_at AT TIME ZONE 'Europe/Madrid', 'YYYY-MM-DD') AS day,
                   COUNT(*) AS n
              FROM leads
             WHERE created_at >= now() - INTERVAL '30 days'
               AND (${s} = '' OR split_part(site, '/', 3) = ${s})
             GROUP BY 1 ORDER BY 1 ASC`,
        sql`SELECT * FROM leads
             WHERE (${s} = '' OR split_part(site, '/', 3) = ${s})
             ORDER BY created_at DESC LIMIT 50`,
        // Deliberately unfiltered: the picker has to keep offering the other
        // sites once one of them is selected, or it is a one-way door.
        sql`SELECT DISTINCT split_part(site, '/', 3) AS host
              FROM leads WHERE site IS NOT NULL AND site <> '' ORDER BY 1 ASC`,
      ]);

    const rows = <T,>(r: unknown): T[] => (Array.isArray(r) ? (r as T[]) : []);
    const t = rows<Record<string, unknown>>(totals)[0] ?? {};
    const tally = (r: unknown) =>
      rows<{ label: string; n: unknown }>(r).map((x) => ({ label: x.label, n: num(x.n) }));

    return {
      total: num(t.total),
      last7: num(t.last7),
      last30: num(t.last30),
      byChannel: tally(byChannel),
      byForm: tally(byForm),
      byLanding: tally(byLanding),
      bySite: tally(bySite),
      byPage: tally(byPage),
      daily: rows<{ day: string; n: unknown }>(daily).map((r) => ({ day: r.day, n: num(r.n) })),
      recent: rows<LeadRow>(recent),
      sites: rows<{ host: string }>(sites).map((r) => r.host).filter(Boolean),
    };
  } catch {
    // A connection string that points at a database without the migration
    // applied lands here. An empty dashboard beats a 500.
    return EMPTY;
  }
}

// No delete here.
//
// The dashboard no longer offers one, and an exported helper that deletes
// customer records — with no caller — is an invitation. An erasure request is
// answered in the database, by someone who opened it meaning to.
