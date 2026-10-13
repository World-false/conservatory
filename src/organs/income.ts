import { withOperatorNote, type IncomeReportRecord, type Ledger } from './ledger';

export type IncomeErrorCode =
  | 'report_not_found'
  | 'report_not_pending'
  | 'reporter_not_alive'
  | 'exchange_rate_unset'
  | 'invalid_amount'
  | 'invalid_field';

export type IncomeResult =
  | { ok: true; report: IncomeReportRecord; credited: number }
  | { ok: false; code: IncomeErrorCode };

export interface ReportIncomeInput {
  where: string;
  work: string;
  amount: number;
  currency: string;
}

export function reportIncome(
  ledger: Ledger,
  agent: string,
  input: ReportIncomeInput,
  at: number,
): IncomeResult {
  if (input.where.trim() === '' || input.work.trim() === '' || input.currency.trim() === '') {
    return { ok: false, code: 'invalid_field' };
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { ok: false, code: 'invalid_amount' };
  }
  const id = ledger.insertIncomeReport({
    agent,
    where: input.where.trim(),
    work: input.work.trim(),
    amount: input.amount,
    currency: input.currency.trim(),
    at,
  });
  const report = ledger.getIncomeReport(id);
  if (report === null) {
    return { ok: false, code: 'report_not_found' };
  }
  return { ok: true, report, credited: 0 };
}

/**
 * The operator verifies an outside-income report and it is credited at the
 * configured exchange rate. When the rate is unset the credit is refused: no
 * default, no guess. The reporter is told what was credited, in the same
 * transaction, so the notice and the balance can never disagree.
 */
export function verifyIncome(
  ledger: Ledger,
  reportId: number,
  verifiedAmount: number,
  exchangeRate: number | null,
  at: number,
  note?: string,
): IncomeResult {
  if (exchangeRate === null) {
    return { ok: false, code: 'exchange_rate_unset' };
  }
  if (!Number.isFinite(verifiedAmount) || verifiedAmount < 0) {
    return { ok: false, code: 'invalid_amount' };
  }
  const existing = ledger.getIncomeReport(reportId);
  if (existing === null) {
    return { ok: false, code: 'report_not_found' };
  }
  if (existing.status !== 'pending') {
    return { ok: false, code: 'report_not_pending' };
  }
  // Crediting a dead agent would move a balance the death certificate already
  // recorded as final, and the certificate is append-only. Refuse instead.
  const reporter = ledger.getAgent(existing.agent);
  if (reporter === null || reporter.status !== 'alive') {
    return { ok: false, code: 'reporter_not_alive' };
  }
  const credited = verifiedAmount * exchangeRate;
  const changed = ledger.transaction(() => {
    const resolved = ledger.resolveIncomeReport(
      reportId,
      'credited',
      verifiedAmount,
      exchangeRate,
      credited,
      at,
    );
    if (!resolved) {
      return false;
    }
    ledger.appendBalanceEvent(existing.agent, credited, 'income_credit', String(reportId), at);
    ledger.appendMessage(
      'system',
      existing.agent,
      withOperatorNote(
        `Income report #${reportId} (${existing.where}) was verified: verified amount ${verifiedAmount}, credited +${credited} balance.`,
        note,
      ),
      at,
    );
    return true;
  });
  if (!changed) {
    return { ok: false, code: 'report_not_pending' };
  }
  const report = ledger.getIncomeReport(reportId);
  if (report === null) {
    return { ok: false, code: 'report_not_found' };
  }
  return { ok: true, report, credited };
}

/**
 * The operator refuses a report. The reporter is told, in the same transaction
 * as the refusal, so a rejected claim is never left looking merely unanswered.
 */
export function rejectIncome(
  ledger: Ledger,
  reportId: number,
  at: number,
  note?: string,
): IncomeResult {
  const existing = ledger.getIncomeReport(reportId);
  if (existing === null) {
    return { ok: false, code: 'report_not_found' };
  }
  if (existing.status !== 'pending') {
    return { ok: false, code: 'report_not_pending' };
  }
  const changed = ledger.transaction(() => {
    const resolved = ledger.resolveIncomeReport(reportId, 'rejected', null, null, null, at);
    if (!resolved) {
      return false;
    }
    ledger.appendMessage(
      'system',
      existing.agent,
      withOperatorNote(`Income report #${reportId} (${existing.where}) was rejected (0 credited).`, note),
      at,
    );
    return true;
  });
  if (!changed) {
    return { ok: false, code: 'report_not_pending' };
  }
  const report = ledger.getIncomeReport(reportId);
  if (report === null) {
    return { ok: false, code: 'report_not_found' };
  }
  return { ok: true, report, credited: 0 };
}
