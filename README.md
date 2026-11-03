# Propane morning audit (sample)

A morning reconciliation for a propane distributor, run on one **fictional** week (Monday 26 to Friday 30 October 2026, El Paso). Truck meter registers, Cargas exports, QuickBooks Online query results, card settlements, POS exports and plant gauge sheets go in. Out comes the report a manager would read at 06:00: figures of the day, then dossiers sorted into *needs a person*, *cannot conclude yet* and *explained by a record*, each with its records and the arithmetic of the rule that raised it.

- Live page: https://theaipipe.com/demos/propane-morning-audit/ (runs this engine in the browser on the files in `fixtures/`; deployed by hand with `npx wrangler deploy`, CI does not deploy)
- Run everything: `npm run check` (Node 22 or later, no dependency): rebuilds the fictional files, checks they did not change, runs the tests.

Everything in `fixtures/` is invented: Sample Propane Co., every customer, dealer, truck, ticket and amount. Export formats on the Cargas and POS side are **assumptions**, to be aligned with a real installation. QuickBooks files follow the shape of its public Accounting API (`JournalEntry`, `Deposit`).

## How the numbers are validated

1. **Exact arithmetic.** Gallons are integers in tenths, money in cents, unit prices in thousandths (`src/util.js`). Rounding is written where it happens (gallons x price, half up). A value that cannot be read (a price, a gallon figure, an unknown account, a quantity whose base is not net at 60 °F) stops its check, or the line it was on, and the dossier says which value; it never becomes zero (`tests/guards.test.js`).
2. **Expected results written first, by hand.** `expected/cases.json` holds 10 situations the engine must find (among them a card deposit whose difference the fee explains, a meter totalizer 12.4 gal ahead of its tickets and a ticket number missing from a meter register), 15 it must leave quiet (a PreBuy price, an approved discount, a voided and replaced transaction, a file received twice, a late posting, a rent not yet due, a waived rent, a day when truck meter temperatures run from 46 °F to 86 °F...) and 5 where it must refuse to conclude. The arithmetic is in the file. `tests/cases.test.js` replays each one, checks the qualification, the amount and the records cited, and fails on any finding outside the planted cases. This proves behaviour on these named situations, not an absence of false alarms in general.
3. **Properties and guards.** `tests/properties.test.js` and `tests/guards.test.js`: trucks never loaded above 85 % of their tank; ten distinct accounts per truck and day; a PreBuy customer billed above the locked price is reported; the POS export is held against the register close on amounts as well as receipts; a settlement whose net does not follow from gross and fee explains nothing; a cage counted without its movements cannot conclude; ingesting every file a second time creates nothing; removing a source suspends exactly the checks that need it; changing one amount in a source changes the result; a voided transaction and its replacement count once while two active ones are reported; a gauge reading with an unknown temperature base is never corrected.
4. **Accounts, not totals.** A QuickBooks journal entry can balance, match the Cargas total and still be wrong. The GL check compares the batch account by account (Tuesday's planted case).

## Traceability

Every dossier carries the records it rests on (file, row, time received), the rule's plain statement and formula, and its worked arithmetic. Every quantity keeps its unit, base (net at 60 °F, or unknown), origin (meter, gauge, bill of lading), time and file.

The morning note is written by code from fixed templates that quote dossier fields, never by a model. `verifySummary()` in `src/summary.js` is a **reference check**: each figure, identifier and business name in a sentence must belong to the dossier it cites, the sentence must carry that dossier's qualification, and words such as *loss* or *theft* are refused. `tests/summary.test.js` replays ten plausible wrong sentences that it refuses (an amount from another dossier, the wrong truck, two deposits added together, another customer, another day...). It does not check meaning: two figures swapped inside one sentence still pass, and a test records that limit. So it is not enough to validate free text written by a model. If Claude writes the note in a pilot, the next step is structured assertions (dossier, field, unit, period, qualification) that the code checks before the sentence is shown.

Meter totalizers are **net at 60 °F**, like the tickets; `METER_BALANCE` stops if a totalizer or ticket carries another base.

## Missing, stale and incomplete data

| Situation | What the run does |
|---|---|
| File not received | Checks that need it are suspended, its figures marked unavailable |
| File received today but covering an earlier day | Stale: freshness is judged on the period covered, not the file date |
| Rows or control totals differ from the export trailer | Incomplete: nothing from the file is counted |
| No trailer at all | Completeness not established |
| Same file received twice | Second copy ignored |
| Export re-sent for the same day | The later one replaces the earlier one |
| POS export without its register close | Counter totals marked partial, counter checks suspended |
| POS export whose amounts differ from the register close | Not used: counter totals unavailable |
| Cage counted but no movements file (or the reverse) | Cannot conclude, never a check that disappears |
| Ticket missing from posted transactions while its route is still open | Pending, re-examined at the next run |

A job that never starts cannot alert anyone. The pilot needs a separate watchdog that notices the missing success; `examples/run_journal.json` shows what the journal and that alert would look like.

## Systems without a suitable API

QuickBooks Online is read through its public Accounting API. For Cargas, whether an API or a scheduled export (saved queries dropped at a fixed time) is available on a given installation, with its licences and permissions, has to be confirmed. The engine only needs each file to state its period and, where the system provides them, control totals. A manual export is enough to reconcile a first real day; it is not yet an automated report.

## Rules

| Rule | Checks |
|---|---|
| `METER_BALANCE` | Net totalizer end minus start equals the sum of net tickets, per truck, within 0.5 gal |
| `METER_SEQUENCE` | No gap in meter ticket numbers, within the day and from the previous day |
| `TICKET_POSTED` | Every metered ticket is among the posted transactions once its route is closed and the posting deadline has passed |
| `POSTED_MATCH` | Every posted delivery has its meter ticket, same net gallons; late postings matched to their day |
| `ACTIVE_ONCE` | One active transaction per ticket; voids and replacements count once |
| `PRICE_PLAN` | A price below plan is covered by a PreBuy contract or a recorded approval; a PreBuy customer is not billed above the locked price |
| `GL_BATCH_TO_QBO` | The Cargas GL batch holds the day's transactions and matches its QuickBooks JournalEntry account by account |
| `PAYMENTS_IN_DEPOSITS` | Payments add up to their Cargas deposit |
| `DEPOSIT_TO_QBO` | Cargas deposit matches the QuickBooks Deposit; a card fee explains a difference only when settlement gross, fee and net, the deposit and its fee line all agree |
| `POS_CASH_TO_QBO` | Register close cash matches the cash deposit booked (convention of the sample: all the cash of a close in one deposit) |
| `POS_CARD_TO_SETTLEMENT` | Register close card total matches its settlement and deposit |
| `BULK_BALANCE` | Storage and trucks balance in net gallons within a gauge tolerance; loads to trucks cancel out; an unknown base stops the check |
| `CAGE_COUNT` | Dealer cage: previous count + delivered - exchanged - sold without return = counted (consignment) |
| `LEASE_BILLED` | Tank rent billed in the last billing cycle that has closed, unless waived or not yet due |

Tax amounts are copied from the records as they are; autogas and interstate tax calculation is out of scope. Gross margin is not calculated: the sample has no cost method. There is no bank statement in the sample, so deposits are matched to QuickBooks, which is not a bank reconciliation.

## Layout

`src/`: the engine, same files in Node and in the page. `fixtures/`: fictional files and their arrival times, written by `scripts/make-fixtures.mjs`. `expected/`: hand-written cases. `tests/`. `site/`: the page (`npm run build` copies the engine and files into it).

Built by Frederic de Lavenne de Choulot, The AI Pipe. A 15-minute call: https://cal.theaipipe.com
