import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import dataSource from '../typeorm.datasource';
import { ComplianceDocMasterEntity } from '../../../modules/compliance/entities/compliance-doc-master.entity';
import { ComplianceDocTypeEntity } from '../../../modules/compliance/entities/compliance-doc-type.entity';
import { ShipEntity } from '../../../modules/ships/entities/ship.entity';
import {
  deriveFlagRegistry,
  deriveGtBucket,
  FLAG_REGISTRY_COLUMN,
  GT_BUCKET_COLUMN,
  resolveApplicability,
} from '../../../modules/compliance/compliance-profile.util';

/**
 * Load the vessel-agnostic compliance rulebook (`compliance_doc_master`) from
 * the checked-in snapshot.
 *
 * The catalogue used to exist only in the database: it was loaded outside the
 * repository, so a fresh environment came up with an empty compliance module
 * and the rows could not be rebuilt from code. `data/compliance-doc-master.json`
 * is a snapshot of production (303 rows, taken 2026-07-29) and this seed is how
 * it gets back in.
 *
 * Upsert by `sfi_code`, never delete: per-ship rows in `compliance_doc_types`
 * and the records hanging off them must survive a re-seed.
 *
 *   npm run db:seed:compliance
 */

type MasterRow = Record<string, string | null>;

const SNAPSHOT = join(__dirname, 'data', 'compliance-doc-master.json');

/** snake_case column → entity property, for the columns the snapshot carries. */
const COLUMN_TO_PROPERTY: Record<string, keyof ComplianceDocMasterEntity> = {
  sfi_code: 'sfiCode',
  section_code: 'sectionCode',
  section_name: 'sectionName',
  name: 'name',
  scope: 'scope',
  linked_sfi: 'linkedSfi',
  app_lt24: 'appLt24',
  app_24_300: 'app24300',
  app_300_399: 'app300399',
  app_400_499: 'app400499',
  app_500_3000: 'app5003000',
  app_gt3000: 'appGt3000',
  app_private: 'appPrivate',
  app_commercial: 'appCommercial',
  app_yet: 'appYet',
  app_red_ensign: 'appRedEnsign',
  app_eu_flag: 'appEuFlag',
  app_other_flag: 'appOtherFlag',
  renewal_cycle: 'renewalCycle',
  survey_window: 'surveyWindow',
  update_trigger: 'updateTrigger',
  notes: 'notes',
  archetype: 'archetype',
  link_cardinality: 'linkCardinality',
  reg_basis: 'regBasis',
  basis_note: 'basisNote',
  drives_pms: 'drivesPms',
  // document type + validity axes
  document_type: 'documentType',
  validity_driver: 'validityDriver',
  reminder_profile: 'reminderProfile',
  library_ref: 'libraryRef',
  field_profile: 'fieldProfile',
  special_data: 'specialData',
};

