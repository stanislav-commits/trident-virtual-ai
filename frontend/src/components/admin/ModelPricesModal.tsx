import { useCallback, useEffect, useState } from "react";
import {
  deleteModelPrice,
  getModelPrices,
  saveModelPrice,
  type ModelPrice,
} from "../../api/overviewApi";

/**
 * The rate card behind every figure on the usage card.
 *
 * Two numbers per model, the ones printed on a provider's pricing page. The
 * cache rates are not editable: they are fixed ratios of the input rate in the
 * provider's own billing (a 5-minute cache write is 1.25x input, an hour is 2x,
 * a read is 0.1x), so asking for five numbers would only invite three of them
 * to be wrong.
 *
 * A rate change applies to the NEXT call. Everything already recorded keeps the
 * rate it was charged at, which is why last month's invoice does not move when
 * a price goes up today — the note under the table says so, because that is the
 * first question anyone asks before touching this.
 */
export function ModelPricesModal({
  token,
  onClose,
}: {
  token: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<ModelPrice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ prefix: "", input: "", output: "" });

  const load = useCallback(async () => {
    try {
      setRows(await getModelPrices(token));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async (fn: () => Promise<ModelPrice[]>) => {
    setBusy(true);
    try {
      setRows(await fn());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveRow = (row: ModelPrice, input: string, output: string) => {
    const nextIn = Number(input);
    const nextOut = Number(output);
    if (!Number.isFinite(nextIn) || !Number.isFinite(nextOut)) {
      setError("Both rates have to be numbers.");
      return;
    }
    if (nextIn === row.inputPerMTok && nextOut === row.outputPerMTok) return;
    void run(() =>
      saveModelPrice(token, {
        modelPrefix: row.modelPrefix,
        inputPerMTok: nextIn,
        outputPerMTok: nextOut,
        // Carried through untouched: this row's rate is edited in its own
        // field, and a token edit must not silently drop it.
        perMinuteUsd: row.perMinuteUsd,
        note: row.note,
      }),
    );
  };

  const addRow = () => {
    const prefix = draft.prefix.trim().toLowerCase();
    const input = Number(draft.input);
    const output = Number(draft.output);
    if (!prefix) {
      setError("A model prefix is required.");
      return;
    }
    if (!Number.isFinite(input) || !Number.isFinite(output)) {
      setError("Both rates have to be numbers.");
      return;
    }
    void run(async () => {
      const next = await saveModelPrice(token, {
        modelPrefix: prefix,
        inputPerMTok: input,
        outputPerMTok: output,
      });
      setDraft({ prefix: "", input: "", output: "" });
      return next;
    });
  };

  return (
    <div className="prices__backdrop" onClick={onClose}>
      <div
        className="prices"
        role="dialog"
        aria-label="Model prices"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="prices__head">
          <h3 className="prices__title">Model prices</h3>
          <button
            type="button"
            className="prices__close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <p className="prices__lede">
          USD per million tokens, or per minute for the models that bill on
          audio. A change applies to the next call — everything already recorded
          keeps the rate it was charged at, so past reports do not move.
        </p>

        {error && <p className="prices__error">{error}</p>}

        {rows == null ? (
          <p className="prices__note">Loading…</p>
        ) : (
          <table className="prices__table">
            <thead>
              <tr>
                <th>Model prefix</th>
                <th>Input</th>
                <th>Output</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <PriceRow
                  /* The saved rates are part of the key, so a row that comes
                     back changed is a fresh row with fresh fields — no effect
                     copying props into state behind the operator's cursor. */
                  key={`${row.modelPrefix}:${row.inputPerMTok}:${row.outputPerMTok}`}
                  row={row}
                  busy={busy}
                  onSave={saveRow}
                  onDelete={() =>
                    void run(() => deleteModelPrice(token, row.modelPrefix))
                  }
                />
              ))}
              <tr className="prices__row prices__row--new">
                <td>
                  <input
                    className="prices__input"
                    placeholder="claude-opus-5"
                    value={draft.prefix}
                    onChange={(e) =>
                      setDraft({ ...draft, prefix: e.target.value })
                    }
                  />
                </td>
                <td>
                  <input
                    className="prices__input prices__input--rate"
                    inputMode="decimal"
                    placeholder="5"
                    value={draft.input}
                    onChange={(e) =>
                      setDraft({ ...draft, input: e.target.value })
                    }
                  />
                </td>
                <td>
                  <input
                    className="prices__input prices__input--rate"
                    inputMode="decimal"
                    placeholder="25"
                    value={draft.output}
                    onChange={(e) =>
                      setDraft({ ...draft, output: e.target.value })
                    }
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="prices__add"
                    disabled={busy}
                    onClick={addRow}
                  >
                    Add
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        )}

        <p className="prices__note">
          A model matches the longest prefix that fits its name, so
          <code> claude-sonnet-4</code> covers every dated build of it. A model
          matching nothing here is recorded without a cost and counted as
          unpriced on the card.
        </p>
      </div>
    </div>
  );
}

/** One rate, saved when the field loses focus — no Save button per row. */
function PriceRow({
  row,
  busy,
  onSave,
  onDelete,
}: {
  row: ModelPrice;
  busy: boolean;
  onSave: (row: ModelPrice, input: string, output: string) => void;
  onDelete: () => void;
}) {
  const [input, setInput] = useState(String(row.inputPerMTok));
  const [output, setOutput] = useState(String(row.outputPerMTok));

  return (
    <tr className="prices__row">
      <td>
        <span className="prices__prefix">{row.modelPrefix}</span>
        {row.note && <span className="prices__source">{row.note}</span>}
      </td>
      <td>
        <input
          className="prices__input prices__input--rate"
          inputMode="decimal"
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onBlur={() => onSave(row, input, output)}
        />
      </td>
      <td>
        {row.perMinuteUsd == null ? (
          <input
            className="prices__input prices__input--rate"
            inputMode="decimal"
            value={output}
            disabled={busy}
            onChange={(e) => setOutput(e.target.value)}
            onBlur={() => onSave(row, input, output)}
          />
        ) : (
          <span className="prices__per-minute">
            ${row.perMinuteUsd}/min
          </span>
        )}
      </td>
      <td>
        <button
          type="button"
          className="prices__remove"
          disabled={busy}
          onClick={onDelete}
          title={`Stop pricing ${row.modelPrefix}`}
        >
          ×
        </button>
      </td>
    </tr>
  );
}
