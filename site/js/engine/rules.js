// The reconciliation rules. Each one states the sources it needs; when one of them is missing, stale or
// incomplete the engine does not run the rule and says so (see engine.js). Every line a rule returns carries
// its status, a qualification, the fields its sentence may quote, the records it rests on, and its arithmetic.
//
// status: pass | flag (needs a person) | explained (a difference fully accounted for by a document) | pending (not concluded yet)
// qualification: billing_to_verify | accounting_difference | settlement_pending | quantity_to_confirm | explained | not_concluded
import { tenths, cents, mills, extend, fmtUsd, fmtGal, fmtPrice, fmtDay, fmtStamp, sum, DataError, need } from './util.js';

const gal = (t) => (t / 10).toFixed(1);
// one line per scope: a value it cannot read stops that line only, never becomes a number
function perScope(scope, fn) {
  try { return { scope, ...fn() }; } catch (e) {
    if (!(e instanceof DataError)) throw e;
    return { scope, status: 'suspended', cause: 'data', qualification: 'not_concluded', headline: `Cannot conclude for ${scope}: ${e.message}`, action: 'Correct or re-send the record; the check runs again with it.', fields: { scope: String(scope), reason: e.message }, calc: [['Value needed', e.message, true], ['Result', 'not concluded', true]] };
  }
}

export const POSTING_DEADLINE = '20:00';         // fictional house rule: a closed route is posted the same evening
export const METER_TOLERANCE = 5;                // tenths of a gallon per route (0.5 gal), to agree with the meter practice
export const BULK_TOLERANCE = 4500;              // tenths (450.0 gal) on plant + trucks, demo value to set from the real gauges

const meterCols = ['Ticket', 'Time', 'Account', 'Gross gal', 'Net gal at 60 °F', 'Temp °F'];
const meterCells = (r) => [r.ticket_no, r.time, r.account, r.gross_gal, r.net_gal, r.temp_f];
const card = (o) => ({ rows: [], foot: [], ...o });
const fileOf = (f) => ({ file: f.path, received_at: f.received_at });

function trucksIn(meter) {
  const by = {};
  for (const r of meter.rows) (by[r.truck] ||= []).push(r);
  return Object.entries(by).map(([truck, rows]) => ({
    truck, rows,
    start: rows.find((r) => r.record === 'SHIFT_START'), end: rows.find((r) => r.record === 'SHIFT_END'),
    tickets: rows.filter((r) => r.record === 'TICKET' && r.status !== 'VOID'),
  }));
}
const activeRows = (posted) => posted.rows.filter((r) => r.status !== 'VOID');
function planPrice(ctx, account, date) {
  const cust = ctx.customer(account); if (!cust) return null;
  let p = null; for (const r of ctx.ref('price_plans')) if (r.plan === cust.price_plan && r.effective_from <= date) p = mills(r.price_per_gal);
  return p;
}
const revenueAccount = (ctx, account) => (ctx.customer(account)?.type === 'RES' ? '4010' : '4020');

