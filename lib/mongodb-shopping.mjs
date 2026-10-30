import { randomUUID } from 'node:crypto';

function requireOwner(ownerId) {
  const value = String(ownerId || '');
  if (!value || value.length > 160) throw new TypeError('Shopping owner is invalid.');
  return value;
}

function validateLine(product, { quantity, variantId }) {
  if (!product || product.isActive === false) return { error: 'Product is unavailable.' };
  const amount = Number(quantity);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 999) return { error: 'Quantity must be a positive whole number.' };
  let variant = null;
  if (variantId) {
    variant = (product.variants || []).find(row => row.id === variantId && row.isActive !== false);
    if (!variant) return { error: 'Choose an available product option.' };
  }
  const stock = Number(variant?.stock ?? product.stock);
  const consumed = variant?.unit === 'g' || variant?.unit === 'ml' ? Number(variant.quantityBase) * amount : amount;
  if (!Number.isSafeInteger(stock) || stock < consumed) return { error: 'The requested quantity is not available.' };
  const price = Number(variant?.price ?? product.price);
  if (!Number.isFinite(price) || price < 0) return { error: 'Product pricing is unavailable.' };
  return { line: { productId: String(product.id), ...(variantId ? { variantId } : {}), quantity: amount, price, saleType: product.saleType || 'packed', ...(variant ? { variant: { id: variant.id, label: variant.label, quantityBase: variant.quantityBase, unit: variant.unit } } : {}) } };
}

export async function listMongoAddresses(db, customerId) {
  const owner = requireOwner(customerId);
  return db.collection('addresses').find({ customerId: owner }, { projection: { _id: 0 } }).sort({ isDefault: -1, updatedAt: -1, id: 1 }).toArray();
}

export async function saveMongoAddress(db, customerId, address, { session } = {}) {
  const owner = requireOwner(customerId);
  if (!address || typeof address !== 'object' || Array.isArray(address)) throw new TypeError('Address is invalid.');
  const id = String(address.id || randomUUID());
  const updatedAt = new Date().toISOString();
  const { createdAt = updatedAt, ...addressFields } = address;
  const document = { ...addressFields, id, customerId: owner, createdAt, updatedAt };
  const { createdAt: _createdAt, ...setFields } = document;
  const result = await db.collection('addresses').updateOne({ customerId: owner, id }, { $set: setFields, $setOnInsert: { createdAt } }, { upsert: true, session });
  return { ...document, inserted: Boolean(result.upsertedCount) };
}

export async function deleteMongoAddress(db, customerId, addressId, { session } = {}) {
  return db.collection('addresses').deleteOne({ customerId: requireOwner(customerId), id: String(addressId) }, { session });
}

export async function listMongoCart(db, ownerId, { session } = {}) {
  return await db.collection('carts').findOne({ ownerId: requireOwner(ownerId) }, { session, projection: { _id: 0 } }) || { ownerId, version: 0, items: [] };
}

export async function setMongoCartQuantity(db, ownerId, { productId, variantId = null, quantity }) {
  const owner = requireOwner(ownerId), id = String(productId || '');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return { error: 'Product ID is invalid.' };
  const found = await db.collection('products').findOne({ id }, { projection: { _id: 0 } });
  const checked = validateLine(found, { quantity, variantId });
  if (checked.error) return { error: checked.error };
  const key = variantId ? `${id}:${variantId}` : id;
  const collection = db.collection('carts');
  for (let attempt = 0; attempt < 4; attempt++) {
    const cart = await listMongoCart(db, owner);
    const items = cart.items.filter(item => `${item.productId}${item.variantId ? `:${item.variantId}` : ''}` !== key);
    items.push(checked.line);
    const result = await collection.updateOne({ ownerId: owner, version: cart.version || 0 }, { $set: { items, updatedAt: new Date().toISOString() }, $inc: { version: 1 }, $setOnInsert: { ownerId: owner, createdAt: new Date().toISOString() } }, { upsert: (cart.version || 0) === 0 && !cart.items.length });
    if (result.matchedCount === 1 || result.upsertedCount === 1) return { cart: { ownerId: owner, version: (cart.version || 0) + 1, items } };
  }
  throw new Error('Cart changed concurrently; retry the update.');
}

