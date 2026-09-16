-- The paid-traffic spending guardrail, enforced by the database itself.
--
-- These constraints are the floor the whole design stands on. Application code
-- can have bugs, the AI agent can be wrong, and someone can open psql — none of
-- that can push an ad account past its monthly cap, because Postgres refuses
-- the row. Each cap is per ad account: Meta, Google and TikTok are independent.

ALTER TABLE "ad_budget_periods"
  ADD CONSTRAINT ad_budget_periods_cap_positive_ck
  CHECK (cap_cents > 0);
--> statement-breakpoint

ALTER TABLE "ad_budget_periods"
  ADD CONSTRAINT ad_budget_periods_non_negative_ck
  CHECK (committed_cents >= 0 AND spent_cents >= 0 AND usable_cents >= 0);
--> statement-breakpoint

-- The usable portion (70%) is what may be planned against; the remaining 30%
-- exists to absorb overdelivery and reporting lag, never to be allocated.
ALTER TABLE "ad_budget_periods"
  ADD CONSTRAINT ad_budget_periods_usable_within_cap_ck
  CHECK (usable_cents <= cap_cents);
--> statement-breakpoint

-- Planned exposure may never exceed the usable portion.
ALTER TABLE "ad_budget_periods"
  ADD CONSTRAINT ad_budget_periods_committed_within_usable_ck
  CHECK (committed_cents <= usable_cents);
--> statement-breakpoint

-- THE WALL: planned exposure can never exceed what is left of the cap.
--
-- Deliberately written as a bound on committed_cents rather than as
-- "spent + committed <= cap". Platforms can overdeliver, so real spend may
-- exceed the cap through no act of ours; a constraint that forbade recording
-- that would make the system unable to write down the truth, which is far more
-- dangerous than the overspend itself. Reality is always recordable; what the
-- database forbids is ever *authorising* more exposure than remains.
ALTER TABLE "ad_budget_periods"
  ADD CONSTRAINT ad_budget_periods_within_cap_ck
  CHECK (committed_cents <= GREATEST(cap_cents - spent_cents, 0));
--> statement-breakpoint

-- Guardrail events and spend snapshots are evidence: append-only, like the
-- RH/DP time clock and the audit log.
CREATE TRIGGER ad_guardrail_events_append_only
  BEFORE UPDATE OR DELETE ON "ad_guardrail_events"
  FOR EACH ROW EXECUTE FUNCTION wings_forbid_update_delete();
--> statement-breakpoint

CREATE TRIGGER ad_spend_snapshots_append_only
  BEFORE UPDATE OR DELETE ON "ad_spend_snapshots"
  FOR EACH ROW EXECUTE FUNCTION wings_forbid_update_delete();
--> statement-breakpoint

CREATE TRIGGER ad_budget_cap_history_append_only
  BEFORE UPDATE OR DELETE ON "ad_budget_cap_history"
  FOR EACH ROW EXECUTE FUNCTION wings_forbid_update_delete();
--> statement-breakpoint

-- A change request must carry a sane monetary shape.
ALTER TABLE "ad_change_requests"
  ADD CONSTRAINT ad_change_requests_values_ck
  CHECK (
    (from_value_cents IS NULL OR from_value_cents >= 0)
    AND (to_value_cents IS NULL OR to_value_cents >= 0)
  );
