-- Backfill `site` for the leads recorded while the endpoint was dropping it.
--
-- Between the column shipping and the fix in the send-email endpoint, every
-- studio lead was written with site NULL: the value arrived from the browser,
-- was read, clipped, and then never passed to recordLead. Two rows were
-- recorded in that window.
--
-- Their origin is not a guess. `form` is written by the endpoint itself and
-- names the form that was submitted — 'studio · /launch' — so the submission
-- URL follows from data we did record, not from inference about what probably
-- happened.
--
-- Without this the dashboard's site picker offered orbitaleap.com only, while
-- the table below it plainly showed two studio leads. That gap reads as a bug
-- every time somebody looks at it, and the fix for new rows cannot reach old
-- ones — the browser's value was never stored and cannot be recovered.
--
-- Scoped by what each row says it is, never by an id range. Both predicates
-- matter: `site IS NULL` keeps it off anything already recorded properly, and
-- the exact `form` match keeps it off every other form.
--
-- Applied to production 2026-08-07; 2 rows updated, 0 rows left without a site.

UPDATE leads
   SET site = 'https://studio.orbitaleap.com/launch/'
 WHERE site IS NULL
   AND form = 'studio · /launch';
