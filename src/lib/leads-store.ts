/**
 * Writing to the leads table on Neon. Writing only.
 *
 * This site records leads; it no longer reads them. The dashboard now lives at
 * orbitaleap.com/metrics and is deliberately the only one — it covers every
 * Orbital Leap site from one place, and the `site` column on each row is what
 * tells them apart. Two dashboards would have meant answering "how many leads
 * did we get" twice and adding the results up by hand.
 *
 * So readMetrics and the row/metric types that fed it are gone from here
 * rather than kept for symmetry. The table is shared; the reading is not.
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
