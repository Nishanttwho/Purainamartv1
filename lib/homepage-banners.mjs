export function defaultHomepageBanners() {
  return [
    { id: 'everyday-low-prices', title: 'Everyday low prices', alt: 'Everyday low prices and fee offer', image: '/assets/customer/zepto-home/banners/everyday-low-prices.webp', enabled: true, action: { type: 'none' } },
    { id: 'paan-corner', title: 'Paan Corner', alt: 'Paan Corner', image: '/assets/customer/zepto-home/banners/paan-corner.webp', enabled: true, action: { type: 'none' } }
  ];
}

export const BANNER_INTERNAL_PAGES = ['home', 'categories', 'cart', 'account'];

export function validateHomepageBanners(input, { isAllowedImage, products = [], categories = [] } = {}) {
  if (!Array.isArray(input) || input.length > 30) return { error: 'Provide no more than 30 banners.' };
  const ids = new Set();
  const banners = [];
  for (let index = 0; index < input.length; index++) {
    const item = input[index];
    const id = String(item?.id || '').trim();
    const title = String(item?.title || '').trim().slice(0, 100);
    const image = String(item?.image || '').trim();
    const alt = String(item?.alt || title).trim().slice(0, 160);
    if (!/^[a-z0-9][a-z0-9-]{0,49}$/.test(id) || ids.has(id) || !title || !image || !isAllowedImage?.(image) || typeof item.enabled !== 'boolean') return { error: `Banner ${index + 1} needs a unique short ID, title, valid image, and enabled status.` };
    ids.add(id);
    const source = item.action || { type: 'none' };
    const type = String(source.type || 'none');
    let action = { type: 'none' };
    if (type === 'product') {
      const productId = String(source.id || '');
      if (!products.some(row => row.id === productId && row.isActive !== false)) return { error: `Choose an active product for banner “${title}”.` };
      action = { type, id: productId };
    } else if (type === 'category') {
      const categoryId = String(source.id || '');
      if (!categories.some(row => row.id === categoryId && row.id !== 'all' && row.isActive !== false)) return { error: `Choose an active category for banner “${title}”.` };
      action = { type, id: categoryId };
    } else if (type === 'page') {
      const page = String(source.page || '');
      if (!BANNER_INTERNAL_PAGES.includes(page)) return { error: `Choose a supported internal page for banner “${title}”.` };
      action = { type, page };
    } else if (type === 'external') {
      try {
        const url = new URL(String(source.url || ''));
        if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error();
        action = { type, url: url.toString() };
      } catch { return { error: `Enter a valid HTTPS URL for banner “${title}”.` }; }
    } else if (type !== 'none') return { error: `Choose a supported click action for banner “${title}”.` };
    banners.push({ id, title, alt: alt || title, image, enabled: item.enabled, order: index, action });
  }
  return { banners };
}