export const RULES = [
  {
    id: 'METER_BALANCE', title: 'Truck meter balances its tickets',
    plain: 'For each truck and route, the net totalizer at 60 °F at the end minus the one at the start must equal the sum of the net tickets printed, within a written tolerance. A totalizer or ticket whose base is not net at 60 °F stops the check.',
    formula: '(net totalizer end - net totalizer start) - sum(ticket net gallons), tolerance 0.5 gal',
    sources: ['meter_register'],
    run(ctx) {
      const m = ctx.src('meter_register');
      return trucksIn(m).map((t) => perScope(t.truck, () => {
        need(t.start, `no shift start on the ${t.truck} register`); need(t.end, `no shift end on the ${t.truck} register`);
        for (const r of [t.start, t.end, ...t.tickets]) if (r.base !== 'NET60') throw new DataError(`${r.record === 'TICKET' ? `ticket ${r.ticket_no}` : 'totalizer'} on ${t.truck} has base ${r.base || 'unknown'}, not net at 60 °F`);
        const s0 = need(tenths(t.start.totalizer_gal), `start totalizer of ${t.truck} unreadable`); const s1 = need(tenths(t.end.totalizer_gal), `end totalizer of ${t.truck} unreadable`);
        const tk = sum(t.tickets, (r) => need(tenths(r.net_gal), `ticket ${r.ticket_no} gallons unreadable`)); const run = s1 - s0; const diff = run - tk;
        const calc = [['Net totalizer at 60 °F, start', fmtGal(s0)], ['Net totalizer at 60 °F, end', fmtGal(s1)], ['Metered on the route', fmtGal(run)], [`Sum of ${t.tickets.length} net tickets`, fmtGal(tk)], ['Difference', fmtGal(diff), true], ['Tolerance', fmtGal(METER_TOLERANCE)]];
        if (Math.abs(diff) <= METER_TOLERANCE) return { status: 'pass', calc };
        return {
          status: 'flag', qualification: 'quantity_to_confirm', qty: diff,
          headline: `Truck ${t.truck}: ${fmtGal(Math.abs(diff))} ${diff > 0 ? 'metered with no ticket' : 'more on tickets than on the meter'}`,
          action: 'Check the meter for an unprinted or voided ticket, a proving run or a product transfer that was not recorded.',
          fields: { truck: t.truck, diff: fmtGal(Math.abs(diff)), run: fmtGal(run), tickets: fmtGal(tk), count: String(t.tickets.length), period: fmtDay(ctx.day) },
          quantity: { value: fmtGal(diff), base: 'net at 60 °F', origin: `truck meter ${t.truck}, totalizer`, at: `${fmtDay(ctx.day)}, ${t.end.time}`, source: m.path },
          calc,
          evidence: [card({ system: 'Truck meter', style: 'tape', title: `Meter register, truck ${t.truck}`, ...fileOf(m), columns: meterCols, rows: t.tickets.map((r) => ({ cells: meterCells(r) })),
            foot: [['Net totalizer at 60 °F, start', t.start.totalizer_gal], ['Net totalizer at 60 °F, end', t.end.totalizer_gal], ['Sum of net tickets', gal(tk)]] })],
        };
      }));
    },
  },
  {
    id: 'METER_SEQUENCE', title: 'No gap in meter ticket numbers',
    plain: 'Ticket numbers printed by each truck meter must follow each other with no gap, inside the day and from the last ticket of the previous register when there is one.',
    formula: 'ticket(n+1) = ticket(n) + 1, first ticket = last ticket of the previous register + 1',
    sources: ['meter_register'],
    run(ctx) {
      const m = ctx.src('meter_register'); const prev = ctx.previous('meter_register');
      return trucksIn(m).map((t) => perScope(t.truck, () => {
        const nos = t.rows.filter((r) => r.record === 'TICKET').map((r) => need(Number(r.ticket_no) || null, `a ticket number on ${t.truck} is unreadable`)).sort((a, b) => a - b);
        if (!nos.length) return { status: 'pass', calc: [['Tickets', 'none today']] };
        const gaps = [];
        for (let i = 1; i < nos.length; i++) for (let n = nos[i - 1] + 1; n < nos[i]; n++) gaps.push(n);
        const prevNos = prev ? prev.rows.filter((r) => r.truck === t.truck && r.record === 'TICKET').map((r) => Number(r.ticket_no)) : [];
        const prevLast = prevNos.length ? Math.max(...prevNos) : null;
        if (prevLast && nos[0] > prevLast + 1) for (let n = prevLast + 1; n < nos[0]; n++) gaps.unshift(n);
        const calc = [['First and last ticket', `${nos[0]} to ${nos[nos.length - 1]}`], ['Last ticket of the previous register', prevLast ? String(prevLast) : 'not available'], ['Numbers missing', gaps.length ? gaps.join(', ') : 'none', true]];
        if (!gaps.length) return { status: 'pass', calc };
        const list = gaps.join(', ');
        return {
          status: 'flag', qualification: 'quantity_to_confirm',
          headline: `Truck ${t.truck}: ticket number ${list} missing from the meter register`,
          action: 'Find the printed ticket or the void record for this number; until then the gallons it may carry are unknown.',
          fields: { truck: t.truck, gaps: list, first: String(nos[0]), last: String(nos[nos.length - 1]), count: String(gaps.length), period: fmtDay(ctx.day) },
          calc,
          evidence: [card({ system: 'Truck meter', style: 'tape', title: `Meter register, truck ${t.truck}`, ...fileOf(m), columns: meterCols,
            rows: t.rows.filter((r) => r.record === 'TICKET').flatMap((r) => { const n = Number(r.ticket_no); const out = gaps.filter((g) => g === n - 1 && !nos.includes(g)).map((g) => ({ cells: [String(g), '', '', '', 'no record', ''], mark: 'ghost' })); return [...out, { cells: meterCells(r) }]; }) })],
        };
      }));
    },
  },
  {
    id: 'TICKET_POSTED', title: 'Every metered delivery is posted in Cargas',
    plain: 'Each ticket printed by a truck meter must appear among the transactions posted in Cargas. A ticket is reported only once its route is closed, the posted export is complete and the posting deadline has passed; before that, it is pending.',
    formula: 'meter tickets - posted tickets (same truck and ticket number), after route closed and posting deadline',
    sources: ['meter_register', 'cargas_routes', 'cargas_posted'],
    run(ctx) {
      const m = ctx.src('meter_register'); const posted = ctx.src('cargas_posted'); const routes = ctx.src('cargas_routes');
      const have = new Set(activeRows(posted).map((r) => `${r.truck}|${r.ticket_no}`));
      const deadline = `${ctx.day}T${POSTING_DEADLINE}`;
      return trucksIn(m).map((t) => perScope(t.truck, () => {
        const missing = t.tickets.filter((r) => !have.has(`${t.truck}|${r.ticket_no}`));
        const route = routes.rows.find((r) => r.truck === t.truck);
        const calc = [['Tickets on the meter', String(t.tickets.length)], ['Found among posted transactions', String(t.tickets.length - missing.length)], ['Route', route ? `${route.route_id} ${route.status}${route.closed_at ? `, closed ${route.closed_at.slice(11)}` : ''}` : 'no route record'], ['Posted export generated', fmtStamp(posted.meta.generated)], ['Posting deadline', `${fmtDay(ctx.day)}, ${POSTING_DEADLINE}`]];
        const evidence = (ghostMark) => [
          card({ system: 'Truck meter', style: 'tape', title: `Meter register, truck ${t.truck}`, ...fileOf(m), columns: meterCols,
            rows: t.tickets.map((r) => ({ cells: meterCells(r), mark: missing.includes(r) ? 'hit' : null })),
            foot: [['Net totalizer at 60 °F, start', t.start?.totalizer_gal ?? 'none'], ['Net totalizer at 60 °F, end', t.end?.totalizer_gal ?? 'none']] }),
          card({ system: 'Cargas Energy (assumed export)', style: 'sheet', title: `Posted transactions, truck ${t.truck}`, ...fileOf(posted), columns: ['Txn', 'Ticket', 'Account', 'Net gal', 'Price', 'Amount', 'Status'],
            rows: [...posted.rows.filter((r) => r.truck === t.truck).map((r) => ({ cells: [r.txn_id, r.ticket_no, r.account, r.net_gal, r.unit_price, r.amount, r.status], mark: r.status === 'VOID' ? 'void' : null })),
              ...missing.map((r) => ({ cells: ['', r.ticket_no, r.account, r.net_gal, '', '', ghostMark], mark: 'ghost' }))],
            foot: [['Export trailer', `${posted.trailer?.rows} rows, ${posted.rows.length} received`]] }),
          ...(route ? [card({ system: 'Cargas Energy (assumed export)', style: 'slip', title: `Route ${route.route_id}`, ...fileOf(routes), columns: ['Truck', 'Driver', 'Status', 'Opened', 'Closed'],
            rows: [{ cells: [route.truck, route.driver, route.status, route.opened_at?.slice(11), route.closed_at ? route.closed_at.slice(11) : 'not closed'], mark: 'hit' }] })] : []),
        ];
        if (!missing.length) return { status: 'pass', calc };
        const list = missing.map((r) => r.ticket_no).join(', ');
        if (!route) {
          return { status: 'pending', qualification: 'not_concluded', calc, headline: `Ticket ${list} not posted, and the routes export has no route for truck ${t.truck}`,
            action: 'Find the route this truck ran under; the ticket is examined again once the route is known and closed.', fields: { tickets: list, truck: t.truck, period: fmtDay(ctx.day) }, evidence: evidence('not posted') };
        }
        if (route.status !== 'CLOSED') {
          return { status: 'pending', qualification: 'not_concluded', calc,
            headline: `Ticket ${list} not posted yet: route ${route.route_id} still open`,
            fields: { route: route.route_id, tickets: list, truck: t.truck },
            evidence: evidence('not posted, route open') };
        }
        if (!(posted.meta.generated >= deadline && ctx.runAt >= deadline)) {
          return { status: 'pending', qualification: 'not_concluded', calc, headline: `Ticket ${list} not posted before the export`, fields: { tickets: list, truck: t.truck }, evidence: evidence('not posted') };
        }
        const est = missing.map((r) => {
          const g = need(tenths(r.net_gal), `gallons of ticket ${r.ticket_no} unreadable`);
          const price = need(planPrice(ctx, r.account, ctx.day), `no plan price for account ${r.account} on ticket ${r.ticket_no}`);
          return { r, g, price, cents: extend(g, price) };
        });
        const amount = sum(est, (e) => e.cents); const one = missing[0];
        return {
          status: 'flag', qualification: 'billing_to_verify', amount,
          headline: `Ticket ${list} absent from the posted transactions examined after the scheduled close`,
          action: 'Check how this ticket was processed in Cargas (held, unsynced, or entered under another ticket number).',
          fields: { ticket: list, truck: t.truck, net: fmtGal(sum(est, (e) => e.g)), time: one.time, account: one.account, deadline: POSTING_DEADLINE, exported: posted.meta.generated.slice(11, 16), route: route.route_id, closed: route.closed_at.slice(11), price: fmtPrice(est[0].price), amount: fmtUsd(amount), period: fmtDay(ctx.day) },
          quantity: missing.length === 1 ? { value: fmtGal(est[0].g), base: 'net at 60 °F', origin: `truck meter, ticket ${one.ticket_no}`, at: `${fmtDay(ctx.day)}, ${one.time}`, source: m.path } : undefined,
          calc: [...calc, ['Not found', list, true], ...est.map((e) => [`Ticket ${e.r.ticket_no} at plan price`, `${fmtGal(e.g)} x ${fmtPrice(e.price)} = ${fmtUsd(e.cents)}`, true]), ...(est.length > 1 ? [['Total to verify', fmtUsd(amount), true]] : [])],
          evidence: evidence('not posted'),
        };
      }));
    },
  },
  {
    id: 'POSTED_MATCH', title: 'Every posted delivery has its meter ticket',
    plain: 'Each posted delivery must match a ticket of the same truck and number on a meter register, with the same net gallons. A ticket from an earlier day posted late is matched to that day\'s register.',
    formula: 'posted net gallons = metered net gallons (same truck, ticket number)',
    sources: ['cargas_posted', 'meter_register'],
    run(ctx) {
      const posted = ctx.src('cargas_posted');
      return activeRows(posted).map((r) => perScope(r.txn_id, () => {
        const reg = ctx.register(r.delivery_date);
        const tk = reg?.rows.find((x) => x.record === 'TICKET' && x.truck === r.truck && x.ticket_no === r.ticket_no);
        if (!tk) return { scope: r.txn_id, status: 'flag', qualification: 'quantity_to_confirm', headline: `Transaction ${r.txn_id} has no meter ticket`, fields: { txn: r.txn_id, ticket: r.ticket_no, truck: r.truck } };
        const d = need(tenths(r.net_gal), `posted gallons of ${r.txn_id} unreadable`) - need(tenths(tk.net_gal), `meter gallons of ticket ${r.ticket_no} unreadable`);
        if (d) return { scope: r.txn_id, status: 'flag', qualification: 'quantity_to_confirm', qty: d, headline: `Ticket ${r.ticket_no}: posted gallons differ from the meter`, fields: { ticket: r.ticket_no, diff: fmtGal(d) } };
        if (r.delivery_date < ctx.day) {
          return {
            scope: r.txn_id, status: 'explained', qualification: 'explained',
            headline: `Ticket ${r.ticket_no} from ${fmtDay(r.delivery_date)} posted late, matched to its meter ticket`,
            fields: { ticket: r.ticket_no, delivered: fmtDay(r.delivery_date), posted: fmtStamp(r.posted_at), net: fmtGal(tenths(r.net_gal)), txn: r.txn_id, truck: r.truck },
            calc: [['Delivered', `${fmtDay(r.delivery_date)}, ${tk.time}`], ['Posted', fmtStamp(r.posted_at)], ['Meter net', fmtGal(tenths(tk.net_gal))], ['Posted net', fmtGal(tenths(r.net_gal))], ['Result', 'matched, posted late', true]],
            evidence: [
              card({ system: 'Truck meter', style: 'tape', title: `Meter register, truck ${r.truck}, ${fmtDay(r.delivery_date)}`, ...fileOf(reg), columns: meterCols, rows: [{ cells: meterCells(tk), mark: 'hit' }] }),
              card({ system: 'Cargas Energy (assumed export)', style: 'sheet', title: `Posted transaction ${r.txn_id}`, ...fileOf(posted), columns: ['Txn', 'Posted', 'Delivered', 'Ticket', 'Net gal', 'Amount'], rows: [{ cells: [r.txn_id, r.posted_at.replace('T', ' '), r.delivery_date, r.ticket_no, r.net_gal, r.amount], mark: 'hit' }] }),
            ],
          };
        }
        return { scope: r.txn_id, status: 'pass' };
      }));
    },
  },
  {
    id: 'ACTIVE_ONCE', title: 'A voided or replaced transaction counts once',
    plain: 'Each ticket has exactly one active posted transaction. A voided transaction and its replacement count as one; two active transactions for one ticket are reported.',
    formula: 'count(active transactions per ticket) = 1; "replaces" points to a voided transaction',
    sources: ['cargas_posted'],
    run(ctx) {
      const posted = ctx.src('cargas_posted'); const by = {};
      for (const r of posted.rows) (by[`${r.truck}|${r.ticket_no}`] ||= []).push(r);
      return Object.entries(by).map(([k, rows]) => {
        const act = rows.filter((r) => r.status !== 'VOID'); const ticket = k.split('|')[1];
        const badReplace = act.some((r) => r.replaces && !rows.find((x) => x.txn_id === r.replaces && x.status === 'VOID'));
        if (act.length === 1 && !badReplace) return { scope: ticket, status: 'pass', note: rows.length > 1 ? `${rows.filter((r) => r.status === 'VOID').map((r) => r.txn_id).join(', ')} voided, ${act[0].txn_id} active` : '' };
        const extra = sum(act.slice(1), (r) => cents(r.amount));
        return { scope: ticket, status: 'flag', qualification: 'billing_to_verify', amount: extra, headline: `Ticket ${ticket} has ${act.length} active transactions`, fields: { ticket, count: String(act.length), amount: fmtUsd(extra) } };
      });
    },
  },
  {
    id: 'PRICE_PLAN', title: 'Price below plan needs a contract or an approval',
    plain: 'A delivery posted below the customer\'s plan price on the delivery date must be covered by a PreBuy contract (same account, dates, price, gallons left) or a recorded approval for that ticket. A customer with an active PreBuy contract billed above the locked price is reported too. A price, a plan or gallons that cannot be read stop the line.',
    formula: 'if unit price < plan price: contract or approval, else (plan - price) x gallons to verify; if PreBuy active and price > locked price: (price - locked) x gallons',
    sources: ['cargas_posted', 'price_plans', 'prebuy_contracts', 'approvals', 'customers'],
    run(ctx) {
      const posted = ctx.src('cargas_posted');
      return activeRows(posted).map((r) => perScope(r.txn_id, () => {
        const cust = need(ctx.customer(r.account), `account ${r.account} on ${r.txn_id} is not in the customer list`);
        const plan = need(planPrice(ctx, r.account, r.delivery_date), `no plan price for ${r.account} on ${r.delivery_date}`);
        const p = need(mills(r.unit_price), `price "${r.unit_price}" on ${r.txn_id} unreadable`); const g = need(tenths(r.net_gal), `gallons on ${r.txn_id} unreadable`);
        const locked = ctx.ref('prebuy_contracts').find((x) => x.account === r.account && x.start <= r.delivery_date && r.delivery_date <= x.end && tenths(x.gallons_used_before) + g <= tenths(x.gallons));
        if (locked && p > mills(locked.price_per_gal)) {
          const lp = mills(locked.price_per_gal); const amount = extend(g, p - lp);
          return { status: 'flag', qualification: 'billing_to_verify', amount, headline: `Ticket ${r.ticket_no} billed above the PreBuy price of ${r.account}`,
            action: 'Re-price the delivery at the contract price, or record why the contract does not apply.',
            fields: { ticket: r.ticket_no, account: r.account, price: fmtPrice(p), locked: fmtPrice(lp), doc: `PreBuy contract ${locked.contract}`, net: fmtGal(g), amount: fmtUsd(amount), txn: r.txn_id, period: fmtDay(r.delivery_date) },
            calc: [['Posted price', fmtPrice(p)], [`Locked by ${locked.contract}`, fmtPrice(lp)], ['Gallons', fmtGal(g)], ['Difference', `(${fmtPrice(p)} - ${fmtPrice(lp)}) x ${fmtGal(g)} = ${fmtUsd(amount)}`, true]] };
        }
        if (p >= plan) return { status: 'pass' };
        const c = ctx.ref('prebuy_contracts').find((x) => x.contract === r.contract_ref && x.account === r.account && x.start <= r.delivery_date && r.delivery_date <= x.end && mills(x.price_per_gal) === p && tenths(x.gallons_used_before) + g <= tenths(x.gallons));
        const a = ctx.ref('approvals').find((x) => x.approval === r.approval_ref && x.account === r.account && x.ticket_no === r.ticket_no && mills(x.price_per_gal) === p);
        const calc = [['Plan', `${cust.price_plan}, ${fmtPrice(plan)} on ${fmtDay(r.delivery_date)}`], ['Posted price', fmtPrice(p)], ['Gallons', fmtGal(g)]];
        const evPosted = card({ system: 'Cargas Energy (assumed export)', style: 'sheet', title: `Posted transaction ${r.txn_id}`, ...fileOf(posted), columns: ['Txn', 'Ticket', 'Account', 'Net gal', 'Price', 'Amount', 'Contract', 'Approval'], rows: [{ cells: [r.txn_id, r.ticket_no, r.account, r.net_gal, r.unit_price, r.amount, r.contract_ref || 'none', r.approval_ref || 'none'], mark: 'hit' }] });
        const evPlan = card({ system: 'Cargas Energy (assumed export)', style: 'slip', title: `Price plan ${cust.price_plan}`, ...fileOf(ctx.refFile('price_plans')), columns: ['Plan', 'From', 'Price per gal'], rows: ctx.ref('price_plans').filter((x) => x.plan === cust.price_plan).map((x) => ({ cells: [x.plan, x.effective_from, x.price_per_gal], mark: mills(x.price_per_gal) === plan ? 'hit' : null })) });
        if (c || a) {
          const doc = c ? `PreBuy contract ${c.contract}` : `approval ${a.approval}`;
          return {
            scope: r.txn_id, status: 'explained', qualification: 'explained',
            headline: `Ticket ${r.ticket_no} below plan price, covered by ${doc}`,
            fields: { ticket: r.ticket_no, account: r.account, price: fmtPrice(p), plan: fmtPrice(plan), doc, txn: r.txn_id },
            calc: [...calc, ['Covered by', c ? `${c.contract}: ${c.account}, ${fmtPrice(mills(c.price_per_gal))}, ${c.gallons} gal, ${c.start} to ${c.end}` : `${a.approval}: ${a.approved_by}, ${a.approved_on}`, true]],
            evidence: [evPosted, evPlan, c
              ? card({ system: 'Contract (fictional)', style: 'contract', title: `PreBuy contract ${c.contract}`, ...fileOf(ctx.refFile('prebuy_contracts')), columns: ['Account', 'Price', 'Gallons', 'Used before', 'Valid'], rows: [{ cells: [c.account, c.price_per_gal, c.gallons, c.gallons_used_before, `${c.start} to ${c.end}`], mark: 'hit' }] })
              : card({ system: 'Approval log (fictional)', style: 'contract', title: `Approval ${a.approval}`, ...fileOf(ctx.refFile('approvals')), columns: ['Account', 'Ticket', 'Price', 'By', 'On'], rows: [{ cells: [a.account, a.ticket_no, a.price_per_gal, a.approved_by, a.approved_on], mark: 'hit' }] })],
          };
        }
        const amount = extend(g, plan - p);
        return {
          scope: r.txn_id, status: 'flag', qualification: 'billing_to_verify', amount,
          headline: `Ticket ${r.ticket_no} posted below plan price with no contract or approval`,
          action: 'Confirm whether a discount was agreed for this delivery, or correct the price.',
          fields: { ticket: r.ticket_no, account: r.account, price: fmtPrice(p), plan: fmtPrice(plan), net: fmtGal(g), amount: fmtUsd(amount), txn: r.txn_id, period: fmtDay(r.delivery_date) },
          calc: [...calc, ['Contract or approval on file', 'none', true], ['Difference', `(${fmtPrice(plan)} - ${fmtPrice(p)}) x ${fmtGal(g)} = ${fmtUsd(amount)}`, true]],
          evidence: [evPosted, evPlan],
        };
      }));
    },
  },
  {
    id: 'GL_BATCH_TO_QBO', title: 'Cargas GL batch matches its QuickBooks journal entry, account by account',
    plain: 'The day\'s GL distribution batch must contain exactly the active posted transactions, split by revenue account, and must be found once in QuickBooks with the same amount on every account. A balanced journal with the same total can still be wrong.',
    formula: 'for each account: QBO JournalEntry amount - Cargas batch amount = 0',
    sources: ['cargas_gl_batch', 'cargas_posted', 'qbo_journalentries', 'customers'],
    run(ctx) {
      const b = ctx.src('cargas_gl_batch').doc; const bf = ctx.src('cargas_gl_batch'); const posted = ctx.src('cargas_posted'); const jef = ctx.src('qbo_journalentries');
      const act = activeRows(posted);
      const exp = { '1100': sum(act, (r) => cents(r.amount)), '4010': 0, '4020': 0 };
      for (const r of act) exp[revenueAccount(ctx, r.account)] -= cents(r.amount);
      const bat = {}; for (const l of b.lines) bat[l.account] = cents(l.debit) - cents(l.credit);
      const idsOk = b.transactions.map(String).sort().join() === act.map((r) => r.txn_id).sort().join();
      const internal = Object.keys(exp).every((k) => exp[k] === (bat[k] || 0)) && idsOk;
      const jes = jef.rows.filter((j) => j.DocNumber === b.batch_id);
      const name = {}; for (const l of b.lines) name[l.account] = l.name;
      const batchCard = card({ system: 'Cargas Energy (assumed export)', style: 'sheet', title: `GL distribution batch ${b.batch_id}`, ...fileOf(bf), columns: ['Account', 'Name', 'Debit', 'Credit'], rows: b.lines.map((l) => ({ cells: [l.account, l.name, l.debit, l.credit] })), foot: [['Transactions in batch', String(b.transactions.length)]] });
      if (!internal) return [{ scope: b.batch_id, status: 'flag', qualification: 'accounting_difference', headline: `Batch ${b.batch_id} does not match its posted transactions`, fields: { batch: b.batch_id }, evidence: [batchCard] }];
      if (jes.length !== 1) {
        return [{ scope: b.batch_id, status: 'flag', qualification: 'accounting_difference', amount: exp['1100'], headline: jes.length ? `Batch ${b.batch_id} booked ${jes.length} times in QuickBooks` : `Batch ${b.batch_id} not found in QuickBooks`, fields: { batch: b.batch_id, count: String(jes.length), amount: fmtUsd(exp['1100']) }, evidence: [batchCard] }];
      }
      const je = jes[0]; const q = {};
      for (const l of je.Line) { const d = l.JournalEntryLineDetail; q[d.AccountRef.value] = (q[d.AccountRef.value] || 0) + (d.PostingType === 'Debit' ? 1 : -1) * cents(l.Amount); }
      const accts = [...new Set([...Object.keys(bat), ...Object.keys(q)])].sort();
      const diffs = accts.map((a) => [a, (q[a] || 0) - (bat[a] || 0)]).filter(([, d]) => d);
      const balanced = sum(Object.values(q)) === 0;
      const jeCard = card({ system: 'QuickBooks Online', style: 'ledger', title: `JournalEntry ${je.Id}, DocNumber ${je.DocNumber}`, ...fileOf(jef), columns: ['Account', 'Posting', 'Amount'],
        rows: je.Line.map((l) => { const d = l.JournalEntryLineDetail; const df = diffs.find(([a]) => a === d.AccountRef.value); return { cells: [`${d.AccountRef.value} ${d.AccountRef.name}`, d.PostingType, l.Amount.toFixed(2)], mark: df ? 'hit' : null }; }),
        foot: [['Debits = credits', balanced ? 'yes' : 'no']] });
      const calc = accts.map((a) => [`${a} ${name[a] || ''}`, `Cargas ${fmtUsd(Math.abs(bat[a] || 0))}, QuickBooks ${fmtUsd(Math.abs(q[a] || 0))}`, !!diffs.find(([x]) => x === a)]);
      if (!diffs.length) return [{ scope: b.batch_id, status: 'pass', calc }];
      const amount = sum(diffs.filter(([, d]) => d > 0), ([, d]) => d);
      // credits are negative: an account receiving more credit than expected has a negative difference
      const more = diffs.find(([, d]) => d < 0); const less = diffs.find(([, d]) => d > 0);
      return [{
        scope: b.batch_id, status: 'flag', qualification: 'accounting_difference', amount,
        headline: `Batch ${b.batch_id}: same total, ${fmtUsd(amount)} on the wrong revenue account in QuickBooks`,
        action: 'Correct the account mapping or the journal entry; the Cargas batch is consistent with its posted transactions.',
        fields: { batch: b.batch_id, amount: fmtUsd(amount), acct_more: more ? more[0] : '', acct_less: less ? less[0] : '', name_more: more ? name[more[0]] : '', name_less: less ? name[less[0]] : '', period: fmtDay(ctx.day) },
        calc: [...calc, ['Debits = credits in QuickBooks', balanced ? 'yes, and still wrong' : 'no'], ['Difference by account', diffs.map(([a, d]) => `${a} ${d < 0 ? '+' : '-'}${fmtUsd(Math.abs(d))} credit`).join(', '), true]],
        evidence: [batchCard, jeCard],
      }];
    },
  },
  {
    id: 'PAYMENTS_IN_DEPOSITS', title: 'Customer payments add up to their Cargas deposit',
    plain: 'The payments a Cargas deposit groups must add up to its amount, method by method.',
    formula: 'sum(payments with this deposit id) = deposit amount',
    sources: ['cargas_payments', 'cargas_deposits'],
    run(ctx) {
      const pays = ctx.src('cargas_payments').rows;
      return ctx.src('cargas_deposits').rows.map((d) => {
        const s = sum(pays.filter((p) => p.deposit_id === d.deposit_id), (p) => cents(p.amount)); const diff = cents(d.amount) - s;
        return diff ? { scope: d.deposit_id, status: 'flag', qualification: 'accounting_difference', amount: Math.abs(diff), headline: `Deposit ${d.deposit_id} differs from its payments`, fields: { deposit: d.deposit_id, amount: fmtUsd(Math.abs(diff)) } } : { scope: d.deposit_id, status: 'pass' };
      });
    },
  },
  {
    id: 'DEPOSIT_TO_QBO', title: 'Cargas deposit matches the deposit booked in QuickBooks',
    plain: 'Each Cargas deposit must be found in QuickBooks. A card deposit booked net of fees is explained only when the processor settlement shows the same gross, the same fee, and QuickBooks carries that fee on its own line. There is no bank statement in this sample, so this is not a bank reconciliation.',
    formula: 'Cargas deposit = settlement gross; gross - fee - adjustment = net paid = QBO Deposit TotalAmt; QBO fee line = -fee',
    sources: ['cargas_deposits', 'qbo_deposits', 'cargas_payments'],
    run(ctx) {
      const df = ctx.src('cargas_deposits'); const qf = ctx.src('qbo_deposits'); const pays = ctx.src('cargas_payments').rows; const sf = ctx.srcIfOk('processor_settlement');
      return df.rows.map((d) => {
        const qd = qf.rows.find((x) => x.DocNumber === d.deposit_id || (x.PrivateNote || '').includes(d.deposit_id));
        const c = cents(d.amount);
        const dCard = card({ system: 'Cargas Energy (assumed export)', style: 'sheet', title: `Deposit ${d.deposit_id}`, ...fileOf(df), columns: ['Payment', 'Account', 'Method', 'Amount'], rows: pays.filter((p) => p.deposit_id === d.deposit_id).map((p) => ({ cells: [p.pay_id, p.account, p.method, p.amount] })), foot: [['Deposit amount', d.amount]] });
        if (!qd) return { scope: d.deposit_id, status: 'flag', qualification: 'accounting_difference', amount: c, headline: `Deposit ${d.deposit_id} not found in QuickBooks`, fields: { deposit: d.deposit_id, amount: fmtUsd(c) }, evidence: [dCard] };
        const q = cents(qd.TotalAmt); const diff = c - q;
        const feeLine = qd.Line.find((l) => l.DepositLineDetail?.AccountRef?.value === '6120');
        const qCard = card({ system: 'QuickBooks Online', style: 'ledger', title: `Deposit ${qd.Id}, DocNumber ${qd.DocNumber}`, ...fileOf(qf), columns: ['Account', 'Description', 'Amount'], rows: qd.Line.map((l) => ({ cells: [`${l.DepositLineDetail.AccountRef.value} ${l.DepositLineDetail.AccountRef.name}`, l.Description || '', l.Amount.toFixed(2)], mark: l === feeLine ? 'hit' : null })), foot: [['TotalAmt', qd.TotalAmt.toFixed(2)]] });
        if (!diff) return { scope: d.deposit_id, status: 'pass' };
        const ids = new Set(pays.filter((p) => p.deposit_id === d.deposit_id).map((p) => p.pay_id));
        const batch = sf ? sf.rows.filter((r) => r.record === 'BATCH').find((b) => { const items = sf.rows.filter((r) => r.record === 'ITEM' && r.batch === b.batch).map((r) => r.ref); return items.length === ids.size && items.every((i) => ids.has(i)); }) : null;
        const base = { scope: d.deposit_id, fields: { deposit: d.deposit_id, cargas: fmtUsd(c), qbo: fmtUsd(q), diff: fmtUsd(diff), period: fmtDay(ctx.day) } };
        const calc = [['Cargas deposit', fmtUsd(c)], [`QuickBooks Deposit ${qd.Id} TotalAmt`, fmtUsd(q)], ['Difference', fmtUsd(diff), true]];
        if (d.method === 'CARD' && !batch) return { ...base, status: 'flag', qualification: 'settlement_pending', amount: diff, headline: `Card deposit ${d.deposit_id}: ${fmtUsd(diff)} difference, settlement not received`, calc, evidence: [dCard, qCard] };
        if (batch) {
          const fee = cents(batch.fee) + cents(batch.adjustment || '0');
          const netOk = cents(batch.gross) - fee === cents(batch.net) && cents(batch.net) === q;
          const ok = cents(batch.gross) === c && fee === diff && netOk && feeLine && cents(feeLine.Amount) === -cents(batch.fee);
          const sCard = card({ system: 'Card processor (fictional)', style: 'statement', title: `Settlement batch ${batch.batch}`, ...fileOf(sf), columns: ['Ref', 'Gross'], rows: sf.rows.filter((r) => r.record === 'ITEM' && r.batch === batch.batch).map((r) => ({ cells: [r.ref, r.gross] })), foot: [['Gross', batch.gross], ['Fee', batch.fee], ['Adjustment', batch.adjustment], ['Net paid', batch.net]] });
          const c2 = [...calc, [`Settlement ${batch.batch}`, `gross ${fmtUsd(cents(batch.gross))}, fee ${fmtUsd(cents(batch.fee))}, adjustment ${fmtUsd(cents(batch.adjustment || '0'))}`], ['QuickBooks fee line (6120)', feeLine ? fmtUsd(cents(feeLine.Amount)) : 'none'], ['Gross - fee - adjustment = net paid = deposit', netOk ? `${fmtUsd(cents(batch.net))}, yes` : `net paid ${fmtUsd(cents(batch.net))}, no`], ['Result', ok ? 'difference explained' : 'not explained', true]];
          if (ok) return { ...base, fields: { ...base.fields, batch: batch.batch, fee: fmtUsd(cents(batch.fee)) }, status: 'explained', qualification: 'explained', amount: diff, headline: `Card deposit ${d.deposit_id}: ${fmtUsd(diff)} difference explained by the processor fee`, calc: c2, evidence: [dCard, sCard, qCard] };
          return { ...base, status: 'flag', qualification: 'accounting_difference', amount: Math.abs(diff), headline: `Deposit ${d.deposit_id}: difference not explained by settlement ${batch.batch}`, calc: c2, evidence: [dCard, sCard, qCard] };
        }
        return { ...base, status: 'flag', qualification: 'accounting_difference', amount: Math.abs(diff), headline: `Deposit ${d.deposit_id}: ${fmtUsd(Math.abs(diff))} difference with QuickBooks`, calc, evidence: [dCard, qCard] };
      });
    },
  },
  {
    id: 'POS_CASH_TO_QBO', title: 'Register close cash matches the cash deposit booked',
    plain: 'Cash on the POS register close must equal the cash deposit booked in QuickBooks for that close. Convention in this sample: all the cash of a close goes into one deposit, with no float kept in the drawer and no paid-out; a real setup would state its own.',
    formula: 'register close cash tender - QBO Deposit (close-CASH) TotalAmt = 0',
    sources: ['pos_close', 'qbo_deposits'],
    run(ctx) {
      const zf = ctx.src('pos_close'); const z = zf.rows[0]; const qf = ctx.src('qbo_deposits');
      const qd = qf.rows.find((x) => x.DocNumber === `${z.z_number}-CASH`);
      const zc = cents(z.tender_cash); const q = qd ? cents(qd.TotalAmt) : 0; const diff = zc - q;
      if (!diff && qd) return [{ scope: z.z_number, status: 'pass' }];
      return [{
        scope: z.z_number, status: 'flag', qualification: 'accounting_difference', amount: Math.abs(diff),
        headline: qd ? `Close ${z.z_number}: cash deposit booked ${fmtUsd(Math.abs(diff))} ${diff > 0 ? 'below' : 'above'} the register close` : `Close ${z.z_number}: no cash deposit in QuickBooks`,
        action: 'Compare the deposit slip with the register close; a second deposit or a counting error are both possible.',
        fields: { z: z.z_number, zcash: fmtUsd(zc), qbo: fmtUsd(q), diff: fmtUsd(Math.abs(diff)), period: fmtDay(ctx.day) },
        calc: [['Cash on the register close', fmtUsd(zc)], ['Cash deposit in QuickBooks', fmtUsd(q)], ['Difference', fmtUsd(diff), true]],
        evidence: [
          card({ system: 'POS (assumed export)', style: 'tape', title: `Register close ${z.z_number}`, ...fileOf(zf), columns: ['Field', 'Value'], rows: [['Opened', z.opened], ['Closed', z.closed], ['Receipts', z.receipts], ['Sales before tax', z.sales_total], ['Tax', z.tax_total], ['Payments on account', z.payments_on_account], ['Cash tender', z.tender_cash], ['Card tender', z.tender_card]].map((c) => ({ cells: c, mark: c[0] === 'Cash tender' ? 'hit' : null })) }),
          card({ system: 'QuickBooks Online', style: 'ledger', title: qd ? `Deposit ${qd.Id}, DocNumber ${qd.DocNumber}` : 'No deposit found', ...fileOf(qf), columns: ['Account', 'Amount'], rows: qd ? qd.Line.map((l) => ({ cells: [`${l.DepositLineDetail.AccountRef.value} ${l.DepositLineDetail.AccountRef.name}`, l.Amount.toFixed(2)], mark: 'hit' })) : [], foot: qd ? [['TotalAmt', qd.TotalAmt.toFixed(2)]] : [] }),
        ],
      }];
    },
  },
  {
    id: 'POS_CARD_TO_SETTLEMENT', title: 'Register close card total matches its settlement and deposit',
    plain: 'Card tender on the register close must equal the gross of its processor batch; the QuickBooks deposit must equal the net paid, with the fee on its own line.',
    formula: 'close card tender = settlement gross; gross - fee - adjustment = net paid = QBO TotalAmt; QBO fee line = -fee',
    sources: ['pos_close', 'processor_settlement', 'qbo_deposits'],
    run(ctx) {
      const zf = ctx.src('pos_close'); const z = zf.rows[0]; const sf = ctx.src('processor_settlement'); const qf = ctx.src('qbo_deposits');
      const item = sf.rows.find((r) => r.record === 'ITEM' && r.ref === z.z_number); const b = item && sf.rows.find((r) => r.record === 'BATCH' && r.batch === item.batch);
      const qd = qf.rows.find((x) => x.DocNumber === `${z.z_number}-CARD`); const feeLine = qd?.Line.find((l) => l.DepositLineDetail?.AccountRef?.value === '6120');
      const zc = cents(z.tender_card);
      const ok = b && cents(b.gross) === zc && cents(b.gross) - cents(b.fee) - cents(b.adjustment || '0') === cents(b.net) && qd && cents(qd.TotalAmt) === cents(b.net) && feeLine && cents(feeLine.Amount) === -cents(b.fee);
      const fields = { z: z.z_number, gross: fmtUsd(zc), net: qd ? fmtUsd(cents(qd.TotalAmt)) : '', fee: b ? fmtUsd(cents(b.fee)) : '', batch: b ? b.batch : '', period: fmtDay(ctx.day) };
      const calc = [['Card on the register close', fmtUsd(zc)], ['Settlement gross', b ? fmtUsd(cents(b.gross)) : 'not found'], ['Fee', b ? fmtUsd(cents(b.fee)) : ''], ['QuickBooks deposit', qd ? fmtUsd(cents(qd.TotalAmt)) : 'not found'], ['Result', ok ? 'difference explained' : 'not explained', true]];
      const ev = [
        card({ system: 'POS (assumed export)', style: 'tape', title: `Register close ${z.z_number}`, ...fileOf(zf), columns: ['Field', 'Value'], rows: [['Card tender', z.tender_card], ['Cash tender', z.tender_cash]].map((c, i) => ({ cells: c, mark: i === 0 ? 'hit' : null })) }),
        ...(b ? [card({ system: 'Card processor (fictional)', style: 'statement', title: `Settlement batch ${b.batch}`, ...fileOf(sf), columns: ['Ref', 'Gross'], rows: [{ cells: [item.ref, item.gross] }], foot: [['Gross', b.gross], ['Fee', b.fee], ['Net paid', b.net]] })] : []),
        ...(qd ? [card({ system: 'QuickBooks Online', style: 'ledger', title: `Deposit ${qd.Id}, DocNumber ${qd.DocNumber}`, ...fileOf(qf), columns: ['Account', 'Amount'], rows: qd.Line.map((l) => ({ cells: [`${l.DepositLineDetail.AccountRef.value} ${l.DepositLineDetail.AccountRef.name}`, l.Amount.toFixed(2)], mark: l === feeLine ? 'hit' : null })), foot: [['TotalAmt', qd.TotalAmt.toFixed(2)]] })] : []),
      ];
      if (ok) return [{ scope: z.z_number, status: 'explained', qualification: 'explained', amount: cents(b.fee), headline: `Counter card batch ${b.batch}: fee ${fmtUsd(cents(b.fee))} explains the deposit`, fields, calc, evidence: ev }];
      return [{ scope: z.z_number, status: 'flag', qualification: b ? 'accounting_difference' : 'settlement_pending', amount: zc, headline: `Close ${z.z_number}: card total not matched to a settlement and deposit`, fields, calc, evidence: ev }];
    },
  },
  {
    id: 'BULK_BALANCE', title: 'Plant and trucks balance in net gallons, within the gauge tolerance',
    plain: 'Opening gauge estimates (storage tank and trucks) plus transport receipts, minus metered deliveries and dock fills, should land near the closing gauge estimates. Loads from storage to trucks stay inside the perimeter and cancel out. Every quantity must be net at 60 °F; a reading with an unknown base stops the check, no correction is guessed. A gauge difference is an estimate to confirm, never a loss.',
    formula: 'closing estimate - (opening estimate + receipts - deliveries - dock fills), tolerance 450.0 gal',
    sources: ['gauge_sheet', 'transport_receipts', 'loading_rack', 'dock_fills', 'meter_register'],
    run(ctx) {
      const gf = ctx.src('gauge_sheet'); const rf = ctx.src('transport_receipts'); const lf = ctx.src('loading_rack'); const dfl = ctx.src('dock_fills'); const m = ctx.src('meter_register');
      const vessels = [...new Set(gf.rows.map((r) => r.vessel))];
      const open = vessels.map((v) => gf.rows.filter((r) => r.vessel === v).sort((a, b) => a.time.localeCompare(b.time))[0]);
      const close = vessels.map((v) => gf.rows.filter((r) => r.vessel === v).sort((a, b) => b.time.localeCompare(a.time))[0]);
      const gaugeCard = (mark) => card({ system: 'Plant gauge sheet (fictional)', style: 'sheet', title: 'Gauge readings', ...fileOf(gf), columns: ['Time', 'Vessel', 'Reading %', 'Liquid °F', 'Net gal', 'Base'], rows: gf.rows.map((r) => ({ cells: [r.time.slice(11), r.vessel, r.reading_pct, r.liquid_temp_f || 'none', r.net_gal || 'none', r.base], mark: mark(r) })) });
      const bad = [...open, ...close].filter((r) => r.base !== 'NET60' || tenths(r.net_gal) === null);
      if (bad.length) {
        return [{
          scope: 'plant', status: 'suspended', qualification: 'not_concluded', cause: 'data',
          headline: `Plant balance not computed: ${bad.map((r) => `${r.vessel} at ${r.time.slice(11)}`).join(', ')} has an unknown base`,
          action: 'Ask for the liquid temperature or the net quantity on the gauge sheet; the balance runs again with it.',
          fields: { vessel: bad[0].vessel, time: bad[0].time.slice(11), pct: bad[0].reading_pct, period: fmtDay(ctx.day) },
          calc: [['Reading', `${bad[0].vessel}, ${bad[0].reading_pct} % at ${bad[0].time.slice(11)}`], ['Liquid temperature', bad[0].liquid_temp_f || 'not recorded'], ['Net gallons', bad[0].net_gal || 'not recorded'], ['Base', 'unknown', true], ['Result', 'not computed, no correction guessed', true]],
          evidence: [gaugeCard((r) => (bad.includes(r) ? 'hit' : null))],
        }];
      }
      const t = (rows) => sum(rows, (r) => tenths(r.net_gal));
      const o = t(open); const c = t(close); const rec = t(rf.rows); const dock = t(dfl.rows); const loads = t(lf.rows);
      const del = sum(m.rows.filter((r) => r.record === 'TICKET' && r.status !== 'VOID'), (r) => tenths(r.net_gal));
      const expected = o + rec - del - dock; const diff = c - expected;
      const calc = [['Opening estimate, storage + trucks', fmtGal(o)], ['Transport receipts (BOL)', `+ ${fmtGal(rec)}`], ['Loads storage to trucks', `- ${fmtGal(loads)} / + ${fmtGal(loads)} = 0`], ['Deliveries (truck meters)', `- ${fmtGal(del)}`], ['Dock fills to cylinders', `- ${fmtGal(dock)}`], ['Expected closing', fmtGal(expected)], ['Closing estimate, storage + trucks', fmtGal(c)], ['Difference (estimate)', fmtGal(diff), true], ['Tolerance', fmtGal(BULK_TOLERANCE)]];
      if (Math.abs(diff) <= BULK_TOLERANCE) return [{ scope: 'plant', status: 'pass', calc, note: `difference ${fmtGal(diff)} within ${fmtGal(BULK_TOLERANCE)}` }];
      return [{
        scope: 'plant', status: 'flag', qualification: 'quantity_to_confirm', qty: diff,
        headline: `Estimated ${fmtGal(Math.abs(diff))} ${diff < 0 ? 'below' : 'above'} the expected closing quantity: measure to confirm`,
        action: 'Re-read the storage gauge and check for an unrecorded movement before drawing any conclusion.',
        fields: { diff: fmtGal(Math.abs(diff)), direction: diff < 0 ? 'below' : 'above', expected: fmtGal(expected), closing: fmtGal(c), tol: fmtGal(BULK_TOLERANCE), period: fmtDay(ctx.day) },
        quantity: { value: fmtGal(diff), base: 'net at 60 °F', origin: 'gauge estimates (storage and trucks)', at: `${fmtDay(ctx.day)}, 18:30`, source: gf.path },
        calc,
        evidence: [gaugeCard((r) => (r.vessel === 'STORAGE-1' ? 'hit' : null)),
          card({ system: 'Plant records (fictional)', style: 'slip', title: 'Receipts, loads and dock fills', file: `${rf.path}, ${lf.path}, ${dfl.path}`, received_at: rf.received_at, columns: ['Record', 'Time', 'Net gal', 'Origin'],
            rows: [...rf.rows.map((r) => ({ cells: [r.bol, r.time.slice(11), r.net_gal, 'bill of lading'] })), ...lf.rows.map((r) => ({ cells: [`Load ${r.truck}`, r.time.slice(11), r.net_gal, 'rack meter'] })), ...dfl.rows.map((r) => ({ cells: [`Dock fills (${r.cylinders_20lb} x 20 lb, ${r.cylinders_33lb} x 33.5 lb)`, r.time.slice(11), r.net_gal, 'dock meter'] }))] })],
      }];
    },
  },
  {
    id: 'CAGE_COUNT', title: 'Dealer cage count matches the cylinder movements',
    plain: 'On consignment, full cylinders in a dealer cage = previous count + delivered - exchanged by the dealer - sold without return. Empties are tracked on their own line. Propane, containers and sales are kept apart.',
    formula: 'previous full + delivered - exchanged - sold without return = counted full',
    sources: ['cage_counts', 'cylinder_movements'], optional: true,
    run(ctx) {
      const cf = ctx.src('cage_counts'); const mf = ctx.src('cylinder_movements');
      return cf.rows.filter((r) => r.date === ctx.day).map((now) => {
        const prev = cf.rows.filter((r) => r.dealer === now.dealer && r.date < ctx.day).sort((a, b) => b.date.localeCompare(a.date))[0];
        const mv = (k) => sum(mf.rows.filter((r) => r.dealer === now.dealer && r.movement === k), (r) => Number(r.qty));
        const expFull = Number(prev.full) + mv('DELIVERED_FULL') - mv('DEALER_EXCHANGE') - mv('DEALER_SOLD_NO_RETURN');
        const expEmpty = Number(prev.empty) + mv('DEALER_EXCHANGE') - mv('PICKED_EMPTY');
        const df = Number(now.full) - expFull; const de = Number(now.empty) - expEmpty;
        const dealer = ctx.customer(now.dealer)?.name || now.dealer;
        const calc = [[`Full at the ${fmtDay(prev.date)} count`, prev.full], ['Delivered full', `+ ${mv('DELIVERED_FULL')}`], ['Exchanged by the dealer', `- ${mv('DEALER_EXCHANGE')}`], ['Sold without return', `- ${mv('DEALER_SOLD_NO_RETURN')}`], ['Expected full', String(expFull)], ['Counted full', now.full], ['Difference', String(df), true], ['Empties expected / counted', `${expEmpty} / ${now.empty}`]];
        if (!df && !de) return { scope: now.dealer, status: 'pass', calc };
        return {
          scope: now.dealer, status: 'flag', qualification: 'quantity_to_confirm', qty: df,
          headline: `${Math.abs(df)} full cylinder${Math.abs(df) > 1 ? 's' : ''} at ${dealer} not explained by the movements on file`,
          action: 'Ask the dealer for sales after the report cut-off, then recount at the next visit.',
          fields: { dealer, cage: now.cage, expected: String(expFull), counted: now.full, diff: String(Math.abs(df)), period: fmtDay(ctx.day) },
          note: 'Convention in this sample: consignment. Propane in that cylinder, if filled to 20 lb, about 4.8 gal (estimate at 4.2 lb/gal, not a measured quantity).',
          calc,
          evidence: [
            card({ system: 'Cylinder route (fictional)', style: 'slip', title: `Cage ${now.cage}, ${dealer}`, ...fileOf(cf), columns: ['Date', 'Full', 'Empty', 'Counted by', 'Note'], rows: [prev, now].map((r) => ({ cells: [r.date, r.full, r.empty, r.counted_by, r.ref], mark: r === now ? 'hit' : null })) }),
            card({ system: 'Cylinder route and dealer report (fictional)', style: 'sheet', title: `Movements since ${fmtDay(prev.date)}`, ...fileOf(mf), columns: ['Dates', 'Movement', 'Qty', 'Record'], rows: mf.rows.filter((r) => r.dealer === now.dealer).map((r) => ({ cells: [r.date, r.movement.replace(/_/g, ' ').toLowerCase(), r.qty, r.ref] })) }),
          ],
        };
      });
    },
  },
  {
    id: 'LEASE_BILLED', title: 'Tank rent billed once its cycle has closed',
    plain: 'For each tank lease owned by the company: once the billing cycle that contains the due date has closed, a lease charge must be on file, unless the contract waives the rent. An annual rent not yet due stays quiet.',
    formula: 'day > cycle close and no lease charge between due date and cycle close and no waiver',
    sources: ['leases', 'cargas_lease_charges'],
    run(ctx) {
      return ctx.ref('leases').filter((l) => l.start <= ctx.day && ctx.day <= l.end).map((l) => {
        if (l.waiver) return { scope: l.lease, status: 'pass', note: `waived: ${l.waiver}` };
        if (l.frequency === 'ANNUAL') return l.next_due > ctx.day ? { scope: l.lease, status: 'pass', note: `annual rent due ${l.next_due}` } : { scope: l.lease, status: 'pending', qualification: 'not_concluded' };
        const close = (ym) => `${ym}-${String(l.cycle_close_day).padStart(2, '0')}`;
        let ym = ctx.day.slice(0, 7);
        if (ctx.day <= close(ym)) { const d = new Date(`${ym}-15T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); ym = d.toISOString().slice(0, 7); } // the last cycle that has closed
        const due = `${ym}-${String(l.due_day).padStart(2, '0')}`; const closeD = close(ym);
        const month = new Date(`${ym}-15T12:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
        if (due < l.start) return { scope: l.lease, status: 'pass', note: `lease starts ${l.start}` };
        const lf = ctx.monthFile('cargas_lease_charges', ym);
        if (!lf) return { scope: l.lease, status: 'pending', qualification: 'not_concluded', headline: `Lease ${l.lease}: no lease-charge export covers the ${month} cycle`, fields: { lease: l.lease, month }, note: `no export for ${month}` };
        const ch = lf.rows.filter((r) => r.lease === l.lease && r.date >= due && r.date <= closeD);
        if (ch.length) return { scope: l.lease, status: 'pass', note: `${month} cycle billed (${ch.map((r) => r.charge_id).join(', ')})` };
        const rent = cents(l.rent); const cust = ctx.customer(l.account)?.name || l.account;
        return {
          scope: l.lease, status: 'flag', qualification: 'billing_to_verify', amount: rent,
          headline: `Lease ${l.lease}: ${fmtUsd(rent)} rent due ${fmtDay(due)} not found in the ${month} cycle`,
          action: 'Bill the rent or record why it is not due (waiver, contract change).',
          fields: { lease: l.lease, tank: l.tank, customer: cust, rent: fmtUsd(rent), due: fmtDay(due), close: fmtDay(closeD), month, period: fmtDay(ctx.day) },
          calc: [['Contract', `${l.lease}, tank ${l.tank} (${l.tank_wc_gal} gal), owner ${l.owner}`], ['Rent', `${fmtUsd(rent)} monthly, due day ${l.due_day}`], ['Cycle', `${fmtDay(due)} to ${fmtDay(closeD)}, closed`], ['Lease charges found for this lease', 'none', true], ['Waiver in the contract', 'none']],
          evidence: [
            card({ system: 'Lease contract (fictional)', style: 'contract', title: `Lease ${l.lease}`, ...fileOf(ctx.refFile('leases')), columns: ['Field', 'Value'], rows: [['Tank', `${l.tank}, ${l.tank_wc_gal} gal water capacity`], ['Owner', l.owner], ['Customer and site', `${cust} (${l.account}), ${l.site}`], ['Period', `${l.start} to ${l.end}`], ['Rent', `${l.rent} ${l.frequency.toLowerCase()}, due day ${l.due_day}`], ['Waiver', l.waiver || 'none']].map((c) => ({ cells: c, mark: c[0] === 'Rent' ? 'hit' : null })) }),
            card({ system: 'Cargas Energy (assumed export)', style: 'sheet', title: `Lease charges, ${month}`, ...fileOf(lf), columns: ['Charge', 'Date', 'Lease', 'Account', 'Amount', 'Tax'], rows: [...lf.rows.map((r) => ({ cells: [r.charge_id, r.date, r.lease, r.account, r.amount, r.tax] })), { cells: ['', '', l.lease, l.account, '', 'no charge'], mark: 'ghost' }] }),
          ],
        };
      });
    },
  },
];

export const DATA_RULES = {
  POS_COMPLETENESS: { id: 'POS_COMPLETENESS', title: 'POS export covers the whole register day', plain: 'The POS sales export must cover the day up to the register close and agree with the close on receipts and totals. Without the close, completeness cannot be established: counter totals are marked partial and the checks that need the close are suspended.', formula: 'export period ends at or after the close; receipts and totals equal the close' },
  SOURCE_FRESH_COMPLETE: { id: 'SOURCE_FRESH_COMPLETE', title: 'Each source covers the day and arrived complete', plain: 'A file must cover the business day being audited (not the day it arrived), and match the control totals its system writes at the end of the export. A stale or incomplete file stops the checks that depend on it.', formula: 'file period = business day; rows and control totals = trailer' },
};
