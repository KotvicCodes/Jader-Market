import { sql, type SQL } from "drizzle-orm";

// Every query returns only failures. Numeric values are text to preserve exact
// integer accounting in JSON, including aggregate amounts above Number's range.
export const reconciliationChecks: Record<string, SQL> = {
  accounting_links: sql`
    SELECT e.id::text AS id, 'ledger_entry' AS source FROM ledger_entries e
      LEFT JOIN journals j ON j.id=e.journal_id LEFT JOIN ledger_accounts a ON a.id=e.account_id WHERE j.id IS NULL OR a.id IS NULL
    UNION ALL SELECT s.id::text, 'share_movement' FROM share_movements s
      LEFT JOIN holdings h ON h.id=s.holding_id LEFT JOIN trading_operations t ON t.id=s.operation_id
      WHERE h.id IS NULL OR t.id IS NULL OR t.market_id IS DISTINCT FROM h.market_id
    UNION ALL SELECT j.id::text, 'journal' FROM journals j
      LEFT JOIN trading_operations t ON t.id=j.trading_operation_id LEFT JOIN withdrawal_operations w ON w.id=j.withdrawal_operation_id
      WHERE (j.trading_operation_id IS NOT NULL AND t.id IS NULL) OR (j.withdrawal_operation_id IS NOT NULL AND w.id IS NULL)
        OR (j.trading_operation_id IS NOT NULL AND j.withdrawal_operation_id IS NOT NULL)
        OR (j.trading_operation_id IS NOT NULL AND j.reason<>'trading')
        OR (j.withdrawal_operation_id IS NOT NULL AND j.reason<>'withdrawal')
        OR (j.trading_operation_id IS NULL AND j.withdrawal_operation_id IS NULL AND (j.kind NOT IN ('credit','debit') OR j.reason IN ('trading','withdrawal')))
        OR (j.reason='offline_credit' AND j.kind<>'credit') OR (j.reason='offline_debit' AND j.kind<>'debit')`,
  required_accounts: sql`
    SELECT u.id::text AS id, k.kind AS missing_kind FROM users u CROSS JOIN (VALUES ('wallet'), ('reserved')) k(kind)
    WHERE NOT EXISTS (SELECT 1 FROM ledger_accounts a WHERE a.owner_id=u.id AND a.kind=k.kind)
    UNION ALL SELECT 'issuance', 'issuance' WHERE (SELECT count(*) FROM ledger_accounts WHERE kind='issuance')<>1`,
  ledger_projections: sql`
    SELECT a.id::text AS id, a.balance::text AS actual, coalesce(sum(e.delta),0)::text AS expected
    FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id
    GROUP BY a.id HAVING a.balance<>coalesce(sum(e.delta),0)`,
  journal_balance: sql`
    SELECT j.id::text AS id, count(e.id)::text AS entry_count, coalesce(sum(e.delta),0)::text AS net,
      j.amount::text AS expected_amount, coalesce(sum(e.delta) FILTER (WHERE e.delta>0),0)::text AS actual_amount
    FROM journals j LEFT JOIN ledger_entries e ON e.journal_id=j.id GROUP BY j.id
    HAVING count(e.id)<>2 OR coalesce(sum(e.delta),0)<>0 OR coalesce(sum(e.delta) FILTER (WHERE e.delta>0),0)<>j.amount`,
  journal_transfers: sql`
    WITH expected AS (SELECT j.*,
      CASE WHEN w.id IS NOT NULL THEN CASE WHEN w.action='request' THEN 'wallet' ELSE 'withdrawal_reserved' END
        WHEN j.kind IN ('credit','debit') THEN 'issuance' WHEN j.kind='payout' THEN 'escrow'
        WHEN j.kind='trade' THEN 'reserved' ELSE 'wallet' END AS source_kind,
      CASE WHEN w.id IS NOT NULL AND w.action='pay' THEN 'issuance'
        WHEN w.id IS NOT NULL AND w.action='request' THEN 'withdrawal_reserved'
        WHEN w.id IS NOT NULL THEN 'wallet' WHEN j.kind IN ('mint','burn') THEN 'escrow'
        WHEN j.kind IN ('reserve','release') THEN 'reserved' ELSE 'wallet' END AS destination_kind,
      CASE WHEN j.withdrawal_operation_id IS NOT NULL THEN j.recipient_id
        WHEN j.kind IN ('credit','debit','payout') THEN NULL::uuid WHEN j.kind='trade' THEN b.owner_id ELSE j.recipient_id END AS source_owner,
      CASE WHEN j.kind IN ('mint','burn') THEN NULL::uuid
        WHEN w.action='pay' THEN NULL::uuid ELSE j.recipient_id END AS destination_owner,
      CASE WHEN j.kind='payout' THEN t.market_id ELSE NULL::uuid END AS source_market,
      CASE WHEN j.kind IN ('mint','burn') THEN t.market_id ELSE NULL::uuid END AS destination_market,
      CASE WHEN j.withdrawal_operation_id IS NULL AND j.kind IN ('debit','burn','release') THEN -j.amount ELSE j.amount END AS signed_amount
      FROM journals j LEFT JOIN withdrawal_operations w ON w.id=j.withdrawal_operation_id
        LEFT JOIN trading_operations t ON t.id=j.trading_operation_id
        LEFT JOIN fills f ON f.id=j.id LEFT JOIN orders b ON b.id=f.buy_order_id)
    SELECT j.id::text AS id FROM expected j
    LEFT JOIN ledger_accounts src ON src.kind=j.source_kind AND src.owner_id IS NOT DISTINCT FROM j.source_owner AND src.market_id IS NOT DISTINCT FROM j.source_market
    LEFT JOIN ledger_accounts dst ON dst.kind=j.destination_kind AND dst.owner_id IS NOT DISTINCT FROM j.destination_owner AND dst.market_id IS NOT DISTINCT FROM j.destination_market
    WHERE src.id IS NULL OR dst.id IS NULL
      OR NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.journal_id=j.id AND e.account_id=src.id AND e.delta=-j.signed_amount)
      OR NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.journal_id=j.id AND e.account_id=dst.id AND e.delta=j.signed_amount)`,
  complete_sets: sql`
    SELECT j.id::text AS id FROM journals j LEFT JOIN trading_operations t ON t.id=j.trading_operation_id
    WHERE j.kind IN ('mint','burn') AND (t.action IS DISTINCT FROM j.kind OR t.owner_id IS DISTINCT FROM j.recipient_id OR j.amount%10000<>0
      OR (SELECT count(*) FROM share_movements s JOIN holdings h ON h.id=s.holding_id WHERE s.group_id=j.id
        AND s.operation_id=t.id AND s.kind=j.kind AND h.owner_id=t.owner_id AND h.market_id=t.market_id AND s.reserved_delta=0
        AND s.available_delta=(CASE WHEN j.kind='mint' THEN j.amount/10000 ELSE -j.amount/10000 END))<>2
      OR (SELECT count(DISTINCT h.outcome) FROM share_movements s JOIN holdings h ON h.id=s.holding_id WHERE s.group_id=j.id)<>2)
    UNION ALL SELECT s.id::text FROM share_movements s LEFT JOIN journals j ON j.id=s.group_id
      WHERE s.kind IN ('mint','burn') AND j.kind IS DISTINCT FROM s.kind`,
  holding_projections: sql`
    SELECT h.id::text AS id, h.available::text AS actual_available, h.reserved::text AS actual_reserved,
      coalesce(sum(s.available_delta),0)::text AS expected_available, coalesce(sum(s.reserved_delta),0)::text AS expected_reserved
    FROM holdings h LEFT JOIN share_movements s ON s.holding_id=h.id GROUP BY h.id
    HAVING h.available<>coalesce(sum(s.available_delta),0) OR h.reserved<>coalesce(sum(s.reserved_delta),0)`,
  buy_reservations: sql`
    WITH needed AS (SELECT owner_id, sum(price::numeric*remaining) AS amount FROM orders WHERE status='open' AND side='buy' GROUP BY owner_id),
      held AS (SELECT owner_id, balance AS amount FROM ledger_accounts WHERE kind='reserved')
    SELECT coalesce(n.owner_id,a.owner_id)::text AS id, coalesce(a.amount,0)::text AS actual, coalesce(n.amount,0)::text AS expected
    FROM needed n FULL JOIN held a USING(owner_id)
    WHERE coalesce(a.amount,0)<>coalesce(n.amount,0) OR (n.owner_id IS NOT NULL AND a.owner_id IS NULL)`,
  sell_reservations: sql`
    WITH needed AS (SELECT owner_id,market_id,outcome,sum(remaining) AS amount FROM orders WHERE status='open' AND side='sell' GROUP BY owner_id,market_id,outcome)
    SELECT coalesce(h.id,n.owner_id)::text AS id, coalesce(h.market_id,n.market_id)::text AS market_id,
      coalesce(h.outcome,n.outcome) AS outcome, coalesce(h.reserved,0)::text AS actual, coalesce(n.amount,0)::text AS expected
    FROM holdings h FULL JOIN needed n USING(owner_id,market_id,outcome)
    WHERE coalesce(h.reserved,0)<>coalesce(n.amount,0) OR (n.owner_id IS NOT NULL AND h.id IS NULL)`,
  withdrawal_reservations: sql`
    WITH needed AS (SELECT owner_id,sum(amount) AS amount FROM withdrawals WHERE status IN ('requested','processing') GROUP BY owner_id),
      held AS (SELECT owner_id,balance AS amount FROM ledger_accounts WHERE kind='withdrawal_reserved')
    SELECT coalesce(n.owner_id,a.owner_id)::text AS id, coalesce(a.amount,0)::text AS actual, coalesce(n.amount,0)::text AS expected
    FROM needed n FULL JOIN held a USING(owner_id)
    WHERE coalesce(a.amount,0)<>coalesce(n.amount,0) OR (n.owner_id IS NOT NULL AND a.owner_id IS NULL)`,
  collateral: sql`
    WITH supply AS (SELECT market_id,coalesce(sum(available::numeric+reserved) FILTER (WHERE outcome='YES'),0) AS yes,
      coalesce(sum(available::numeric+reserved) FILTER (WHERE outcome='NO'),0) AS no FROM holdings GROUP BY market_id)
    SELECT m.id::text AS id, coalesce(a.balance,0)::text AS actual,
      (CASE WHEN r.result='YES' THEN coalesce(s.yes,0)*10000 WHEN r.result='NO' THEN coalesce(s.no,0)*10000
        WHEN r.result='invalid' THEN (coalesce(s.yes,0)+coalesce(s.no,0))*5000 ELSE coalesce(s.yes,0)*10000 END)::text AS expected,
      coalesce(s.yes,0)::text AS yes_shares, coalesce(s.no,0)::text AS no_shares
    FROM markets m LEFT JOIN supply s ON s.market_id=m.id LEFT JOIN market_resolutions r ON r.market_id=m.id
      LEFT JOIN ledger_accounts a ON a.market_id=m.id AND a.kind='escrow'
    WHERE (r.id IS NULL AND coalesce(s.yes,0)<>coalesce(s.no,0)) OR coalesce(a.balance,0)<>
      CASE WHEN r.result='YES' THEN coalesce(s.yes,0)*10000 WHEN r.result='NO' THEN coalesce(s.no,0)*10000
        WHEN r.result='invalid' THEN (coalesce(s.yes,0)+coalesce(s.no,0))*5000 ELSE coalesce(s.yes,0)*10000 END`,
  order_fills: sql`
    WITH executed AS (SELECT order_id,sum(quantity) AS quantity FROM (
      SELECT buy_order_id AS order_id,quantity FROM fills UNION ALL SELECT sell_order_id,quantity FROM fills) f GROUP BY order_id)
    SELECT o.id::text AS id, o.remaining::text AS actual, (o.quantity-coalesce(f.quantity,0))::text AS expected
    FROM orders o LEFT JOIN executed f ON f.order_id=o.id LEFT JOIN trading_operations t ON t.id=o.operation_id
    WHERE o.remaining<>o.quantity-coalesce(f.quantity,0) OR t.action IS DISTINCT FROM 'place' OR t.owner_id IS DISTINCT FROM o.owner_id
      OR t.market_id IS DISTINCT FROM o.market_id OR o.id<>o.operation_id OR (o.status='open' AND o.time_in_force='IOC')`,
  fill_accounting: sql`
    SELECT f.id::text AS id FROM fills f LEFT JOIN orders b ON b.id=f.buy_order_id LEFT JOIN orders s ON s.id=f.sell_order_id
      LEFT JOIN orders maker ON maker.id=f.maker_order_id LEFT JOIN journals j ON j.id=f.id
      LEFT JOIN trading_operations t ON t.id=f.operation_id
    WHERE b.side IS DISTINCT FROM 'buy' OR s.side IS DISTINCT FROM 'sell' OR b.owner_id=s.owner_id
      OR b.market_id IS DISTINCT FROM f.market_id OR s.market_id IS DISTINCT FROM f.market_id
      OR b.outcome IS DISTINCT FROM f.outcome OR s.outcome IS DISTINCT FROM f.outcome
      OR maker.id IS NULL OR maker.id NOT IN (b.id,s.id) OR f.price<>maker.price OR f.price>b.price OR f.price<s.price
      OR t.action IS DISTINCT FROM 'place' OR t.market_id IS DISTINCT FROM f.market_id
      OR j.kind IS DISTINCT FROM 'trade' OR j.amount IS DISTINCT FROM f.price*f.quantity OR j.trading_operation_id IS DISTINCT FROM f.operation_id
      OR NOT EXISTS (SELECT 1 FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE e.journal_id=j.id AND a.owner_id=b.owner_id AND a.kind='reserved' AND e.delta=-j.amount)
      OR NOT EXISTS (SELECT 1 FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE e.journal_id=j.id AND a.owner_id=s.owner_id AND a.kind='wallet' AND e.delta=j.amount)
      OR (SELECT count(*) FROM share_movements sm WHERE sm.group_id=f.id)<>2
      OR NOT EXISTS (SELECT 1 FROM share_movements sm JOIN holdings h ON h.id=sm.holding_id WHERE sm.group_id=f.id AND sm.operation_id=f.operation_id AND sm.kind='trade' AND h.owner_id=b.owner_id AND h.market_id=f.market_id AND h.outcome=f.outcome AND sm.available_delta=f.quantity AND sm.reserved_delta=0)
      OR NOT EXISTS (SELECT 1 FROM share_movements sm JOIN holdings h ON h.id=sm.holding_id WHERE sm.group_id=f.id AND sm.operation_id=f.operation_id AND sm.kind='trade' AND h.owner_id=s.owner_id AND h.market_id=f.market_id AND h.outcome=f.outcome AND sm.available_delta=0 AND sm.reserved_delta=-f.quantity)`,
  settlement_lifecycle: sql`
    SELECT m.id::text AS id, m.status::text AS status FROM markets m LEFT JOIN market_resolutions r ON r.market_id=m.id
    WHERE (m.status IN ('settling','resolved','void'))<>(r.id IS NOT NULL)
      OR (r.id IS NOT NULL AND EXISTS (SELECT 1 FROM orders o WHERE o.market_id=m.id AND o.status='open'))
      OR (m.status IN ('resolved','void') AND (m.status::text<>CASE WHEN r.result='invalid' THEN 'void' ELSE 'resolved' END
        OR EXISTS (SELECT 1 FROM holdings h WHERE h.market_id=m.id AND (h.available<>0 OR h.reserved<>0))
        OR EXISTS (SELECT 1 FROM ledger_accounts a WHERE a.market_id=m.id AND a.kind='escrow' AND a.balance<>0)))`,
  payout_receipts: sql`
    SELECT p.id::text AS id, p.amount::text AS actual,
      (p.quantity*(CASE WHEN r.result='invalid' THEN 5000 WHEN r.result=h.outcome THEN 10000 ELSE 0 END))::text AS expected
    FROM market_payouts p LEFT JOIN market_resolutions r ON r.id=p.resolution_id LEFT JOIN holdings h ON h.id=p.holding_id
      LEFT JOIN trading_operations t ON t.id=p.id LEFT JOIN journals j ON j.id=p.journal_id
    WHERE r.id IS NULL OR h.id IS NULL OR h.market_id IS DISTINCT FROM r.market_id OR p.owner_id IS DISTINCT FROM h.owner_id
      OR p.amount<>p.quantity*(CASE WHEN r.result='invalid' THEN 5000 WHEN r.result=h.outcome THEN 10000 ELSE 0 END)
      OR t.action IS DISTINCT FROM 'settle' OR t.market_id IS DISTINCT FROM r.market_id OR t.owner_id IS DISTINCT FROM r.actor_id
      OR (p.amount=0)<>(p.journal_id IS NULL)
      OR (p.amount>0 AND (j.kind IS DISTINCT FROM 'payout' OR j.amount IS DISTINCT FROM p.amount OR j.trading_operation_id IS DISTINCT FROM p.id
        OR j.recipient_id IS DISTINCT FROM p.owner_id
        OR NOT EXISTS (SELECT 1 FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE e.journal_id=j.id AND a.market_id=r.market_id AND a.kind='escrow' AND e.delta=-p.amount)
        OR NOT EXISTS (SELECT 1 FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE e.journal_id=j.id AND a.owner_id=p.owner_id AND a.kind='wallet' AND e.delta=p.amount)))
      OR (SELECT count(*) FROM share_movements s WHERE s.operation_id=p.id AND s.group_id=p.id AND s.holding_id=p.holding_id AND s.kind='payout' AND s.available_delta=-p.quantity AND s.reserved_delta=0)<>1`,
  payout_coverage: sql`
    SELECT s.id::text AS id FROM share_movements s LEFT JOIN market_payouts p ON p.id=s.operation_id AND p.holding_id=s.holding_id
    WHERE s.kind='payout' AND p.id IS NULL
    UNION ALL SELECT j.id::text FROM journals j LEFT JOIN market_payouts p ON p.journal_id=j.id WHERE j.kind='payout' AND p.id IS NULL`,
  withdrawal_history: sql`
    WITH history AS (SELECT o.*, row_number() OVER (PARTITION BY withdrawal_id ORDER BY sequence) AS position,
      lag(to_status) OVER (PARTITION BY withdrawal_id ORDER BY sequence) AS prior_status,
      row_number() OVER (PARTITION BY withdrawal_id ORDER BY sequence DESC) AS latest FROM withdrawal_operations o)
    SELECT o.id::text AS id FROM history o JOIN withdrawals w ON w.id=o.withdrawal_id
    WHERE o.from_status IS DISTINCT FROM o.prior_status
      OR NOT ((o.position=1 AND o.action='request' AND o.from_status IS NULL AND o.to_status='requested' AND o.id=w.id)
        OR (o.position>1 AND ((o.action='start' AND o.from_status='requested' AND o.to_status='processing')
          OR (o.action='cancel' AND o.from_status='requested' AND o.to_status='cancelled')
          OR (o.action='pay' AND o.from_status='processing' AND o.to_status='paid')
          OR (o.action='release' AND o.from_status='processing' AND o.to_status='cancelled'))))
      OR (o.latest=1 AND (w.last_operation_id<>o.id OR w.status<>o.to_status))
      OR (o.action='pay' AND (length(trim(o.reference))<3 OR o.reference<>trim(o.reference)))
      OR (o.action<>'pay' AND o.reference<>'')
    UNION ALL SELECT w.id::text FROM withdrawals w WHERE NOT EXISTS (SELECT 1 FROM history o WHERE o.withdrawal_id=w.id)`,
  withdrawal_journals: sql`
    SELECT o.id::text AS id FROM withdrawal_operations o JOIN withdrawals w ON w.id=o.withdrawal_id
    LEFT JOIN journals j ON j.withdrawal_operation_id=o.id
    WHERE (o.action='start' AND j.id IS NOT NULL) OR (o.action<>'start' AND (
      j.id IS NULL OR j.reason<>'withdrawal' OR j.amount<>w.amount OR j.recipient_id<>w.owner_id OR j.actor_id<>o.actor_id
      OR j.operation_key<>o.id OR j.request_hash<>o.request_hash OR j.trading_operation_id IS NOT NULL
      OR j.kind<>CASE WHEN o.action='request' THEN 'reserve' WHEN o.action='pay' THEN 'debit' ELSE 'release' END
      OR NOT EXISTS (SELECT 1 FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE e.journal_id=j.id AND a.owner_id=w.owner_id AND a.kind=CASE WHEN o.action='request' THEN 'wallet' ELSE 'withdrawal_reserved' END AND e.delta=-w.amount)
      OR NOT EXISTS (SELECT 1 FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE e.journal_id=j.id AND e.delta=w.amount AND
        ((o.action='pay' AND a.kind='issuance') OR (o.action<>'pay' AND a.owner_id=w.owner_id AND a.kind=CASE WHEN o.action='request' THEN 'withdrawal_reserved' ELSE 'wallet' END)))))`,
  payment_references: sql`
    SELECT min(withdrawal_id::text) AS id, count(*)::text AS uses FROM withdrawal_operations WHERE action='pay'
    GROUP BY reference HAVING count(*)<>1 OR length(trim(reference))<3`,
};
