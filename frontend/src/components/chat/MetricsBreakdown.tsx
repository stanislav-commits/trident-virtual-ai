import { useMemo } from "react";
import type {
  ChatMetricExecutionDto,
  ChatMetricExecutionMemberDto,
  ChatRagflowContextDto,
} from "../../types/chat";

interface MetricsBreakdownProps {
  ragflowContext?: ChatRagflowContextDto | null;
}

interface MetricsBreakdownRow {
  key: string;
  label: string;
  value: string;
  timestamp: string | null;
}

function formatMetricValue(value: unknown, unit?: string | null): string {
  if (typeof value === "number") {
    const formatter = new Intl.NumberFormat(undefined, {
      maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
    });
    return `${formatter.format(value)}${unit ? ` ${unit}` : ""}`;
  }

  if (typeof value === "string") {
    return `${value}${unit ? ` ${unit}` : ""}`;
  }

  if (value === null || value === undefined) {
    return "No data";
  }

  return `${JSON.stringify(value)}${unit ? ` ${unit}` : ""}`;
}

function formatMetricTimestamp(timestamp?: string | null): string | null {
  if (!timestamp) {
    return null;
  }

  const parsed = new Date(timestamp);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toLocaleString([], {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "short",
  });
}

function collectLeafRows(
  members: ChatMetricExecutionMemberDto[],
  rows: MetricsBreakdownRow[] = [],
): MetricsBreakdownRow[] {
  members.forEach((member) => {
    rows.push({
      key: member.memberId || member.metricCatalogId || member.label,
      label: member.label,
      value: formatMetricValue(member.value, member.unit),
      timestamp: member.timestamp ?? null,
    });
  });

  return rows;
}

function shouldRenderExecution(execution: ChatMetricExecutionDto): boolean {
  return (
    execution.result.members.length > 1 &&
    (execution.result.type === "group" ||
      execution.result.type === "composite" ||
      execution.result.type === "paired")
  );
}

export function MetricsBreakdown({ ragflowContext }: MetricsBreakdownProps) {
  const executions = useMemo(() => {
    const askResults = Array.isArray(ragflowContext?.askResults)
      ? ragflowContext.askResults
      : [];

    return askResults
      .map((askResult) => askResult.data?.execution)
      .filter(
        (execution): execution is ChatMetricExecutionDto =>
          Boolean(execution && shouldRenderExecution(execution)),
      );
  }, [ragflowContext]);

  if (executions.length === 0) {
    return null;
  }

  return (
    <div className="chat-metrics-breakdowns">
      {executions.map((execution) => {
        const rows = collectLeafRows(execution.result.members);
        const displayTimestamp = formatMetricTimestamp(
          execution.result.timestamp ?? execution.timestamp,
        );

        if (rows.length === 0) {
          return null;
        }

        return (
          <section
            key={execution.concept.id}
            className="chat-metrics-breakdown"
            aria-label={`${execution.concept.displayName} breakdown`}
          >
            <div className="chat-metrics-breakdown__header">
              <div>
                <div className="chat-metrics-breakdown__eyebrow">Breakdown</div>
                <h4 className="chat-metrics-breakdown__title">
                  {execution.concept.displayName}
                </h4>
              </div>
              <div className="chat-metrics-breakdown__summary">
                <span className="chat-metrics-breakdown__summary-label">
                  Total
                </span>
                <span className="chat-metrics-breakdown__summary-value">
                  {formatMetricValue(
                    execution.result.value,
                    execution.result.unit ?? execution.concept.unit,
                  )}
                </span>
                {displayTimestamp && (
                  <span className="chat-metrics-breakdown__timestamp">
                    {displayTimestamp}
                  </span>
                )}
              </div>
            </div>

            <div className="chat-metrics-breakdown__table-wrap">
              <table className="chat-metrics-breakdown__table">
                <thead>
                  <tr>
                    <th scope="col">Metric</th>
                    <th scope="col">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.key}>
                      <td>{row.label}</td>
                      <td>{row.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
