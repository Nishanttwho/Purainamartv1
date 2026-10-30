function publicDocument(document) {
  if (!document) return document;
  const value = document.data && typeof document.data === 'object' ? document.data : document;
  const { _id, data, categoryId: _categoryId, ...publicValue } = value;
  return publicValue;
}

function escapedRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function listMongoProducts(db, { search = '', category = 'all', limit = 100, skip = 0 } = {}) {
  const filter = {
    isActive: { $ne: false },
    stock: { $gt: 0 },
    $or: [
      { 'variants.0': { $exists: false } },
      { variants: { $elemMatch: { isActive: { $ne: false }, stock: { $gt: 0 } } } }
    ]
  };
  if (category !== 'all') filter.category = category;
  const term = String(search).trim();
  if (term) {
    const contains = new RegExp(escapedRegex(term), 'i');
    filter.$and = [{ $or: [{ name: contains }, { detail: contains }, { description: contains }, { category: contains }] }];
  }
  const rows = await db.collection('products').find(filter, { projection: { _id: 0 } }).sort({ position: 1, rank: 1, id: 1 }).skip(Math.max(0, skip)).limit(Math.min(200, Math.max(1, limit))).toArray();
  const products = rows.map(publicDocument);
  return { products, count: await db.collection('products').countDocuments(filter), offset: skip, limit };
}

export async function listMongoCategories(db, { limit = 200, skip = 0 } = {}) {
  const rows = await db.collection('categories')
    .find({ $or: [{ id: 'all' }, { isActive: { $ne: false } }] })
    .sort({ position: 1, id: 1 })
    .skip(skip)
    .limit(limit)
    .toArray();
  return { categories: rows.map(publicDocument) };
}

export async function getMongoProduct(db, id, { includeInactive = false } = {}) {
  const filter = { id: String(id) };
  if (!includeInactive) filter.isActive = { $ne: false };
  return publicDocument(await db.collection('products').findOne(filter));
}

export async function createMongoProduct(db, product) {
  if (!product?.id || !product?.name || !product?.category) throw new TypeError('Product identity, name and category are required.');
  const category = await db.collection('categories').findOne({ id: product.category, isActive: { $ne: false } }, { projection: { _id: 0, id: 1 } });
  if (!category || category.id === 'all') throw Object.assign(new Error('Choose an active category.'), { code: 'INVALID_CATEGORY' });
  const document = { ...product, id: String(product.id), categoryId: String(product.category), createdAt: product.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
  await db.collection('products').insertOne(document);
  return publicDocument(document);
}

export async function updateMongoProduct(db, id, changes) {
  const productId = String(id);
  if (changes.category !== undefined) {
    const category = await db.collection('categories').findOne({ id: String(changes.category), isActive: { $ne: false } }, { projection: { _id: 0, id: 1 } });
    if (!category || category.id === 'all') throw Object.assign(new Error('Choose an active category.'), { code: 'INVALID_CATEGORY' });
  }
  const update = { ...changes, updatedAt: new Date().toISOString() };
  if (update.category !== undefined) update.categoryId = String(update.category);
  const result = await db.collection('products').findOneAndUpdate({ id: productId }, { $set: update }, { returnDocument: 'after', projection: { _id: 0 } });
  return publicDocument(result?.value || result);
}

export async function deactivateMongoProduct(db, id) {
  return updateMongoProduct(db, id, { isActive: false });
}

export async function createMongoCategory(db, category) {
  if (!category?.id || category.id === 'all' || !category?.name) throw new TypeError('A category needs a name and non-reserved ID.');
  const document = { ...category, id: String(category.id), createdAt: category.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
  await db.collection('categories').insertOne(document);
  return document;
}

export async function updateMongoCategory(db, id, changes) {
  const categoryId = String(id);
  if (categoryId === 'all') throw new TypeError('The all-products category cannot be changed through this route.');
  if (changes.isActive === false) {
    const product = await db.collection('products').findOne({ category: categoryId, isActive: { $ne: false } }, { projection: { _id: 0, id: 1 } });
    if (product) throw Object.assign(new Error('Deactivate or move this category’s products first.'), { code: 'CATEGORY_HAS_ACTIVE_PRODUCTS' });
  }
  const result = await db.collection('categories').findOneAndUpdate({ id: categoryId }, { $set: { ...changes, updatedAt: new Date().toISOString() } }, { returnDocument: 'after', projection: { _id: 0 } });
  return publicDocument(result?.value || result);
}

export async function deactivateMongoCategory(db, id) {
  const categoryId = String(id);
  if (categoryId === 'all') throw new TypeError('The all-products category cannot be deactivated.');
  const product = await db.collection('products').findOne({ category: categoryId, isActive: { $ne: false } }, { projection: { _id: 0, id: 1 } });
  if (product) throw Object.assign(new Error('Move or deactivate this category’s products first.'), { code: 'CATEGORY_HAS_PRODUCTS' });
  return updateMongoCategory(db, categoryId, { isActive: false });
}
