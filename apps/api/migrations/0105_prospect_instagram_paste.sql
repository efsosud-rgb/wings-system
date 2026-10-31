CREATE TABLE "ig_paste_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"created_by" uuid NOT NULL,
	"post_url" text NOT NULL,
	"post_owner_username" text,
	"chars" integer NOT NULL,
	"lines_total" integer NOT NULL,
	"comments_found" integer NOT NULL,
	"lines_ignored" integer NOT NULL,
	"lines_unrecognized" integer NOT NULL,
	"already_known" integer NOT NULL,
	"format_detected" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ig_paste_batches_post_url_check" CHECK ("ig_paste_batches"."post_url" like 'https://www.instagram.com/%' and position('?' in "ig_paste_batches"."post_url") = 0),
	CONSTRAINT "ig_paste_batches_format_check" CHECK ("ig_paste_batches"."format_detected" is null or "ig_paste_batches"."format_detected" in ('web_computador', 'web_celular', 'manual', 'misto'))
);
--> statement-breakpoint
CREATE TABLE "prospect_ai_settings" (
	"tenant_id" uuid PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"settings" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prospect_classifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"method" text NOT NULL,
	"category" text,
	"secondary_categories" text[] DEFAULT '{}' NOT NULL,
	"intent" text,
	"buy_signal" text,
	"confidence" smallint,
	"justification" text,
	"model" text,
	"prompt_version" text,
	"run_id" uuid,
	"verdict" text,
	"verdict_fields" text[],
	"actor_employee_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prospect_classifications_method_check" CHECK ("prospect_classifications"."method" in ('palavra_chave', 'regra', 'ia', 'ia_lote', 'ia_sombra', 'humano')),
	CONSTRAINT "prospect_classifications_signal_check" CHECK ("prospect_classifications"."buy_signal" is null or "prospect_classifications"."buy_signal" in ('quer_comprar', 'pediu_preco', 'duvida', 'elogio', 'reclamacao', 'spam')),
	CONSTRAINT "prospect_classifications_verdict_check" CHECK ("prospect_classifications"."verdict" is null or "prospect_classifications"."verdict" in ('certo', 'errado')),
	CONSTRAINT "prospect_classifications_justification_check" CHECK (char_length("prospect_classifications"."justification") <= 200)
);
--> statement-breakpoint
CREATE TABLE "prospect_classifier_cache" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"key_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prospect_classifier_cache_tenant_id_key_hash_pk" PRIMARY KEY("tenant_id","key_hash")
);
--> statement-breakpoint
CREATE TABLE "prospect_classifier_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"key_hash" text NOT NULL,
	"shadow" boolean DEFAULT false NOT NULL,
	"items" smallint DEFAULT 1 NOT NULL,
	"reserved_micro_usd" integer NOT NULL,
	"cost_micro_usd" integer,
	"cost_source" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"outcome" text DEFAULT 'pending' NOT NULL,
	CONSTRAINT "prospect_classifier_runs_cost_source_check" CHECK ("prospect_classifier_runs"."cost_source" is null or "prospect_classifier_runs"."cost_source" in ('provider', 'estimate')),
	CONSTRAINT "prospect_classifier_runs_outcome_check" CHECK ("prospect_classifier_runs"."outcome" in ('pending', 'ok', 'invalid', 'failed', 'timeout'))
);
--> statement-breakpoint
CREATE TABLE "prospect_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"occurred_at_precision" text DEFAULT 'exata' NOT NULL,
	"excerpt" text,
	"author_igsid" text,
	"author_username" text,
	"media_id" text,
	"ad_id" text,
	"legal_basis" text NOT NULL,
	"retention_until" timestamp with time zone,
	"recorded_by" uuid,
	"opportunity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prospect_evidence_source_check" CHECK ("prospect_evidence"."source" in ('instagram_comment', 'instagram_dm', 'instagram_ad_comment', 'instagram_ad_referral', 'instagram_mention', 'competitor_radar', 'instagram_colagem')),
	CONSTRAINT "prospect_evidence_precision_check" CHECK ("prospect_evidence"."occurred_at_precision" in ('exata', 'aproximada')),
	CONSTRAINT "prospect_evidence_excerpt_check" CHECK (char_length("prospect_evidence"."excerpt") <= 280),
	CONSTRAINT "prospect_evidence_legal_basis_check" CHECK ("prospect_evidence"."legal_basis" in ('consent', 'pre_contract', 'legitimate_interest'))
);
--> statement-breakpoint
CREATE TABLE "prospect_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"evidence_id" uuid NOT NULL,
	"source" text NOT NULL,
	"state" text DEFAULT 'nova' NOT NULL,
	"category" text,
	"secondary_categories" text[] DEFAULT '{}' NOT NULL,
	"intent" text,
	"buy_signal" text,
	"priority" smallint,
	"confidence" smallint,
	"justification" text,
	"classification_id" uuid,
	"needs_review_reason" text,
	"owner_employee_id" uuid,
	"respond_by" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"lead_id" uuid,
	"duplicate_of_opportunity_id" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"paste_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prospect_opportunities_source_check" CHECK ("prospect_opportunities"."source" in ('instagram_comment', 'instagram_dm', 'instagram_ad_comment', 'instagram_ad_referral', 'instagram_mention', 'competitor_radar', 'instagram_colagem')),
	CONSTRAINT "prospect_opportunities_state_check" CHECK ("prospect_opportunities"."state" in ('nova', 'em_revisao', 'abordada', 'aprovada', 'rejeitada', 'duplicada', 'prazo_vencido')),
	CONSTRAINT "prospect_opportunities_intent_check" CHECK ("prospect_opportunities"."intent" is null or "prospect_opportunities"."intent" in ('interesse_declarado', 'necessidade_provavel', 'conteudo_educativo', 'comentario_casual', 'outro_assunto', 'informacao_insuficiente')),
	CONSTRAINT "prospect_opportunities_signal_check" CHECK ("prospect_opportunities"."buy_signal" is null or "prospect_opportunities"."buy_signal" in ('quer_comprar', 'pediu_preco', 'duvida', 'elogio', 'reclamacao', 'spam')),
	CONSTRAINT "prospect_opportunities_review_check" CHECK ("prospect_opportunities"."needs_review_reason" is null or "prospect_opportunities"."needs_review_reason" in ('confianca_baixa', 'revisao_obrigatoria', 'servico_nao_vendido', 'sem_ia', 'teto_ia', 'ia_invalida', 'registro_manual', 'duvida')),
	CONSTRAINT "prospect_opportunities_secondary_check" CHECK (cardinality("prospect_opportunities"."secondary_categories") <= 3),
	CONSTRAINT "prospect_opportunities_priority_check" CHECK ("prospect_opportunities"."priority" between 0 and 100),
	CONSTRAINT "prospect_opportunities_confidence_check" CHECK ("prospect_opportunities"."confidence" between 0 and 100),
	CONSTRAINT "prospect_opportunities_justification_check" CHECK (char_length("prospect_opportunities"."justification") <= 200),
	CONSTRAINT "prospect_opportunities_reason_check" CHECK (char_length("prospect_opportunities"."decision_reason") <= 300),
	CONSTRAINT "prospect_opportunities_approved_check" CHECK ("prospect_opportunities"."state" <> 'aprovada' or "prospect_opportunities"."lead_id" is not null),
	CONSTRAINT "prospect_opportunities_duplicate_check" CHECK ("prospect_opportunities"."state" <> 'duplicada' or "prospect_opportunities"."lead_id" is not null or "prospect_opportunities"."duplicate_of_opportunity_id" is not null),
	CONSTRAINT "prospect_opportunities_decided_check" CHECK ("prospect_opportunities"."state" not in ('aprovada', 'rejeitada', 'duplicada') or "prospect_opportunities"."decided_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "ig_paste_batches" ADD CONSTRAINT "ig_paste_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ig_paste_batches" ADD CONSTRAINT "ig_paste_batches_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_ai_settings" ADD CONSTRAINT "prospect_ai_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_ai_settings" ADD CONSTRAINT "prospect_ai_settings_updated_by_employees_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_classifications" ADD CONSTRAINT "prospect_classifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_classifications" ADD CONSTRAINT "prospect_classifications_opportunity_id_prospect_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."prospect_opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_classifications" ADD CONSTRAINT "prospect_classifications_run_id_prospect_classifier_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."prospect_classifier_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_classifications" ADD CONSTRAINT "prospect_classifications_actor_employee_id_employees_id_fk" FOREIGN KEY ("actor_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_classifier_cache" ADD CONSTRAINT "prospect_classifier_cache_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_classifier_runs" ADD CONSTRAINT "prospect_classifier_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_evidence" ADD CONSTRAINT "prospect_evidence_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_evidence" ADD CONSTRAINT "prospect_evidence_recorded_by_employees_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_evidence" ADD CONSTRAINT "prospect_evidence_opportunity_id_prospect_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."prospect_opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_opportunities" ADD CONSTRAINT "prospect_opportunities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_opportunities" ADD CONSTRAINT "prospect_opportunities_evidence_id_prospect_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."prospect_evidence"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_opportunities" ADD CONSTRAINT "prospect_opportunities_classification_id_prospect_classifications_id_fk" FOREIGN KEY ("classification_id") REFERENCES "public"."prospect_classifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_opportunities" ADD CONSTRAINT "prospect_opportunities_owner_employee_id_employees_id_fk" FOREIGN KEY ("owner_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_opportunities" ADD CONSTRAINT "prospect_opportunities_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_opportunities" ADD CONSTRAINT "prospect_opportunities_duplicate_of_opportunity_id_prospect_opportunities_id_fk" FOREIGN KEY ("duplicate_of_opportunity_id") REFERENCES "public"."prospect_opportunities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_opportunities" ADD CONSTRAINT "prospect_opportunities_decided_by_employees_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_opportunities" ADD CONSTRAINT "prospect_opportunities_paste_batch_id_ig_paste_batches_id_fk" FOREIGN KEY ("paste_batch_id") REFERENCES "public"."ig_paste_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ig_paste_batches_creator_idx" ON "ig_paste_batches" USING btree ("tenant_id","created_by","created_at");--> statement-breakpoint
CREATE INDEX "prospect_classifications_opportunity_idx" ON "prospect_classifications" USING btree ("opportunity_id","created_at");--> statement-breakpoint
CREATE INDEX "prospect_classifications_method_idx" ON "prospect_classifications" USING btree ("tenant_id","method","created_at");--> statement-breakpoint
CREATE INDEX "prospect_classifier_cache_created_idx" ON "prospect_classifier_cache" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "prospect_classifier_runs_at_idx" ON "prospect_classifier_runs" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "prospect_evidence_external_uq" ON "prospect_evidence" USING btree ("tenant_id","source","external_id");--> statement-breakpoint
CREATE INDEX "prospect_evidence_igsid_idx" ON "prospect_evidence" USING btree ("tenant_id","author_igsid");--> statement-breakpoint
CREATE INDEX "prospect_evidence_username_idx" ON "prospect_evidence" USING btree ("tenant_id","author_username");--> statement-breakpoint
CREATE INDEX "prospect_evidence_opportunity_idx" ON "prospect_evidence" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "prospect_evidence_retention_idx" ON "prospect_evidence" USING btree ("retention_until");--> statement-breakpoint
CREATE UNIQUE INDEX "prospect_opportunities_evidence_uq" ON "prospect_opportunities" USING btree ("evidence_id");--> statement-breakpoint
CREATE INDEX "prospect_opportunities_queue_idx" ON "prospect_opportunities" USING btree ("tenant_id","state","respond_by");--> statement-breakpoint
CREATE INDEX "prospect_opportunities_owner_idx" ON "prospect_opportunities" USING btree ("tenant_id","owner_employee_id","state");--> statement-breakpoint
CREATE INDEX "prospect_opportunities_source_idx" ON "prospect_opportunities" USING btree ("tenant_id","source","created_at");--> statement-breakpoint
CREATE INDEX "prospect_opportunities_lead_idx" ON "prospect_opportunities" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "prospect_opportunities_batch_idx" ON "prospect_opportunities" USING btree ("paste_batch_id");