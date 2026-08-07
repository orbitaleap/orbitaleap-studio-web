-- Who may open /metrics.
--
-- Separate from neon_auth."user" on purpose. That table answers "does an
-- account exist"; this one answers "do we want them", and the two are only the
-- same thing while public sign-up happens to be closed — a console setting
-- that can be changed, forgotten, or reset. Keeping our own list means a
-- re-opened registration door is not also an open dashboard.
--
-- It also makes access manageable from the page itself, which an environment
-- variable never could: nothing here needs a deploy to change.

CREATE TABLE IF NOT EXISTS metrics_access (
  email       TEXT PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Who granted it. Useful when there is more than one person with the power
  -- to grant, and free to record.
  created_by  TEXT
);

-- Emails are compared lowercased everywhere, so store them that way and let
-- the primary key reject a duplicate that differs only in case.
