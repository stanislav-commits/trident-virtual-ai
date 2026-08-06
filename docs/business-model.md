# Trident Virtual AI — the product, screen by screen and control by control

This is the living map of the product: the business it serves, every surface,
every screen, and every control on every screen. **Anything new — a feature, a
button, a tool, an endpoint — is added here in the same commit that adds it.**
A control that is not written down here is a control nobody outside this
repository knows exists.

Counts throughout are real, read from the working database on 5 August 2026.
They are there to show the shape and the order of magnitude of each thing, not
as a target.

---

## 1. The business

### The problem

A modern yacht is a 500-tonne industrial plant with a hotel on top, run by four
to twenty people, and it is regulated as heavily as a cargo ship while being
crewed like a small business. On Sea Wolf X that means, concretely:

| What has to be known | How much of it |
|---|---|
| Pieces of equipment on board | 1 480 |
| Scheduled maintenance jobs | 550 |
| Spare-part lines | 754 |
| Certificates and compliance records | 108, drawn from a rulebook of 612 document types |
| Live sensor channels | 1 881 |
| Manuals, procedures, forms, drawings | 6 274 files |
| Nodes of flag, class and IMO regulation | 51 241 |

No one holds that. What actually happens is that the chief engineer knows where
most of it is, the master knows the rest, and when either of them leaves, the
vessel loses years of context in a week. Meanwhile the answer to almost every
question a surveyor, a manager or an insurer asks already exists on board — in a
manual, a circular, a PMS record, a sensor trend — and finding it costs an hour.

### What Trident sells

**One place where the vessel's own facts and the rules that bind her are
readable by asking.**

Not a document store, not a PMS, not a monitoring dashboard — those exist and
several are good. The product is the *join*: a question in plain language that
reaches the asset register, the maintenance plan, the certificates, the stock,
the telemetry and 51 000 nodes of regulation in one turn, and comes back with an
answer that names its source.

"When is the liferaft service due, and what does the flag actually require?" is
two systems and a rulebook today. It should be one sentence.

### Who it is for

| Person | What they come for |
|---|---|
| **Master** | Certificate status, port-state requirements, what the flag demands, the overnight picture |
| **Chief engineer** | Machinery history, manual specifications, running hours, alarm causes, what is due |
| **Chief officer** | Deck maintenance, safety equipment schedules, drills, forms and checklists |
| **Chief stewardess / chef** | Their own department's tasks and stock, without the engine room's noise |
| **Shore superintendent / owner's rep** | The state of the vessel without a phone call; spend; what is overdue |
| **Us** | The admin panel: loading, correcting and scoping everything above |

### The four jobs the product does

1. **Answer** — retrieval over the vessel's records and the regulatory library,
   with citations (§3, §6).
2. **Remember** — the registers themselves: assets, PMS, compliance, inventory,
   crew, metrics (§5).
3. **Watch** — telemetry alarms, metric watches, trend warnings, certificate
   expiry, the morning brief (§5.9, §8).
4. **Record** — the crew writes back through the chat: tasks, hours, defects
   (§3.4).

### What makes it defensible

Not the model — that is rented and replaceable. Two things:

- **The library** (§6): 51 000 nodes of flag, class and IMO material, cleaned of
  the font and OCR damage that PDF extraction leaves, structured by each
  publisher's own citation form (RINA `Pt A, Ch 1, Sec 1`, BV `Pt C, Ch 1, Sec 4,
  [1.2]`, DNV `Pt.4 Ch.5 Sec.1`), and scoped so a Malta-flagged, RINA-classed
  vessel is never answered from Bahamas orders.
- **The join and the scoping**: the asset register bound to SFI groups, to
  metrics, to manuals, to certificates and to PMS tasks — so "this pump" means
  one thing across five systems.

Both took months of judgement that does not transfer with a prompt.

### Commercial terms

One vessel in production (Sea Wolf X, Malta flag, RINA class, 499 GT). The code
is fleet-ready throughout: every table is keyed by `ship_id`, every retrieval is
scoped to a vessel, and the admin panel switches vessels at the top. Spend is
metered per vessel, per purpose and per person (§7), which is the mechanism a
per-vessel subscription or a usage tier would bill on.

*Price per vessel, what is included, and what is metered are not in the code and
belong here once agreed.*

---

## 2. Surfaces

| Surface | Who | Where | What it is |
|---|---|---|---|
| **Crew chat** | Master, HODs, crew | Web app, `/` | The product proper: ask, get an answer with sources, record work |
| **Admin panel** | Owner's rep, superintendent, us | Web, `/admin/<section>` | 14 sections; loads, corrects and scopes everything the chat reads |
| **Mobile app** | Crew on deck and in the engine room | React Native, separate repo | Chat, photographs from the camera, alerts and tasks drawers, document viewer |
| **API** | Importers, scripts, integrations | NestJS, `/api` | Everything the UIs use, plus bulk import endpoints |

The mobile app ships over-the-air (EAS) for JavaScript changes and needs a store
build only when native code or the runtime version moves.

---

## 3. Crew chat — the product proper

### 3.1 What happens to a question

1. **Classify** — is this small talk, a metrics question, a documentation
   question, a job to record? (`chat_classify`)
2. **Decompose** — a compound question is split into parts that can be answered
   separately (`chat_decompose`).
3. **Route** — the semantic router picks the responder. Route beats intent: a
   turn carrying a photograph goes to vision even if the words look like a
   documents question.
4. **Answer** — one of eight responders runs, with the tools it is allowed:

   | Responder | Handles |
   |---|---|
   | `small_talk` | Greetings, thanks, conversation about the conversation |
   | `metrics` | Live and historical telemetry; hands the deep questions — correlation, unusual periods, forecasts — to the metric analyzer |
   | `documents` | Manuals, procedures, the knowledge base, the publications library |
   | `pms` | Maintenance plan, tasks, defects, running hours |
   | `compliance` | Certificates, surveys, what the flag and class require |
   | `files` | Handing over an actual file — a form, a drawing, a certificate |
   | `web_search` | Explicitly outside knowledge, or a documented fallback |
   | `in_development` | An honest "not built yet" instead of an invention |

5. **Compose** — the answer is assembled with its sources, sanitised (metrics
   never leak into the Sources list), and blocks are rendered. When a cited
   chunk is a figure description (`[Figure]`, §6), the drawing itself is
   rendered in the answer body — beside the prose that paraphrases it, like a
   chart block — and stays out of the Sources list.

### 3.2 What the assistant can reach — all 54 tools

**Telemetry (13)** — `query_metric`, `run_flux_query`, `forecast_metric`,
`compare_periods`, `correlate_metrics`, `find_unusual_periods`,
`find_threshold_crossings`, `find_metrics_by_intent`, `get_vessel_state`,
`find_voyages`, `find_bunker_events`, `find_event`, `find_active_alarms`

**Derived quantities (8)** — `compute_fuel_per_nm`, `compute_kw_avg_when_state`,
`infer_runtime_from_power`, `find_load_energy_consumed`, `find_running_hours`,
`find_power_consumption_total`, `find_fuel_consumption_total`,
`find_consumable_consumption_total`

**The vessel's own records (17)** — `lookup_asset`, `lookup_asset_fact`,
`aggregate_asset_facts`, `list_assets_by_sfi`, `find_assets_by_function`,
`find_assets_by_location`, `find_asset_metrics`, `compare_to_typical`,
`trace_dependencies`, `get_drawing_ref`, `get_inventory`, `get_crew`,
`find_pms_due`, `get_maintenance_tasks`, `get_inspection_schedule`,
`get_compliance_status`, `find_defects`

**Documents and rules** — retrieval over the knowledge base and the publications
library, plus `lookup_manual_spec` for a figure out of a manual

**Writing back (8)** — `create_maintenance_task`, `complete_maintenance_task`,
`log_hours_reading`, `log_defect`, `close_defect`, `create_metric_watch`,
`list_metric_watches`, `remove_metric_watch`

**Showing (4)** — `render_chart`, `render_table`, `render_kpi`, `render_map`

**Outside (3)** — `web_search`, `reverse_geocode`, `get_marine_forecast` (Windy)

### 3.3 Blocks — answers that are not prose

An answer can carry rendered blocks inline: a **chart** (recharts, with series
combination and legend isolation), a **table**, **KPI cards and rings**, and a
**map** of position fixes with a Windy weather layer. The mobile app renders the
same blocks through a WebView so an answer looks the same in both places.

### 3.4 Writing back — nothing is written silently

A tool that changes the database never fires on the first turn. The assistant
states what it is about to write and waits for a confirmation; a write claimed
in prose without a tool call is caught by a guard and corrected, because
"task created" with no row is worse than no answer.

Who may write is decided by department, not by seniority: an engineer records
engine work. See §4.

### 3.5 Attachments, photographs and voice

The **+** menu attaches a file or a photograph — from the camera, the library,
or the recent-photos strip on mobile. Images are read by vision, and a
photograph plus "this is leaking" produces a defect report with the asset
already linked. Voice notes are transcribed (`chat_transcribe`).

### 3.6 Notifications and the morning brief

The notifications panel carries alarms, certificate reminders and the morning
brief. The brief is deliberately two-stage: at 04:30 UTC a cron posts one
notification saying, in plain deterministic sentences, what happened overnight —
**no model is called**. The full write-up with its KPI cards, tables and charts
is generated only when someone presses the button on that notification, and it
bills to the person who pressed it. A brief nobody reads costs nothing.

### 3.7 Controls in the chat

| Control | What it does |
|---|---|
| Message input | The question. Enter sends |
| **+** Add files or photos | Attach for the next message; images go to vision |
| Remove photo · Remove part | Drops an attachment before sending |
| ✨ Ask AI | Starts a chat from context elsewhere in the app |
| Ask the AI how to do this job | Opens a chat pre-loaded with a task |
| Regenerate response | Re-runs the last turn |
| Copy message | The answer to the clipboard |
| Sources · All sources | The evidence behind the answer |
| Figure block | A cited rulebook drawing, shown in the answer body itself with its rule reference as caption; click opens full size. Kept out of Sources — the drawing is content, not a citation |
| ⤓ Download the original | The source file itself — a form is filled in, not read |
| ↗ Open in a new tab | Opens the document at the cited page |
| Suggested clarification actions | One-tap answers when the assistant asks back |
| Expand map · Zoom in · Zoom out | The map block |
| New chat · Search chats · Recent chats | The chat rail |
| Pinned chat · Chat options · Rename · Delete | Housekeeping |
| Toggle theme · Toggle notifications panel · Toggle upcoming PMS panel | Layout |
| Active vessel · Select active vessel | Which vessel everything is about |
| Admin panel · Logout | Leaving the chat |

**Notifications panel:** Filter by severity · Acknowledge · Ack All · Dismiss ·
Brief · No alarms · This view is clear

**Tasks panel (beside the chat):** Tasks · All tasks · Overdue · Previous week ·
Next week · Pick another date · Perform · Postpone (with a required reason) ·
Note from last completion · Assign to · Department · Priority · Due date ·
Create work order · Add parts · Search inventory

**Quick actions from the chat:** Report defect (what broke, equipment, cause,
immediate action, photo) · Record running hours (hour-counter reading) ·
Create work order (title, description, asset, department, due date)

---

## 4. Who sees what — access control

Access is granted by **position** over **information category**, per vessel.

**Departments (the single taxonomy for the whole app):** Deck · Engine ·
Interior · Galley.

**Positions:** Master · Chief Engineer · Chief Officer · Chief Stewardess ·
Chef · Engine crew · Deck crew · Interior crew · Galley crew.
(`Superintendent` and `Guest` exist internally as derived fallbacks and are not
assignable in the UI.)

**Categories (16, of which 9 are shown as toggles):** Manuals · Forms &
Checklists · Vessel Plans & Drawings · Publications · Compliance Docs · PMS /
Tasks · Metrics · Alarms (metric) · Certificate reminders — plus Equipment
Service, Personnel, Insurance, Legal & Agreements, Records, Reports and the
Asset Register, which gate content behind the scenes at their defaults but are
not offered as switches.

**The cell is a read toggle** — none or read. `write` survives in the enum for
API compatibility only; crew never mutate the database through the matrix, they
do it through confirmed chat writes (§3.4).

**Defaults, before any per-vessel override:**

- Master — everything except the asset register (admin-only)
- Heads of department — operational categories, open compliance, Personnel
  scoped to their own department, certificate reminders; **not** insurance or
  legal
- Crew — operational categories only
- Publications are readable by everyone: fleet regulation is not a secret
- Sensitive compliance — personnel, insurance, legal — is Master and shore only

Per-vessel rows in `access_matrix_cell` override a cell; absence means the
default above.

---

## 5. Admin panel — section by section

Fourteen sections. The vessel switcher at the top scopes all of them. Every
section refreshes itself live: writes are optimistic and a global event bus over
SSE (`admin/events/stream`) pushes changes to every open section, so two people
in the panel see the same thing without reloading.

### 5.1 Overview

The state of the vessel on one screen, counted server-side.

- **Vessel card** — photograph (click to upload, **Remove the photo**), identity
  and certificate facts, **Vessel details & settings** opens the full record.
- **Usage tracking** — spend for the period (§7). **Pick the period** (month to
  date, last month, last 7 / 30 days, custom **From**–**Apply**), **Model
  prices** (what each model costs per million tokens, editable, **Add** a model
  by prefix), the day strip — one bar per day of the month, click a bar to
  narrow every panel below to that day — and four splits: **Who it is for**
  (crew chat versus platform upkeep), by purpose, by person, by model. Clicking
  a row filters the tile to it. **Calls with no price** counts calls whose model
  is not in the price book, deliberately outside the money column so it can
  never be read as a cost.
- **Tiles** — asset register, maintenance plan, tasks, crew, alerts, metrics
  catalog, knowledge base, inventory, compliance documents. Each counts what
  needs attention and opens its section.

### 5.2 Ships

The fleet record: name, IMO number, build year, organization, gross tonnage,
length, flag, class, commercial or private, assigned users.

Two settings decide what the assistant may read for this vessel:
**Flag rules** and **Class register rules** — the dropdowns that select which
shelves of the library answer her (§6), with **Whole library** as the opt-out.

Vessel attributes also drive the compliance rulebook (§5.6): gross tonnage and
length pick the size bucket (<24 m by length, then 24–300, 300–399, 400–499,
500–3000, >3000 GT); the flag picks the registry column (Red Ensign, EU, other);
commercial or private picks the operation column.

Controls: Add ship · Edit · Assigned users · Select destination ship (move a
user) · Stays on this ship.

### 5.3 Users

Who has a login. Add admin · Create new admin · Click to edit name · Role ·
New password / Password reset (with **Copy**) · Delete user. Crew rows and user
rows stay in step: creating a login for a crew member links the two.

### 5.4 Crew

The roster: 9 aboard today. Full name · Rank (pick or type) · Department ·
Email · Phone · Joined · Status (Active aboard) · Notes · certificates, watch
and contract fields.

Controls: Add crew · Edit · Remove · **Create login** (username, password) ·
Revoke · Reset password · **Access control** — the position × category matrix
of §4.

### 5.5 Asset Register

Every piece of equipment on board — 1 480 rows — organised by SFI group
(196 taxonomy rows).

- **Filter by coverage**: missing metrics, missing manual, fully incomplete,
  import complete — the register's own quality report.
- **The drawer** on a row: identity (name, number, brand, model, serial,
  category, location, department, SFI group and sub-group), **Bound metrics**
  (bind metric to this asset / unbind), **Linked manuals** (link / unlink),
  **Compliance records**, **Type approvals**, **Drawings** (click to open the
  drawing), **Running hours** — manual counter or derived from a bound metric,
  baseline hours and date, **Log reading & settings**, **Reading history**,
  service rules, and the change log.
- **Import** from a spreadsheet: preview, then commit. Header and display-name
  matching is normalised; imports never invent assets they were not given.
- **Snapshot / restore**, **Download the full register as an xlsx file**,
  **Add asset**, **Delete asset**, **Clear all assets** (with an explicit
  "this permanently deletes" confirmation).
- Bulk editing across selected rows, including **Empty this field on the
  selected assets**.

### 5.6 Compliance Docs

The doc-control register — 108 records on this vessel — sitting on a
vessel-agnostic master matrix of **612 document types**.

**The rulebook.** Each type in the master declares which vessels it applies to
by size bucket, flag registry and operation. The vessel's own attributes (§5.2)
select her required set automatically, so **Only required** shows what this
vessel must hold rather than everything that exists. Filters: Red Ensign · EU
flag · Other flag · Commercial · Private · Gross tonnage (exact) ·
search by name or code.

**Eleven archetypes**, each with BASE fields plus its own:
STAT_CERT (statutory certificates) · EQUIP_TYPE (type approvals) · EQUIP_SVC
(equipment service records) · PERSONNEL · INSURANCE · LEGAL · AGREEMENT ·
PLAN · PUBLICATION · RECORD_BOOK · REPORT.
BASE fields include document number, issuing party, approval authority and
capacity, issue date, expiry date, anniversary date, survey window, next survey
type, last endorsement date, governing standard, conditions reference.

Per row: **Open fields to view / edit** · **Records on file** · **Open /
preview file** · **+ link / Unlink** (assets and crew) · **Regulatory basis** ·
**How it links to assets** · **Drives a PMS task** · **AI-extracted — confirm**
(a certificate read by the model is *proposed*, never filed silently) ·
**Mark as assessed and clear the flag** · **Put this issue back in force** ·
**Delete record** · **Restore**.

Also: **Log a compliance event** (survey, inspection, audit, deficiency) and the
ingest modal — choose category → document type, doc number, issuing party, issue
date, linked assets.

Expiry drives reminders: a daily job raises certificate notifications before the
date, not after it.

### 5.7 Maintenance Plan · Tasks

Two boards over the same machinery, mirroring the IDEA yacht PMS the crew
already know: **Maintenance Plan** is scheduled work, **Tasks** is everything
else. 550 rows today.

Per task: title · description (what the job involves, parts, notes) · asset ·
category · type · **Department (visibility)** · **Position responsible** · Who ·
Schedule (**Repeat every** N days/months, or **Start from hours** on a counter,
**Start from date**) · Due date · Instructions · **Parts / spares** (search by
name or number, none linked yet → use Edit to attach) · History ·
**Note from last completion**.

Controls: Create task · Edit · **Perform (mark done)** · **Reopen task** ·
**Postpone** (with a required reason and a new due date) · Delete ·
**Auto monthly hours-reading reminder** · **Low confidence — please check** on
an imported or AI-created row.

**Import** carries task codes and references and is idempotent — re-running it
updates rather than duplicates — and, as with assets, **imports never create
assets**.

Running hours are derived from the register binding rather than typed in
wherever a bound metric exists.

### 5.8 Inventory

Stock: 754 lines. Item, part number, manufacturer, supplier, category, group,
location, quantity and unit, min/max, linked assets, linked tasks.

Controls: Add part · **Import stock** (choose a file) · filters by asset,
category, location, manufacturer, supplier and task · search across name,
number, maker, supplier and asset · **Select all** · **Delete selected** ·
Remove · Clear.

### 5.9 Alerts

Alarms from Grafana Cloud evaluating Influx and POSTing to `/api/alerts/grafana`.
57 recorded. Columns: rule, folder, severity, state, started, last fired, value,
linked asset, episodes.

Controls: **All severities / Critical / High / Warning / Info** · **Ack** ·
Refresh · filter rules, folders and assets · click through to the metric and the
asset.

An alarm resolves to a vessel by its `metric_key` label against the metric
catalog, then by `ship_id`, then by single-vessel fallback. Alarms do **not**
auto-create PMS tasks unless `ALERT_AUTO_TASK_SEVERITY` says so — the default is
off, because an alarm storm should not become a task storm.

Related watchers: **metric watches** the crew set from the chat are checked every
5 minutes; **trend warnings** run at 05:00; **certificate reminders** at 06:00.

### 5.10 Knowledge Base

The vessel's own documents — 6 274 files: manuals, procedures, forms and
checklists, circulars, plans and drawings, certificates, reports.

Controls: **Upload documents** · **Search documents by name** ·
**Knowledge Base sections** (the class filter) · **Filter by parse status** ·
paging (Previous / Next page) · **Select all documents on this page** ·
**Delete selected** · per row: Open / preview file · **Rename / edit asset
links** · **Link asset(s)…** · **Parse/index** · Parse error · Remove.

Extraction produces markdown for retrieval and keeps the original file, because
a form has to be handed over as a form. Documents link to assets, and those
links are what makes "the manual for this pump" a resolvable phrase.

### 5.11 Metrics

The Influx catalog — 1 881 channels — and the semantic layer above it
(2 644 concepts).

**Raw catalog view:** key, bucket, field, display name, description, bound
asset. Controls: **Bind this metric to an asset** · **Change asset** ·
**Unbind** · **Click to add description** / **Save description** — what the
metric means in the words the crew use, which is what makes natural-language
lookup work · **Enable all / Disable all** · **All buckets** filter · search by
key, bucket, field or description · paging · **Metrics view** switch (Raw
catalog ↔ Semantic layer).

**Semantic concepts panel:** display name, category, type, unit, aggregation,
resolution, execution, description; **Add metric members** (search by name, key
or bucket) · **New concept** / **Blank concept** / **Choose a starting point** ·
**Refresh concepts** · **Validate phrase** — type a natural-language phrase and
see which concept resolves, without leaving the panel · Remove · Clear.

Scale and unit can be locked (`scale_source = manual`) when an AI label was
wrong — eight fuel-tank channels were labelled temperature and are in fact level
in litres; locking is how that stays fixed.

### 5.12 Publications — the library

The regulatory shelf: 27 publications, 108 shelves, **51 241 nodes**.

- **Rail** — publication → category, each with its node count. **⋯** per row:
  Add a branch… · Rename… · Delete category. **Add publication**.
- **Tree** — click a branch to open it, click a row to preview. **⋯** per row:
  Rename · Add inside · Upload file… · **Parse / Re-parse** · Delete.
  Status shows Parsed / Parsing failed.
- **Preview** — **Original** / **Text** tabs · **⤓ Download the original** ·
  **⤡ Full screen** · **× Close** · **Parse**.
- **Search the library** by title or number; a hit opens the preview.
- **Text review** → the review queue (§5.13).

Each shelf declares whose rules it holds; each vessel declares what she sails
under (§6).

### 5.13 Text review

The queue of rows whose extracted text scored below the quality floor — the
screen that exists because extraction from PDF is not trustworthy and somebody
has to look.

Left: the queue, worst first, rows carrying text before photographs. Middle: the
extracted text, editable. Right: the original — the row's own file, or the book
it belongs to, marked "· the whole document".

| Control | What it does |
|---|---|
| ↑ ↓ ← → | Walks the queue; the window loads more as it goes |
| **Accept** | The text is good as it stands; the row leaves the queue |
| **Save** | Appears when the text is edited; stores the correction |
| **Re-parse** | Reads the file again with vision. Closed when the row has no file of its own |
| **Delete** | Removes the row. Two presses |
| **Back to the library** | Returns |

### 5.14 Not in the navigation

`TagsSection`, `SystemPromptSection` and `PublicationsSection` still exist as
components but are not rendered by `AdminPanelPage` — the tag taxonomy was
folded into the semantic concepts, the system prompt moved into configuration,
and the publications catalog was replaced by the library. They are dead code
awaiting removal, and are listed here so nobody mistakes them for a screen.

---

## 6. The library and how a vessel is scoped

**27 publications:**
flag states — Bahamas, Bermuda, Cayman, Gibraltar, Isle of Man, Malta, Marshall
Islands, UK; class societies — RINA, Bureau Veritas, DNV, Lloyd's Register;
IACS; and the international bodies — IMO, ILO, WHO, SOLAS, MARPOL, STCW,
UNCLOS, Load Lines, Port State Control, EU.

**Scoping.** Each shelf declares whose rules it holds: `flag:MT`, `class:RINA`,
`international`, `eu`. Each vessel declares what she sails under. Retrieval
hands her the international material, her own flag, her own class society, and
the EU shelf if her flag is in the Union — and nothing else. A Malta-flagged,
RINA-classed yacht is never answered from Bahamas orders, and the answer is
shorter and more likely right because of it.

**Structure.** Each publication keeps its publisher's own citation form, so a
cited node is a reference a surveyor recognises rather than a page number in a
PDF.

**Extraction — three engines in turn.** MuPDF first (tables kept cell by cell);
Poppler where the font's character map is broken; OCR where no text layer can be
trusted. Which engine produced each page is stored beside it, because text read
off a picture is not the same claim as text that was in the file. Pages are
scored, and anything below the floor goes to the review queue (§5.13) instead of
into an answer.

Two classes of damage were found and fixed library-wide this way: a Private Use
Area font shift (glyphs landing at ASCII + 0xF000, 4 701 nodes) and Symbol-font
upper-half characters — both invisible in a PDF viewer and both fatal to
retrieval.

---

## 7. The economics, as the product measures them

Every model call is written to `llm_usage` with the vessel, the person, the
purpose, the model, the token counts, the cache split and the computed cost —
18 264 calls recorded so far.

**Purposes (17):**

| Purpose | What it is |
|---|---|
| `chat_answer` | The answer itself |
| `chat_classify` | Routing the turn |
| `chat_decompose` | Splitting a compound question |
| `chat_title` | Naming the conversation |
| `chat_summary` | Conversation memory |
| `chat_vision` | Reading a photograph |
| `chat_transcribe` | A voice note |
| `chat_write_confirm` | Confirming a write |
| `doc_ingest` | Taking a document in |
| `doc_extract` | Pulling text out of it |
| `metric_describe` | Labelling a metric channel |
| `metric_analyze` | Analysis across metrics |
| `alert_analysis` | Explaining an alarm |
| `daily_brief` | The morning write-up |
| `compliance_extract` | Reading a certificate |
| `grafana_assist` | Grafana's own LLM calls |
| `unattributed` | Anything that arrived without context — a bug signal, not a category |

**Two buckets.** *Crew chat* — everything a person asked for, including the
routing and titling around it, and the morning brief when someone presses the
button. *Platform upkeep* — what the system did on its own: ingest, extraction,
metric labelling, alarm analysis. The same total, split three ways (who it is
for, by job, by person), so one morning brief is not read as three charges.

**Model tiering** (since 2026-07-31): Sonnet answers and routes, Haiku runs the
admin panel, nano writes chat titles, an OpenAI-compatible path extracts
documents. No fallback ladders — a silent downgrade is worse than an error.

**Caching** is reported as money saved, with the written / read token split
beside it, because on long documents the cache is most of the bill.

**The price book** is editable in the UI (Model prices, by model prefix, input
and output per million tokens). Calls whose model has no price are counted
separately and never folded into a money figure.

---

## 8. Behind the screens

**Modules** — ships, assets (register + SFI), pms, compliance (doc-control),
documents (knowledge base + publications), metrics (Influx catalog + semantic
concepts + analyzer tools), alerts, chat (orchestration, planning, routing,
responders, context, voice), access-control, crew, inventory, sfi, users, admin,
llm-usage, overview.

**Integrations** — Influx (telemetry), RAGFlow (retrieval and vectors),
Anthropic (answers, vision), an OpenAI-compatible path (extraction), web search,
transcription, Grafana Cloud (alarm evaluation), Windy (marine forecast).

**Scheduled work** — metric watches every 5 minutes · trend warnings 05:00 ·
morning-brief announcement 04:30 UTC · certificate reminders 06:00.

**Storage** — Postgres for everything the product knows (assets, tasks,
compliance, metrics catalog, publications tree with its full text, chat,
usage); RAGFlow holds the vectors; Influx holds the telemetry. Original files
live on the backend disk (DigitalOcean Spaces available, not yet switched on) —
and for the library, **originals are kept only where the file itself is the
deliverable**: forms a user is handed, and figures drawn in the chat. A text
node's original is deleted once its markdown is verified — the text is the
product, and the download archive keeps the source.

**Deployment** — push to `main` deploys production automatically (GitHub Action
→ droplet → build → migrations), about 95 seconds with a ~30 second outage.

---

## 9. How this document is kept

Every change that adds or removes something a user can see gets a line here, in
the commit that makes the change:

- a new button → the control table of its screen (§3.7, §5)
- a new screen → a section under §5
- a new chat tool → the list in §3.2
- a new responder or route → §3.1
- a new access category or position → §4
- a new publication or shelf → §6
- a new billed purpose → §7
- a new integration or scheduled job → §8

If a change makes a line here false, fix the line. The document is worth exactly
as much as its agreement with the code.
