import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validatePricingVariants } from './product-pricing.mjs';
import { cloudinaryConfig, isCloudinaryImageUrl } from './cloudinary.mjs';
export function adminImagePath(value, publicDir) {
  const image = String(value || '').trim();
  if (!image) return null;
  if (isCloudinaryImageUrl(image, cloudinaryConfig()?.cloudName || null)) return image;
  if (!image.startsWith('/assets/') || image.includes('..')) return undefined;
  const file = path.resolve(publicDir, '.' + image);
  return file.startsWith(path.join(publicDir, 'assets') + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile() ? image : undefined;
}
function parseCouponLimits(body) {
  const parsed = {};
  if (Object.hasOwn(body, 'expiresAt')) {
    if (body.expiresAt === '' || body.expiresAt === null) parsed.expiresAt = null;
    else { if (typeof body.expiresAt !== 'string') return null; const timestamp = Date.parse(body.expiresAt); if (!Number.isFinite(timestamp)) return null; parsed.expiresAt = new Date(timestamp).toISOString(); }
  } else if (Object.hasOwn(body, 'createdAt')) parsed.expiresAt = null;
  for (const key of ['maxRedemptions', 'maxRedemptionsPerCustomer']) if (Object.hasOwn(body, key)) {
    if (body[key] === '' || body[key] === null) parsed[key] = null;
    else { const value = Number(body[key]); if (!Number.isInteger(value) || value < 1) return null; parsed[key] = value; }
  }
  return parsed;
}

export async function handleAdminCatalogue(repo, ctx) {
  const { route, body } = ctx, req = { method: ctx.method }, res = {};
  const readBody = async () => body;
  const send = (_res, status, value) => { ctx.status = status; return value; };
  const imagePath = value => adminImagePath(value, ctx.publicDir);
  const segment = route.split('/')[3], id = route.split('/')[4];
  if (!['products','categories','delivery-areas','coupons'].includes(segment)) return undefined;
  if (ctx.method === 'GET') return undefined;
  const products = segment === 'products' && id ? await repo.list('products', { id }) : [];
  const categories = segment === 'categories' ? await repo.list('categories', { id: id || String(body.id || String(body.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')) }) : body.category ? await repo.list('categories', { id: String(body.category) }) : [];
  const deliveryAreas = segment === 'delivery-areas' && id ? await repo.list('deliveryAreas', { id }) : [];
  const couponRows = segment === 'coupons' ? await repo.list('coupons', { code: String(id || body.code || '').trim().toUpperCase() }) : [];
  const coupons = Object.fromEntries(couponRows.map(row => [row.code, row]));
  if (req.method === 'POST' && route === '/api/admin/products') {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 100);
    const category = categories.find(row => row.id === body.category && row.id !== 'all' && row.isActive !== false);
    let pricing = null;
    if (body.saleType !== undefined) {
      pricing = validatePricingVariants(String(body.saleType), String(body.measurementUnit || ''), body.variants, { makeId: () => `v-${crypto.randomBytes(6).toString('hex')}` });
      if (pricing.error) return send(res, 400, { error: pricing.error });
    }
    const price = pricing ? (pricing.saleType === 'loose' ? Math.round(pricing.variants.find(row => row.isActive).price * 100000 / pricing.variants.find(row => row.isActive).quantityBase) / 100 : pricing.variants.find(row => row.isActive).price) : Number(body.price);
    const mrp = pricing ? (pricing.saleType === 'loose' ? null : pricing.variants.find(row => row.isActive)?.mrp ?? price) : (body.mrp == null || body.mrp === '' ? price : Number(body.mrp));
    const stock = pricing ? pricing.saleType === 'loose' ? Math.max(...pricing.variants.map(row => row.stock)) : pricing.variants.reduce((sum, row) => sum + row.stock, 0) : Number(body.stock);
    if (!name || !category || !Number.isFinite(price) || price <= 0 || (mrp != null && (!Number.isFinite(mrp) || mrp < price)) || !Number.isInteger(stock) || stock < 0) return send(res, 400, { error: 'Provide a name, category, valid prices, and non-negative stock.' });
    const image = imagePath(body.image);
    if (image === undefined) return send(res, 400, { error: 'Choose an image path that already exists under /assets/.' });
    const product = { id: `p-${crypto.randomBytes(6).toString('hex')}`, name, detail: String(body.detail || '').trim().slice(0, 120), category: category.id, price, mrp, stock, emoji: String(body.emoji || '🛒').slice(0, 8), badge: String(body.badge || '').trim().slice(0, 32), color: /^#[\da-f]{6}$/i.test(body.color || '') ? body.color : '#f4eff8', image, description: String(body.description || name).slice(0, 300), isActive: body.isActive !== false, rank: await repo.count('products') };
    if (pricing) Object.assign(product, pricing);
    await repo.insert('products', product); await repo.flush(); return send(res, 201, { product });
  }
  const productMatch = route.match(/^\/api\/admin\/products\/([^/]+)$/);
  if (productMatch) {
    const product = products.find(row => row.id === decodeURIComponent(productMatch[1]));
    if (!product) return send(res, 404, { error: 'Product not found' });
    if (req.method === 'DELETE') { product.isActive = false; await repo.flush(); return send(res, 200, { product }); }
    if (req.method !== 'PATCH') return send(res, 405, { error: 'Method not allowed' });
    const body = await readBody(req);
    const next = { ...product };
    if (body.name !== undefined) { next.name = String(body.name).trim().slice(0, 100); if (!next.name) return send(res, 400, { error: 'Product name is required.' }); }
    if (body.detail !== undefined) next.detail = String(body.detail).trim().slice(0, 120);
    if (body.badge !== undefined) next.badge = String(body.badge).trim().slice(0, 32);
    if (body.emoji !== undefined) next.emoji = String(body.emoji).slice(0, 8);
    if (body.description !== undefined) next.description = String(body.description).slice(0, 300);
    if (body.price !== undefined) { next.price = Number(body.price); if (!Number.isFinite(next.price) || next.price <= 0) return send(res, 400, { error: 'Enter a positive selling price.' }); }
    if (body.mrp !== undefined) { next.mrp = body.mrp == null || body.mrp === '' ? next.price : Number(body.mrp); if (!Number.isFinite(next.mrp) || next.mrp < next.price) return send(res, 400, { error: 'MRP must be at least the selling price.' }); }
    if (body.stock !== undefined) { next.stock = Number(body.stock); if (!Number.isInteger(next.stock) || next.stock < 0) return send(res, 400, { error: 'Stock must be a non-negative whole number.' }); }
    if (body.category !== undefined) { if (!categories.some(row => row.id === body.category && row.id !== 'all' && row.isActive !== false)) return send(res, 400, { error: 'Choose an active category.' }); next.category = body.category; }
    if (body.saleType !== undefined) {
      if (body.saleType === 'legacy') { delete next.saleType; delete next.measurementUnit; delete next.variants; }
      else {
        const pricing = validatePricingVariants(String(body.saleType), String(body.measurementUnit || ''), body.variants, { makeId: () => `v-${crypto.randomBytes(6).toString('hex')}` });
        if (pricing.error) return send(res, 400, { error: pricing.error });
        const hasLegacyCart = await repo.exists('carts', { items: { $elemMatch: { productId: product.id, variantId: null } } });
        if (!product.variants?.length && hasLegacyCart) return send(res, 409, { error: 'This product is in an existing cart. Wait for those legacy cart lines to be cleared before changing its sale type.' });
        Object.assign(next, pricing);
        next.stock = pricing.saleType === 'loose' ? Math.max(...pricing.variants.map(row => row.stock)) : pricing.variants.reduce((sum, row) => sum + row.stock, 0);
        const first = pricing.variants.find(row => row.isActive);
        next.price = pricing.saleType === 'loose' ? Math.round(first.price * 100000 / first.quantityBase) / 100 : first.price; next.mrp = pricing.saleType === 'loose' ? null : first.mrp ?? first.price;
      }
    } else if (body.variants !== undefined) {
      const pricing = validatePricingVariants(String(next.saleType || ''), String(body.measurementUnit || next.measurementUnit || ''), body.variants, { makeId: () => `v-${crypto.randomBytes(6).toString('hex')}` });
      if (pricing.error) return send(res, 400, { error: pricing.error });
      Object.assign(next, pricing); next.stock = pricing.saleType === 'loose' ? Math.max(...pricing.variants.map(row => row.stock)) : pricing.variants.reduce((sum, row) => sum + row.stock, 0);
      const first = pricing.variants.find(row => row.isActive); next.price = pricing.saleType === 'loose' ? Math.round(first.price * 100000 / first.quantityBase) / 100 : first.price; next.mrp = pricing.saleType === 'loose' ? null : first.mrp ?? first.price;
    }
    if (next.variants?.length) {
      const sameStocks = product.variants?.length === next.variants.length && next.variants.every(row => product.variants.some(old => old.id === row.id && old.stock === row.stock));
      if (body.stock !== undefined) next.stock = Number(body.stock);
      else if (sameStocks) next.stock = product.stock;
    }
    if (body.isActive !== undefined) next.isActive = Boolean(body.isActive);
    if (body.image !== undefined) { const image = imagePath(body.image); if (image === undefined) return send(res, 400, { error: 'Choose an image path that already exists under /assets/.' }); next.image = image; }
    if (next.mrp != null && next.mrp < next.price) return send(res, 400, { error: 'MRP must be at least the selling price.' });
    // Keep inventory units and option identities restorable for outstanding
    // orders. Price and stock edits remain allowed while fulfillment proceeds.
    const changedUnits = product.saleType !== next.saleType || product.measurementUnit !== next.measurementUnit;
    const changedOptions = (product.variants || []).filter(old => !next.variants?.some(row => row.id === old.id && row.quantityBase === old.quantityBase));
    if ((changedUnits || changedOptions.length) && await repo.exists('orders', {
      status: { $in: ['Order received', 'Being packed', 'Ready for pickup', 'Rider assigned'] },
      items: { $elemMatch: { id: product.id, ...(changedUnits ? {} : { variantId: { $in: changedOptions.map(row => row.id) } }) } }
    })) return send(res, 409, { error: 'Complete or cancel outstanding orders before changing their inventory units or removing quantity options.' });
    for (const key of Object.keys(product)) if (!Object.hasOwn(next, key)) delete product[key];
    Object.assign(product, next); await repo.flush(); return send(res, 200, { product });
  }

  if (req.method === 'POST' && route === '/api/admin/categories') {
    const body = await readBody(req); const name = String(body.name || '').trim().slice(0, 50);
    const id = String(body.id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).slice(0, 32);
    if (!name || !/^[a-z0-9-]{2,32}$/.test(id) || id === 'all' || categories.some(row => row.id === id)) return send(res, 400, { error: 'Choose a new category name and unique short ID.' });
    const category = { id, name, icon: String(body.icon || '🛒').slice(0, 8), color: /^#[\da-f]{6}$/i.test(body.color || '') ? body.color : '#f4eff8', isActive: true };
    const image = imagePath(body.image); if (image === undefined) return send(res, 400, { error: 'Choose an image path that already exists under /assets/.' });
    if (image) category.image = image; await repo.insert('categories', category); await repo.flush(); return send(res, 201, { category });
  }
  const categoryMatch = route.match(/^\/api\/admin\/categories\/([^/]+)$/);
  if (categoryMatch) {
    const category = categories.find(row => row.id === decodeURIComponent(categoryMatch[1]) && row.id !== 'all');
    if (!category) return send(res, 404, { error: 'Category not found' });
    if (req.method === 'DELETE') {
      if (await repo.exists('products', { category: category.id, isActive: { $ne: false } })) return send(res, 409, { error: 'Move or deactivate this category’s products first.' });
      category.isActive = false; await repo.flush(); return send(res, 200, { category });
    }
    if (req.method !== 'PATCH') return send(res, 405, { error: 'Method not allowed' });
    const body = await readBody(req);
    const next = { ...category };
    if (body.name !== undefined) { next.name = String(body.name).trim().slice(0, 50); if (!next.name) return send(res, 400, { error: 'Category name is required.' }); }
    if (body.isActive === false && await repo.exists('products', { category: category.id, isActive: { $ne: false } })) return send(res, 409, { error: 'Deactivate or move this category’s products first.' });
    if (body.icon !== undefined) next.icon = String(body.icon).slice(0, 8);
    if (body.color !== undefined) { if (!/^#[\da-f]{6}$/i.test(body.color)) return send(res, 400, { error: 'Enter a valid hex color.' }); next.color = body.color; }
    if (body.image !== undefined) { const image = imagePath(body.image); if (image === undefined) return send(res, 400, { error: 'Choose an image path that already exists under /assets/.' }); if (image) next.image = image; else delete next.image; }
    if (body.isActive !== undefined) next.isActive = Boolean(body.isActive);
    for (const key of Object.keys(category)) if (!Object.hasOwn(next, key)) delete category[key];
    Object.assign(category, next);
    await repo.flush(); return send(res, 200, { category });
  }

  if (req.method === 'POST' && route === '/api/admin/delivery-areas') {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 70);
    const pinCodes = Array.isArray(body.pinCodes) ? body.pinCodes.map(String) : String(body.pinCodes || '').split(',').map(pin => pin.trim()).filter(Boolean);
    const deliveryCharge = Number(body.deliveryCharge), minimumOrder = Number(body.minimumOrder);
    const freeDeliveryThreshold = body.freeDeliveryThreshold === '' || body.freeDeliveryThreshold === undefined || body.freeDeliveryThreshold === null ? null : Number(body.freeDeliveryThreshold);
    const etaMinMinutes = Number(body.etaMinMinutes), etaMaxMinutes = Number(body.etaMaxMinutes);
    if (!name || pinCodes.some(pin => !/^\d{6}$/.test(pin)) || new Set(pinCodes).size !== pinCodes.length || !Number.isFinite(deliveryCharge) || deliveryCharge < 0 || !Number.isFinite(minimumOrder) || minimumOrder < 0 || (freeDeliveryThreshold !== null && (!Number.isFinite(freeDeliveryThreshold) || freeDeliveryThreshold < 0)) || !Number.isInteger(etaMinMinutes) || etaMinMinutes < 1 || !Number.isInteger(etaMaxMinutes) || etaMaxMinutes < etaMinMinutes) return send(res, 400, { error: 'Enter a name, optional valid PIN metadata, non-negative charges/minimums, and a valid delivery estimate.' });
    const area = { id: `area-${crypto.randomBytes(6).toString('hex')}`, name, pinCodes, deliveryCharge, minimumOrder, freeDeliveryThreshold, etaMinMinutes, etaMaxMinutes, isActive: body.isActive !== false, isDemoFallback: false, createdAt: new Date().toISOString() };
    await repo.insert('deliveryAreas', area); await repo.flush(); return send(res, 201, { area });
  }
  const deliveryAreaMatch = route.match(/^\/api\/admin\/delivery-areas\/([^/]+)$/);
  if (deliveryAreaMatch) {
    const area = deliveryAreas.find(row => row.id === decodeURIComponent(deliveryAreaMatch[1]));
    if (!area) return send(res, 404, { error: 'Delivery area not found' });
    if (req.method === 'DELETE') {
      await repo.remove('deliveryAreas', { id: area.id });
      await repo.updateMany('shoppingPreferences', { areaId: area.id }, { $unset: { areaId: '' } });
      await repo.flush(); return send(res, 200, { ok: true });
    }
    if (req.method !== 'PATCH') return send(res, 405, { error: 'Method not allowed' });
    const body = await readBody(req), next = { ...area };
    if (body.name !== undefined) next.name = String(body.name).trim().slice(0, 70);
    if (body.pinCodes !== undefined) {
      const pins = Array.isArray(body.pinCodes) ? body.pinCodes.map(String) : String(body.pinCodes || '').split(',').map(pin => pin.trim()).filter(Boolean);
      if (pins.some(pin => !/^\d{6}$/.test(pin)) || new Set(pins).size !== pins.length) return send(res, 400, { error: 'PIN codes must be unique 6-digit values.' });
      next.pinCodes = pins;
      if (pins.length) next.isDemoFallback = false;
    }
    if (body.deliveryCharge !== undefined) next.deliveryCharge = Number(body.deliveryCharge);
    if (body.minimumOrder !== undefined) next.minimumOrder = Number(body.minimumOrder);
    if (body.freeDeliveryThreshold !== undefined) next.freeDeliveryThreshold = body.freeDeliveryThreshold === '' || body.freeDeliveryThreshold === null ? null : Number(body.freeDeliveryThreshold);
    if (body.etaMinMinutes !== undefined) next.etaMinMinutes = Number(body.etaMinMinutes);
    if (body.etaMaxMinutes !== undefined) next.etaMaxMinutes = Number(body.etaMaxMinutes);
    if (body.isActive !== undefined) next.isActive = Boolean(body.isActive);
    if (!next.name || !Number.isFinite(next.deliveryCharge) || next.deliveryCharge < 0 || !Number.isFinite(next.minimumOrder) || next.minimumOrder < 0 || (next.freeDeliveryThreshold !== null && (!Number.isFinite(next.freeDeliveryThreshold) || next.freeDeliveryThreshold < 0)) || !Number.isInteger(next.etaMinMinutes) || next.etaMinMinutes < 1 || !Number.isInteger(next.etaMaxMinutes) || next.etaMaxMinutes < next.etaMinMinutes) return send(res, 400, { error: 'Area name, charges, minimums, and delivery estimate must be valid.' });
    Object.assign(area, next); await repo.flush(); return send(res, 200, { area });
  }

  if (req.method === 'POST' && route === '/api/admin/coupons') {
    const body = await readBody(req); const code = String(body.code || '').trim().toUpperCase();
    const discount = Number(body.discount), minimum = Number(body.minimum), maximumDiscount = body.maximumDiscount === '' || body.maximumDiscount == null ? null : Number(body.maximumDiscount);
    const limits = parseCouponLimits(body);
    const supportedType = ['fixed', 'percentage', 'free_delivery'].includes(body.discountType);
    const validDiscount = body.discountType === 'free_delivery' ? Number.isFinite(discount) && discount === 0 && maximumDiscount === null : Number.isFinite(discount) && discount > 0;
    if (!/^[A-Z0-9_-]{3,32}$/.test(code) || coupons[code] || !supportedType || !validDiscount || (body.discountType === 'percentage' && discount > 100) || !Number.isFinite(minimum) || minimum < 0 || (maximumDiscount !== null && (!Number.isFinite(maximumDiscount) || maximumDiscount <= 0)) || !limits || (body.isActive !== undefined && typeof body.isActive !== 'boolean')) return send(res, 400, { error: 'Enter a unique code and valid discount, limits, expiry, minimum, and optional cap.' });
    const coupon = { code, label: String(body.label || `${code} offer`).trim().slice(0, 80), discountType: body.discountType, discount, minimum, maximumDiscount, isActive: body.isActive === undefined ? true : body.isActive === true, createdAt: new Date().toISOString(), ...limits };
    await repo.insert('coupons', coupon); await repo.flush(); return send(res, 201, { coupon });
  }
  const couponMatch = route.match(/^\/api\/admin\/coupons\/([^/]+)$/);
  if (couponMatch) {
    const code = decodeURIComponent(couponMatch[1]).toUpperCase(); const coupon = coupons[code];
    if (!coupon) return send(res, 404, { error: 'Coupon not found' });
    if (req.method === 'DELETE') { coupon.isActive = false; await repo.flush(); return send(res, 200, { coupon }); }
    if (req.method !== 'PATCH') return send(res, 405, { error: 'Method not allowed' });
    const body = await readBody(req);
    const next = { ...coupon };
    if (body.isActive !== undefined) { if (typeof body.isActive !== 'boolean') return send(res, 400, { error: 'Coupon status must be enabled or disabled.' }); next.isActive = body.isActive; }
    if (body.label !== undefined) next.label = String(body.label).trim().slice(0, 80);
    if (body.minimum !== undefined) { next.minimum = Number(body.minimum); if (!Number.isFinite(next.minimum) || next.minimum < 0) return send(res, 400, { error: 'Minimum order value must be non-negative.' }); }
    if (body.discount !== undefined) { next.discount = Number(body.discount); if (!Number.isFinite(next.discount) || next.discount < 0 || (next.discountType !== 'free_delivery' && next.discount <= 0)) return send(res, 400, { error: 'Enter a valid discount.' }); }
    if (body.discountType !== undefined) { if (!['fixed', 'percentage', 'free_delivery'].includes(body.discountType)) return send(res, 400, { error: 'Discount type must be fixed, percentage, or free delivery.' }); next.discountType = body.discountType; if (body.discountType === 'free_delivery') { next.discount = 0; next.maximumDiscount = null; } }
    if (body.maximumDiscount !== undefined) { next.maximumDiscount = body.maximumDiscount === null || body.maximumDiscount === '' ? null : Number(body.maximumDiscount); if (next.maximumDiscount !== null && (!Number.isFinite(next.maximumDiscount) || next.maximumDiscount <= 0)) return send(res, 400, { error: 'Enter a valid discount cap.' }); }
    const limits = parseCouponLimits(body);
    if (!limits) return send(res, 400, { error: 'Enter valid expiry and redemption limits.' });
    for (const key of ['expiresAt', 'maxRedemptions', 'maxRedemptionsPerCustomer']) if (Object.hasOwn(body, key)) next[key] = limits[key];
    if (next.discountType === 'percentage' && next.discount > 100) return send(res, 400, { error: 'Percentage discounts cannot exceed 100%.' });
    if (next.discountType === 'free_delivery' && (next.discount !== 0 || next.maximumDiscount != null)) return send(res, 400, { error: 'Free-delivery coupons do not use a cash discount or cap.' });
    Object.assign(coupon, next);
    await repo.flush(); return send(res, 200, { coupon });
  }


  return undefined;
}
