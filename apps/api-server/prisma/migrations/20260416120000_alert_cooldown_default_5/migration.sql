-- Lower the default alert cooldown from 60 minutes to 5 minutes.
-- The previous default was too coarse: a noteworthy spike that subsides
-- and recurs within an hour produced no second notification.
ALTER TABLE "Alert" ALTER COLUMN "cooldownMinutes" SET DEFAULT 5;

-- Migrate any existing rows that are still on the previous default so
-- the change is felt immediately by current users without manual edits.
-- Rows with a custom value (anything != 60) are left untouched.
UPDATE "Alert" SET "cooldownMinutes" = 5 WHERE "cooldownMinutes" = 60;
