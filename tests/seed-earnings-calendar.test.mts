import assert from 'node:assert/strict';
import { it } from 'node:test';

import { boundEarningsCalendar, EARNINGS_CALENDAR_CAP } from '../scripts/seed-earnings-calendar.mjs';

it('caps earnings by date and prioritizes larger estimates on the same day', () => {
  const rows = Array.from({ length: EARNINGS_CALENDAR_CAP + 2 }, (_, index) => ({
    symbol: `EQUITY${index}`,
    date: '2026-11-30',
    revenueEstimate: index,
  }));
  rows.push({ symbol: 'EARLIER', date: '2026-11-29', revenueEstimate: 0 });

  const bounded = boundEarningsCalendar(rows);

  assert.equal(bounded.length, EARNINGS_CALENDAR_CAP);
  assert.equal(bounded[0]?.symbol, 'EARLIER');
  assert.equal(bounded[1]?.symbol, `EQUITY${EARNINGS_CALENDAR_CAP + 1}`);
  assert.equal(rows[0]?.symbol, 'EQUITY0');
});
