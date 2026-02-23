import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});
const prisma = new PrismaClient({ adapter });

const METRIC_DEFINITIONS = [
  { key: 'aft_garage_hydraulic_active_power_phase_a', label: 'AFT-GARAGE-HYDRAULIC Active power on phase A', unit: 'W' },
  { key: 'aft_garage_hydraulic_active_power_phase_b', label: 'AFT-GARAGE-HYDRAULIC Active power on phase B', unit: 'W' },
  { key: 'aft_garage_hydraulic_active_power_phase_c', label: 'AFT-GARAGE-HYDRAULIC Active power on phase C', unit: 'W' },
  { key: 'aft_garage_hydraulic_partial_active_energy', label: 'AFT-GARAGE-HYDRAULIC Partial active energy delivered + received', unit: 'Wh' },
  { key: 'aft_garage_hydraulic_rms_current_phase_a', label: 'AFT-GARAGE-HYDRAULIC RMS current - phase A', unit: 'A' },
  { key: 'aft_garage_hydraulic_rms_current_phase_b', label: 'AFT-GARAGE-HYDRAULIC RMS current - phase B', unit: 'A' },
  { key: 'aft_garage_hydraulic_rms_current_phase_c', label: 'AFT-GARAGE-HYDRAULIC RMS current - phase C', unit: 'A' },
  { key: 'aft_garage_hydraulic_rms_voltage_a_n', label: 'AFT-GARAGE-HYDRAULIC RMS phase to neutral Voltage A-N', unit: 'V' },
  { key: 'aft_garage_hydraulic_rms_voltage_b_n', label: 'AFT-GARAGE-HYDRAULIC RMS phase to neutral Voltage B-N', unit: 'V' },
  { key: 'aft_garage_hydraulic_rms_voltage_c_n', label: 'AFT-GARAGE-HYDRAULIC RMS phase to neutral Voltage C-N', unit: 'V' },
  { key: 'aft_garage_hydraulic_rms_voltage_a_b', label: 'AFT-GARAGE-HYDRAULIC RMS phase to phase Voltage A-B', unit: 'V' },
  { key: 'aft_garage_hydraulic_rms_voltage_b_c', label: 'AFT-GARAGE-HYDRAULIC RMS phase to phase Voltage B-C', unit: 'V' },
  { key: 'aft_garage_hydraulic_rms_voltage_c_a', label: 'AFT-GARAGE-HYDRAULIC RMS phase to phase Voltage C-A', unit: 'V' },
  { key: 'aft_garage_hydraulic_total_active_energy', label: 'AFT-GARAGE-HYDRAULIC Total active energy delivered + received', unit: 'Wh' },
  { key: 'aft_garage_hydraulic_total_active_power', label: 'AFT-GARAGE-HYDRAULIC Total active power', unit: 'W' },
  { key: 'aft_garage_hydraulic_total_apparent_power', label: 'AFT-GARAGE-HYDRAULIC Total apparent power (arithmetic)', unit: 'VA' },
  { key: 'aft_garage_hydraulic_total_power_factor', label: 'AFT-GARAGE-HYDRAULIC Total power factor', unit: null },
  { key: 'beach_area_active_power_phase_a', label: 'BEACH-AREA Active power on phase A', unit: 'W' },
  { key: 'beach_area_active_power_phase_b', label: 'BEACH-AREA Active power on phase B', unit: 'W' },
  { key: 'beach_area_active_power_phase_c', label: 'BEACH-AREA Active power on phase C', unit: 'W' },
];

async function main() {
  for (const m of METRIC_DEFINITIONS) {
    await prisma.metricDefinition.upsert({
      where: { key: m.key },
      create: { key: m.key, label: m.label, unit: m.unit, dataType: 'numeric' },
      update: { label: m.label, unit: m.unit },
    });
  }
  console.log(`Seeded ${METRIC_DEFINITIONS.length} metric definitions`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
