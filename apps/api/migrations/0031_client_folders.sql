ALTER TABLE "clients" ADD COLUMN "number" integer;--> statement-breakpoint
ALTER TABLE "drive_folders" ADD COLUMN "slot" text;--> statement-breakpoint
ALTER TABLE "drive_template_nodes" ADD COLUMN "slot" text;--> statement-breakpoint
CREATE UNIQUE INDEX "clients_tenant_number_idx" ON "clients" USING btree ("tenant_id","number");--> statement-breakpoint
-- Every client registered so far gets its number in the order it was registered.
-- Wings Company keeps none: it has no client folder.
UPDATE "clients" AS c SET "number" = n.rn
  FROM (
    SELECT "id", row_number() OVER (PARTITION BY "tenant_id" ORDER BY "created_at", "id") AS rn
      FROM "clients"
     WHERE "id" <> '00000000-0000-4000-8000-0000000000c1'
  ) AS n
 WHERE c."id" = n."id" AND c."number" IS NULL;
