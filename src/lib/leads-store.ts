/**
 * Reading and writing the leads table.
 *
 * Every function here treats a missing or broken database as a normal state
 * rather than an error. The binding does not exist until the D1 database is
 * created, and more importantly: recording a lead must never be able to stop
 * one being delivered. The email is what the business runs on; this table is
 * for counting. If the write fails the lead still arrives, and the only cost
 * is a gap in the dashboard.
 */

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
 * How long a lead is kept. Deleting on write rather than on a schedule keeps
 * this to one statement and no extra moving parts — the table only grows when
 * something is inserted, so that is the only moment it can need trimming.
 */
const RETENTION_MONTHS = 24;

/** Minimal shape we need from D1, so this file does not depend on the worker types. */
interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      all<T>(): Promise<{ results: T[] }>;
      first<T>(): Promise<T | null>;
    };
    all<T>(): Promise<{ results: T[] }>;
    first<T>(): Promise<T | null>;
    run(): Promise<unknown>;
  };
}

export async function recordLead(db: D1Like | undefined, lead: NewLead): Promise<void> {
  if (!db) return;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - RETENTION_MONTHS);

  await db
    .prepare(
      `INSERT INTO leads
         (created_at, form, channel, detail, landing, country, region, city,
          name, email, phone, company, message, consent_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      new Date().toISOString(),
      lead.form,
      lead.channel || null,
      lead.detail || null,
      lead.landing || null,
      lead.country || null,
      lead.region || null,
      lead.city || null,
      lead.name,
      lead.email,
      lead.phone || null,
      lead.company || null,
      lead.message || null,
      lead.consentAt || null,
    )
    .run();

  await db.prepare(`DELETE FROM leads WHERE created_at < ?`).bind(cutoff.toISOString()).run();
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

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
};

export async function readMetrics(db: D1Like | undefined): Promise<Metrics | null> {
  // null, not EMPTY: the dashboard needs to distinguish "no database yet"
  // from "a database with nothing in it", because the fix differs.
  if (!db) return null;

  try {
    const count = async (sql: string, ...args: unknown[]) =>
      ((await db.prepare(sql).bind(...args).first<{ n: number }>())?.n ?? 0);

    const group = async (col: string) =>
      (
        await db
          .prepare(
            `SELECT COALESCE(${col}, 'Sin registrar') AS label, COUNT(*) AS n
               FROM leads GROUP BY label ORDER BY n DESC LIMIT 12`,
          )
          .all<{ label: string; n: number }>()
      ).results;

    const [total, last7, last30, byChannel, byForm, byLanding, daily, recent] = await Promise.all([
      count(`SELECT COUNT(*) AS n FROM leads WHERE 1 = ?`, 1),
      count(`SELECT COUNT(*) AS n FROM leads WHERE created_at >= ?`, daysAgo(7)),
      count(`SELECT COUNT(*) AS n FROM leads WHERE created_at >= ?`, daysAgo(30)),
      group('channel'),
      group('form'),
      group('landing'),
      db
        .prepare(
          `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n
             FROM leads WHERE created_at >= ?
            GROUP BY day ORDER BY day ASC`,
        )
        .bind(daysAgo(29))
        .all<{ day: string; n: number }>()
        .then((r) => r.results),
      db
        .prepare(`SELECT * FROM leads ORDER BY created_at DESC LIMIT 50`)
        .all<LeadRow>()
        .then((r) => r.results),
    ]);

    return { total, last7, last30, byChannel, byForm, byLanding, daily, recent };
  } catch {
    // A binding that exists but points at a database without the migration
    // applied lands here. Showing an empty dashboard beats a 500.
    return EMPTY;
  }
}

/** For an erasure request. Returns whether a row actually went. */
export async function deleteLead(db: D1Like | undefined, id: number): Promise<boolean> {
  if (!db || !Number.isInteger(id)) return false;
  try {
    await db.prepare(`DELETE FROM leads WHERE id = ?`).bind(id).run();
    return true;
  } catch {
    return false;
  }
}
