-- Leads, as we hold them ourselves.
--
-- Until now the only record of a lead was the notification email, which makes
-- "how many leads came from the ad last month" a question nobody can answer
-- without reading an inbox by hand. Neither site wrote a row anywhere: both
-- endpoints verify Turnstile, send through Resend, and forget.
--
-- Postgres on Neon, reached over the HTTP driver rather than a TCP pool —
-- Workers have no long-lived connections to pool, and a serverless function
-- holding one open is how a database runs out of them.
--
-- This table holds personal data — name, email, phone, message — so it is a
-- processing activity in its own right under the RGPD, not just a cache of
-- something already sent. Two consequences are built in rather than left to
-- policy: consent_at records the art. 7 proof that came with the submission,
-- and rows are deleted after the retention window (see lib/leads-store.ts).
-- The IP address is deliberately absent, matching the notification email,
-- which already states that it is not recorded.

CREATE TABLE IF NOT EXISTS leads (
  id          BIGSERIAL PRIMARY KEY,

  -- Stored with its zone rather than as text: the dashboard renders in
  -- Europe/Madrid, but "last 7 days" should not depend on where it is asked.
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Which form. Matches `source` in the email subject: 'studio · contacto',
  -- 'studio · autodiagnóstico', 'studio · launch'.
  form        TEXT NOT NULL,

  -- Attribution, as classified in lib/attribution.ts.
  channel     TEXT,  -- Google Ads | Campaña de pago | Campaña | Búsqueda orgánica | Referido | Directo
  detail      TEXT,  -- gclid=…, the referring host, or the utm set
  landing     TEXT,  -- first page of the visit, not the page they submitted from

  -- From Cloudflare's own request metadata, same as the email.
  country     TEXT,
  region      TEXT,
  city        TEXT,

  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  phone       TEXT,
  company     TEXT,
  message     TEXT,

  -- RGPD art. 7: when the privacy checkbox was ticked.
  consent_at  TIMESTAMPTZ
);

-- The dashboard's three questions: what came in recently, through which
-- channel, and from which form.
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_channel ON leads (channel);
CREATE INDEX IF NOT EXISTS idx_leads_form    ON leads (form);
