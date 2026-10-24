export function distinctProductImageSources(product) {
  const primary = Array.isArray(product?.image) ? product.image : [product?.image];
  const configured = Array.isArray(product?.images) ? product.images : [];
  const seen = new Set();
  return [...primary, ...configured]
    .map(value => String(value || '').trim())
    .filter(value => value && !seen.has(value) && seen.add(value));
}
