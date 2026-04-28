import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDocumentsRagflowIngestion20260426000100
  implements MigrationInterface
{
  name = 'AddDocumentsRagflowIngestion20260426000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."document_doc_class_enum" AS ENUM(
        'manual',
        'historical_procedure',
        'certificate',
        'regulation'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."document_time_scope_enum" AS ENUM(
        'current',
        'past',
        'future'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."document_parse_profile_enum" AS ENUM(
        'manual_long',
        'procedure_bunkering',
        'safety_hard_parse',
        'regulation_baseline'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."document_chunk_method_enum" AS ENUM(
        'manual',
        'general'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."document_parse_status_enum" AS ENUM(
        'uploaded',
        'pending_config',
        'pending_parse',
        'parsing',
        'parsed',
        'failed',
        'reparse_required'
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "ships"
      ADD COLUMN IF NOT EXISTS "ragflow_dataset_id" character varying(128)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_ships_ragflow_dataset_id"
      ON "ships" ("ragflow_dataset_id")
      WHERE "ragflow_dataset_id" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE "documents" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "ship_id" uuid NOT NULL,
        "uploaded_by_user_id" uuid,
        "original_file_name" character varying(512) NOT NULL,
        "storage_key" character varying(1024),
        "mime_type" character varying(255) NOT NULL,
        "file_size_bytes" bigint NOT NULL,
        "checksum_sha256" character(64) NOT NULL,
        "page_count" integer,
        "ragflow_document_id" character varying(128),
        "ragflow_dataset_id" character varying(128),
        "doc_class" "public"."document_doc_class_enum" NOT NULL,
        "language" character varying(32),
        "equipment_or_system" character varying(255),
        "manufacturer" character varying(255),
        "model" character varying(255),
        "revision" character varying(255),
        "time_scope" "public"."document_time_scope_enum" NOT NULL DEFAULT 'current',
        "source_priority" integer NOT NULL DEFAULT 100,
        "content_focus" character varying(100),
        "parse_profile" "public"."document_parse_profile_enum" NOT NULL,
        "chunk_method" "public"."document_chunk_method_enum" NOT NULL,
        "pdf_parser" character varying(64) NOT NULL,
        "auto_keywords" integer NOT NULL,
        "auto_questions" integer NOT NULL,
        "chunk_size" integer,
        "delimiter" character varying(32),
        "overlap_percent" integer,
        "page_index_enabled" boolean NOT NULL DEFAULT false,
        "child_chunks_enabled" boolean NOT NULL DEFAULT false,
        "image_table_context_window" integer,
        "parse_status" "public"."document_parse_status_enum" NOT NULL DEFAULT 'uploaded',
        "parse_error" text,
        "chunk_count" integer,
        "parsed_at" TIMESTAMPTZ,
        "last_synced_at" TIMESTAMPTZ,
        "metadata_json" jsonb,
        "parser_config_json" jsonb,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_documents_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_documents_ship_id"
          FOREIGN KEY ("ship_id")
          REFERENCES "ships"("id")
          ON DELETE CASCADE
          ON UPDATE NO ACTION,
        CONSTRAINT "FK_documents_uploaded_by_user_id"
          FOREIGN KEY ("uploaded_by_user_id")
          REFERENCES "users"("id")
          ON DELETE SET NULL
          ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_documents_ship_created" ON "documents" ("ship_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_documents_ship_checksum" ON "documents" ("ship_id", "checksum_sha256")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_documents_ship_doc_class" ON "documents" ("ship_id", "doc_class")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_documents_ship_parse_status" ON "documents" ("ship_id", "parse_status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_documents_ragflow_document" ON "documents" ("ragflow_dataset_id", "ragflow_document_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_documents_ragflow_document"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_documents_ship_parse_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_documents_ship_doc_class"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_documents_ship_checksum"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_documents_ship_created"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "documents"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_ships_ragflow_dataset_id"`);
    await queryRunner.query(
      `ALTER TABLE "ships" DROP COLUMN IF EXISTS "ragflow_dataset_id"`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."document_parse_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."document_chunk_method_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."document_parse_profile_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."document_time_scope_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."document_doc_class_enum"`);
  }
}
