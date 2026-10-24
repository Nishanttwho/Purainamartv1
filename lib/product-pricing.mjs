const VALID_UNITS = new Set(['g', 'ml', 'piece']);

export function toMoneyCents(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || Math.round(amount * 100) > Number.MAX_SAFE_INTEGER) return null;
  return Math.round(amount * 100);
}

export function fromMoneyCents(cents) {
  return Number(cents) / 100;
}

export function validatePricingVariants(saleType, unit, variants, { makeId } = {}) {
  if (!['packed', 'loose'].includes(saleType)) return { error: 'Choose packed or loose pricing.' };
  if (!VALID_UNITS.has(unit) || (saleType === 'loose' && !['g', 'ml'].includes(unit))) return { error: 'Choose a supported measurement unit.' };
  if (!Array.isArray(variants) || variants.length < 1 || variants.length > 20) return { error: 'Add between 1 and 20 quantity options.' };
  const ids = new Set();
  const normalized = [];
  for (const row of variants) {
    const label = String(row?.label || row?.name || '').trim().slice(0, 60);
    const quantityBase = Number(row?.quantityBase);
    const priceCents = toMoneyCents(row?.price);
    const mrpCents = row?.mrp == null || row.mrp === '' ? null : toMoneyCents(row.mrp);
    const stock = Number(row?.stock);
    const rowUnit = String(row?.unit || unit);
    const id = String(row?.id || makeId?.() || `v-${normalized.length + 1}`).trim().slice(0, 64);
    if (!label || !Number.isSafeInteger(quantityBase) || quantityBase < 1 || quantityBase > 100000000) return { error: 'Each option needs a label and positive whole-number quantity.' };
    if (rowUnit !== unit) return { error: 'All options for a product must use the configured measurement unit.' };
    if (priceCents == null || priceCents <= 0 || (mrpCents != null && (mrpCents <= 0 || priceCents > mrpCents))) return { error: 'Each selling price must be positive and cannot exceed its MRP/reference price.' };
    if (!Number.isSafeInteger(stock) || stock < 0 || stock > 2147483647) return { error: saleType === 'packed' ? 'Pack stock must be a non-negative whole number.' : `Stock must be a non-negative whole number of ${unit}.` };
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || ids.has(id)) return { error: 'Quantity option IDs must be unique.' };
    ids.add(id);
    normalized.push({ id, label, quantityBase, unit, price: fromMoneyCents(priceCents), mrp: mrpCents == null ? null : fromMoneyCents(mrpCents), stock, isActive: row?.isActive !== false });
  }
  if (!normalized.some(row => row.isActive)) return { error: 'Enable at least one quantity option.' };
  return { saleType, measurementUnit: unit, variants: normalized };
}

export function activeVariant(product, variantId) {
  return (product?.variants || []).find(row => row.id === variantId && row.isActive !== false && Number(row.stock) > 0) || null;
}
