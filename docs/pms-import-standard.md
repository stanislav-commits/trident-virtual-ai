# PMS Import Standard

The single contract between the outside world and Trident's PMS data. Any
source file (another PMS's PDF/CSV/Excel export) is first **reformatted by the
AI into this standard**, reviewed, and only then **imported deterministically**.
Trident's own exports use this format natively (no AI step needed).

```
foreign file (any PMS, PDF/CSV/XLSX)
        │
        ▼  [1] AI reformatter — mapping + repair (foreign files only)
   THIS STANDARD (reviewable)
        │
        ▼  [2] deterministic importer — validate, match, upsert
        database
```

## Identifiers

| id | example | who makes it | purpose |
|---|---|---|---|
| `task_code` | `SWX-M0421` | Trident, on create | our permanent human id: `<ship prefix>-<M\|G><seq>`; M = Maintenance Plan, G = Tasks board |
| `external_ref` | `1P231` | source PMS | idempotency key (re-import **updates** instead of duplicating) and the join key for history records |

The ship prefix comes from the asset register (`SWX.` style majority prefix),
falling back to the ship name's first letters.

## tasks (Maintenance Plan board)

| column | example | notes |
|---|---|---|
| `external_ref` | `1P231` | source Reference ID, verbatim; never invented |
| `asset` | `Castoldi engine` | the specific component |
| `asset_group` | `0331 Tenders` | its system, when the source distinguishes one |
| `counter` | `CASTOLDI` | hour-counter name for hour-based intervals (`50 CASTOLDI` → interval_hours 50, counter CASTOLDI) |
| `task` | `Check zinc anodes` | see naming rules below |
| `category` | `Inspection` | Inspection · Service · Replacement · Overhaul · Lubrication · Test · Cleaning · Calibration · Survey · Repair · Other |
| `responsible` | `Chief Engineer` | a POSITION, never a person; intervals leaked into this column are repaired out |
| `interval_value` + `interval_unit` | `6` + `months` | calendar interval |
| `interval_hours` | `300` | running-hours interval (dual intervals allowed: whichever comes first) |
| `last_done` / `next_due` | `2025-01-30` | ISO dates |
| `status` | `postponed` | free note (e.g. "Scheduled in Flamenco Marina") |
| `description` | numbered checklist | one step per line |
| parts table | Spare Name / Qty / Location / Manufacturer Part# / Supplier Part# | extracted into inventory + linked to the task & asset |

### Naming rules (the AI reformatter MUST apply)

1. Sentence case; marine abbreviations (PS, SB, ER, FW, LO, DPF…), equipment
   codes (EL-11, ACB 531) and part numbers stay uppercase.
2. **Titles are self-sufficient** — they must read correctly without the asset
   column. A bare action gets its component folded in:
   `GREASING` (on Jet Ski Hatch Drive) → `Grease jet ski hatch drive`.
3. Generic hour services take the component:
   `100 HRS SERVICE` (Chase Boat Generator) → `Chase boat generator — 100 h service`.
4. No intervals, dates or reference IDs inside the title — they have fields.
5. Obvious typos are fixed (`CASTPOLDIN` → `Castoldi`); nothing is invented.

### Hour counters

`counter` links an hour-based task to the asset whose running hours drive it.
The asset's hours source is one of the three existing mechanisms
(`asset_hours_config`): direct hours metric, derived from kW load, or a
**manual monthly reading** (auto-creates the "Record running hours" reminder;
logging a reading rolls it forward). If the matched asset has **no** source,
the import review flags it and offers a one-tick switch to manual counting.

## inventory (spare parts / stock)

| column | example | notes |
|---|---|---|
| `name` | `Volvo Penta - Fuel Filter` | |
| `manufacturer` | `VOLVO PENTA` | |
| `manuf_part_no` | `22377272` | **dedup key** — re-import updates the item |
| `supplier` / `suppl_part_no` | `SYS` / `SYS00073554` | |
| `barcode` | `000481321013` | |
| `model` | `D13 C1-A` | |
| `qty` / `min` / `max` / `unit` | `6 / 12 / 24 / pcs` | stock + reorder band |
| `location` | `BOX 24 VOLVO PENTA FUEL FILTERS` | storage place |
| `asset_group` | `0212 ENGINES` | links stock to the register group |
| `value_eur` | `103.49` | unit value |

## history (performed maintenance log)

| column | example | notes |
|---|---|---|
| `external_ref` | `1P26` | **joins the record to its task** |
| `asset` | `Bow thruster SB retracting mechanism` | |
| `date` | `2026-07-11` | idempotency key = `external_ref` + `date` |
| `hour_counter` | `1240` | the counter READING at completion |
| `category` | `Planned Maintenance` | |
| `performed_by` | `Danijel Uremovic` | the actual person (snapshot) |
| `spares_used` | `Impeller kit ×1` | "No spares were used" → empty |
| `description` | work notes | |

## Import guarantees

- **Idempotent**: tasks upsert by `(ship, external_ref)`; inventory by
  `(ship, manuf_part_no)`; history by `(ship, external_ref, date)`.
  Re-importing the same file changes nothing the second time.
- **Reviewed**: the AI's output is always shown as an editable preview before
  commit; unmatched equipment is flagged (create new asset = opt-in per row).
- **Asset matching**: fuzzy token scoring against the register with an LLM
  disambiguation pass; same-named components in different systems stay
  distinct (`hint + group` key).
