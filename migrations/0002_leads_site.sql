-- Where the form was submitted from, as a full URL.
--
-- The leads table now takes submissions from two different sites, so "which
-- site" has to be a stored fact rather than something inferred from the form
-- name. The full URL rather than a slug: knowing it came from
-- https://studio.orbitaleap.com/launch/ answers both "which site" and "which
-- page" at once, and the dashboard derives the host from it for filtering.
--
-- Distinct from `landing`, which records where the VISIT started. Someone can
-- arrive on /launch and submit from the contact modal on /servicios; landing
-- is for attribution, site is for provenance.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS site TEXT;

-- Filtering by host is the dashboard's main axis now, and it filters on a
-- prefix of this value.
CREATE INDEX IF NOT EXISTS idx_leads_site ON leads (site);
