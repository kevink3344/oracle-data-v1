## View Builder idea

### What is the View Builder?

The View Builder is a tool that allows users to create a view from a SQL query. It provides a user-friendly interface for selecting the columns and rows to include in the view, and allows users to customize the view's name and description.

### First View
** This is an example only **
The user might want a view titled "FIRST FUNDINGS ONLY" to show when a code combination was first funded. It might look & appear like so. The user will have a "preview" option where they can see a preview of the view.

Code Combination | Funding Amount | First Funding Date
04.6570.862.500.0450.0840.000 | 100,000.00 | 2026-07-01
04.6570.862.22500.0450.0840.000 | 10,000.00 | 2026-06-11
04.6570.862.35000.0450.0840.000 | 250,000.00 | 2026-06-01
04.6570.862.401.0450.0840.000 | 10,000.00 | 2026-05-01
...

### View Notifications
Once the view is built, if there are any changes staff can SUBSCRIBE TO A VIEW and receive a notification (in-app or webhook) when the view is updated. This is a great way to keep staff up to date with the latest data. NOTE: I will handle the webhook part.

### Sample query (for one result initial funding, not for the above example)
WITH acct AS (                      -- replaces :new_ccid
  SELECT cc.code_combination_id
    FROM gl_code_combinations cc
   WHERE cc.chart_of_accounts_id = 101
     AND cc.segment1 = :s1
     AND cc.segment2 = :s2
     AND cc.segment3 = :s3
     AND cc.segment4 = :s4
     AND cc.segment5 = :s5
     AND cc.segment6 = :s6
     AND cc.segment7 = :s7
),
code_period AS (
  SELECT gb.budget_version_id, gb.period_year, gb.period_num, gb.period_name,
         SUM(gb.period_net_dr)                    AS net_dr,
         SUM(gb.period_net_cr)                    AS net_cr,
         SUM(gb.period_net_dr - gb.period_net_cr) AS net_amount
    FROM gl_balances  gb
    JOIN acct        a ON a.code_combination_id = gb.code_combination_id
    JOIN gl_ledgers  l ON l.ledger_id           = gb.ledger_id
   WHERE gb.actual_flag         = 'B'                    -- B = Budget
     AND gb.translated_flag     = 'N'
     AND gb.encumbrance_type_id IS NULL
     AND gb.currency_code       = l.currency_code         -- derived, not supplied
   GROUP BY gb.budget_version_id, gb.period_year, gb.period_num, gb.period_name
  HAVING SUM(gb.period_net_dr - gb.period_net_cr) <> 0
)
SELECT cp.period_name        AS first_allocation_period,
       cp.period_year,
       cp.period_num,
       cp.net_dr, cp.net_cr,
       cp.net_amount         AS first_allocation_amount,
       bv.budget_name,
       bv.budget_type_id,
       bv.first_period_name  AS version_first_period
  FROM code_period cp
  JOIN gl_budget_versions bv ON bv.budget_version_id = cp.budget_version_id
 ORDER BY cp.period_year, cp.period_num, cp.period_name, cp.budget_version_id
 FETCH FIRST 1 ROW ONLY;