export async function removeMongoCartItem(db, ownerId, { productId, variantId = null }) {
  const owner = requireOwner(ownerId), key = `${String(productId)}${variantId ? `:${variantId}` : ''}`;
  const collection = db.collection('carts');
  for (let attempt = 0; attempt < 4; attempt++) {
    const cart = await listMongoCart(db, owner);
    const items = cart.items.filter(item => `${item.productId}${item.variantId ? `:${item.variantId}` : ''}` !== key);
    const result = await collection.updateOne({ ownerId: owner, version: cart.version || 0 }, { $set: { items, updatedAt: new Date().toISOString() }, $inc: { version: 1 } });
    if (result.matchedCount === 1) return { ownerId: owner, version: (cart.version || 0) + 1, items };
    if (!cart.items.length) return cart;
  }
  throw new Error('Cart changed concurrently; retry the update.');
}

export async function clearMongoCart(db, ownerId) {
  return db.collection('carts').updateOne({ ownerId: requireOwner(ownerId) }, { $set: { items: [], updatedAt: new Date().toISOString() }, $inc: { version: 1 } });
}

export async function addMongoWishlistItem(db, ownerId, productId) {
  const owner = requireOwner(ownerId), id = String(productId || '');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return { error: 'Product ID is invalid.' };
  const product = await db.collection('products').findOne({ id, isActive: { $ne: false } }, { projection: { _id: 0, id: 1 } });
  if (!product) return { error: 'Product is unavailable.' };
  await db.collection('wishlists').updateOne({ ownerId: owner }, { $setOnInsert: { ownerId: owner, createdAt: new Date().toISOString() }, $addToSet: { productIds: id }, $set: { updatedAt: new Date().toISOString() } }, { upsert: true });
  return db.collection('wishlists').findOne({ ownerId: owner }, { projection: { _id: 0 } });
}

export async function mergeMongoGuestData(db, customerId, guestOwnerId, { session } = {}) {
  const customer = requireOwner(customerId), guest = requireOwner(guestOwnerId);
  if (!guest.startsWith('guest:') || guest === customer) return;
  const carts = db.collection('carts');
  const guestCart = await carts.findOne({ ownerId: guest }, { session });
  if (guestCart?.items?.length) {
    const own = await carts.findOne({ ownerId: customer }, { session });
    const merged = new Map((own?.items || []).map(item => [`${item.productId}:${item.variantId || ''}`, item]));
    for (const item of guestCart.items) {
      const key = `${item.productId}:${item.variantId || ''}`;
      const existing = merged.get(key);
      merged.set(key, existing ? { ...existing, quantity: Math.min(10, existing.quantity + item.quantity) } : { productId: item.productId, ...(item.variantId ? { variantId: item.variantId } : {}), quantity: Math.min(10, item.quantity) });
    }
    await carts.updateOne({ ownerId: customer }, { $set: { items: [...merged.values()], updatedAt: new Date().toISOString() }, $inc: { version: 1 }, $setOnInsert: { ownerId: customer, createdAt: new Date().toISOString() } }, { upsert: true, session });
    await carts.deleteOne({ ownerId: guest }, { session });
  }

  const wishlists = db.collection('wishlists');
  const guestWishlist = await wishlists.findOne({ ownerId: guest }, { session });
  if (guestWishlist?.productIds?.length) {
    const own = await wishlists.findOne({ ownerId: customer }, { session });
    await wishlists.updateOne({ ownerId: customer }, { $set: { productIds: [...new Set([...(own?.productIds || []), ...guestWishlist.productIds])], updatedAt: new Date().toISOString() }, $setOnInsert: { ownerId: customer, createdAt: new Date().toISOString() } }, { upsert: true, session });
    await wishlists.deleteOne({ ownerId: guest }, { session });
  }

  const preferences = db.collection('shoppingPreferences');
  const guestPreferences = await preferences.findOne({ ownerId: guest }, { session });
  if (guestPreferences) {
    const own = await preferences.findOne({ ownerId: customer }, { session });
    const fields = {};
    for (const key of ['couponCode', 'areaId']) if (guestPreferences[key] && !own?.[key]) fields[key] = guestPreferences[key];
    if (Object.keys(fields).length) await preferences.updateOne({ ownerId: customer }, { $set: fields }, { upsert: true, session });
    await preferences.deleteOne({ ownerId: guest }, { session });
  }
}

export const mergeMongoGuestCart = mergeMongoGuestData;
