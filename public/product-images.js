export function distinctProductImageSources(product) {
  const primary = Array.isArray(product?.image) ? product.image : [product?.image];
  const configured = Array.isArray(product?.images) ? product.images : [];
  const seen = new Set();
  return [...primary, ...configured]
    .map(value => String(value || '').trim())
    .filter(value => value && !seen.has(value) && seen.add(value));
}

export function optimizedImage(value, width = 600) {
  const image = String(value || '');
  if (!/^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\//.test(image) || image.includes('/s--')) return image;
  return image.replace('/image/upload/', `/image/upload/f_auto,q_auto,c_limit,w_${Math.min(1600, Math.max(80, Math.round(width)))}/`);
}