async function run() {
  const rows: MasterRow[] = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));

  await dataSource.initialize();
  const repository = dataSource.getRepository(ComplianceDocMasterEntity);

  let created = 0;
  let updated = 0;

  for (const row of rows) {
    const sfiCode = row.sfi_code;
    if (!sfiCode) continue;

    const existing = await repository.findOne({ where: { sfiCode } });
    const target = existing ?? repository.create({ sfiCode });
    const writable = target as unknown as Record<string, unknown>;

    for (const [column, property] of Object.entries(COLUMN_TO_PROPERTY)) {
      if (!(column in row)) continue;
      // Write the snapshot value verbatim, nulls included. Coercing null to ''
      // would silently rewrite 1298 cells across the nullable columns
      // (renewal_cycle, survey_window and update_trigger are null on every row)
      // and break any `IS NULL` query against the rulebook.
      writable[property] = row[column];
    }

    await repository.save(target);
    if (existing) updated += 1;
    else created += 1;
  }

  // Push the rulebook's own fields down onto the per-ship rows. Those were
  // copied at instantiate time, so a re-seeded catalogue would otherwise reach
  // the vessels only for types created after it. Per-ship overrides live in
  // other columns (applicability, notes) and are not touched.
  await dataSource.query(`
    UPDATE "compliance_doc_types" t
       SET "document_type"    = m."document_type",
           "validity_driver"  = m."validity_driver",
           "reminder_profile" = m."reminder_profile",
           "library_ref"          = m."library_ref",
           "field_profile"    = m."field_profile",
           "special_data"     = m."special_data",
           "archetype"        = m."archetype",
           "link_cardinality" = m."link_cardinality",
           "reg_basis"        = m."reg_basis",
           "basis_note"       = m."basis_note",
           "drives_pms"       = m."drives_pms"
      FROM "compliance_doc_master" m
     WHERE m."sfi_code" = t."sfi_code"
  `);
  // Count separately: the driver's return shape for UPDATE ... RETURNING is not
  // a plain row array, and reading a length off it under-reported 606 as 2.
  const [{ n: propagated }]: Array<{ n: string }> = await dataSource.query(
    `SELECT COUNT(*)::text AS n FROM "compliance_doc_types"`,
  );

  // New rulebook rows have to reach the vessels too. instantiateForShip only
  // runs when an operator triggers it, so a catalogue that gained rows would
  // otherwise sit in the master table and never appear on any ship.
  const shipRepository = dataSource.getRepository(ShipEntity);
  const typeRepository = dataSource.getRepository(ComplianceDocTypeEntity);
  const masterRows = await repository.find();
  const ships = await shipRepository.find();
  let instantiated = 0;
  for (const ship of ships) {
    if (ship.isPlatform) continue; // the hidden Publications scope owns no register
    const existing = await typeRepository.find({
      where: { shipId: ship.id },
      select: { sfiCode: true },
    });
    if (!existing.length) continue; // never instantiated — leave that to the operator
    const have = new Set(existing.map((t) => t.sfiCode));
    const missing = masterRows.filter((m) => !have.has(m.sfiCode));
    if (!missing.length) continue;

    const bucket = ship.gtBucket ?? deriveGtBucket(ship.grossTonnage, ship.lengthM ? Number(ship.lengthM) : null);
    const gtKey = bucket ? GT_BUCKET_COLUMN[bucket] : null;
    const opKey = ship.operationType === 'private' ? 'appPrivate' : 'appCommercial';
    const flag = ship.flagRegistry ?? deriveFlagRegistry(ship.flag);
    const flagKey = flag ? FLAG_REGISTRY_COLUMN[flag] : null;

    await typeRepository.save(
      missing.map((row) =>
        typeRepository.create({
          shipId: ship.id,
          sfiCode: row.sfiCode,
          sectionCode: row.sectionCode,
          sectionName: row.sectionName,
          name: row.name,
          scope: row.scope,
          linkedSfi: row.linkedSfi,
          applicability: gtKey
            ? resolveApplicability(row, { gtKey, opKey, flagKey })
            : '',
          renewalCycle: row.renewalCycle,
          surveyWindow: row.surveyWindow,
          updateTrigger: row.updateTrigger,
          notes: row.notes,
          archetype: row.archetype,
          linkCardinality: row.linkCardinality,
          regBasis: row.regBasis,
          basisNote: row.basisNote,
          drivesPms: row.drivesPms,
          oneCurrentVersion: row.oneCurrentVersion,
          retainHistory: row.retainHistory,
          autoArchivePrevious: row.autoArchivePrevious,
          mandatoryUpload: row.mandatoryUpload,
          documentType: row.documentType,
          validityDriver: row.validityDriver,
          reminderProfile: row.reminderProfile,
          libraryRef: row.libraryRef,
          fieldProfile: row.fieldProfile,
          specialData: row.specialData,
        }),
      ),
      { chunk: 100 },
    );
    instantiated += missing.length;
  }

  const total = await repository.count();
  await dataSource.destroy();

  console.log(
    `Compliance rulebook seeded: ${created} created, ${updated} updated, ` +
      `${total} rows total; ${propagated} per-ship rows refreshed, ` +
      `${instantiated} newly instantiated`,
  );
}

void run();
