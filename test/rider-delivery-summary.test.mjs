import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidSummaryDate, isValidSummaryMonth, summarizeRiderDeliveries } from '../lib/rider-delivery-summary.mjs';

test('Rider summaries deduplicate completed orders, scope COD proof to the Rider, and group by delivery month', () => {
  const orders = [
    { id:'one', riderId:'r1', status:'Delivered', deliveredAt:'2026-01-31T23:59:00-05:00', total:125, paymentMethod:'Cash on delivery', paymentCollection:{ method:'cash', riderId:'r1', amount:125, collectedAt:'2026-02-01T04:59:00Z' } },
    { id:'one', riderId:'r1', status:'Delivered', deliveredAt:'2026-02-01T04:59:00Z', total:125, paymentMethod:'Cash on delivery', paymentCollection:{ method:'cash', riderId:'r1', amount:125, collectedAt:'2026-02-01T04:59:00Z' } },
    { id:'two', riderId:'r1', status:'Delivered', deliveredAt:'2026-02-04T11:00:00Z', total:80, paymentMethod:'Cash on delivery', paymentCollection:{ method:'cash', riderId:'other', amount:80, collectedAt:'2026-02-04T10:00:00Z' } },
    { id:'three', riderId:'r1', status:'Out for delivery', deliveredAt:'2026-02-05T11:00:00Z', total:90, paymentMethod:'Cash on delivery', paymentCollection:{ method:'cash', riderId:'r1', amount:90, collectedAt:'2026-02-05T10:00:00Z' } },
    { id:'four', riderId:'r2', status:'Delivered', deliveredAt:'2026-02-05T11:00:00Z', total:30, paymentMethod:'Cash on delivery', paymentCollection:{ method:'cash', riderId:'r2', amount:30, collectedAt:'2026-02-05T10:00:00Z' } }
  ];
  const februaryFirst=summarizeRiderDeliveries(orders,'r1','2026-02','2026-02-01');
  assert.equal(februaryFirst.completedDeliveries,2);assert.equal(februaryFirst.codCollected,125);
  assert.equal(februaryFirst.monthCompletedDeliveries,2);assert.equal(februaryFirst.monthCodCollected,125);
  assert.equal(februaryFirst.dailyCompletedDeliveries,1);assert.equal(februaryFirst.dailyCodCollected,125,'the UTC completion day owns the entire deduplicated COD amount');
  const februaryFourth=summarizeRiderDeliveries(orders,'r1','2026-02','2026-02-04');
  assert.equal(februaryFourth.dailyCompletedDeliveries,1);assert.equal(februaryFourth.dailyCodCollected,0,'collection attributed to another Rider is excluded');
  assert.equal(summarizeRiderDeliveries(orders,'r1','2026-01','2026-01-31').dailyCompletedDeliveries,0,'an offset timestamp is grouped by its UTC completion date');
  assert.equal(isValidSummaryMonth('2026-13'),false);
  assert.equal(isValidSummaryDate('2026-02-30'),false);assert.equal(isValidSummaryDate('2026-02-28'),true);
  assert.throws(()=>summarizeRiderDeliveries(orders,'r1','2026-00'),/YYYY-MM/);
  assert.throws(()=>summarizeRiderDeliveries(orders,'r1','2026-02','2026-02-30'),/YYYY-MM-DD/);
});
