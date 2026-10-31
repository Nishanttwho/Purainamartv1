// Read-only inspection: no initialization, index writes, records, or external services.
import fs from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import { mongoConnectionOptions } from '../lib/mongodb.mjs';
import { cloudinaryConfig } from '../lib/cloudinary.mjs';
const config = mongoConnectionOptions(), client = new MongoClient(config.uri, config.options);
try {
  await client.connect();
  const db = client.db(config.dbName);
  const statuses = await db.collection('orders').aggregate([{ $group: { _id: { status: '$status', assigned: { $cond: [{ $ifNull: ['$riderId', false] }, true, false] }, paymentMethod: '$paymentMethod', paymentStatus: '$paymentStatus' }, count: { $sum: 1 } } }]).toArray();
  const media = {};
  for (const name of ['products', 'categories']) {
    const rows = await db.collection(name).find({}, { projection: { image: 1, images: 1, imageAsset: 1 } }).toArray();
    const refs = rows.flatMap(row => [...(Array.isArray(row.image) ? row.image : [row.image]), ...(row.images || [])]).filter(Boolean);
    media[name] = { records: rows.length, local: refs.filter(v => String(v).startsWith('/assets/')).length, cloudinary: refs.filter(v => String(v).startsWith('https://res.cloudinary.com/')).length, other: refs.filter(v => !String(v).startsWith('/assets/') && !String(v).startsWith('https://res.cloudinary.com/')).length, managed: rows.filter(v => v.imageAsset?.public_id).length };
  }
  const settings = await db.collection('settings').find({ key: { $in: ['homepageBanners', 'homepageHeroFruitImage', 'dispatchSettings'] } }, { projection: { key: 1, value: 1 } }).toArray();
  const report = { inspectedAt: new Date().toISOString(), readOnly: true, statuses, media, banners: (settings.find(s => s.key === 'homepageBanners')?.value || []).map(b => ({ id: b.id, referenceType: String(b.image).startsWith('/assets/') ? 'local' : 'remote' })), heroConfigured: Boolean(settings.find(s => s.key === 'homepageHeroFruitImage')?.value), legacyDesignatedRiderConfigured: Boolean(settings.find(s => s.key === 'dispatchSettings')?.value?.designatedRiderId), cloudinaryConfigured: Boolean(cloudinaryConfig()), orderIndexes: (await db.collection('orders').listIndexes().toArray()).map(i => ({ name: i.name, key: i.key })) };
  await fs.mkdir('verification', { recursive: true });
  await fs.writeFile('verification/admin-redesign-audit.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await client.close(); }
