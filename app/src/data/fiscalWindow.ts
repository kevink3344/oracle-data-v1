/**
 * Which fiscal years an AP register opens on, when nobody has said otherwise.
 *
 * ── THE PROBLEM THIS EXISTS FOR ──────────────────────────────────────────────
 *
 * `GET /api/ap/checks` and `GET /api/ap/invoices` are both bounded to a fiscal year, and with no
 * query parameters the server picks **the newest year `GL_PERIODS` carries**. That default is right
 * for the ledger and wrong for a tenant. An organization whose Settings screen says **Start FY
 * 2022** has a window that opens in FY2022, so a reader on the Checks page searched for a check
 * issued in 2023 and was answered *"No check of the 4,218 in this window matches"* — about a
 * register the page had silently cut to one year. Both registers now open where the organization's
 * window opens.
 *
 * ★ THE FIX IS A DEFAULT, NOT A FILTER, AND THE CONTROL STAYS. The bound is real — the underlying
 *   view holds 1,246,676 checks, so an unbounded read is a way to ask for a hang — and the reader
 *   may still move it. The only thing this module decides is which year the picker opens on.
 *
 * ★ THE ORGANIZATION'S Start FY IS THE RIGHT FLOOR BECAUSE IT IS ALREADY THE TENANT'S WINDOW.
 *   `ScopeTenant.startFy` is documented as "the fiscal year this tenant's window opens on", and it
 *   is the same number `Settings → Organizations` writes. Two screens reading one row is the entire
 *   reason the row exists, and a page that picked its own floor would be a second answer to a
 *   question the reader believes they already answered.
 *
 * ── THE NUMBERING, WHICH IS THE ONE WAY TO GET THIS WRONG ────────────────────
 *
 * ★ `fiscalYear` IS THE YEAR THE FISCAL YEAR **ENDS** IN. `ap.ts` says so of its own response:
 *   *"FY2027 = `2026-07-01 .. 2027-06-30`. That convention is the ledger's, not this endpoint's."*
 *   Settings' Start FY uses the same convention — `fiscalYearStart(2022)` in `data/scope.ts` is
 *   `2021-07-01` — so the two numbers are comparable **directly and need no arithmetic here**. An
 *   off-by-one added "to be safe" would move the floor a year, and it would move it in the
 *   direction that hides rows rather than the one that shows them.
 */

/**
 * The years the ledger carries, narrowed to the one field this reads.
 *
 * ★ NARROWED RATHER THAN IMPORTED, SO THIS MODULE IMPORTS NOTHING. `FiscalYear` lives in
 *   `data/invoices.ts` beside `loadFiscalYears`, and both registers' pages already hold that type;
 *   a structural parameter accepts them without either page changing, and without this file
 *   acquiring a dependency on one register's module to describe a rule that governs both.
 */
export interface CarriedYear {
  /** The year the fiscal year ends in — see the numbering note above. */
  fiscalYear: number;
}

/** The window a register should open on, and what it cost to arrive at. */
export interface FiscalWindow {
  /** The first fiscal year to include. Always a year the ledger carries. */
  start: number;
  /** The last fiscal year to include — the newest the ledger carries. */
  end: number;
  /** What Settings says, so a page can quote it when it was not usable as asked. */
  asked: number;
  /**
   * True when `asked` was not a year usable as-is and the window had to move.
   *
   * ★ THE PAGE MUST **SAY** THIS RATHER THAN APPLY IT SILENTLY. A Start FY the ledger no longer
   *   carries is a configuration the reader can fix, and a window that quietly opened elsewhere
   *   would be indistinguishable from the ledger having no data that far back — which is the exact
   *   false conclusion the whole window disclosure exists to prevent.
   */
  clamped: boolean;
}

/**
 * The window both AP registers open on for a given organization Start FY.
 *
 * Returns the organization's floor through the newest year the ledger carries. `null` means **there
 * is nothing to say** — the year list could not be read — and the caller is expected to send no
 * parameters at all, which lets the server apply its own default. That degradation is deliberate:
 * a missing year list must not block a register. See `Invoices.tsx` for the same rule stated of the
 * picker.
 */
