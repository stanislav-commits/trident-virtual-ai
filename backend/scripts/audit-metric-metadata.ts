import { PrismaService } from '../src/prisma/prisma.service';
import {
  auditMetricMetadata,
  type MetricMetadataAuditResult,
} from '../src/telemetry-catalog/audit/metric-metadata-audit.utils';

function parseLimitArg(): number {
  const raw = process.argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1];
  const parsed = raw ? Number(raw) : 25;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 25;
}

function severityRank(value: string): number {
  switch (value) {
    case 'critical':
      return 3;
    case 'high':
      return 2;
    case 'medium':
      return 1;
    default:
      return 0;
  }
}

function printFinding(result: MetricMetadataAuditResult): void {
  const top = result.findings[0];
  const families = Object.entries(result.channelFamilies)
    .map(([channel, family]) => `${channel}=${family}`)
    .join(', ');

  console.log(`- [${top.severity.toUpperCase()}] ${result.key}`);
  console.log(`  label: ${result.label ?? '(empty)'}`);
  console.log(`  unit: ${result.unit ?? '(empty)'}`);
  console.log(`  suggested family: ${result.suggestedFamily ?? 'none'}`);
  console.log(`  channels: ${families || 'none'}`);
  console.log(`  issue: ${top.summary}`);
}

async function main() {
  const prisma = new PrismaService();
  await prisma.onModuleInit();

  try {
    const definitions = await prisma.metricDefinition.findMany({
      select: {
        key: true,
        label: true,
        description: true,
        unit: true,
        bucket: true,
        measurement: true,
        field: true,
      },
      orderBy: [{ lastSeenAt: 'desc' }, { key: 'asc' }],
    });

    const audited = definitions
      .map((definition) => auditMetricMetadata(definition))
      .filter((result) => result.findings.length > 0)
      .sort((left, right) => {
        const severityDiff =
          severityRank(right.findings[0]?.severity ?? '') -
          severityRank(left.findings[0]?.severity ?? '');
        if (severityDiff !== 0) {
          return severityDiff;
        }
        return left.key.localeCompare(right.key);
      });

    const summary = audited.reduce(
      (acc, result) => {
        const severity = result.findings[0]?.severity;
        if (severity) {
          acc[severity] += 1;
        }
        return acc;
      },
      { critical: 0, high: 0, medium: 0 },
    );

    console.log(`Audited metrics: ${definitions.length}`);
    console.log(`Flagged metrics: ${audited.length}`);
    console.log(
      `By severity: critical=${summary.critical}, high=${summary.high}, medium=${summary.medium}`,
    );

    const limit = parseLimitArg();
    console.log('');
    console.log(`Top ${Math.min(limit, audited.length)} flagged metrics:`);
    for (const result of audited.slice(0, limit)) {
      printFinding(result);
    }
  } finally {
    await prisma.onModuleDestroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
