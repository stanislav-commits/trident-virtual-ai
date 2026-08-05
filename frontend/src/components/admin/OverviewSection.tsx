import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ModelPricesModal } from "./ModelPricesModal";
import {
  deleteShipPhoto,
  fetchShipPhotoUrl,
  getShipOverview,
  getShipSpend,
  uploadShipPhoto,
  type OverviewCard,
  type OverviewVessel,
  type ShipOverviewResponse,
} from "../../api/overviewApi";
import { useAdminShip } from "../../context/AdminShipContext";
import { AddVesselModal } from "./AddVesselModal";
import { useAdminEvents, type AdminEvent } from "../../hooks/admin/adminEvents";
import { appRoutes, isAdminSectionRoute } from "../../utils/routes";

interface OverviewSectionProps {
  token: string | null;
}

/**
 * A bulk import fires one SSE event per row while this endpoint runs nine
 * aggregates per call, so events are collapsed into a single trailing refresh.
 *
 * The window is long on purpose. At 1.5 s an import that emits events for
 * minutes re-fired the whole fan-out every 1.5 s, competing with the import
 * itself for the same connection pool. Nobody watching a data-health page needs
 * second-level freshness, and the Refresh button covers the impatient case.
 */
const REFRESH_DEBOUNCE_MS = 20_000;

/** Unattended refresh cadence. Slow on purpose: nine aggregates per call. */
const AUTO_REFRESH_MS = 60_000;

/**
 * Display order for the nine domain cards — three rows of three. Not the
 * server's order: the asset register leads because "nothing linked" is the most
 * actionable number on the page, and compliance goes last because it is a
 * deliberate placeholder until that model is reworked.
 */
const CARD_ORDER = [
  "assets",
  "maintenance",
  "tasks",
  "crew",
  "alerts",
  "metrics",
  "knowledge",
  "inventory",
  "compliance",
];

/**
 * The domain cards in display order. Anything the server adds later that this
 * list does not know about still renders, at the end — a new card must not
 * vanish because nobody updated a constant.
 */
function orderedCards(cards: OverviewCard[]): OverviewCard[] {
  const rest = cards.filter((card) => !CARD_ORDER.includes(card.key));
  return [...byKey(cards, CARD_ORDER), ...rest];
}

/** Cards in the given order, skipping any the server did not send. */
function byKey(cards: OverviewCard[], keys: string[]): OverviewCard[] {
  return keys
    .map((key) => cards.find((card) => card.key === key))
    .filter((card): card is OverviewCard => card != null);
}

