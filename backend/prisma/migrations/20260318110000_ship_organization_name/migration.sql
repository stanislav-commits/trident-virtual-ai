ALTER TABLE "Ship"
RENAME COLUMN "serial_number" TO "organization_name";

ALTER INDEX "Ship_serial_number_key"
RENAME TO "Ship_organization_name_key";