export function windowFromSettings(
  startFy: number,
  years: readonly CarriedYear[],
): FiscalWindow | null {
  if (years.length === 0) return null;

  // ★ OLDEST AND NEWEST ARE COMPUTED, NOT READ OFF THE ENDS. The server's list is ordered
  //   `PERIOD_YEAR DESC` today, so `years[0]` and `years[years.length - 1]` would in fact be the
  //   bounds — and a floor that depends on that ordering would break silently on the day the
  //   ordering changed, by opening the register on a middling year.
  let oldest = Number.POSITIVE_INFINITY;
  let newest = Number.NEGATIVE_INFINITY;
  for (const year of years) {
    if (year.fiscalYear < oldest) oldest = year.fiscalYear;
    if (year.fiscalYear > newest) newest = year.fiscalYear;
  }

  const asked = Math.trunc(Number(startFy));

  // A tenant with no Start FY set, or a corrupt one, opens on the newest year. That is the
  // server's own default, so nothing is gained by leaving the range blank — and naming it gives
  // the picker a value to show instead of an unselected control.
  if (!Number.isFinite(asked) || asked <= 0) {
    return { start: newest, end: newest, asked: 0, clamped: true };
  }

  // ★ CLAMPED INTO THE LEDGER'S RANGE, BECAUSE `resolveWindow` ANSWERS **400**. A year the ledger
  //   does not carry is refused — "The ledger has no fiscal year N. It carries X to Y." — and a
  //   reversed range is refused with it. So sending `startFy` unchecked would fail the whole
  //   register on a stale configuration instead of degrading, which is a worse outcome than
  //   showing too much. `max` handles a floor older than the ledger's oldest year (the ledger
  //   simply does not reach that far back, so its oldest is the widest answer available); `min`
  //   handles one newer than its newest (a tenant configured ahead of the data).
  const start = Math.min(Math.max(asked, oldest), newest);
  return { start, end: newest, asked, clamped: start !== asked };
}

/**
 * The second sentence of a register's window line: whose floor this is, and whether it is still the
 * one in force.
 *
 * ── WHY THIS IS A FUNCTION AND NOT A SENTENCE IN EACH PAGE ───────────────────
 *
 * ★ BOTH REGISTERS STATE THE SAME WINDOW, SO BOTH MUST STATE IT THE SAME WAY. The two pages were
 *   written days apart and had already drifted — one said *"Set from this organization's Start FY
 *   2022 in Settings"* and the other *"This is where the organization's Start FY 2022 puts it."* —
 *   which is worse than either wording on its own, because a reader who compares the Checks tab
 *   with the Invoices tab learns that the app explains its own bound differently depending on which
 *   tab they are on, and stops believing the explanation on both. One sentence, one home.
 *
 * ★ FOUR ENDINGS, BECAUSE THERE ARE FOUR DIFFERENT FACTS, AND THE FIRST TWO ARE EASY TO CONFLATE:
 *
 *   1. **No Start FY is set at all.** `startFy` comes through as `0`, which is not a year and must
 *      not be reported as one. The old wording said *"Settings has 0, which this ledger does not
 *      carry"*, which reads as a corrupt configuration when the truth is an unfinished one.
 *   2. **A Start FY the ledger does not carry.** This is the one that must be said out loud: a
 *      window that quietly opened three years later than Settings claims is indistinguishable from
 *      the ledger having no data that far back, which is the exact false conclusion the whole
 *      window disclosure exists to prevent.
 *   3. **The reader has moved the control.** Naming the source here is the only thing that makes
 *      moving it undoable — without it the reader has to leave for Settings to find out what they
 *      changed it from.
 *   4. **The default is in force.** A courtesy, and it doubles as the instruction for widening.
 *
 * `current` is what the register is actually under, which is `null` before the default has been
 * applied; entries 3 and 4 fall through to 4 in that case, since nothing has been moved yet.
 *
 * Returns the empty string when `window` is `null` — the year list could not be read, so the page
 * has no idea whose floor is in force and must not claim one.
 */
export function windowOriginSentence(
  window: FiscalWindow | null,
  current?: { start: number; end: number } | null,
): string {
  if (!window) return '';

  if (window.asked <= 0) {
    return (
      'This organization has no Start FY set in Settings, so this register opens on the newest ' +
      `year the ledger carries, FY${window.end} — widen the year range above to look further back.`
    );
  }

  if (window.clamped) {
    return (
      `Settings has FY${window.asked} as this organization's Start FY, which this ledger does not ` +
      `carry — so the window opens on FY${window.start} rather than failing the whole register.`
    );
  }

  if (current && (current.start !== window.start || current.end !== window.end)) {
    return (
      `The organization's Start FY ${window.asked} opens this register at FY${window.start} — you ` +
      `have moved the start to FY${current.start}.`
    );
  }

  return (
    `Set from this organization's Start FY ${window.asked} in Settings — widen the year range ` +
    'above to look outside it.'
  );
}