function fmtNumber(value: number): string {
  return value.toLocaleString();
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function OverviewSection({ token }: OverviewSectionProps) {
  const { selectedShipId: shipId, isLoading: shipsLoading } = useAdminShip();
  const navigate = useNavigate();
  const [data, setData] = useState<ShipOverviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!token || !shipId) {
      setData(null);
      return;
    }
    setLoading(true);
    try {
      const next = await getShipOverview(token, shipId);
      // Switching vessels while a request is in flight used to let the OLD
      // response land last and overwrite the new one; the render then discarded
      // it as stale and the page sat on "No overview yet." with nothing to click.
      setData((current) => (next.shipId === shipId ? next : current));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load overview");
    } finally {
      setLoading(false);
    }
  }, [token, shipId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);


  // The debounced timer must not fire the fetch for a vessel the admin has
  // already switched away from, so it reads the current refresh from a ref.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });
  /**
   * No Refresh button: this page is a status board, so it keeps itself current.
   * The SSE handler below reacts to changes made elsewhere in the panel; this
   * interval covers what SSE cannot see — a Grafana alert arriving, a cron job
   * finishing, another operator working in a different browser. It skips hidden
   * tabs so a forgotten window does not aggregate all night.
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshRef.current();
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  const pendingRefresh = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (pendingRefresh.current !== null) {
        window.clearTimeout(pendingRefresh.current);
      }
    },
    [],
  );

  const onDomainEvent = useCallback(
    (event: AdminEvent) => {
      // shipId null = platform-wide change (ships, users) — it can still move
      // the vessel header, so it counts.
      if (event.shipId !== null && event.shipId !== shipId) return;
      if (pendingRefresh.current !== null) return;
      // A background tab would keep re-aggregating for nobody; the refresh on
      // mount covers coming back to it.
      if (document.hidden) return;
      pendingRefresh.current = window.setTimeout(() => {
        pendingRefresh.current = null;
        void refreshRef.current();
      }, REFRESH_DEBOUNCE_MS);
    },
    [shipId],
  );

  // Every card reads a different domain, so this page listens to all of them.
  useAdminEvents("assets", onDomainEvent);
  useAdminEvents("compliance", onDomainEvent);
  useAdminEvents("pms", onDomainEvent);
  useAdminEvents("crew", onDomainEvent);
  useAdminEvents("inventory", onDomainEvent);
  useAdminEvents("alerts", onDomainEvent);
  useAdminEvents("documents", onDomainEvent);
  useAdminEvents("metrics", onDomainEvent);
  useAdminEvents("ships", onDomainEvent);

  const openSection = useCallback(
    (section: string | null) => {
      if (!section || !isAdminSectionRoute(section)) return;
      navigate(appRoutes.adminSection(section));
    },
    [navigate],
  );

  if (!shipId) {
    return (
      <div className="inv">
        {/* This is the landing page now, so the first paint happens before the
            vessel list has loaded and a bare "select a vessel" would read as an
            instruction rather than a wait. */}
        <p className="inv__empty">
          {shipsLoading
            ? "Loading vessels…"
            : "Select a vessel to see its overview."}
        </p>
      </div>
    );
  }

  // After a vessel switch the previous ship's response is still in state until
  // the refetch lands; showing its counts under the new hull's name would be a
  // lie, so anything not matching the selected ship reads as "not loaded yet".
  const fresh = data && data.shipId === shipId ? data : null;

  if (!fresh) {
    return (
      <div className="inv">
        {error ? (
          <div className="overview__error">
            <p>{error}</p>
            <button
              type="button"
              className="pms__btn"
              onClick={() => void refresh()}
            >
              Try again
            </button>
          </div>
        ) : loading ? (
          <p className="inv__empty">Reading this vessel's data…</p>
        ) : (
          // Reachable without an error — a request that resolved for a vessel
          // that is no longer selected leaves nothing to show — so this state
          // needs its own way out.
          <div className="overview__error">
            <p>No overview loaded for this vessel yet.</p>
            <button
              type="button"
              className="pms__btn"
              onClick={() => void refresh()}
            >
              Load it
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="inv">
      <div className="inv__head">
        <div>
          <h2 className="inv__title">Overview</h2>
          <p className="inv__sub">
            {`Counted on the server as of ${fmtWhen(fresh.generatedAt)}`}
            {loading ? " · refreshing…" : ""}
          </p>
        </div>
      </div>

      {error && <div className="overview__error">{error}</div>}

      {/* Row one is the vessel and its spend, edge to edge. The nine domain
          cards fall into three rows of three below it. */}
      <div className="overview__grid">
        <VesselTile vessel={fresh.vessel} token={token} shipId={shipId} />
        <TokensTile tokens={fresh.tokens} token={token} shipId={shipId} />
        {orderedCards(fresh.cards).map((card) => (
          <CardTile key={card.key} card={card} onOpen={openSection} />
        ))}
      </div>
    </div>
  );
}

/**
 * The vessel itself, as the first tile of the same grid — square, so the row it
 * starts reads as one band with the domain cards beside it.
 *
 * The gear is the same vessel editor the sidebar switcher opens. It lives here
 * too because this is where an admin already is when they notice the identity is
 * wrong, and the sidebar copy is easy to miss.
 */
/** Every purpose the ledger can hold, in the words an admin would use. */
const PURPOSE_LABEL: Record<string, string> = {
  chat_answer: "Chat answers",
  chat_classify: "Chat routing",
  chat_decompose: "Question breakdown",
  chat_title: "Chat titles",
  chat_summary: "Chat summaries",
  chat_vision: "Photo reading",
  chat_write_confirm: "Write confirmations",
  doc_ingest: "Document intake",
  doc_extract: "Document extraction",
  metric_describe: "Metric labelling",
  metric_analyze: "Metric analysis",
  alert_analysis: "Alarm analysis",
  daily_brief: "Morning brief",
  compliance_extract: "Certificate reading",
  grafana_assist: "Grafana assist",
  unattributed: "Unattributed",
};

const BUCKET_LABEL: Record<string, string> = {
  crew: "Crew chat",
  platform: "Platform upkeep",
  unattributed: "Unattributed",
};

/**
 * Money, at both scales this tile has to survive: a month of real traffic reads
 * in dollars, while a freshly-started ledger is fractions of a cent — and
 * rounding that to $0.00 on a page used for invoicing reads as "free".
 */
const fmtUsd = (value: number): string => {
  if (value >= 100) return `$${Math.round(value)}`;
  if (value >= 0.01) return `$${value.toFixed(2)}`;
  if (value === 0) return "$0";
  // Below a cent, cents are all zeroes — and on a page used for invoicing that
  // reads as free. Only here does the extra precision earn its noise.
  return `$${value.toFixed(4)}`;
};

const fmtTokens = (value: number): string =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1_000
      ? `${Math.round(value / 1_000)}k`
      : String(value);

/**
 * Model spend. Month to date by default, any window the operator picks with the
 * calendar — the periods a client is actually billed on rarely line up with a
 * calendar month.
 *
 * Deliberately empty rather than zero before recording began: a vessel that was
 * never measured has not spent nothing. It spans two columns so the breakdowns
 * are readable side by side instead of stacked into a scroll.
 */
function TokensTile({
  tokens,
  token,
  shipId,
}: {
  tokens: ShipOverviewResponse["tokens"];
  token: string | null;
  shipId: string | null;
}) {
  // A picked window and a picked row live here, not in the parent: the page
  // auto-refreshes every minute with unfiltered month-to-date figures, and those
  // must not silently replace what the operator chose to look at.
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [filter, setFilter] = useState<SpendPick | null>(null);
  const [custom, setCustom] = useState<ShipOverviewResponse["tokens"]>(null);
  const [busy, setBusy] = useState(false);
  const [rangeError, setRangeError] = useState("");

  const load = useCallback(
    async (
      nextRange: { from: string; to: string } | null,
      nextFilter: SpendPick | null,
    ) => {
      setRange(nextRange);
      setFilter(nextFilter);
      setRangeError("");
      // Neither picked means the figures already on the page are the answer.
      if ((!nextRange && !nextFilter) || !token || !shipId) {
        setCustom(null);
        return;
      }
      setBusy(true);
      try {
        setCustom(
          await getShipSpend(
            token,
            shipId,
            nextRange?.from,
            nextRange?.to,
            nextFilter ? { [nextFilter.kind]: nextFilter.value } : undefined,
          ),
        );
      } catch (e) {
        setRangeError(e instanceof Error ? e.message : "Failed to load spend");
        setCustom(null);
      } finally {
        setBusy(false);
      }
    },
    [token, shipId],
  );

  // A vessel switch invalidates the data, not the window or the pick.
  useEffect(() => {
    setCustom(null);
    setRange(null);
    setFilter(null);
  }, [shipId]);

  /** Clicking the row that is already picked clears it — one control, both ways. */
  const pick = useCallback(
    (next: SpendPick) => {
      const same =
        filter != null && filter.kind === next.kind && filter.value === next.value;
      void load(range, same ? null : next);
    },
    [filter, range, load],
  );

  const shown = range || filter ? custom : tokens;
  const oneDay = Boolean(range && range.from === range.to);
  const dayStrip = oneDay && tokens ? tokens : shown;
  const [pricesOpen, setPricesOpen] = useState(false);

  if (!tokens) {
    return (
      <div className="overview__card overview__card--placeholder overview__card--wide">
        <div className="overview__card-head">
          <span className="overview__card-title">Usage tracking</span>
        </div>
        <div className="overview__headline">
          <span className="overview__headline-value overview__headline-value--empty">
            —
          </span>
          <span className="overview__headline-label">not recorded yet</span>
        </div>
        <p className="overview__placeholder-note">
          Recording has not started, so there is nothing to report — this is not
          a zero.
        </p>
      </div>
    );
  }

  const started = tokens.recordingStartedAt
    ? new Date(tokens.recordingStartedAt)
    : null;
  // Recording that began inside the window means the figure covers part of it.
  // Saying so matters more here than anywhere else on the page.
  const partial =
    started != null && shown != null && started > new Date(shown.rangeStart)
      ? started.toLocaleDateString(undefined, { day: "numeric", month: "short" })
      : null;

  return (
    <div className="overview__card overview__card--wide">
      <div className="overview__card-head">
        <span className="overview__card-title">
          Usage tracking · {shown ? periodLabel(shown, range != null) : "—"}
        </span>
        {partial && (
          <span className="overview__spend-since">measured since {partial}</span>
        )}
        <SpendPeriodPicker
          range={range}
          busy={busy}
          onApply={(next) => void load(next, filter)}
        />
        {/* Every figure on this card is tokens x a rate, and the rates are the
            one part of it an operator has to maintain. The menu sits with the
            numbers it explains rather than in a settings page nobody opens. */}
        {token && (
          <button
            type="button"
            className="overview__card-menu"
            onClick={() => setPricesOpen(true)}
            title="Model prices"
            aria-label="Model prices"
          >
            ⋯
          </button>
        )}
      </div>
      {pricesOpen && token && (
        <ModelPricesModal token={token} onClose={() => setPricesOpen(false)} />
      )}

      {rangeError && <p className="overview__spend-error">{rangeError}</p>}

      {shown == null ? (
        <p className="overview__placeholder-note">
          {busy ? "Loading…" : "No spend recorded in this period."}
        </p>
      ) : (
        <>
          <div className="overview__spend-top">
            <div>
              <div className="overview__headline">
                <span className="overview__headline-value">
                  {shown.costUsd == null ? "—" : fmtUsd(shown.costUsd)}
                </span>
                <span className="overview__headline-label">
                  {`${fmtTokens(shown.totalTokens)} tokens · ${fmtNumber(shown.calls)} calls`}
                </span>
              </div>
              <CacheSaving tokens={shown} />
            </div>
            {/* The three lists below (buckets, purpose, person) are the SAME
                money split three ways. Without saying so, one morning brief
                shows up as "Platform upkeep", "Morning brief" AND "Automatic
                (no user)" and reads like three separate charges. */}
            <span className="overview__spend-heading">Who it is for</span>
            <ul className="overview__spend-buckets">
              {shown.byBucket.map((bucket) => (
                <li key={bucket.bucket}>
                  <span
                    className={`overview__dot overview__dot--${bucket.bucket}`}
                  />
                  <span className="overview__spend-bucket-label">
                    {BUCKET_LABEL[bucket.bucket] ?? bucket.bucket}
                  </span>
                  <span className="overview__spend-bucket-tokens">
                    {fmtTokens(bucket.tokens)}
                  </span>
                  <span className="overview__spend-bucket-value">
                    {bucket.costUsd == null ? "—" : fmtUsd(bucket.costUsd)}
                  </span>
                </li>
              ))}
              {/* A count, not an amount: the money column is where every other
                  row carries dollars, and a bare "7" sitting in it read as $7
                  of spend. These calls have no price at all — that is the
                  whole point of the row — so the amount is a dash. */}
              {shown.unpricedCalls > 0 && (
                <li>
                  <span className="overview__dot overview__dot--warn" />
                  <span className="overview__spend-bucket-label">
                    Calls with no price
                  </span>
                  <span className="overview__spend-bucket-tokens overview__stat-value--warn">
                    {`${fmtNumber(shown.unpricedCalls)} ${
                      shown.unpricedCalls === 1 ? "call" : "calls"
                    }`}
                  </span>
                  <span className="overview__spend-bucket-value">—</span>
                </li>
              )}
              {/* Document extraction runs as a separate tool whose log knows
                  files, not vessels. Its older calls belong to no ship, and
                  they are the largest single line on the bill — shown here
                  rather than left off the page. */}
              {shown.unattributedUsd != null && shown.unattributedUsd > 0 && (
                <li>
                  <span className="overview__dot" />
                  <span className="overview__spend-bucket-label">
                    Not tied to a vessel
                  </span>
                  <span className="overview__spend-bucket-value">
                    {fmtUsd(shown.unattributedUsd)}
                  </span>
                </li>
              )}
            </ul>
          </div>

          <div className="overview__spend-grid">
            <SpendList
              heading="By purpose — same total, split by job"
              active={filter?.kind === "purpose" ? filter.value : null}
              onPick={pick}
              rows={shown.byPurpose.map((row) => ({
                key: row.purpose,
                pick: {
                  kind: "purpose" as const,
                  value: row.purpose,
                  label: PURPOSE_LABEL[row.purpose] ?? row.purpose,
                },
                label: PURPOSE_LABEL[row.purpose] ?? row.purpose,
                sub: `${fmtNumber(row.calls)} calls`,
                tokens: row.tokens,
                costUsd: row.costUsd,
                dot: row.bucket,
              }))}
            />
            <SpendList
              heading="By person — same total, split by who asked"
              active={filter?.kind === "user" ? filter.value : null}
              onPick={pick}
              rows={shown.byUser.map((row) => ({
                key: row.userId ?? "system",
                pick: {
                  kind: "user" as const,
                  // 'none' is the server's word for "no person initiated this".
                  value: row.userId ?? "none",
                  label:
                    row.name ?? row.login ?? (row.userId ? "Removed account" : "Automatic"),
                },
                label:
                  // A row with a user id but no name is a deleted account, not a
                  // cron job — the join outlives the user, and merging the two
                  // would credit a person's spend to the platform.
                  row.name ??
                  row.login ??
                  (row.userId ? "Removed account" : "Automatic (no user)"),
                sub: row.login && row.name ? row.login : `${fmtNumber(row.calls)} calls`,
                tokens: row.tokens,
                costUsd: row.costUsd,
              }))}
              empty="No calls in this period."
            />
          </div>

          <div className="overview__spend-models">
            <span className="overview__spend-heading">By model</span>
            <div className="overview__spend-model-line">
              {shown.byModel.map((row) => (
                <button
                  type="button"
                  key={row.model}
                  className={`overview__spend-model${
                    filter?.kind === "model" && filter.value === row.model
                      ? " overview__spend-model--active"
                      : ""
                  }`}
                  onClick={() =>
                    pick({ kind: "model", value: row.model, label: row.model })
                  }
                  title={`Show only ${row.model}`}
                >
                  <span className="overview__spend-model-name">{row.model}</span>
                  <span className="overview__spend-model-tokens">
                    {fmtTokens(row.tokens)}
                  </span>
                  <span className="overview__spend-model-value">
                    {row.costUsd == null ? "unpriced" : fmtUsd(row.costUsd)}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* The strip keeps the month even while a single day is picked:
              collapsing it to the chosen day would leave one fat bar and no
              way to step to the day beside it. */}
          <SpendDays
            days={(dayStrip ?? shown).byDay}
            rangeStart={(dayStrip ?? shown).rangeStart}
            rangeEnd={(dayStrip ?? shown).rangeEnd}
            picked={range && range.from === range.to ? range.from : null}
            onPickDay={(day) =>
              void load(
                range && range.from === day && range.to === day
                  ? null
                  : { from: day, to: day },
                filter,
              )
            }
          />
        </>
      )}
    </div>
  );
}

/** "July", or the two dates when the operator picked the window himself. */
function periodLabel(
  tokens: NonNullable<ShipOverviewResponse["tokens"]>,
  picked: boolean,
): string {
  const from = new Date(tokens.rangeStart);
  // Formatted in UTC, because these are UTC day boundaries, not instants. Local
  // formatting shifted every label by a day: an exclusive end of 1 Jul 00:00Z
  // read as "1 Jul" east of Greenwich, so "last month" ended in July.
  if (!picked) {
    return from.toLocaleDateString(undefined, {
      month: "long",
      timeZone: "UTC",
    });
  }
  // The stored end is exclusive; the label has to name the last day included.
  const last = new Date(new Date(tokens.rangeEnd).getTime() - 1);
  const day = (d: Date) =>
    d.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  return `${day(from)} — ${day(last)}`;
}

/**
 * What caching is worth on this vessel: the same traffic priced with caching off,
 * against what it actually cost. Without this line the cache-read and
 * cache-write token counts are trivia; with it they are the argument for the
 * whole mechanism, in dollars, on the page a client is billed from.
 */
function CacheSaving({
  tokens,
}: {
  tokens: NonNullable<ShipOverviewResponse["tokens"]>;
}) {
  const { costUsd, costWithoutCacheUsd, cacheWriteTokens, cacheReadTokens } =
    tokens;
  if (costUsd == null || costWithoutCacheUsd == null) return null;
  if (cacheWriteTokens === 0 && cacheReadTokens === 0) return null;

  const saved = costWithoutCacheUsd - costUsd;
  const pct =
    costWithoutCacheUsd > 0 ? Math.round((saved / costWithoutCacheUsd) * 100) : 0;

  return (
    <p
      className="overview__spend-cache"
      title={`${fmtNumber(cacheWriteTokens)} tokens written to cache, ${fmtNumber(cacheReadTokens)} read from it`}
    >
      <span className="overview__spend-cache-plain">
        {fmtUsd(costWithoutCacheUsd)}
      </span>
      {" without caching · "}
      <span
        className={
          saved >= 0
            ? "overview__spend-cache-saved"
            : "overview__spend-cache-lost"
        }
      >
        {saved >= 0 ? `saved ${fmtUsd(saved)} (${pct}%)` : `cost ${fmtUsd(-saved)} extra`}
      </span>
      {` · ${fmtTokens(cacheWriteTokens)} written, ${fmtTokens(cacheReadTokens)} read`}
    </p>
  );
}

/**
 * The period control. Presets cover what is actually asked for month after month;
 * the two date fields are there because a client's billing period does not have
 * to be any of them.
 */
const SPEND_PRESETS: { label: string; range: () => { from: string; to: string } }[] = [
  {
    label: "This month",
    range: () => {
      const now = new Date();
      return {
        from: utcDay(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
        to: utcDay(now.getTime()),
      };
    },
  },
  {
    label: "Last month",
    range: () => {
      const now = new Date();
      const first = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
      const last = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0);
      return { from: utcDay(first), to: utcDay(last) };
    },
  },
  {
    label: "Last 7 days",
    range: () => {
      const now = Date.now();
      return { from: utcDay(now - 6 * 86_400_000), to: utcDay(now) };
    },
  },
  {
    label: "Last 30 days",
    range: () => {
      const now = Date.now();
      return { from: utcDay(now - 29 * 86_400_000), to: utcDay(now) };
    },
  },
];

/** YYYY-MM-DD in UTC, matching the day boundaries the server counts on. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function SpendPeriodPicker({
  range,
  busy,
  onApply,
}: {
  range: { from: string; to: string } | null;
  busy: boolean;
  onApply: (range: { from: string; to: string } | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(range?.from ?? "");
  const [to, setTo] = useState(range?.to ?? "");
  const wrap = useRef<HTMLDivElement | null>(null);
  // Read once per mount, not per render: the max on a date field must not change
  // under the operator's cursor, and the clock is not a render input.
  const [today] = useState(() => utcDay(Date.now()));

  // Click-away, so the popover behaves like every other menu in the panel.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const valid = from !== "" && to !== "" && from <= to;

  return (
    <div className="overview__period" ref={wrap}>
      <button
        type="button"
        className={`overview__period-btn${range ? " overview__period-btn--active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title="Pick the period"
        aria-label="Pick the period"
        disabled={busy}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
          <rect
            x="3"
            y="5"
            width="18"
            height="16"
            rx="2.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
          <path
            d="M3 10h18M8 3v4M16 3v4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
        </svg>
        {range ? "Period" : "Month"}
      </button>
      {open && (
        <div className="overview__period-pop">
          {SPEND_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="overview__period-preset"
              onClick={() => {
                const next = preset.range();
                setFrom(next.from);
                setTo(next.to);
                onApply(next);
                setOpen(false);
              }}
            >
              {preset.label}
            </button>
          ))}
          <div className="overview__period-fields">
            <label>
              From
              <input
                type="date"
                value={from}
                max={to || today}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label>
              To
              <input
                type="date"
                value={to}
                min={from || undefined}
                max={today}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
          </div>
          <div className="overview__period-actions">
            <button
              type="button"
              className="overview__period-reset"
              onClick={() => {
                setFrom("");
                setTo("");
                onApply(null);
                setOpen(false);
              }}
            >
              Month to date
            </button>
            <button
              type="button"
              className="overview__period-apply"
              disabled={!valid}
              onClick={() => {
                onApply({ from, to });
                setOpen(false);
              }}
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** What a click on a breakdown row narrows the whole tile to. */
export interface SpendPick {
  kind: "model" | "purpose" | "user";
  value: string;
  label: string;
}

interface SpendRow {
  key: string;
  label: string;
  sub?: string;
  tokens: number;
  costUsd: number | null;
  dot?: string;
  pick?: SpendPick;
}

/**
 * A breakdown column. Long lists are cut, but never silently: the remainder is
 * summed into its own line, so the visible rows plus that line still add up to
 * the headline.
 */
const SPEND_ROWS_SHOWN = 4;

function SpendList({
  heading,
  rows,
  empty = "Nothing recorded.",
  active = null,
  onPick,
}: {
  heading: string;
  rows: SpendRow[];
  empty?: string;
  active?: string | null;
  onPick?: (pick: SpendPick) => void;
}) {
  // Collapsed by default to keep the tile short, but the remainder is a control,
  // not a footnote: everything the ledger holds has to be reachable.
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? rows : rows.slice(0, SPEND_ROWS_SHOWN);
  const rest = expanded ? [] : rows.slice(SPEND_ROWS_SHOWN);
  const restTokens = rest.reduce((sum, row) => sum + row.tokens, 0);
  const restCost = rest.some((row) => row.costUsd != null)
    ? rest.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)
    : null;

  return (
    <div className="overview__spend-col">
      <span className="overview__spend-heading">{heading}</span>
      {rows.length === 0 ? (
        <span className="overview__spend-empty">{empty}</span>
      ) : (
        <ul className="overview__spend-rows">
          {shown.map((row) => {
            const picked = row.pick != null && row.pick.value === active;
            const body = (
              <>
                <span
                  className="overview__spend-row-label"
                  title={row.sub ? `${row.label} · ${row.sub}` : row.label}
                >
                  {row.dot && (
                    <span className={`overview__dot overview__dot--${row.dot}`} />
                  )}
                  <span className="overview__spend-row-text">{row.label}</span>
                </span>
                <span className="overview__spend-row-tokens">
                  {fmtTokens(row.tokens)}
                </span>
                <span className="overview__spend-row-value">
                  {row.costUsd == null ? "unpriced" : fmtUsd(row.costUsd)}
                </span>
              </>
            );
            return (
              <li
                key={row.key}
                className={picked ? "overview__spend-row--picked" : undefined}
              >
                {row.pick && onPick ? (
                  <button
                    type="button"
                    className="overview__spend-row-btn"
                    onClick={() => onPick(row.pick as SpendPick)}
                    title={picked ? "Show everything again" : `Show only ${row.label}`}
                  >
                    {body}
                  </button>
                ) : (
                  body
                )}
              </li>
            );
          })}
          {(rest.length > 0 || expanded) && (
            <li className="overview__spend-row--rest">
              <button
                type="button"
                className="overview__spend-row-btn"
                onClick={() => setExpanded((v) => !v)}
                title={expanded ? "Show the top rows only" : "Show every row"}
              >
                <span className="overview__spend-row-label">
                  <span className="overview__spend-row-text">
                    {expanded ? "Show fewer" : `+${rest.length} more`}
                  </span>
                </span>
                <span className="overview__spend-row-tokens">
                  {expanded ? "" : fmtTokens(restTokens)}
                </span>
                <span className="overview__spend-row-value">
                  {expanded ? "" : restCost == null ? "unpriced" : fmtUsd(restCost)}
                </span>
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * Spend per day of the month, as bars. It answers the question the totals cannot:
 * whether this month's figure is steady traffic or one expensive afternoon.
 *
 * Days are UTC to match the month boundary the total is cut on, and days with no
 * calls are rendered as gaps rather than skipped — a sparse month should look
 * sparse.
 */
function SpendDays({
  days,
  rangeStart,
  rangeEnd,
  picked,
  onPickDay,
}: {
  days: { day: string; tokens: number; costUsd: number | null }[];
  rangeStart: string;
  rangeEnd: string;
  picked?: string | null;
  onPickDay?: (day: string) => void;
}) {
  if (days.length === 0) return null;

  const first = new Date(rangeStart);
  // The window ends at the moment it is read, so a month-to-date strip drew
  // four fat bars across the whole width and called it August. A month is
  // thirty-one slots whether they have been lived through or not: the axis
  // runs to the end of the calendar month, and the days still to come stand
  // empty like the days without calls.
  const requested = new Date(new Date(rangeEnd).getTime() - 1);
  const startsMonth = first.getUTCDate() === 1;
  const sameMonth =
    requested.getUTCFullYear() === first.getUTCFullYear() &&
    requested.getUTCMonth() === first.getUTCMonth();
  const last =
    startsMonth && sameMonth
      ? new Date(
          Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
        )
      : requested;
  const span = Math.round(
    (Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate()) -
      Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate())) /
      86_400_000,
  );
  // A year-long window would draw 365 hairlines; past a quarter the strip stops
  // being readable, so only the days that carry spend are drawn.
  const dense = span > 92;
  const byDay = new Map(days.map((row) => [row.day, row]));
  const peak = Math.max(...days.map((row) => row.tokens), 1);

  const bars = dense
    ? days.map((row) => ({ iso: row.day, row }))
    : Array.from({ length: span + 1 }, (_, index) => {
        const at = new Date(first.getTime() + index * 86_400_000);
        const iso = at.toISOString().slice(0, 10);
        return { iso, row: byDay.get(iso) };
      });

  return (
    <div className="overview__spend-days">
      <span className="overview__spend-heading">
        By day (UTC){dense ? " · days with spend only" : ""}
      </span>
      <div className="overview__spend-bars">
        {bars.map((bar) => (
          <button
            type="button"
            key={bar.iso}
            // A day is a window, so picking one narrows everything above:
            // the buckets, the purposes, the people and the models become
            // whoever was working that day. Picking it again lets go.
            className={`overview__spend-bar${
              bar.row ? "" : " overview__spend-bar--empty"
            }${picked === bar.iso ? " overview__spend-bar--picked" : ""}`}
            disabled={!bar.row || !onPickDay}
            onClick={() => bar.row && onPickDay?.(bar.iso)}
            style={
              bar.row
                ? { height: `${Math.max(8, (bar.row.tokens / peak) * 100)}%` }
                : undefined
            }
            title={
              bar.row
                ? `${bar.iso}: ${fmtTokens(bar.row.tokens)} tokens${
                    bar.row.costUsd == null ? "" : ` · ${fmtUsd(bar.row.costUsd)}`
                  }`
                : `${bar.iso}: no calls`
            }
            aria-label={bar.iso}
          />
        ))}
      </div>
    </div>
  );
}

function VesselTile({
  vessel,
  token,
  shipId,
}: {
  vessel: OverviewVessel;
  token: string | null;
  shipId: string | null;
}) {
  const { availableShips, selectedShipId } = useAdminShip();
  const [editOpen, setEditOpen] = useState(false);
  const editable =
    availableShips.find((ship) => ship.id === selectedShipId) ?? null;

  // The stat rows keep the certificate facts an inspector asks for.
  const specs: Array<[string, string]> = [
    ["IMO", vessel.imoNumber ?? "—"],
    ["Flag", vessel.flag ?? "—"],
    ["Class", vessel.classSociety ?? "—"],
    ["Built", vessel.buildYear != null ? String(vessel.buildYear) : "—"],
    ["Length", vessel.lengthM != null ? `${vessel.lengthM} m` : "—"],
    [
      "GT",
      vessel.grossTonnage != null ? fmtNumber(vessel.grossTonnage) : "—",
    ],
  ];

  // Identity an operator uses to find or chase the vessel. Only what is filled
  // in: an empty row here would look like data, and the whole point of this page
  // is to show what is missing.
  const optional: Array<[string, string | null]> = [
    ["Call sign", vessel.callSign],
    ["MMSI", vessel.mmsi],
    ["Home port", vessel.homePort],
    ["Built at", vessel.shipyard],
    ["Operation", vessel.operationType],
    ["Manager", vessel.fleetManagerEmail],
  ];
  const facts = optional.filter((entry): entry is [string, string] =>
    Boolean(entry[1]),
  );
  const missing = optional
    .filter(([, value]) => !value)
    .map(([label]) => label.toLowerCase());

  return (
    <section className="overview__card overview__vessel">
      <div className="overview__card-head">
        <span className="overview__card-title">Vessel</span>
        {editable && (
          <button
            type="button"
            className="overview__gear"
            title="Vessel details & settings"
            aria-label="Vessel details & settings"
            onClick={() => setEditOpen(true)}
          >
            ⚙
          </button>
        )}
      </div>

      <div className="overview__vessel-top">
        <VesselPhoto
          hasPhoto={vessel.hasPhoto}
          token={token}
          shipId={shipId}
          canEdit={editable != null}
        />
        <div className="overview__vessel-titles">
          <h3 className="overview__vessel-name">{vessel.name}</h3>
          {vessel.isPlatform && (
            <span className="overview__badge">Platform, not a vessel</span>
          )}
          {/* Beside the photo, under the name: the card is a third of the row
              wide now, so these fit here — and keeping them out of the full-width
              stack below is what keeps the first row short. */}
          {facts.length > 0 ? (
            <dl className="overview__vessel-facts">
              {facts.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd title={value}>{value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="overview__vessel-empty">
              No call sign, MMSI or home port on file — the gear above opens the
              form.
            </p>
          )}
        </div>
      </div>

      <dl className="overview__specs">
        {specs.map(([label, value]) => (
          <div className="overview__spec" key={label}>
            <dt className="overview__spec-label">{label}</dt>
            <dd className="overview__spec-value">{value}</dd>
          </div>
        ))}
      </dl>

      {missing.length > 0 && facts.length > 0 && (
        <p className="overview__vessel-missing">
          {`Not on file: ${missing.join(", ")}`}
        </p>
      )}

      {editOpen && editable && (
        <AddVesselModal
          editShip={editable}
          onClose={() => setEditOpen(false)}
        />
      )}
    </section>
  );
}

/**
 * The vessel's picture, and the way to put one there: the empty frame is the
 * upload control, so nobody has to find a settings tab to fix the one thing on
 * this page that is obviously missing.
 *
 * The endpoint is not public, so the bytes are fetched with the token and shown
 * from an object URL — which has to be revoked, or every refresh leaks a blob.
 */
function VesselPhoto({
  hasPhoto,
  token,
  shipId,
  canEdit,
}: {
  hasPhoto: boolean;
  token: string | null;
  shipId: string | null;
  canEdit: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [present, setPresent] = useState(hasPhoto);
  const fileInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setPresent(hasPhoto);
  }, [hasPhoto, shipId]);

  useEffect(() => {
    if (!present || !token || !shipId) {
      setUrl(null);
      return;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    void fetchShipPhotoUrl(token, shipId).then((next) => {
      if (cancelled) {
        if (next) URL.revokeObjectURL(next);
        return;
      }
      objectUrl = next;
      setUrl(next);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [present, token, shipId]);

  const onFile = async (file: File | undefined) => {
    if (!file || !token || !shipId) return;
    setBusy(true);
    setError("");
    try {
      await uploadShipPhoto(token, shipId, file);
      // Re-read rather than showing the local file: what the server accepted and
      // stored is the thing worth displaying.
      setPresent(true);
      const next = await fetchShipPhotoUrl(token, shipId);
      setUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!token || !shipId) return;
    setBusy(true);
    setError("");
    try {
      await deleteShipPhoto(token, shipId);
      setUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
      setPresent(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Remove failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overview__photo-wrap">
      <button
        type="button"
        className={`overview__photo${url ? " overview__photo--filled" : ""}`}
        onClick={() => fileInput.current?.click()}
        disabled={!canEdit || busy}
        title={
          canEdit
            ? url
              ? "Replace the photo"
              : "Upload a photo (JPEG, PNG or WebP, up to 8 MB)"
            : "Only an admin can change the photo"
        }
      >
        {url ? (
          <img src={url} alt="" className="overview__photo-img" />
        ) : (
          <span className="overview__photo-label">
            {busy ? "Uploading…" : canEdit ? "Add photo" : "No photo"}
          </span>
        )}
      </button>
      {url && canEdit && (
        <button
          type="button"
          className="overview__photo-remove"
          onClick={() => void remove()}
          disabled={busy}
          title="Remove the photo"
          aria-label="Remove the photo"
        >
          ×
        </button>
      )}
      <input
        ref={fileInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={(e) => {
          void onFile(e.target.files?.[0]);
          // Cleared so picking the same file twice still fires a change.
          e.target.value = "";
        }}
      />
      {error && <p className="overview__photo-error">{error}</p>}
    </div>
  );
}

function CardTile({
  card,
  onOpen,
}: {
  card: OverviewCard;
  onOpen: (section: string | null) => void;
}) {
  const clickable = card.section !== null && isAdminSectionRoute(card.section);
  const classes = [
    "overview__card",
    clickable ? "overview__card--clickable" : "",
    card.degraded ? "overview__card--degraded" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classes}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => onOpen(card.section) : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(card.section);
              }
            }
          : undefined
      }
    >
      <div className="overview__card-head">
        <span className="overview__card-title">{card.title}</span>
        {clickable && (
          <span className="overview__card-go" aria-hidden="true">
            →
          </span>
        )}
      </div>

      <div className="overview__headline">
        <span
          className={`overview__headline-value${
            card.headline === null ? " overview__headline-value--empty" : ""
          }`}
        >
          {card.headline === null ? "—" : fmtNumber(card.headline)}
        </span>
        <span className="overview__headline-label">{card.headlineLabel}</span>
      </div>

      {card.degraded && (
        <div className="overview__degraded-box">
          <span className="overview__degraded-title">Could not be counted</span>
          <p className="overview__degraded-reason">{card.degraded.reason}</p>
          {card.degraded.affects.length > 0 && (
            <p className="overview__degraded-affects">
              Missing: {card.degraded.affects.join(", ")}
            </p>
          )}
        </div>
      )}

      {card.stats.length > 0 && (
        <ul className="overview__stats">
          {card.stats.map((stat) => (
            <li className="overview__stat" key={stat.label}>
              {/* The note hangs off the label itself. A "?" next to every
                  second row turned the card into a field of punctuation, and
                  the label is a wide enough target on its own. */}
              <span
                className={`overview__stat-label${
                  stat.hint ? " overview__stat-label--hinted" : ""
                }`}
                tabIndex={stat.hint ? 0 : undefined}
                role={stat.hint ? "note" : undefined}
              >
                {stat.label}
                {stat.hint && (
                  <span className="overview__hint-bubble">{stat.hint}</span>
                )}
              </span>
              <span
                className={`overview__stat-value overview__stat-value--${stat.tone}`}
              >
                {fmtNumber(stat.value)}
              </span>
            </li>
          ))}
        </ul>
      )}

    </div>
  );
}
