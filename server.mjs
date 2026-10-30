import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isIPv4 } from 'node:net';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { Pool } from 'pg';
import { assertPostgresSchema, readPostgresStore, writePostgresStore } from './lib/postgres-store.mjs';
import { resolveGoogleCustomer, verifyGoogleIdToken } from './lib/google-auth.mjs';
import { hashPassword, isPasswordHash, validPassword, verifyPassword } from './lib/password.mjs';
import { firebaseMessagingStatus, publicWebMessagingConfig, sendFirebaseInstallationMessage, isInvalidFirebaseInstallation } from './lib/firebase-push.mjs';
import { activeVariant, fromMoneyCents, toMoneyCents, validatePricingVariants } from './lib/product-pricing.mjs';
import { cloudinaryConfig, isCloudinaryImageUrl, signCloudinaryUpload } from './lib/cloudinary.mjs';
import { defaultHomepageBanners, validateHomepageBanners } from './lib/homepage-banners.mjs';
import { isValidSummaryDate, isValidSummaryMonth, summarizeRiderDeliveries } from './lib/rider-delivery-summary.mjs';
import { createSerialRequestQueue, enqueueWithDeadline } from './lib/serial-request-queue.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const dbPath = process.env.STORE_PATH ? path.resolve(process.env.STORE_PATH) : path.join(dataDir, 'store.json');
const usePostgres = Boolean(process.env.DATABASE_URL);
const port = Number(process.env.PORT || 4173);
const isProduction = process.env.NODE_ENV === 'production';
function boundedTimeoutMs(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 250 && parsed <= 120000 ? Math.round(parsed) : fallback;
}
const devHost = process.env.DEV_HOST || '127.0.0.1';
if (!isProduction && process.env.DEV_HOST) {
  const octets = devHost.split('.').map(Number);
  const isPrivateIpv4 = isIPv4(devHost) && (octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168));
  if (!isPrivateIpv4) throw new Error('DEV_HOST must be a private IPv4 address; do not bind the development server to all interfaces.');
}
const testAuthEnabled = process.env.NODE_ENV === 'test' && process.env.APP_TEST_AUTH === '1';
const demoOtp = '246810';
const demoRiderPhone = String(process.env.DEMO_RIDER_PHONE || '9000000000').replace(/\D/g, '').slice(-10);
const demoRiderName = String(process.env.DEMO_RIDER_NAME || 'Demo Rider').slice(0, 50);
const adminPhone = String(process.env.ADMIN_PHONE || '').replace(/\D/g, '').slice(-10);
const adminName = String(process.env.ADMIN_NAME || 'Administrator').trim().slice(0, 50);
const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH || '';
if (isProduction && (!/^\d{10}$/.test(adminPhone) || !isPasswordHash(adminPasswordHash))) throw new Error('Production requires ADMIN_PHONE and a valid ADMIN_PASSWORD_HASH generated with scripts/hash-password.mjs.');
if (isProduction && !usePostgres) throw new Error('Production requires DATABASE_URL. JSON storage is development/test only.');
if (isProduction && process.env.PGSSL === 'disable') throw new Error('PGSSL=disable is not permitted in production. Use a TLS-enabled PostgreSQL connection.');
if (isProduction && typeof crypto.argon2 !== 'function') throw new Error('Production authentication requires Node.js 24.7 or later with built-in Argon2id support.');
const dummyPasswordHash = await hashPassword(crypto.randomBytes(32).toString('hex'));

let categories = [
  { id: 'all', name: 'All', icon: '✨', color: '#eee5ff' },
  { id: 'fruits', name: 'Fruits & Veg', icon: '🥑', color: '#e8f6df', image: '/assets/customer/zepto-home/categories/fruits.webp' },
  { id: 'dairy', name: 'Dairy & Eggs', icon: '🥛', color: '#e5f1ff', image: '/assets/customer/zepto-home/categories/dairy.webp' },
  { id: 'snacks', name: 'Snacks', icon: '🍿', color: '#fff0db', image: '/assets/customer/zepto-home/categories/snacks.webp' },
  { id: 'beverages', name: 'Drinks', icon: '🥤', color: '#fbe3ed', image: '/assets/customer/zepto-home/categories/beverages.webp' },
  { id: 'pantry', name: 'Staples', icon: '🍚', color: '#f8edcf', image: '/assets/customer/zepto-home/categories/staples.webp' },
  { id: 'bakery', name: 'Bakery', icon: '🍞', color: '#f8e8d8', image: '/assets/customer/zepto-home/products/p115-whole-wheat-bread.jpg' },
  { id: 'beauty', name: 'Beauty', icon: '🧴', color: '#f1e4f7', image: '/assets/customer/zepto-home/categories/beauty.webp' },
  { id: 'home', name: 'Home care', icon: '🧽', color: '#e4f4f0', image: '/assets/customer/zepto-home/products/p119-dishwash-liquid.jpeg' },
  { id: 'baby', name: 'Baby care', icon: '🧸', color: '#fce8e0', image: '/assets/customer/zepto-home/products/p121-baby-wipes.jpeg' }
];

let products = [
  { id: 'p101', name: 'Avocado', detail: 'Imported · 1 piece', category: 'fruits', price: 79, mrp: 99, emoji: '🥑', badge: 'Fresh pick', color: '#e5f4dd' },
  { id: 'p102', name: 'Banana Robusta', detail: '4 pieces · approx. 500 g', category: 'fruits', price: 35, mrp: 45, emoji: '🍌', badge: 'Popular', color: '#fff4cf' },
  { id: 'p103', name: 'Strawberry', detail: 'Fresh pack · 200 g', category: 'fruits', price: 99, mrp: 129, emoji: '🍓', badge: 'Fresh pick', color: '#ffe6e8' },
  { id: 'p104', name: 'Baby Spinach', detail: 'Farm fresh · 200 g', category: 'fruits', price: 39, mrp: 49, emoji: '🥬', badge: '', color: '#e7f5e9' },
  { id: 'p105', name: 'Farm Fresh Milk', detail: 'Full cream · 500 ml', category: 'dairy', price: 34, mrp: 37, emoji: '🥛', badge: 'Daily essential', color: '#e8f4ff' },
  { id: 'p106', name: 'Classic Farm Eggs', detail: 'Pack of 6', category: 'dairy', price: 59, mrp: 69, emoji: '🥚', badge: '', color: '#fff5d9' },
  { id: 'p107', name: 'Greek Yogurt', detail: 'Blueberry · 100 g', category: 'dairy', price: 45, mrp: 55, emoji: '🫐', badge: 'New', color: '#efe7ff' },
  { id: 'p108', name: 'Salted Potato Chips', detail: 'Classic salted · 52 g', category: 'snacks', price: 20, mrp: 20, emoji: '🥔', badge: '', color: '#fff0da' },
  { id: 'p109', name: 'Dark Chocolate', detail: 'Rich cocoa · 80 g', category: 'snacks', price: 99, mrp: 120, emoji: '🍫', badge: 'Best price', color: '#f3e6df' },
  { id: 'p110', name: 'Butter Popcorn', detail: 'Ready to pop · 90 g', category: 'snacks', price: 49, mrp: 60, emoji: '🍿', badge: '', color: '#fff2cf' },
  { id: 'p111', name: 'Orange Juice', detail: 'No added sugar · 1 L', category: 'beverages', price: 119, mrp: 140, emoji: '🍊', badge: '20% off', color: '#fff0dc' },
  { id: 'p112', name: 'Sparkling Water', detail: 'Lime · 750 ml', category: 'beverages', price: 45, mrp: 55, emoji: '🫧', badge: '', color: '#e5f6f8' },
  { id: 'p113', name: 'Cold Coffee', detail: 'Classic · 200 ml', category: 'beverages', price: 40, mrp: 50, emoji: '🧋', badge: 'Popular', color: '#f2e8df' },
  { id: 'p114', name: 'Basmati Rice', detail: 'Everyday · 1 kg', category: 'pantry', price: 129, mrp: 159, emoji: '🍚', badge: '', color: '#f8f1de' },
  { id: 'p115', name: 'Whole Wheat Bread', detail: 'Freshly baked · 400 g', category: 'pantry', price: 45, mrp: 50, emoji: '🍞', badge: 'Fresh today', color: '#f6e9d8' },
  { id: 'p116', name: 'Peanut Butter', detail: 'Creamy · 340 g', category: 'pantry', price: 149, mrp: 179, emoji: '🥜', badge: '', color: '#f5ead7' },
  { id: 'p117', name: 'Daily Face Cleanser', detail: 'Gentle · 100 ml', category: 'beauty', price: 179, mrp: 220, emoji: '🧴', badge: 'Bestseller', color: '#f2e9fb' },
  { id: 'p118', name: 'Aloe Moisturizer', detail: 'Hydrating · 100 ml', category: 'beauty', price: 149, mrp: 199, emoji: '🧴', badge: '', color: '#e8f4e7' },
  { id: 'p119', name: 'Dishwash Liquid', detail: 'Lemon · 500 ml', category: 'home', price: 99, mrp: 120, emoji: '🧽', badge: '', color: '#e9f4ec' },
  { id: 'p120', name: 'Laundry Detergent', detail: 'Fresh fragrance · 1 kg', category: 'home', price: 189, mrp: 225, emoji: '🫧', badge: 'Value pack', color: '#e5f0fb' },
  { id: 'p121', name: 'Baby Wipes', detail: 'Gentle care · 72 pulls', category: 'baby', price: 89, mrp: 110, emoji: '🧸', badge: '', color: '#fff0e7' },
  { id: 'p122', name: 'Baby Lotion', detail: 'Soft skin · 200 ml', category: 'baby', price: 149, mrp: 180, emoji: '🧴', badge: '', color: '#ffedf0' }
].map((p, index) => ({
  ...p,
  image: ({
    p101: '/assets/customer/zepto-home/products/p101-avocado.jpeg',
    p102: '/assets/customer/zepto-home/products/p102-banana-robusta.jpeg',
      p103: '/assets/customer/puraina/strawberry-pack.png',
    p104: '/assets/customer/zepto-home/products/p104-spinach.jpeg',
    p105: '/assets/customer/zepto-home/products/p105-farm-fresh-milk.jpeg',
    p106: '/assets/customer/zepto-home/products/p106-farm-eggs.jpg',
    p107: '/assets/customer/zepto-home/products/p107-blueberry-greek-yogurt.jpg',
    p108: '/assets/customer/zepto-home/products/p108-salted-chips.jpg',
    p109: '/assets/customer/zepto-home/products/p109-dark-chocolate.png',
    p110: '/assets/customer/zepto-home/products/p110-butter-popcorn.jpeg',
    p111: '/assets/customer/zepto-home/products/p111-orange-juice.png',
    p112: '/assets/customer/zepto-home/products/p112-sparkling-water.jpeg',
    p113: '/assets/customer/zepto-home/products/p113-cold-coffee.jpg',
    p114: '/assets/customer/zepto-home/products/p114-basmati-rice.jpeg',
    p115: '/assets/customer/zepto-home/products/p115-whole-wheat-bread.jpg',
    p116: '/assets/customer/zepto-home/products/p116-peanut-butter.jpg',
    p117: '/assets/customer/zepto-home/products/p117-face-cleanser.jpg',
    p118: '/assets/customer/zepto-home/products/p118-aloe-moisturizer.jpeg',
    p119: '/assets/customer/zepto-home/products/p119-dishwash-liquid.jpeg',
    p120: '/assets/customer/zepto-home/products/p120-laundry-detergent.jpeg',
    p121: '/assets/customer/zepto-home/products/p121-baby-wipes.jpeg',
    p122: '/assets/customer/zepto-home/products/p122-baby-lotion.jpeg'
  })[p.id] || null,
  description: `${p.name} delivered fresh to your door. Demo listing for local browsing.`,
  ...(p.id === 'p103' ? { rating: 4.6, reviewCount: 1200 } : {}),
  stock: 20, isActive: true, rank: index
}));

// Development catalogue examples for the loose-weight checkout flow. Prices are
// validated again from these server-owned product records when cart lines change.
const looseProducts = [
  { id: 'p123', name: 'Basmati Rice (Loose)', detail: 'Loose · sold by weight', category: 'pantry', price: 62, mrp: null, emoji: '🍚', badge: 'Loose', color: '#fff0dc', description: 'Premium quality basmati rice, measured fresh for your order.', saleType: 'loose', measurementUnit: 'g', stock: 10000, variants: [{ id: 'v-p123-250', label: '250 g', quantityBase: 250, unit: 'g', price: 15.5, mrp: null, stock: 10000, isActive: true }, { id: 'v-p123-500', label: '500 g', quantityBase: 500, unit: 'g', price: 31, mrp: null, stock: 10000, isActive: true }, { id: 'v-p123-1000', label: '1 kg', quantityBase: 1000, unit: 'g', price: 62, mrp: null, stock: 10000, isActive: true }] },
  { id: 'p124', name: 'Wheat Flour (Loose)', detail: 'Loose · sold by weight', category: 'pantry', price: 40, mrp: null, emoji: '🌾', badge: 'Loose', color: '#fff0dc', description: 'Freshly milled wheat flour, measured fresh for your order.', saleType: 'loose', measurementUnit: 'g', stock: 10000, variants: [{ id: 'v-p124-250', label: '250 g', quantityBase: 250, unit: 'g', price: 10, mrp: null, stock: 10000, isActive: true }, { id: 'v-p124-500', label: '500 g', quantityBase: 500, unit: 'g', price: 20, mrp: null, stock: 10000, isActive: true }, { id: 'v-p124-1000', label: '1 kg', quantityBase: 1000, unit: 'g', price: 40, mrp: null, stock: 10000, isActive: true }] },
  { id: 'p125', name: 'Toor Dal (Loose)', detail: 'Loose · sold by weight', category: 'pantry', price: 120, mrp: null, emoji: '🫘', badge: 'Loose', color: '#fff0dc', description: 'Everyday toor dal, measured fresh for your order.', saleType: 'loose', measurementUnit: 'g', stock: 10000, variants: [{ id: 'v-p125-250', label: '250 g', quantityBase: 250, unit: 'g', price: 30, mrp: null, stock: 10000, isActive: true }, { id: 'v-p125-500', label: '500 g', quantityBase: 500, unit: 'g', price: 60, mrp: null, stock: 10000, isActive: true }, { id: 'v-p125-1000', label: '1 kg', quantityBase: 1000, unit: 'g', price: 120, mrp: null, stock: 10000, isActive: true }] }
];

function freshStore() {
  return { users: [], sessions: {}, challenges: {}, adminSessions: {}, adminChallenges: {}, adminAuditLog: [], categories: isProduction ? [] : categories, products: isProduction ? [] : products, carts: { guest: {} }, variantCarts: { guest: {} }, wishlists: { guest: [] }, addresses: {}, deliveryAreas: [], selectedDeliveryAreas: {}, selectedDeliveryAddresses: {}, dispatchSettings: { designatedRiderId: isProduction ? null : 'demo-rider' }, homepageBanners: defaultHomepageBanners(), homepageHeroFruitImage: null, orders: [], notifications: {}, notificationWelcome: {}, coupons: isProduction ? {} : { DEMO50: { code: 'DEMO50', label: '₹50 off your demo order', minimum: 299, discountType: 'fixed', discount: 50, isActive: true }, WELCOME50: { code: 'WELCOME50', label: '₹50 off on your first order', minimum: 299, discountType: 'fixed', discount: 50, isActive: true, maxRedemptionsPerCustomer: 1 } }, referralCampaign: referralCampaignDefaults(), referrals: [], rewards: [], referralEvents: [] };
}

function notificationTemplateDefaults() {
  return Object.fromEntries(['order_received','order_status','rider_assigned','delivery_status','payment_update','referral_reward','promotional_campaign','announcement','rider_order','admin_operational'].map(eventType => [eventType,{ eventType,enabled:true,inAppEnabled:true,pushEnabled:true,updatedAt:null,updatedBy:null }]));
}

const pool = usePostgres ? new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.PG_POOL_MAX || 5), ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: true }, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, statement_timeout: boundedTimeoutMs('PG_STATEMENT_TIMEOUT_MS', 12000), lock_timeout: boundedTimeoutMs('PG_LOCK_TIMEOUT_MS', 4000), idle_in_transaction_session_timeout: boundedTimeoutMs('PG_IDLE_TX_TIMEOUT_MS', 40000), application_name: 'zepto-grocery-app' }) : null;
let postgresStartupClient = null;
let postgresNeedsInitialization = false;
let store;
if (usePostgres) {
  await assertPostgresSchema(pool);
  postgresStartupClient = await pool.connect();
  try {
    await postgresStartupClient.query('BEGIN');
    await postgresStartupClient.query('SELECT pg_advisory_xact_lock($1)', [1718343473]);
    store = await readPostgresStore(postgresStartupClient);
    if (!store) { store = freshStore(); postgresNeedsInitialization = true; }
  } catch (error) { await postgresStartupClient.query('ROLLBACK'); postgresStartupClient.release(); postgresStartupClient = null; throw error; }
} else {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  store = fs.existsSync(dbPath) ? JSON.parse(fs.readFileSync(dbPath, 'utf8')) : freshStore();
}
let activeDatabaseRequest = null;
let storeNeedsMigration = false;
for (const [key, fallback] of Object.entries({ referralCampaign: referralCampaignDefaults(), homepageBanners: defaultHomepageBanners(), homepageHeroFruitImage: null, referrals: [], rewards: [], referralEvents: [], wishlists: { guest: [] }, variantCarts: { guest: {} }, riders: [], riderSessions: {}, riderChallenges: {}, adminSessions: {}, adminChallenges: {}, adminAuditLog: [], notifications: {}, notificationWelcome: {}, notificationPreferences: {}, notificationDevices: [], notificationTemplates: notificationTemplateDefaults(), notificationEvents: {}, notificationOutbox: [], notificationCampaigns: [], notificationDeliveryLogs: [], riderNotifications: {}, selectedDeliveryAreas: {}, selectedDeliveryAddresses: {}, dispatchSettings: { designatedRiderId: 'demo-rider' } })) {
  if (store[key] === undefined) { store[key] = fallback; if (!['homepageBanners', 'homepageHeroFruitImage'].includes(key)) storeNeedsMigration = true; }
}
const defaultNotificationTemplates = notificationTemplateDefaults();
for (const [eventType, template] of Object.entries(defaultNotificationTemplates)) if (!store.notificationTemplates[eventType]) { store.notificationTemplates[eventType] = template; storeNeedsMigration = true; }
if (!store.dispatchSettings || typeof store.dispatchSettings !== 'object' || Array.isArray(store.dispatchSettings)) { store.dispatchSettings = { designatedRiderId: 'demo-rider' }; storeNeedsMigration = true; }
if (!Array.isArray(store.deliveryAreas)) { store.deliveryAreas = []; storeNeedsMigration = true; }
for (const area of store.deliveryAreas) if (area.isDemoFallback && area.isActive !== false) { area.isActive = false; storeNeedsMigration = true; }
if (!Array.isArray(store.products)) { store.products = products; storeNeedsMigration = true; }
if (!Array.isArray(store.categories)) { store.categories = categories; storeNeedsMigration = true; }
store.coupons ||= {};
if (!isProduction && !store.coupons.WELCOME50) { store.coupons.WELCOME50 = { code: 'WELCOME50', label: '₹50 off on your first order', minimum: 299, discountType: 'fixed', discount: 50, isActive: true, maxRedemptionsPerCustomer: 1 }; storeNeedsMigration = true; }
for (const user of store.users) { if (!user.referralCode) { user.referralCode = makeReferralCode(); storeNeedsMigration = true; } }
products = store.products;
categories = store.categories;
if (!isProduction) {
  if (!categories.some(row => row.id === 'bakery')) { categories.push(structuredClone(categories.find(row => row.id === 'pantry') ? { id: 'bakery', name: 'Bakery', icon: '🍞', color: '#f8e8d8', image: '/assets/customer/zepto-home/products/p115-whole-wheat-bread.jpg', isActive: true } : {})); storeNeedsMigration = true; }
  const bread = products.find(row => row.id === 'p115');
  if (bread && bread.category === 'pantry') { bread.category = 'bakery'; storeNeedsMigration = true; }
  for (const [id, image] of [['home','/assets/customer/zepto-home/products/p119-dishwash-liquid.jpeg'],['baby','/assets/customer/zepto-home/products/p121-baby-wipes.jpeg']]) {
    const category = categories.find(row => row.id === id);
    if (category && !category.image) { category.image = image; storeNeedsMigration = true; }
  }
  const strawberry = products.find(row => row.id === 'p103');
  if (strawberry && !strawberry.image) { strawberry.image = '/assets/customer/puraina/strawberry-pack.png'; storeNeedsMigration = true; }
  if (strawberry && !strawberry.rating) { strawberry.rating = 4.6; strawberry.reviewCount = 1200; storeNeedsMigration = true; }
  for (const product of products.filter(row => row.saleType === 'loose' && !row.rating)) { product.rating = 4.5; product.reviewCount = 2100; storeNeedsMigration = true; }
  for (const product of looseProducts) if (!products.some(row => row.id === product.id)) {
    products.push(structuredClone(product)); storeNeedsMigration = true;
  }
  const looseRice = products.find(row => row.id === 'p123');
  if (looseRice && looseRice.image !== '/assets/customer/puraina/basmati-rice-loose.png') { looseRice.image = '/assets/customer/puraina/basmati-rice-loose.png'; storeNeedsMigration = true; }
  const looseFlour = products.find(row => row.id === 'p124');
  if (looseFlour && looseFlour.image !== '/assets/customer/puraina/wheat-flour-loose.png') { looseFlour.image = '/assets/customer/puraina/wheat-flour-loose.png'; storeNeedsMigration = true; }
  const looseDal = products.find(row => row.id === 'p125');
  if (looseDal && looseDal.image !== '/assets/customer/puraina/toor-dal-loose.png') { looseDal.image = '/assets/customer/puraina/toor-dal-loose.png'; storeNeedsMigration = true; }
}
const optimizedProductImageAssets = {
  p103: { source: '/assets/customer/puraina/strawberry-pack.png', thumbnail: '/assets/customer/puraina/p103-strawberry-card-v1.jpg', detail: '/assets/customer/puraina/p103-strawberry-detail-v1.jpg' },
  p123: { source: '/assets/customer/puraina/basmati-rice-loose.png', thumbnail: '/assets/customer/puraina/p123-basmati-rice-loose-card-v1.jpg', detail: '/assets/customer/puraina/p123-basmati-rice-loose-detail-v1.jpg' },
  p124: { source: '/assets/customer/puraina/wheat-flour-loose.png', thumbnail: '/assets/customer/puraina/p124-wheat-flour-loose-card-v1.jpg', detail: '/assets/customer/puraina/p124-wheat-flour-loose-detail-v1.jpg' },
  p125: { source: '/assets/customer/puraina/toor-dal-loose.png', thumbnail: '/assets/customer/puraina/p125-toor-dal-loose-card-v1.jpg', detail: '/assets/customer/puraina/p125-toor-dal-loose-detail-v1.jpg' }
};
for (const product of products) {
  const optimized = optimizedProductImageAssets[product.id];
  if (!optimized || ![optimized.source, optimized.detail].includes(product.image)) continue;
  if (product.image !== optimized.detail) { product.image = optimized.detail; storeNeedsMigration = true; }
  if (product.thumbnail !== optimized.thumbnail) { product.thumbnail = optimized.thumbnail; storeNeedsMigration = true; }
  if (product.thumbnailSource !== optimized.detail) { product.thumbnailSource = optimized.detail; storeNeedsMigration = true; }
  if (Array.isArray(product.images) && product.images.includes(optimized.source)) {
    product.images = product.images.map(image => image === optimized.source ? optimized.detail : image);
    storeNeedsMigration = true;
  }
}
function productHasSellableStock(product) {
  if (!product || product.isActive === false) return false;
  if (Array.isArray(product.variants) && product.variants.length) return product.variants.some(variant => variant.isActive !== false && Number(variant.stock) > 0);
  return Number(product.stock) > 0;
}
for (const product of products) {
  if (product.isActive === undefined) { product.isActive = true; storeNeedsMigration = true; }
  if (!Number.isFinite(Number(product.stock))) { product.stock = isProduction ? 0 : 20; storeNeedsMigration = true; }
}
for (const [code, coupon] of Object.entries(store.coupons || {})) {
  if (coupon.isActive === undefined) { coupon.isActive = true; storeNeedsMigration = true; }
  if (!coupon.discountType) { coupon.discountType = 'fixed'; storeNeedsMigration = true; }
  coupon.code ||= code;
  if (isProduction && code === 'DEMO50' && /demo order/i.test(String(coupon.label || '')) && coupon.isActive !== false) { coupon.isActive = false; storeNeedsMigration = true; }
}
if (isProduction) {
  for (const product of products) {
    if (/(?:^|\. )Demo listing for local browsing\.?$/i.test(String(product.description || '').trim()) && product.isActive !== false) { product.isActive = false; storeNeedsMigration = true; }
  }
}
if (!isProduction && !store.riders.some(rider => rider.id === 'demo-rider')) {
  store.riders.push({ id: 'demo-rider', phone: demoRiderPhone, name: demoRiderName, vehicle: 'Motorbike', status: 'offline', createdAt: new Date().toISOString() });
  storeNeedsMigration = true;
}
if (store.dispatchSettings.designatedRiderId && !store.riders.some(rider => rider.id === store.dispatchSettings.designatedRiderId && rider.isActive !== false)) {
  store.dispatchSettings.designatedRiderId = store.riders.find(rider => rider.id === 'demo-rider' && rider.isActive !== false)?.id || null;
  storeNeedsMigration = true;
}
for (const [mapName, keyName, lifetime] of [['sessions', 'userId', 7 * 86400_000], ['riderSessions', 'riderId', 7 * 86400_000], ['adminSessions', 'adminId', 8 * 3600_000]]) {
  const sessions = store[mapName] || (store[mapName] = {});
  for (const [sid, value] of Object.entries(sessions)) {
    if (typeof value === 'string') { sessions[sid] = { [keyName]: value, expiresAt: Date.now() + lifetime }; storeNeedsMigration = true; }
    else if (!value || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) { delete sessions[sid]; storeNeedsMigration = true; }
  }
}
if (isProduction) {
  for (const [sid, session] of Object.entries(store.sessions)) if (!['password', 'google'].includes(session.authMethod)) { delete store.sessions[sid]; storeNeedsMigration = true; }
  for (const [sid, session] of Object.entries(store.riderSessions)) {
    const rider = store.riders.find(row => row.id === session?.riderId);
    if (session?.authMethod !== 'password' || !rider || rider.isActive === false || !isPasswordHash(rider.passwordHash)) { delete store.riderSessions[sid]; storeNeedsMigration = true; }
  }
  for (const [sid, session] of Object.entries(store.adminSessions)) if (session?.adminId !== 'configured-admin' || session?.authMethod !== 'password') { delete store.adminSessions[sid]; storeNeedsMigration = true; }
  const designatedRider = store.riders.find(row => row.id === store.dispatchSettings?.designatedRiderId);
  if (designatedRider && (designatedRider.isActive === false || !isPasswordHash(designatedRider.passwordHash))) { store.dispatchSettings = { ...store.dispatchSettings, designatedRiderId: null, updatedAt: new Date().toISOString() }; storeNeedsMigration = true; }
}
function persist() {
  if (usePostgres) {
    if (activeDatabaseRequest) activeDatabaseRequest.dirty = true;
    else throw new Error('PostgreSQL persistence must run inside a database transaction.');
    return;
  }
  const temp = `${dbPath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(store, null, 2));
  fs.renameSync(temp, dbPath);
}
if (usePostgres) {
  try {
    if (postgresNeedsInitialization || storeNeedsMigration) await writePostgresStore(postgresStartupClient, store, { replace: postgresNeedsInitialization });
    await postgresStartupClient.query('COMMIT');
  } catch (error) { await postgresStartupClient.query('ROLLBACK'); throw error; }
  finally { postgresStartupClient.release(); postgresStartupClient = null; }
} else if (!fs.existsSync(dbPath) || storeNeedsMigration) persist();

function cookieMap(req, { hashSessions = usePostgres } = {}) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const at = part.indexOf('=');
    const name = decodeURIComponent(part.slice(0, at));
    const value = decodeURIComponent(part.slice(at + 1));
    const persistedValue = usePostgres && hashSessions && ['sid','rsid','asid'].includes(name) ? `h:${crypto.createHash('sha256').update(value).digest('hex')}` : value;
    return [name, persistedValue];
  }));
}
function googleRequestOrigin(req) {
  const origin = req.headers.origin;
  const forwardedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const forwardedProto = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
  if (!origin || !forwardedHost || !['http', 'https'].includes(forwardedProto)) return null;
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || parsed.host.toLowerCase() !== forwardedHost.toLowerCase() || parsed.protocol !== `${forwardedProto}:`) return null;
    return parsed.origin;
  } catch { return null; }
}
function secureCookie(req) {
  return process.env.NODE_ENV === 'production' || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ? '; Secure' : '';
}
function currentUser(req) {
  const sid = cookieMap(req).sid;
  const session = sid && store.sessions[sid];
  const userId = session?.userId;
  if (session && session.expiresAt <= Date.now()) { delete store.sessions[sid]; persist(); return null; }
  if (isProduction && !['password', 'google'].includes(session?.authMethod)) { if (sid && session) { delete store.sessions[sid]; persist(); } return null; }
  const user = store.users.find(row => row.id === userId) || null;
  if (user?.blockedAt) { if (sid) delete store.sessions[sid]; persist(); return null; }
  return user;
}
function currentRider(req) {
  const sid = cookieMap(req).rsid, session = sid && store.riderSessions[sid];
  const riderId = session?.riderId;
  if (session && session.expiresAt <= Date.now()) { delete store.riderSessions[sid]; persist(); return null; }
  const rider = store.riders.find(row => row.id === riderId) || null;
  if (isProduction && (session?.authMethod !== 'password' || !isPasswordHash(rider?.passwordHash))) { if (sid && session) { delete store.riderSessions[sid]; persist(); } return null; }
  return rider;
}
function currentAdmin(req) {
  const sid = cookieMap(req).asid, session = sid && store.adminSessions[sid];
  if (session && session.expiresAt <= Date.now()) { delete store.adminSessions[sid]; persist(); return null; }
  if (isProduction && session?.authMethod !== 'password') { if (sid && session) { delete store.adminSessions[sid]; persist(); } return null; }
  if (session?.adminId === 'test-admin' && testAuthEnabled) return { id: 'test-admin', phone: '9000000001', name: 'Test Administrator' };
  return session?.adminId === 'configured-admin' && adminPhone && adminPasswordHash ? { id: 'configured-admin', phone: adminPhone, name: adminName } : null;
}
const authFailures = new Map();
function authRateKey(req, identity) {
  return crypto.createHash('sha256').update(String(identity)).digest('hex');
}
function authRateLimited(req, identity) {
  const keys = [[authRateKey(req, `phone:${identity}`), 8], [authRateKey(req, `ip:${req.socket.remoteAddress || 'unknown'}`), 30]], now = Date.now();
  for (const [key, limit] of keys) {
    const entry = authFailures.get(key);
    if (entry && now - entry.startedAt <= 15 * 60_000 && entry.failures >= limit) return true;
  }
  for (const [key] of keys) {
    const entry = authFailures.get(key);
    if (!entry || now - entry.startedAt > 15 * 60_000) authFailures.set(key, { startedAt: now, failures: 0 });
  }
  return false;
}
function recordAuthFailure(req, identity) {
  const keys = [authRateKey(req, `phone:${identity}`), authRateKey(req, `ip:${req.socket.remoteAddress || 'unknown'}`)], now = Date.now();
  for (const key of keys) {
    const entry = authFailures.get(key);
    if (!entry || now - entry.startedAt > 15 * 60_000) authFailures.set(key, { startedAt: now, failures: 1 });
    else entry.failures++;
  }
}
function clearAuthFailures(req, identity) {
  authFailures.delete(authRateKey(req, `phone:${identity}`));
  authFailures.delete(authRateKey(req, `ip:${req.socket.remoteAddress || 'unknown'}`));
}
const authFailureCleanup = setInterval(() => { const oldest = Date.now() - 15 * 60_000; for (const [key, entry] of authFailures) if (entry.startedAt < oldest) authFailures.delete(key); }, 60_000);
authFailureCleanup.unref();
function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
}
function passwordError(password) { return !validPassword(password) ? 'Use a password between 12 and 128 characters.' : null; }
function sessionCookie(name, sid, req, lifetimeSeconds) {
  return `${name}=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${lifetimeSeconds}${secureCookie(req)}`;
}
function send(res, status, body, extraHeaders = {}) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders };
  if (res.guestCookie && !Object.keys(extraHeaders).some(name => name.toLowerCase() === 'set-cookie')) headers['set-cookie'] = res.guestCookie;
  else if (res.guestCookie && Object.keys(extraHeaders).some(name => name.toLowerCase() === 'set-cookie')) {
    const key = Object.keys(headers).find(name => name.toLowerCase() === 'set-cookie');
    headers[key] = [...(Array.isArray(headers[key]) ? headers[key] : [headers[key]]), res.guestCookie];
  }
  const responseBody = JSON.stringify(body);
  if (activeDatabaseRequest?.res === res) { activeDatabaseRequest.response = { status, headers, responseBody }; return; }
  res.writeHead(status, headers);
  res.end(responseBody);
}
function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) send(res, 401, { error: 'Sign in to continue', code: 'AUTH_REQUIRED' });
  return user;
}
function requireRider(req, res) {
  const rider = currentRider(req);
  if (rider?.isActive === false) return send(res, 403, { error: 'This rider account is inactive' });
  if (!rider) send(res, 401, { error: 'Sign in with an authorized rider account', code: 'RIDER_AUTH_REQUIRED' });
  else if (rider.mustChangePassword) return send(res, 403, { error: 'Set a new password before using Rider operations.', code: 'PASSWORD_CHANGE_REQUIRED' });
  return rider;
}
function requireAdmin(req, res) {
  const admin = currentAdmin(req);
  if (!admin) send(res, 401, { error: 'Sign in as an authorized local administrator', code: 'ADMIN_AUTH_REQUIRED' });
  return admin;
}
async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('Request body is too large');
  }
  return raw ? JSON.parse(raw) : {};
}
function cartOwner(req) {
  const user = currentUser(req);
  if (user) return user.id;
  if (!req.guestOwner) {
    const cookies = cookieMap(req, { hashSessions: false });
    const valid = /^[A-Za-z0-9_-]{32,80}$/.test(cookies.gid || '');
    const visitorId = valid ? cookies.gid : crypto.randomBytes(24).toString('base64url');
    req.guestOwner = `guest:${visitorId}`;
    if (!valid && req.res && !req.res.headersSent) req.res.guestCookie = sessionCookie('gid', visitorId, req, 365 * 86400);
  }
  return req.guestOwner;
}
function cartFor(req) {
  const key = cartOwner(req);
  store.carts[key] ||= {};
  return store.carts[key];
}
function variantCartFor(req) {
  const key = cartOwner(req);
  store.variantCarts ||= {};
  store.variantCarts[key] ||= {};
  return store.variantCarts[key];
}
function cartSummary(req) {
  const items = cartFor(req);
  const lines = Object.entries(items).map(([id, quantity]) => {
    const product = products.find(p => p.id === id && p.isActive !== false && Number(p.stock) > 0);
    if (!product || !Number.isInteger(quantity) || quantity < 1 || product.variants?.length) return null;
    const priceCents = toMoneyCents(product.price) ?? 0;
    const mrpCents = toMoneyCents(product.mrp);
    return { ...product, saleType: 'legacy', variantId: null, quantity, isAvailable: true, price: fromMoneyCents(priceCents), mrp: mrpCents == null ? null : fromMoneyCents(mrpCents), lineTotal: fromMoneyCents(priceCents * quantity), lineDiscount: mrpCents != null && mrpCents >= priceCents ? fromMoneyCents((mrpCents - priceCents) * quantity) : 0 };
  }).filter(Boolean);
  for (const [productId, selections] of Object.entries(variantCartFor(req))) {
    const product = products.find(p => p.id === productId && p.isActive !== false);
    if (!product || !product.variants?.length || !selections || typeof selections !== 'object') continue;
    for (const [variantId, quantity] of Object.entries(selections)) {
      if (!Number.isInteger(quantity) || quantity < 1) continue;
      const customMatch = product.saleType === 'loose' && product.measurementUnit === 'g' && /^custom-\d{1,6}$/.test(variantId) ? variantId.match(/^custom-(\d{1,6})$/) : null;
      const customGrams = customMatch ? Number(customMatch[1]) : 0;
      const variant = customMatch ? { id: variantId, label: `${customGrams} g`, quantityBase: customGrams, unit: 'g', price: fromMoneyCents(Math.round((toMoneyCents(product.price) || 0) * customGrams / 1000)), mrp: null, stock: Number(product.stock || 0), isActive: customGrams > 0 } : (product.variants || []).find(row => row.id === variantId);
      if (!variant) { lines.push({ ...product, saleType: product.saleType, variantId, variantLabel: 'Unavailable quantity option', quantity, price: 0, mrp: null, lineTotal: 0, lineDiscount: 0, isAvailable: false, availabilityError: 'This quantity option was removed. Remove it from the cart to continue.' }); continue; }
      const consumed = product.saleType === 'packed' ? quantity : variant.quantityBase * quantity;
      const priceCents = toMoneyCents(variant.price) ?? 0;
        const mrpCents = variant.mrp == null ? null : toMoneyCents(variant.mrp);
      const isAvailable = product.isActive !== false && variant.isActive !== false && Number(variant.stock) >= consumed;
      const totalBaseQuantity = variant.quantityBase * quantity;
      const discountPerUnit = mrpCents != null && mrpCents >= priceCents ? fromMoneyCents(mrpCents - priceCents) : 0;
      lines.push({ ...product, id: product.id, saleType: product.saleType, variantId, variantLabel: variant.label, measurementUnit: product.measurementUnit, quantityPerUnit: variant.quantityBase, quantity, baseQuantityTotal: totalBaseQuantity, totalBaseQuantity, price: fromMoneyCents(priceCents), mrp: mrpCents == null ? null : fromMoneyCents(mrpCents), stock: variant.stock, variantStock: variant.stock, discountPerUnit, lineTotal: fromMoneyCents(priceCents * quantity), lineDiscount: fromMoneyCents((toMoneyCents(discountPerUnit) ?? 0) * quantity), isAvailable, availabilityError: isAvailable ? null : variant.isActive === false ? 'This quantity option is disabled. Choose another only if you want to change your selection.' : `Only ${variant.stock} ${product.saleType === 'packed' ? 'pack(s)' : product.measurementUnit} remain for this option.` });
    }
  }
  const subtotalCents = lines.reduce((sum, row) => sum + (toMoneyCents(row.lineTotal) ?? 0), 0);
  const subtotal = fromMoneyCents(subtotalCents);
  const itemSavings = fromMoneyCents(lines.reduce((sum, row) => sum + (toMoneyCents(row.lineDiscount) ?? 0), 0));
  const baseDeliveryQuote = quoteDelivery(req, subtotal);
  const candidateCoupon = store.coupons[store.appliedCoupon?.[cartOwner(req)]] || null;
  let activeCoupon = couponEligible(candidateCoupon, cartOwner(req), subtotal) ? candidateCoupon : null;
  if (activeCoupon?.discountType === 'free_delivery' && (!baseDeliveryQuote.available || !baseDeliveryQuote.minimumOrderMet || baseDeliveryQuote.free)) activeCoupon = null;
  const rawDiscountCents = activeCoupon?.discountType === 'percentage'
    ? Math.round(subtotalCents * Number(activeCoupon.discount || 0) / 100)
    : activeCoupon?.discountType === 'free_delivery' ? 0 : (toMoneyCents(activeCoupon?.discount || 0) ?? 0);
  const maxDiscountCents = activeCoupon?.maximumDiscount == null ? null : toMoneyCents(activeCoupon.maximumDiscount);
  const cappedDiscountCents = maxDiscountCents == null ? rawDiscountCents : Math.min(rawDiscountCents, maxDiscountCents);
  const discount = fromMoneyCents(Math.min(cappedDiscountCents, subtotalCents));
  const deliveryQuote = baseDeliveryQuote;
  const freeDeliveryCouponApplied = activeCoupon?.discountType === 'free_delivery';
  const delivery = freeDeliveryCouponApplied ? 0 : deliveryQuote.delivery;
  const platform = subtotal === 0 ? 0 : 2;
  const finalDiscount = Math.min(discount, subtotal);
  const freeDeliverySavings = deliveryQuote.free || freeDeliveryCouponApplied ? Number(deliveryQuote.area?.deliveryCharge || 0) : 0;
  const couponOffers = Object.values(store.coupons || {}).filter(coupon => couponEligible(coupon, cartOwner(req), subtotal, { allowBelowMinimum: true })).map(coupon => ({
    code: coupon.code,
    label: coupon.label,
    minimum: Number(coupon.minimum || 0),
    discountType: coupon.discountType,
    discount: Number(coupon.discount || 0),
    maximumDiscount: coupon.maximumDiscount == null ? null : Number(coupon.maximumDiscount),
    eligible: couponEligible(coupon, cartOwner(req), subtotal) && (coupon.discountType !== 'free_delivery' || (deliveryQuote.available && deliveryQuote.minimumOrderMet && !deliveryQuote.free)),
    remaining: Math.max(0, Number(coupon.minimum || 0) - subtotal, coupon.discountType === 'free_delivery' ? Math.max(0, Number(deliveryQuote.minimumOrder || 0) - subtotal) : 0),
    ineligibleReason: coupon.discountType === 'free_delivery' && deliveryQuote.free ? 'Free delivery is already included for this order.' : coupon.discountType === 'free_delivery' && !deliveryQuote.available ? 'Choose a delivery address where delivery is available.' : coupon.discountType === 'free_delivery' && !deliveryQuote.minimumOrderMet ? `Add ₹${Math.max(0, Number(deliveryQuote.minimumOrder || 0) - subtotal).toLocaleString('en-IN')} more to meet this area’s minimum order.` : Number(coupon.minimum || 0) > subtotal ? `Add ₹${(Number(coupon.minimum || 0) - subtotal).toLocaleString('en-IN')} more to qualify.` : null
  }));
  const freeDeliveryProgressPercent = freeDeliveryCouponApplied ? 100 : deliveryQuote.available && deliveryQuote.freeDeliveryThreshold != null
    ? deliveryQuote.freeDeliveryThreshold > 0 ? Math.min(100, Math.max(0, Math.round(subtotal / deliveryQuote.freeDeliveryThreshold * 100))) : 100
    : null;
  const totalCents = Math.max(0, subtotalCents - (toMoneyCents(finalDiscount) ?? 0) + (toMoneyCents(delivery) ?? 0) + (toMoneyCents(platform) ?? 0));
  const totalSavings = fromMoneyCents((toMoneyCents(itemSavings) ?? 0) + (toMoneyCents(finalDiscount) ?? 0) + (toMoneyCents(freeDeliverySavings) ?? 0));
  return { items: lines, subtotal, itemSavings, discount: finalDiscount, delivery, freeDeliveryUnlocked: deliveryQuote.free || freeDeliveryCouponApplied, freeDeliveryRemaining: freeDeliveryCouponApplied ? 0 : deliveryQuote.available && deliveryQuote.freeDeliveryThreshold != null ? Math.max(0, deliveryQuote.freeDeliveryThreshold - subtotal) : null, freeDeliveryProgressPercent, freeDeliverySavings, freeDeliveryCouponApplied, totalSavings, platform, total: fromMoneyCents(totalCents), count: lines.reduce((sum, row) => sum + row.quantity, 0), activeCoupon, couponOffers, deliveryArea: deliveryQuote.area, deliveryAvailable: deliveryQuote.available, minimumOrder: deliveryQuote.minimumOrder, minimumOrderMet: deliveryQuote.minimumOrderMet, freeDeliveryThreshold: deliveryQuote.freeDeliveryThreshold, deliveryEstimate: deliveryQuote.estimate, deliveryMessage: deliveryQuote.message };
}
function wishlistFor(req) {
  const key = cartOwner(req);
  store.wishlists[key] ||= [];
  return store.wishlists[key];
}
function couponEligible(coupon, ownerId, subtotal = 0, { allowBelowMinimum = false } = {}) {
  if (!coupon || coupon.isActive === false || (coupon.userId && coupon.userId !== ownerId)) return false;
  if (coupon.expiresAt && (!Number.isFinite(Date.parse(coupon.expiresAt)) || Date.parse(coupon.expiresAt) <= Date.now())) return false;
  const totalRedemptions = couponRedemptionCount(coupon);
  if (coupon.maxRedemptions != null && coupon.maxRedemptions !== '' && totalRedemptions >= Number(coupon.maxRedemptions)) return false;
  if (coupon.maxRedemptionsPerCustomer != null && coupon.maxRedemptionsPerCustomer !== '' && !String(ownerId).startsWith('guest:')) {
    const count = store.orders.filter(order => order.userId === ownerId && order.couponCode === coupon.code).length;
    if (count >= Number(coupon.maxRedemptionsPerCustomer)) return false;
  }
  if (coupon.userId && store.orders.some(order => order.userId === coupon.userId && order.couponCode === coupon.code)) return false;
  return allowBelowMinimum || Number(subtotal || 0) >= Number(coupon.minimum || 0);
}
function couponRedemptionCount(coupon) {
  return Math.max(Number(coupon?.redemptionCount || 0), store.orders.filter(order => order.couponCode === coupon?.code).length);
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
function wishlistProducts(req) {
  return wishlistFor(req).map(id => products.find(product => product.id === id && product.isActive !== false)).filter(Boolean);
}
function clearIneligibleCoupon(req) {
  const owner = cartOwner(req);
  const code = store.appliedCoupon?.[owner];
  const coupon = store.coupons[code];
  if (!coupon) return;
  const subtotal = cartSummary(req).subtotal;
  const quote = quoteDelivery(req, subtotal);
  if (!couponEligible(coupon, owner, subtotal) || coupon.discountType === 'free_delivery' && (!quote.available || !quote.minimumOrderMet || quote.free)) delete store.appliedCoupon[owner];
}
function addressesFor(user) {
  return store.addresses[user.id] || [];
}
function activeDeliveryAreas() {
  return (store.deliveryAreas || []).filter(area => area.isActive !== false);
}
function findDeliveryArea(address, preferredId) {
  const active = activeDeliveryAreas();
  if (address?.deliveryAreaId && preferredId && address.deliveryAreaId !== preferredId) return null;
  const id = address?.deliveryAreaId || preferredId;
  return id ? active.find(area => area.id === id) || null : null;
}
function addressForCustomer(address) {
  if (!address) return null;
  const area = findDeliveryArea(address, address.deliveryAreaId);
  const customerAddress = { ...address };
  delete customerAddress.pincode;
  return { ...customerAddress, deliveryAreaId: area?.id || address.deliveryAreaId || null, deliveryAreaName: area?.name || null, deliveryAreaUnavailable: !area };
}
function quoteDelivery(req, subtotal, options = {}) {
  const moneyLabel = value => `₹${Number(value || 0).toLocaleString('en-IN')}`;
  const owner = cartOwner(req);
  const user = currentUser(req);
  const selectedAddressId = options.addressId || store.selectedDeliveryAddresses?.[owner];
  const address = options.address || (user ? addressesFor(user).find(row => row.id === selectedAddressId) || addressesFor(user).find(row => row.isDefault) || addressesFor(user)[0] : null);
  const preferredId = options.areaId || address?.deliveryAreaId || (address ? null : store.selectedDeliveryAreas?.[owner]);
  const area = findDeliveryArea(address, preferredId);
  const available = Boolean(area && area.isActive !== false);
  const minimumOrder = Number(area?.minimumOrder || 0);
  const minimumOrderMet = available && subtotal >= minimumOrder;
  const threshold = area?.freeDeliveryThreshold == null || area.freeDeliveryThreshold === '' ? null : Number(area.freeDeliveryThreshold);
  const free = available && threshold !== null && threshold >= 0 && subtotal >= threshold;
  const delivery = available ? (free ? 0 : Number(area.deliveryCharge || 0)) : 0;
  const estimate = area ? `${area.etaMinMinutes}–${area.etaMaxMinutes} min` : null;
  return { area: area ? { id: area.id, name: area.name, deliveryCharge: Number(area.deliveryCharge || 0), minimumOrder, freeDeliveryThreshold: threshold, etaMinMinutes: Number(area.etaMinMinutes), etaMaxMinutes: Number(area.etaMaxMinutes) } : null, available, minimumOrder, minimumOrderMet, freeDeliveryThreshold: threshold, estimate, delivery, free, message: !available ? 'Delivery area unavailable. Select an enabled area.' : !minimumOrderMet ? `Add ${moneyLabel(minimumOrder - subtotal)} more to meet this area's minimum order.` : free ? 'Free delivery for this area.' : `Delivery charge ${moneyLabel(delivery)}${threshold === null ? '' : ` · Free above ${moneyLabel(threshold)}`}.` };
}
function referralCampaignDefaults() {
  return { enabled: false, minimumOrder: 399, firstOrderOnly: true, qualifyingStatus: 'Delivered', rewardType: 'free_product', rewardAmount: 50, freeProductId: null, expiryDays: 30, redemptionLimit: 1, maxRewardsPerCustomer: 20, publicBaseUrl: '', demoSettings: true, updatedAt: null };
}
function makeReferralCode() {
  let code;
  do { code = 'ZP' + crypto.randomBytes(4).toString('hex').toUpperCase(); }
  while (store.users.some(row => row.referralCode === code));
  return code;
}
function canonicalPublicBaseUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    if (url.protocol !== 'https:' && (!['localhost', '127.0.0.1'].includes(url.hostname) || isProduction)) return null;
    return url.origin;
  } catch { return null; }
}
function createUniqueOrderDisplayId() {
  let displayId;
  do { displayId = `PM${crypto.randomBytes(12).toString('hex').toUpperCase()}`; }
  while (store.orders.some(order => order.displayId === displayId));
  return displayId;
}
function findReferrerByCode(code) { const normalized = String(code || '').trim().toUpperCase(); return store.users.find(row => row.referralCode === normalized) || null; }
function expireAvailableRewards() {
  const now = Date.now(); let changed = false;
  for (const reward of store.rewards || []) if (reward.status === 'available' && reward.expiresAt && Date.parse(reward.expiresAt) <= now) {
    reward.status = 'expired'; reward.expiredAt = new Date().toISOString();
    if (reward.type === 'coupon' && reward.couponCode && store.coupons[reward.couponCode]) store.coupons[reward.couponCode].isActive = false;
    changed = true;
  }
  if (changed) persist();
}
function issueReferralReward(referral, order) {
  const campaign = store.referralCampaign || referralCampaignDefaults();
  if (!campaign.enabled || order.status !== campaign.qualifyingStatus || referral.status !== 'pending') return null;
  const minimum = Number(campaign.minimumOrder || 0);
  const earlierDelivered = campaign.firstOrderOnly && store.orders.some(row => row.userId === referral.referredUserId && row.id !== order.id && row.createdAt < order.createdAt && row.status === campaign.qualifyingStatus);
  if (earlierDelivered || (campaign.firstOrderOnly && Number(order.subtotal || 0) < minimum)) {
    referral.status = 'not_qualified'; referral.qualifyingOrderId = order.id; referral.qualifiedAt = new Date().toISOString(); return null;
  }
  if (Number(order.subtotal || 0) < minimum) return null;
  const max = Math.max(1, Number(campaign.maxRewardsPerCustomer || 1));
  if (store.rewards.filter(row => row.userId === referral.referrerUserId && row.status !== 'cancelled').length >= max) { referral.status = 'reward_limit_reached'; referral.qualifyingOrderId = order.id; referral.qualifiedAt = new Date().toISOString(); return null; }
  if (store.rewards.some(row => row.qualifyingOrderId === order.id)) return null;
  const at = new Date().toISOString();
  const expiresAt = new Date(Date.now() + Math.max(1, Number(campaign.expiryDays || 30)) * 86400000).toISOString();
  const reward = { id: crypto.randomUUID(), userId: referral.referrerUserId, referralId: referral.id, qualifyingOrderId: order.id, type: campaign.rewardType === 'coupon' ? 'coupon' : 'free_product', amount: Number(campaign.rewardAmount || 0), productId: campaign.rewardType === 'free_product' ? campaign.freeProductId : null, status: 'available', issuedAt: at, expiresAt, redemptionLimit: Math.max(1, Number(campaign.redemptionLimit || 1)), redemptionCount: 0, orderId: null };
  if (reward.type === 'coupon') { const code = 'REF' + crypto.randomBytes(5).toString('hex').toUpperCase(); reward.couponCode = code; store.coupons[code] = { code, label: 'Referral reward', minimum: 0, discountType: 'fixed', discount: reward.amount, isActive: true, expiresAt, userId: reward.userId, rewardId: reward.id, maxRedemptions: reward.redemptionLimit, redemptionCount: 0 }; }
  store.rewards.push(reward); referral.status = 'qualified'; referral.qualifyingOrderId = order.id; referral.qualifiedAt = at; referral.rewardId = reward.id;
  addNotification(reward.userId, { type: 'offer',eventType:'referral_reward',eventId:`reward:${reward.id}:earned`,title: 'Referral reward unlocked', message: reward.type === 'free_product' ? 'A free product reward is ready in My Rewards.' : 'Your referral reward coupon ' + reward.couponCode + ' is ready.',destination:'/#referrals' });
  return reward;
}
function referralDashboard(user) {
  expireAvailableRewards();
  const referrals = (store.referrals || []).filter(row => row.referrerUserId === user.id).map(row => {
    const friend = store.users.find(item => item.id === row.referredUserId), order = store.orders.find(item => item.id === row.qualifyingOrderId), reward = store.rewards.find(item => item.id === row.rewardId);
    return { id: row.id, name: friend?.name || 'New Zepto member', phone: friend?.phone ? '••••' + friend.phone.slice(-4) : (friend?.email || ''), status: row.status, attributedAt: row.attributedAt, qualifyingOrder: order ? { id: order.id, displayId: order.displayId, subtotal: order.subtotal, status: order.status } : null, rewardStatus: reward?.status || null };
  });
  const rewards = (store.rewards || []).filter(row => row.userId === user.id).map(row => { const product = row.productId ? products.find(item => item.id === row.productId) : null; return { ...row, product: product ? { id: product.id, name: product.name, detail: product.detail, description: product.description, image: product.image, emoji: product.emoji, price: product.price, mrp: product.mrp } : null }; });
  return { campaign: { enabled: Boolean(store.referralCampaign?.enabled), minimumOrder: Number(store.referralCampaign?.minimumOrder || 399), rewardType: store.referralCampaign?.rewardType || 'free_product' }, referralCode: user.referralCode, referralUrlBase: canonicalPublicBaseUrl(store.referralCampaign?.publicBaseUrl) || '', referrals, rewards };
}
function maskedPhone(phone) { return phone ? '••••' + String(phone).slice(-4) : ''; }
function referralAdminSnapshot() {
  expireAvailableRewards();
  const relations = (store.referrals || []).map(row => ({ ...row, referrer: store.users.find(user => user.id === row.referrerUserId)?.phone || 'Unknown', referred: maskedPhone(store.users.find(user => user.id === row.referredUserId)?.phone), qualifyingOrder: store.orders.find(order => order.id === row.qualifyingOrderId)?.displayId || null, reward: store.rewards.find(reward => reward.id === row.rewardId)?.status || null }));
  const rewards = (store.rewards || []).map(row => ({ ...row, customer: store.users.find(user => user.id === row.userId)?.phone || 'Unknown', friend: store.users.find(user => user.id === store.referrals.find(ref => ref.id === row.referralId)?.referredUserId)?.phone || 'Unknown', order: store.orders.find(order => order.id === row.qualifyingOrderId)?.displayId || null, product: products.find(product => product.id === row.productId)?.name || null }));
  return { campaign: store.referralCampaign || referralCampaignDefaults(), referrals: relations, rewards, events: (store.referralEvents || []).slice(-100).reverse() };
}

function safeUser(user) {
  if (!user) return null;
  return { id: user.id, phone: user.phone || null, email: user.email || null, name: user.name || 'Zepto member' };
}
function mergeGuestCustomerData(userId, guestId) {
  const guestOwner = `guest:${guestId}`;
  store.carts[userId] ||= {};
  for (const [productId, quantity] of Object.entries(store.carts[guestOwner] || {})) store.carts[userId][productId] = Math.min(10, (store.carts[userId][productId] || 0) + quantity);
  store.carts[guestOwner] = {};
  store.variantCarts ||= {}; store.variantCarts[userId] ||= {};
  for (const [productId, variants] of Object.entries(store.variantCarts[guestOwner] || {})) { store.variantCarts[userId][productId] ||= {}; for (const [variantId, quantity] of Object.entries(variants || {})) store.variantCarts[userId][productId][variantId] = Math.min(10, Number(store.variantCarts[userId][productId][variantId] || 0) + Number(quantity || 0)); }
  store.variantCarts[guestOwner] = {};
  store.wishlists ||= {};
  store.wishlists[userId] = [...new Set([...(store.wishlists[userId] || []), ...(store.wishlists[guestOwner] || [])])];
  store.wishlists[guestOwner] = [];
  store.appliedCoupon ||= {};
  if (store.appliedCoupon[guestOwner] && !store.appliedCoupon[userId]) store.appliedCoupon[userId] = store.appliedCoupon[guestOwner];
  delete store.appliedCoupon[guestOwner];
  store.selectedDeliveryAreas ||= {};
  if (store.selectedDeliveryAreas[guestOwner] && !store.selectedDeliveryAreas[userId]) store.selectedDeliveryAreas[userId] = store.selectedDeliveryAreas[guestOwner];
  delete store.selectedDeliveryAreas[guestOwner];
}
function createCustomerSession(user, authMethod, req) {
  const sid = crypto.randomBytes(24).toString('base64url');
  store.sessions[sid] = { userId: user.id, authMethod, createdAt: Date.now(), expiresAt: Date.now() + 7 * 86400_000 };
  const guestId = cookieMap(req, { hashSessions: false }).gid;
  if (guestId && /^[A-Za-z0-9_-]{32,80}$/.test(guestId)) mergeGuestCustomerData(user.id, guestId);
  persist();
  return sid;
}
function safeRider(rider) {
  return { id: rider.id, name: rider.name, phone: rider.phone, vehicle: rider.vehicle, status: rider.status, isActive: rider.isActive !== false, mustChangePassword: Boolean(rider.mustChangePassword) };
}
function riderOrderSummary(order) {
  const codOutstanding = order.paymentMethod === 'Cash on delivery' && !order.paymentCollection?.collectedAt && !['Delivered', 'Cancelled'].includes(order.status);
  return { id: order.id, displayId: order.displayId, status: order.status, deliveredAt: order.deliveredAt || null, itemCount: order.items.reduce((n, item) => n + item.quantity, 0), city: order.address.city, deliveryArea: order.deliveryArea || null, total: order.total, paymentMethod: order.paymentMethod, paymentStatus: order.paymentStatus, paymentCollection: order.paymentCollection || null, amountToCollect: codOutstanding ? order.total : 0, readyAt: order.readyAt || null, assignedAt: order.assignedAt || null };
}
function riderOrderDetails(order, { preview = false } = {}) {
  const customer = store.users.find(user => user.id === order.userId);
  const contact = { name: order.address?.recipientName || customer?.name || 'Customer', phone: order.address?.phone || customer?.phone || null };
  const mayViewContact = Boolean(order.riderId) || preview;
  const address = order.address || {};
  return { ...riderOrderSummary(order), assignedToRiderId: order.riderId || null, customerContact: mayViewContact ? contact : null, address: mayViewContact ? address : { label: address.label, city: address.city, deliveryAreaName: address.deliveryAreaName }, deliveryInstructions: mayViewContact ? String(address.deliveryInstructions || address.instructions || address.landmark || '').slice(0, 300) : '', deliveryArea: order.deliveryArea || null, items: order.items.map(item => ({ id: item.id, name: item.name, detail: item.detail, emoji: item.emoji, quantity: item.quantity, variantLabel: item.variantLabel || null, saleType: item.saleType || 'legacy', measurementUnit: item.measurementUnit || null, quantityPerUnit: item.quantityPerUnit || null, totalBaseQuantity: item.totalBaseQuantity ?? null, price: item.price, mrp: item.mrp ?? null, lineTotal: item.lineTotal })), timeline: order.timeline, cancellation: order.cancellation || null, paymentVerification: order.paymentVerification || null, paymentReconciliation: order.paymentReconciliation || null, inventoryReconciliationRequired: Boolean(order.inventoryReconciliationRequired) };
}
function markOrderMilestone(order, label, at = new Date().toISOString()) {
  const step = order.timeline.find(row => row.label === label);
  if (step) { step.complete = true; step.at = at; }
}
const notificationCategoryFor = eventType => ({ payment_update:'payments',referral_reward:'referrals_rewards',promotional_campaign:'promotions',announcement:'announcements',admin_operational:'announcements' })[eventType] || 'order_updates';
const defaultNotificationPreferences = () => ({ order_updates:true,payments:true,referrals_rewards:true,promotions:false,announcements:true });
function notificationPreference(ownerType, ownerId, category) {
  return store.notificationPreferences?.[ownerType]?.[ownerId]?.[category] ?? defaultNotificationPreferences()[category] ?? true;
}
function notificationDestination(value = '/') {
  const destination = String(value || '/').trim();
  if (['/', '/#home', '/#orders', '/#notifications', '/#referrals', '/#offers', '/rider'].includes(destination)) return destination;
  const riderOrder = destination.match(/^\/rider\?order=([A-Za-z0-9_-]{1,100})$/);
  return riderOrder ? `/rider?order=${encodeURIComponent(riderOrder[1])}` : '/';
}
function createNotificationEvent(ownerType, ownerId, options) {
  if (!ownerId) return null;
  const eventType = options.eventType || (options.type === 'offer' ? 'promotional_campaign' : 'order_received');
  const category = options.category || notificationCategoryFor(eventType);
  const sourceId = options.eventId || (options.orderId ? `order:${options.orderId}:${eventType}` : crypto.randomUUID());
  const eventId = `${ownerType}:${ownerId}:${sourceId}`.slice(0,240);
  const existing = store.notificationEvents[eventId];
  if (existing) return existing.notificationId ? (ownerType === 'customer' ? (store.notifications[ownerId] || []).find(row => row.id === existing.notificationId) : (store.riderNotifications[ownerId] || []).find(row => row.id === existing.notificationId)) || existing : existing;
  const template = store.notificationTemplates?.[eventType] || { enabled:true,inAppEnabled:true,pushEnabled:true };
  const allowedByPreference = notificationPreference(ownerType, ownerId, category);
  const createdAt = new Date().toISOString();
  const notification = { id:crypto.randomUUID(),type:options.type || (ownerType === 'rider' ? 'delivery' : 'order'),category,title:String(options.title || '').slice(0,100),message:String(options.message || '').slice(0,400),orderId:options.orderId || null,destination:notificationDestination(options.destination),createdAt,readAt:null,...(options.campaignId ? {campaignId:options.campaignId} : {}) };
  const showInApp = template.enabled !== false && template.inAppEnabled !== false && (allowedByPreference || options.forceInApp === true) && options.inApp !== false;
  store.notificationEvents[eventId] = { eventId,eventType,ownerType,ownerId,createdAt,notificationId:showInApp ? notification.id : null,category,title:notification.title,message:notification.message,destination:notification.destination,orderId:notification.orderId,campaignId:options.campaignId || null,status:'created' };
  if (showInApp) {
    if (ownerType === 'customer') { store.notifications[ownerId] ||= []; store.notifications[ownerId].unshift(notification); store.notifications[ownerId] = store.notifications[ownerId].slice(0,100); }
    else if (ownerType === 'rider') { store.riderNotifications[ownerId] ||= []; store.riderNotifications[ownerId].unshift(notification); store.riderNotifications[ownerId] = store.riderNotifications[ownerId].slice(0,100); }
  }
  const shouldPush = options.push !== false && template.enabled !== false && template.pushEnabled !== false && allowedByPreference;
  if (shouldPush) store.notificationOutbox.push({ id:crypto.randomUUID(),eventId,ownerType,ownerId,status:'queued',attempts:0,nextAttemptAt:createdAt,createdAt,processedAt:null,notificationId:notification.id,campaignId:options.campaignId || null });
  else if (!allowedByPreference) store.notificationEvents[eventId].status = 'suppressed_by_preference';
  else if (!template.enabled || template.pushEnabled === false) store.notificationEvents[eventId].status = 'in_app_only';
  return notification;
}
function addNotification(userId, options) {
  if (!userId) return null;
  return createNotificationEvent('customer', userId, options);
}
function createCustomerCouponNotification(admin, user, coupon) {
  const discount = coupon.discountType === 'free_delivery' ? 'free delivery' : coupon.discountType === 'percentage' ? `${coupon.discount}% off${coupon.maximumDiscount ? ` up to ₹${coupon.maximumDiscount}` : ''}` : `₹${coupon.discount} off`;
  const expiry = coupon.expiresAt ? ` Expires ${new Date(coupon.expiresAt).toLocaleDateString('en-IN')}.` : '';
  const notification = addNotification(user.id, { type:'offer',eventType:'announcement',category:'announcements',eventId:`customer-coupon:${coupon.code}:notify`,title:`Your coupon ${coupon.code} is ready`,message:`${coupon.label || coupon.code}: ${discount} on orders over ₹${coupon.minimum || 0}.${expiry}`,destination:'/#offers',inApp:true,forceInApp:true,push:true });
  recordAdminAudit(admin, 'customer.coupon_notified', user.id, { code:coupon.code, notificationId:notification?.id || null });
  return notification;
}
function addRiderNotification(riderId, options) {
  if (!riderId) return null;
  return createNotificationEvent('rider', riderId, { ...options,type:'delivery' });
}
function addAdminNotification(adminId, options) {
  if (!adminId) return null;
  return createNotificationEvent('admin', adminId, options);
}
function notifyDesignatedRider(order) {
  const riderId=store.dispatchSettings?.designatedRiderId;
  const rider=store.riders.find(row=>row.id===riderId&&row.isActive!==false);
  if(!rider||!order||order.status!=='Ready for pickup'||order.riderId)return null;
  return addRiderNotification(rider.id,{eventType:'rider_order',eventId:`order:${order.id}:ready_for_pickup`,title:'New delivery available',message:`Order ${order.displayId} is ready for pickup.`,orderId:order.id,destination:`/rider?order=${encodeURIComponent(order.id)}`});
}
function savePushDevice(ownerType,ownerId,body) {
  const fid=String(body.fid||'').trim(),deviceKey=String(body.deviceKey||'').trim(),platform=String(body.platform||'');
  if(!/^[A-Za-z0-9_-]{20,128}$/.test(fid)||!/^[A-Fa-f0-9-]{20,80}$/.test(deviceKey)||platform!=='web')return {error:'This browser registration is invalid.'};
  const now=new Date().toISOString(),hash=crypto.createHash('sha256').update(deviceKey).digest('hex');
  let device=store.notificationDevices.find(row=>row.platform===platform&&(row.fid===fid||row.deviceKey===hash));
  if(!device){device={id:crypto.randomUUID(),createdAt:now};store.notificationDevices.push(device);}
  const metadata=body.metadata&&typeof body.metadata==='object'?body.metadata:{};
  Object.assign(device,{ownerType,ownerId,platform,fid,deviceKey:hash,status:'active',updatedAt:now,lastSeenAt:now,metadata:{userAgent:String(metadata.userAgent||'').slice(0,240),language:String(metadata.language||'').slice(0,20)}});
  return {ok:true};
}
function deactivatePushDevice(ownerType,ownerId,body) {
  const key=String(body.deviceKey||'').trim();
  if(!/^[A-Fa-f0-9-]{20,80}$/.test(key))return {error:'This browser registration is invalid.'};
  const hash=crypto.createHash('sha256').update(key).digest('hex');
  for(const row of store.notificationDevices)if(row.ownerType===ownerType&&row.ownerId===ownerId&&row.deviceKey===hash){row.status='inactive';row.updatedAt=new Date().toISOString();}
  return {ok:true};
}
function getNotificationPreferences(ownerType,ownerId) {
  return {...defaultNotificationPreferences(),...(store.notificationPreferences?.[ownerType]?.[ownerId]||{})};
}
function saveNotificationPreferences(ownerType,ownerId,body) {
  const allowed=['order_updates','payments','referrals_rewards','promotions','announcements'];
  const next=getNotificationPreferences(ownerType,ownerId);
  for(const key of allowed)if(body[key]!==undefined){if(typeof body[key]!=='boolean')return {error:'Notification preferences must be enabled or disabled.'};next[key]=body[key];}
  store.notificationPreferences[ownerType] ||= {};
  store.notificationPreferences[ownerType][ownerId]=next;
  const affectedCampaigns=new Set();
  for(const job of store.notificationOutbox)if(job.ownerType===ownerType&&job.ownerId===ownerId&&job.status==='queued'&&store.notificationEvents[job.eventId]?.category&&next[store.notificationEvents[job.eventId].category]===false){job.status='skipped';job.processedAt=new Date().toISOString();if(job.campaignId)affectedCampaigns.add(job.campaignId);}
  for(const campaignId of affectedCampaigns)updateCampaignDeliveryStatus(campaignId);
  return {preferences:next};
}
function validateNotificationTarget(target) {
  if(!target||typeof target!=='object'||Array.isArray(target))return false;
  if(['all_customers','customers_ordered','customers_never_ordered','promotional_opt_in','all_riders','designated_rider','admin'].includes(target.type))return true;
  if(target.type==='customer')return store.users.some(row=>row.id===target.id);
  if(target.type==='rider')return store.riders.some(row=>row.id===target.id&&row.isActive!==false);
  if(target.type==='delivery_area')return store.deliveryAreas.some(row=>row.id===target.areaId&&row.isActive!==false);
  return false;
}
function campaignPublic(row) {
  const attemptCount=(store.notificationDeliveryLogs||[]).filter(log=>log.campaignId===row.id).length;
  return {id:row.id,title:row.title,message:row.message,category:row.category,channel:row.channel,target:row.target,destination:row.destination,status:row.status,scheduledAt:row.scheduledAt,createdAt:row.createdAt,createdBy:row.createdBy,processedAt:row.processedAt,deliveryFinishedAt:row.deliveryFinishedAt||null,cancelledAt:row.cancelledAt||null,cancelledBy:row.cancelledBy||null,recipientCount:row.recipientCount||0,attemptCount,acceptedCount:row.acceptedCount||0,failedCount:row.failedCount||0,error:row.error||null};
}
function publicCustomerNotifications(userId) {
  return (store.notifications[userId] || []).filter(row => !(isProduction && row.type === 'offer' && /DEMO50/.test(String(row.message || '')) && /sample order/i.test(String(row.message || ''))));
}
function ensureOfferNotification(user) {
  if (isProduction || !user || store.notificationWelcome[user.id]) return;
  addNotification(user.id, { type: 'offer',eventType:'promotional_campaign',eventId:`welcome-offer:${user.id}`, title: 'A little something for your basket', message: 'Try DEMO50 for ₹50 off a sample order of ₹299 or more.',destination:'/#home' });
  store.notificationWelcome[user.id] = true;
  persist();
}
function mime(file) {
  return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2' })[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function customerForAdmin(user) {
  const customerOrders = store.orders.filter(order => order.userId === user.id);
  return { id: user.id, phone: user.phone || null, email: user.email || null, name: user.name || 'Zepto member', profilePhoto: user.profilePhoto || user.photoURL || user.picture || null, createdAt: user.createdAt, status: user.blockedAt ? 'Blocked' : 'Active', blockedAt: user.blockedAt || null, blockReason: user.blockReason || null, orderCount: customerOrders.length, orderValue: customerOrders.reduce((sum, order) => sum + Number(order.total || 0), 0), wishlistCount: (store.wishlists[user.id] || []).length, unreadNotifications: publicCustomerNotifications(user.id).filter(row => !row.readAt).length };
}
function customerListForAdmin(user) {
  return { ...customerForAdmin(user), phone: user.phone || null, searchPhone: user.phone || null };
}
function recordAdminAudit(admin, action, userId, details = {}) {
  store.adminAuditLog ||= [];
  store.adminAuditLog.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), adminId: admin.id, action, userId, details });
  store.adminAuditLog = store.adminAuditLog.slice(0, 2000);
}
function customerCouponStatus(coupon, userId) {
  const usedOrder = store.orders.find(order => order.userId === userId && order.couponCode === coupon.code);
  if (usedOrder) return { status: 'Used', usedOrder, appliedDiscount: Number(usedOrder.discount || 0) };
  if (coupon.revokedAt || coupon.isActive === false) return { status: 'Revoked' };
  if (coupon.expiresAt && Date.parse(coupon.expiresAt) <= Date.now()) return { status: 'Expired' };
  if (coupon.maxRedemptions != null && couponRedemptionCount(coupon) >= Number(coupon.maxRedemptions)) return { status: 'Exhausted' };
  return { status: 'Available' };
}

function orderForAdmin(order) {
  const customer = store.users.find(user => user.id === order.userId);
  const rider = store.riders.find(row => row.id === order.riderId);
  const referralRewardIssued = (store.referrals || []).some(referral => referral.qualifyingOrderId === order.id && referral.rewardId);
  return { ...order, referralRewardIssued, customer: customer ? customerForAdmin(customer) : null, rider: rider ? safeRider(rider) : null };
}

function adminSnapshot(admin) {
  const orders = store.orders.map(orderForAdmin).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const today = new Date().toISOString().slice(0, 10);
  const delivered = store.orders.filter(order => order.status === 'Delivered');
  return {
    admin: { name: admin?.name || adminName, phone: admin?.phone || null },
    metrics: {
      orders: store.orders.length,
      openOrders: store.orders.filter(order => !['Delivered', 'Cancelled'].includes(order.status)).length,
      deliveredToday: delivered.filter(order => order.deliveredAt?.slice(0, 10) === today).length,
      sales: delivered.reduce((sum, order) => sum + Number(order.total || 0), 0),
      customers: store.users.length,
      lowStock: products.filter(product => product.isActive !== false && Number(product.stock) <= 5).length
    },
    products,
    homepageBanners: store.homepageBanners || defaultHomepageBanners(),
    homepageHeroFruitImage: store.homepageHeroFruitImage || null,
    categories: categories.filter(category => category.id !== 'all'),
    deliveryAreas: store.deliveryAreas,
    referralRewards: referralAdminSnapshot(),
    orders,
    customers: store.users.map(customerListForAdmin).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')),
    riders: store.riders.map(rider => ({ ...safeRider(rider), deliverySummary: summarizeRiderDeliveries(store.orders, rider.id, new Date().toISOString().slice(0, 7)) })),
    dispatchSettings: { ...store.dispatchSettings, designatedRider: store.riders.find(row => row.id === store.dispatchSettings.designatedRiderId) ? safeRider(store.riders.find(row => row.id === store.dispatchSettings.designatedRiderId)) : null },
    coupons: Object.values(store.coupons).map(coupon => ({ ...coupon, redemptionCount: couponRedemptionCount(coupon) })),
    adminAuditLog: (store.adminAuditLog || []).slice(0, 200),
    notifications: Object.entries(store.notifications).flatMap(([userId]) => publicCustomerNotifications(userId).map(row => ({ ...row, userId, customer: store.users.find(user => user.id === userId)?.phone || 'Guest' }))).slice(0, 100),
    notificationCenter: {
      config: firebaseMessagingStatus(),
      devices: { customer:store.notificationDevices.filter(row=>row.ownerType==='customer'&&row.status==='active').length,rider:store.notificationDevices.filter(row=>row.ownerType==='rider'&&row.status==='active').length,admin:store.notificationDevices.filter(row=>row.ownerType==='admin'&&row.status==='active').length },
      templates: Object.values(store.notificationTemplates),
      campaigns: store.notificationCampaigns.slice(0,100).map(campaignPublic),
      deliveryLogs: store.notificationDeliveryLogs.slice(-250).reverse().map(({ id,campaignId,eventId,ownerType,ownerId,status,attemptedAt,providerMessageId,errorCode })=>({ id,campaignId,eventId,ownerType,ownerId,status,attemptedAt,providerMessageId,errorCode }))
    }
  };
}

function resolveNotificationRecipients(target, category = 'announcements', adminId = null) {
  const result = [];
  if (!target || typeof target !== 'object') return result;
  if (target.type === 'customer' && store.users.some(row=>row.id===target.id)) result.push({ ownerType:'customer',ownerId:target.id });
  else if (target.type === 'all_customers') result.push(...store.users.map(row=>({ownerType:'customer',ownerId:row.id})));
  else if (target.type === 'customers_ordered' || target.type === 'customers_never_ordered') {
    const ordered = new Set(store.orders.map(row=>row.userId));
    result.push(...store.users.filter(row=>target.type==='customers_ordered'?ordered.has(row.id):!ordered.has(row.id)).map(row=>({ownerType:'customer',ownerId:row.id})));
  } else if (target.type === 'promotional_opt_in') result.push(...store.users.filter(row=>notificationPreference('customer',row.id,'promotions')).map(row=>({ownerType:'customer',ownerId:row.id})));
  else if (target.type === 'delivery_area') {
    const area=store.deliveryAreas.find(row=>row.id===target.areaId&&row.isActive!==false);
    if (area) result.push(...store.users.filter(user=>(store.addresses[user.id]||[]).some(address=>address.deliveryAreaId===area.id)).map(row=>({ownerType:'customer',ownerId:row.id})));
  } else if (target.type === 'rider' && store.riders.some(row=>row.id===target.id&&row.isActive!==false)) result.push({ownerType:'rider',ownerId:target.id});
  else if (target.type === 'all_riders') result.push(...store.riders.filter(row=>row.isActive!==false).map(row=>({ownerType:'rider',ownerId:row.id})));
  else if (target.type === 'designated_rider') { const id=store.dispatchSettings?.designatedRiderId; if(id&&store.riders.some(row=>row.id===id&&row.isActive!==false))result.push({ownerType:'rider',ownerId:id}); }
  else if (target.type === 'admin') { if(adminId) result.push({ownerType:'admin',ownerId:adminId}); }
  const unique = new Map(result.map(row=>[`${row.ownerType}:${row.ownerId}`,row]));
  return [...unique.values()].filter(row => category !== 'promotions' || notificationPreference(row.ownerType,row.ownerId,'promotions'));
}

function processDueNotificationCampaignsInStore(now = Date.now()) {
  const due=store.notificationCampaigns.filter(row=>['queued','scheduled'].includes(row.status)&&(!row.scheduledAt||Date.parse(row.scheduledAt)<=now)).sort((a,b)=>(a.scheduledAt||a.createdAt).localeCompare(b.scheduledAt||b.createdAt)).slice(0,10);
  if(!due.length)return false;
  for(const campaign of due){
    campaign.status='processing';
    const recipients=resolveNotificationRecipients(campaign.target,campaign.category,campaign.createdBy);
    campaign.recipientCount=recipients.length;
    for(const recipient of recipients){
      const eventType=campaign.category==='promotions'?'promotional_campaign':'announcement';
      const options={eventType,eventId:`campaign:${campaign.id}`,campaignId:campaign.id,category:campaign.category,title:campaign.title,message:campaign.message,destination:campaign.destination,inApp:['in_app','both'].includes(campaign.channel),push:['push','both'].includes(campaign.channel)};
      createNotificationEvent(recipient.ownerType,recipient.ownerId,{...options,type:campaign.category==='promotions'?'offer':recipient.ownerType==='rider'?'delivery':'announcement'});
    }
    campaign.processedAt=new Date(now).toISOString();
    const jobs=store.notificationOutbox.filter(row=>row.campaignId===campaign.id);
    campaign.status=jobs.length?'queued':'recorded';
    if(!recipients.length){campaign.status='failed';campaign.error='No eligible recipients at dispatch time.';}
  }
  return true;
}

function adminEvent(order, label, reason = '') {
  const at = new Date().toISOString();
  const step = order.timeline.find(row => row.label === label);
  if (step) { step.complete = true; step.at = at; }
  else order.timeline.push({ label, at, complete: true, ...(reason ? { reason } : {}) });
  return at;
}

function paymentAllowsDelivery(order) {
  if (order.paymentMethod === 'Cash on delivery') {
    const collection = order.paymentCollection;
    return Boolean(collection?.collectedAt && collection.riderId === order.riderId && Number(collection.amount) === Number(order.total) && collection.method === 'cash');
  }
  if (order.paymentMethod === 'Demo UPI') return !isProduction && order.paymentStatus === 'Demo payment complete (simulated)';
  return Boolean(order.paymentVerification?.status === 'verified' && order.paymentVerification?.transactionReference);
}

function cancelOrder(order, { actorType, actorId, reason }) {
  const previousStatus = order.status;
  const at = new Date().toISOString();
  order.status = 'Cancelled';
  order.cancellation = { actorType, actorId, reason, at, previousStatus };
  order.cancellationReason = reason;
  order.cancelledAt = at;
  order.history ||= [];
  order.history.push({ status: 'Cancelled', at, actorType, actorId, reason, previousStatus });
  adminEvent(order, 'Cancelled', reason);
  if (!order.inventoryRestockedAt && ['Order received', 'Being packed', 'Ready for pickup', 'Rider assigned'].includes(previousStatus)) {
    for (const item of order.items) { const product = products.find(row => row.id === item.id); if (!product) continue; const amount = item.saleType === 'packed' ? Number(item.quantity || 0) : item.saleType === 'loose' ? Number(item.totalBaseQuantity || 0) : Number(item.quantity || 0); if (item.variantId) { const variant = product.variants?.find(row => row.id === item.variantId); if (variant) variant.stock = Number(variant.stock || 0) + amount; } product.stock = Number(product.stock || 0) + amount; }
    order.inventoryRestockedAt = at;
  } else if (['Picked up', 'Out for delivery'].includes(previousStatus)) {
    order.inventoryReconciliationRequired = true;
  }
  if (order.paymentCollection?.collectedAt) {
    order.paymentStatus = 'Cash collection reconciliation required';
    order.paymentReconciliation = { status: 'review_required', reason: 'Order cancelled after rider collected cash', amount: order.paymentCollection.amount, flaggedAt: at };
  } else if (order.paymentVerification?.status === 'verified') {
    order.paymentStatus = 'Refund review required';
    order.paymentReconciliation = { status: 'refund_review_required', reason: 'Order cancelled after verified online payment', amount: order.total, transactionReference: order.paymentVerification.transactionReference, flaggedAt: at };
  } else if (order.paymentMethod === 'Demo UPI' && ['Demo payment complete', 'Demo payment complete (simulated)'].includes(order.paymentStatus)) {
    order.paymentStatus = 'Simulated refund review required';
    order.paymentReconciliation = { status: 'simulated_refund_review_required', reason: 'Demo UPI payment was simulated; no provider refund was issued', amount: order.total, flaggedAt: at };
  } else if (order.paymentMethod === 'Cash on delivery') {
    order.paymentStatus = 'Not collected (order cancelled)';
  }
  return at;
}

function adminImagePath(value) {
  const image = String(value || '').trim();
  if (!image) return null;
  if (isCloudinaryImageUrl(image, cloudinaryConfig()?.cloudName || null)) return image;
  if (!image.startsWith('/assets/') || image.includes('..')) return undefined;
  const file = path.resolve(publicDir, `.${image}`);
  return file.startsWith(path.join(publicDir, 'assets') + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile() ? image : undefined;
}

async function handleAdminApi(req, res, url) {
  const admin = requireAdmin(req, res);
  if (!admin) return true;
  const route = url.pathname;
  if (req.method === 'GET' && route === '/api/admin/session') return send(res, 200, { admin });
  if (req.method === 'GET' && route === '/api/admin/bootstrap') return send(res, 200, adminSnapshot(admin));
  if (req.method === 'GET' && route === '/api/admin/rider-delivery-summaries') {
    const month = url.searchParams.get('month') || new Date().toISOString().slice(0, 7);
    const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    if (!isValidSummaryMonth(month)) return send(res, 400, { error: 'Month must use YYYY-MM format.' });
    if (!isValidSummaryDate(date) || date > new Date().toISOString().slice(0, 10)) return send(res, 400, { error: 'Choose a valid date no later than today.' });
    return send(res, 200, { month, date, today: new Date().toISOString().slice(0, 10), riders: store.riders.map(rider => ({ id: rider.id, name: rider.name, deliverySummary: summarizeRiderDeliveries(store.orders, rider.id, month, date) })) });
  }
  if (req.method === 'PATCH' && route === '/api/admin/hero-fruit') {
    const body = await readBody(req);
    const image = body.image == null || body.image === '' ? null : adminImagePath(body.image);
    if (image === undefined) return send(res, 400, { error: 'Choose a Cloudinary URL or an existing image under /assets/.' });
    store.homepageHeroFruitImage = image;
    persist();
    return send(res, 200, { homepageHeroFruitImage: image });
  }
  if (req.method === 'GET' && route === '/api/admin/cloudinary/signature') {
    const config = cloudinaryConfig();
    if (!config) return send(res, 503, { error: 'Cloudinary image uploads are not configured on this server.' }, { 'cache-control': 'no-store' });
    try { return send(res, 200, signCloudinaryUpload(config), { 'cache-control': 'no-store' }); }
    catch { return send(res, 503, { error: 'Cloudinary image uploads are not configured on this server.' }, { 'cache-control': 'no-store' }); }
  }
  if (req.method === 'PATCH' && route === '/api/admin/banners') {
    const body = await readBody(req);
    const result = validateHomepageBanners(body.banners, { isAllowedImage: image => adminImagePath(image) !== undefined && adminImagePath(image) !== null, products, categories });
    if (result.error) return send(res, 400, { error: result.error });
    store.homepageBanners = result.banners.map(banner => ({ ...banner, updatedAt: new Date().toISOString(), updatedBy: admin.id }));
    persist();
    return send(res, 200, { banners: store.homepageBanners });
  }
  if (route === '/api/admin/notifications/devices' && req.method === 'POST') { const result=savePushDevice('admin',admin.id,await readBody(req));if(result.error)return send(res,400,result);persist();scheduleNotificationWorkers();return send(res,200,{ok:true,status:'active'}); }
  if (route === '/api/admin/notifications/devices/deactivate' && req.method === 'POST') { deactivatePushDevice('admin',admin.id,await readBody(req));persist();return send(res,200,{ok:true}); }
  if (route === '/api/admin/notifications/estimate' && req.method === 'POST') {
    const body=await readBody(req),category=String(body.category||'announcements');
    if(!['order_updates','payments','referrals_rewards','promotions','announcements'].includes(category)||!validateNotificationTarget(body.target))return send(res,400,{error:'Choose a valid notification category and recipient group.'});
    return send(res,200,{eligibleRecipients:resolveNotificationRecipients(body.target,category,admin.id).length,maximumRecipients:500,largeCampaignConfirmationRequired:resolveNotificationRecipients(body.target,category,admin.id).length>50});
  }
  if (route === '/api/admin/notifications/test' && req.method === 'POST') {
    const device=store.notificationDevices.find(row=>row.ownerType==='admin'&&row.ownerId===admin.id&&row.platform==='web'&&row.status==='active');
    if(!device)return send(res,409,{error:'Enable notifications on this signed-in Admin browser first.'});
    const body=await readBody(req),title=String(body.title||'Notification test').trim().slice(0,100),message=String(body.message||'Your browser is registered for store notifications.').trim().slice(0,400);
    if(!title||!message)return send(res,400,{error:'Add a test title and message.'});
    const item=createNotificationEvent('admin',admin.id,{eventType:'announcement',eventId:`admin-test:${crypto.randomUUID()}`,category:'announcements',title,message,push:true,inApp:false,destination:'/'});
    persist();scheduleNotificationWorkers();return send(res,202,{status:'queued',eventId:item?.id||null});
  }
  if (route === '/api/admin/notifications' && req.method === 'GET') return send(res,200,{campaigns:store.notificationCampaigns.slice(0,100).map(campaignPublic),deliveryLogs:store.notificationDeliveryLogs.slice(-500).reverse().map(({id,campaignId,eventId,ownerType,ownerId,status,attemptedAt,providerMessageId,errorCode})=>({id,campaignId,eventId,ownerType,ownerId,status,attemptedAt,providerMessageId,errorCode})),templates:Object.values(store.notificationTemplates),status:firebaseMessagingStatus()});
  if (route === '/api/admin/notifications' && req.method === 'POST') {
    const body=await readBody(req),title=String(body.title||'').trim(),message=String(body.message||body.body||'').trim(),category=String(body.category||'announcements'),channel=String(body.channel||'both'),target=body.target|| (body.userId==='all'?{type:'all_customers'}:{type:'customer',id:String(body.userId||'')});
    if(!title||title.length>100||!message||message.length>400)return send(res,400,{error:'Title must be 1–100 characters and message 1–400 characters.'});
    if(!['order_updates','payments','referrals_rewards','promotions','announcements'].includes(category)||!['in_app','push','both'].includes(channel)||!validateNotificationTarget(target))return send(res,400,{error:'Choose a supported category, channel, and authorized recipient group.'});
    const destination=notificationDestination(body.destination|| (category==='promotions'?'/#home':category==='referrals_rewards'?'/#referrals':'/#notifications'));
    const recipients=resolveNotificationRecipients(target,category,admin.id);
    if(recipients.length>500)return send(res,413,{error:'This campaign exceeds the 500-recipient limit. Narrow the target group.'});
    if(recipients.length>50&&body.confirmLargeAudience!==true)return send(res,409,{error:`This campaign targets ${recipients.length} accounts. Confirm the large audience before queuing.`});
    const now=new Date(),scheduledAt=body.scheduledAt?new Date(String(body.scheduledAt)):null;
    if(body.scheduledAt&&(!Number.isFinite(scheduledAt?.getTime())||scheduledAt.getTime()<now.getTime()+120000||scheduledAt.getTime()>now.getTime()+30*86400000))return send(res,400,{error:'Scheduled send time must be at least 2 minutes and no more than 30 days from now.'});
    const signature=crypto.createHash('sha256').update(JSON.stringify({adminId:admin.id,title,message,category,channel,target,destination,scheduledAt:scheduledAt?.toISOString()||null})).digest('hex');
    if(store.notificationCampaigns.some(row=>row.signature===signature&&Date.now()-Date.parse(row.createdAt)<60000))return send(res,409,{error:'A matching campaign was already created recently.'});
    const campaign={id:crypto.randomUUID(),title,message,category,channel,target,destination,status:scheduledAt?'scheduled':'queued',scheduledAt:scheduledAt?.toISOString()||null,createdAt:now.toISOString(),createdBy:admin.id,signature,processedAt:null,recipientCount:0,acceptedCount:0,failedCount:0};
    store.notificationCampaigns.unshift(campaign);persist();scheduleNotificationWorkers();
    return send(res,202,{campaign:campaignPublic(campaign),estimatedRecipients:recipients.length});
  }
  const cancelCampaignMatch=route.match(/^\/api\/admin\/notifications\/campaigns\/([^/]+)\/cancel$/);
  if(req.method==='POST'&&cancelCampaignMatch){const campaign=store.notificationCampaigns.find(row=>row.id===decodeURIComponent(cancelCampaignMatch[1]));if(!campaign)return send(res,404,{error:'Campaign not found.'});if(!['queued','scheduled'].includes(campaign.status))return send(res,409,{error:'Only queued or scheduled campaigns can be cancelled.'});campaign.status='cancelled';campaign.cancelledAt=new Date().toISOString();campaign.cancelledBy=admin.id;persist();return send(res,200,{campaign:campaignPublic(campaign)});}
  const duplicateCampaignMatch=route.match(/^\/api\/admin\/notifications\/campaigns\/([^/]+)\/duplicate$/);
  if(req.method==='POST'&&duplicateCampaignMatch){const source=store.notificationCampaigns.find(row=>row.id===decodeURIComponent(duplicateCampaignMatch[1]));if(!source)return send(res,404,{error:'Campaign not found.'});const draft={...source,id:crypto.randomUUID(),status:'draft',scheduledAt:null,createdAt:new Date().toISOString(),createdBy:admin.id,processedAt:null,recipientCount:0,acceptedCount:0,failedCount:0,signature:null};store.notificationCampaigns.unshift(draft);persist();return send(res,201,{campaign:campaignPublic(draft)});}
  const templateMatch=route.match(/^\/api\/admin\/notifications\/templates\/([a-z_]+)$/);
  if(req.method==='PATCH'&&templateMatch){const eventType=templateMatch[1],template=store.notificationTemplates[eventType];if(!template)return send(res,404,{error:'Notification template not found.'});const body=await readBody(req);for(const key of ['enabled','inAppEnabled','pushEnabled'])if(body[key]!==undefined){if(typeof body[key]!=='boolean')return send(res,400,{error:'Template switches must be boolean values.'});template[key]=body[key];}template.updatedAt=new Date().toISOString();template.updatedBy=admin.id;persist();return send(res,200,{template});}
  if (req.method === 'GET' && route === '/api/admin/referrals') return send(res, 200, referralAdminSnapshot());
  if (req.method === 'PATCH' && route === '/api/admin/referrals/campaign') {
    const body = await readBody(req), current = store.referralCampaign || referralCampaignDefaults(), next = { ...current };
    if (body.enabled !== undefined) next.enabled = Boolean(body.enabled);
    if (body.minimumOrder !== undefined) next.minimumOrder = Number(body.minimumOrder);
    if (body.firstOrderOnly !== undefined) next.firstOrderOnly = Boolean(body.firstOrderOnly);
    if (body.qualifyingStatus !== undefined) next.qualifyingStatus = String(body.qualifyingStatus);
    if (body.rewardType !== undefined) next.rewardType = String(body.rewardType);
    if (body.rewardAmount !== undefined) next.rewardAmount = Number(body.rewardAmount);
    if (body.freeProductId !== undefined) next.freeProductId = String(body.freeProductId || '') || null;
    if (body.expiryDays !== undefined) next.expiryDays = Number(body.expiryDays);
    if (body.redemptionLimit !== undefined) next.redemptionLimit = Number(body.redemptionLimit);
    if (body.maxRewardsPerCustomer !== undefined) next.maxRewardsPerCustomer = Number(body.maxRewardsPerCustomer);
    if (body.publicBaseUrl !== undefined) {
      const rawBase = String(body.publicBaseUrl || '').trim().replace(/\/$/, '');
      if (rawBase) { const parsedBase = canonicalPublicBaseUrl(rawBase); if (!parsedBase) return send(res, 400, { error: 'Enter a canonical public app origin without credentials, path, query, or fragment.' }); }
      next.publicBaseUrl = rawBase.slice(0, 300);
    }
    if (typeof next.enabled !== 'boolean' || !Number.isFinite(next.minimumOrder) || next.minimumOrder < 0 || !['Delivered'].includes(next.qualifyingStatus) || !['coupon','free_product'].includes(next.rewardType) || !Number.isFinite(next.rewardAmount) || next.rewardAmount < 0 || !Number.isInteger(next.expiryDays) || next.expiryDays < 1 || next.expiryDays > 365 || !Number.isInteger(next.redemptionLimit) || next.redemptionLimit < 1 || next.redemptionLimit > 10 || !Number.isInteger(next.maxRewardsPerCustomer) || next.maxRewardsPerCustomer < 1 || next.maxRewardsPerCustomer > 100) return send(res, 400, { error: 'Enter valid referral rules. Qualification currently supports Delivered orders.' });
    if (next.rewardType === 'coupon' && next.rewardAmount <= 0) return send(res, 400, { error: 'Coupon rewards must be greater than ₹0.' });
    if (next.rewardType === 'free_product' && (!next.freeProductId || !products.some(product => product.id === next.freeProductId && product.isActive !== false))) return send(res, 400, { error: 'Select an active product for free-product rewards.' });
    next.demoSettings = false; next.updatedAt = new Date().toISOString(); store.referralCampaign = next; persist(); return send(res, 200, { campaign: next });
  }

  if (req.method === 'POST' && route === '/api/admin/products') {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 100);
    const category = categories.find(row => row.id === body.category && row.id !== 'all' && row.isActive !== false);
    let pricing = null;
    if (body.saleType !== undefined) {
      pricing = validatePricingVariants(String(body.saleType), String(body.measurementUnit || ''), body.variants, { makeId: () => `v-${crypto.randomBytes(6).toString('hex')}` });
      if (pricing.error) return send(res, 400, { error: pricing.error });
    }
    const price = pricing ? pricing.variants.find(row => row.isActive)?.price : Number(body.price);
    const mrp = pricing ? (pricing.variants.find(row => row.isActive)?.mrp ?? price) : (body.mrp == null || body.mrp === '' ? price : Number(body.mrp));
    const stock = pricing ? pricing.variants.reduce((sum, row) => sum + row.stock, 0) : Number(body.stock);
    if (!name || !category || !Number.isFinite(price) || price <= 0 || !Number.isFinite(mrp) || mrp < price || !Number.isInteger(stock) || stock < 0) return send(res, 400, { error: 'Provide a name, category, valid prices, and non-negative stock.' });
    const image = adminImagePath(body.image);
    if (image === undefined) return send(res, 400, { error: 'Choose an image path that already exists under /assets/.' });
    const product = { id: `p-${crypto.randomBytes(6).toString('hex')}`, name, detail: String(body.detail || '').trim().slice(0, 120), category: category.id, price, mrp, stock, emoji: String(body.emoji || '🛒').slice(0, 8), badge: String(body.badge || '').trim().slice(0, 32), color: /^#[\da-f]{6}$/i.test(body.color || '') ? body.color : '#f4eff8', image, description: String(body.description || name).slice(0, 300), isActive: body.isActive !== false, rank: products.length };
    if (pricing) Object.assign(product, pricing);
    products.push(product); persist(); return send(res, 201, { product });
  }
  const productMatch = route.match(/^\/api\/admin\/products\/([^/]+)$/);
  if (productMatch) {
    const product = products.find(row => row.id === decodeURIComponent(productMatch[1]));
    if (!product) return send(res, 404, { error: 'Product not found' });
    if (req.method === 'DELETE') { product.isActive = false; persist(); return send(res, 200, { product }); }
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
        const hasLegacyCart = Object.values(store.carts || {}).some(cart => Number(cart?.[product.id]) > 0);
        if (!product.variants?.length && hasLegacyCart) return send(res, 409, { error: 'This product is in an existing cart. Wait for those legacy cart lines to be cleared before changing its sale type.' });
        Object.assign(next, pricing);
        next.stock = pricing.variants.reduce((sum, row) => sum + row.stock, 0);
        const first = pricing.variants.find(row => row.isActive);
        next.price = first.price; next.mrp = first.mrp ?? first.price;
      }
    } else if (body.variants !== undefined) {
      const pricing = validatePricingVariants(String(next.saleType || ''), String(body.measurementUnit || next.measurementUnit || ''), body.variants, { makeId: () => `v-${crypto.randomBytes(6).toString('hex')}` });
      if (pricing.error) return send(res, 400, { error: pricing.error });
      Object.assign(next, pricing); next.stock = pricing.variants.reduce((sum, row) => sum + row.stock, 0);
      const first = pricing.variants.find(row => row.isActive); next.price = first.price; next.mrp = first.mrp ?? first.price;
    }
    if (body.isActive !== undefined) next.isActive = Boolean(body.isActive);
    if (body.image !== undefined) { const image = adminImagePath(body.image); if (image === undefined) return send(res, 400, { error: 'Choose an image path that already exists under /assets/.' }); next.image = image; }
    if (next.mrp < next.price) return send(res, 400, { error: 'MRP must be at least the selling price.' });
    Object.assign(product, next); persist(); return send(res, 200, { product });
  }

  if (req.method === 'POST' && route === '/api/admin/categories') {
    const body = await readBody(req); const name = String(body.name || '').trim().slice(0, 50);
    const id = String(body.id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).slice(0, 32);
    if (!name || !/^[a-z0-9-]{2,32}$/.test(id) || id === 'all' || categories.some(row => row.id === id)) return send(res, 400, { error: 'Choose a new category name and unique short ID.' });
    const category = { id, name, icon: String(body.icon || '🛒').slice(0, 8), color: /^#[\da-f]{6}$/i.test(body.color || '') ? body.color : '#f4eff8', isActive: true };
    const image = adminImagePath(body.image); if (image === undefined) return send(res, 400, { error: 'Choose an image path that already exists under /assets/.' });
    if (image) category.image = image; categories.push(category); persist(); return send(res, 201, { category });
  }
  const categoryMatch = route.match(/^\/api\/admin\/categories\/([^/]+)$/);
  if (categoryMatch) {
    const category = categories.find(row => row.id === decodeURIComponent(categoryMatch[1]) && row.id !== 'all');
    if (!category) return send(res, 404, { error: 'Category not found' });
    if (req.method === 'DELETE') {
      if (products.some(product => product.category === category.id)) return send(res, 409, { error: 'Move or deactivate this category’s products first.' });
      category.isActive = false; persist(); return send(res, 200, { category });
    }
    if (req.method !== 'PATCH') return send(res, 405, { error: 'Method not allowed' });
    const body = await readBody(req);
    const next = { ...category };
    if (body.name !== undefined) { next.name = String(body.name).trim().slice(0, 50); if (!next.name) return send(res, 400, { error: 'Category name is required.' }); }
    if (body.isActive === false && products.some(product => product.category === category.id && product.isActive !== false)) return send(res, 409, { error: 'Deactivate or move this category’s products first.' });
    if (body.icon !== undefined) next.icon = String(body.icon).slice(0, 8);
    if (body.color !== undefined) { if (!/^#[\da-f]{6}$/i.test(body.color)) return send(res, 400, { error: 'Enter a valid hex color.' }); next.color = body.color; }
    if (body.image !== undefined) { const image = adminImagePath(body.image); if (image === undefined) return send(res, 400, { error: 'Choose an image path that already exists under /assets/.' }); if (image) next.image = image; else delete next.image; }
    if (body.isActive !== undefined) next.isActive = Boolean(body.isActive);
    Object.assign(category, next);
    persist(); return send(res, 200, { category });
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
    store.deliveryAreas.push(area); persist(); return send(res, 201, { area });
  }
  const deliveryAreaMatch = route.match(/^\/api\/admin\/delivery-areas\/([^/]+)$/);
  if (deliveryAreaMatch) {
    const area = store.deliveryAreas.find(row => row.id === decodeURIComponent(deliveryAreaMatch[1]));
    if (!area) return send(res, 404, { error: 'Delivery area not found' });
    if (req.method === 'DELETE') {
      store.deliveryAreas = store.deliveryAreas.filter(row => row.id !== area.id);
      for (const [owner, selectedId] of Object.entries(store.selectedDeliveryAreas || {})) if (selectedId === area.id) delete store.selectedDeliveryAreas[owner];
      persist(); return send(res, 200, { ok: true });
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
    Object.assign(area, next); persist(); return send(res, 200, { area });
  }

  if (req.method === 'POST' && route === '/api/admin/coupons') {
    const body = await readBody(req); const code = String(body.code || '').trim().toUpperCase();
    const discount = Number(body.discount), minimum = Number(body.minimum), maximumDiscount = body.maximumDiscount === '' || body.maximumDiscount === undefined ? null : Number(body.maximumDiscount);
    const limits = parseCouponLimits(body);
    const supportedType = ['fixed', 'percentage', 'free_delivery'].includes(body.discountType);
    const validDiscount = body.discountType === 'free_delivery' ? Number.isFinite(discount) && discount === 0 && maximumDiscount === null : Number.isFinite(discount) && discount > 0;
    if (!/^[A-Z0-9_-]{3,32}$/.test(code) || store.coupons[code] || !supportedType || !validDiscount || (body.discountType === 'percentage' && discount > 100) || !Number.isFinite(minimum) || minimum < 0 || (maximumDiscount !== null && (!Number.isFinite(maximumDiscount) || maximumDiscount <= 0)) || !limits || (body.isActive !== undefined && typeof body.isActive !== 'boolean')) return send(res, 400, { error: 'Enter a unique code and valid discount, limits, expiry, minimum, and optional cap.' });
    const coupon = { code, label: String(body.label || `${code} offer`).trim().slice(0, 80), discountType: body.discountType, discount, minimum, maximumDiscount, isActive: body.isActive === undefined ? true : body.isActive === true, createdAt: new Date().toISOString(), ...limits };
    store.coupons[code] = coupon; persist(); return send(res, 201, { coupon });
  }
  const couponMatch = route.match(/^\/api\/admin\/coupons\/([^/]+)$/);
  if (couponMatch) {
    const code = decodeURIComponent(couponMatch[1]).toUpperCase(); const coupon = store.coupons[code];
    if (!coupon) return send(res, 404, { error: 'Coupon not found' });
    if (req.method === 'DELETE') { coupon.isActive = false; persist(); return send(res, 200, { coupon }); }
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
    persist(); return send(res, 200, { coupon });
  }

  if (req.method === 'POST' && route === '/api/admin/riders') {
    const body = await readBody(req); const phone = normalizePhone(body.phone); const name = String(body.name || '').trim().slice(0, 50);
    if (!name || !/^\d{10}$/.test(phone)) return send(res, 400, { error: 'Provide a name and ten-digit phone number.' });
    if (store.riders.some(rider => rider.phone === phone)) return send(res, 409, { error: 'That phone number already has a rider account.' });
    const password = String(body.password || '');
    if (passwordError(password)) return send(res, 400, { error: 'Set an initial password between 12 and 128 characters.' });
    const rider = { id: crypto.randomUUID(), phone, name, vehicle: String(body.vehicle || 'Motorbike').trim().slice(0, 40), passwordHash: await hashPassword(password), mustChangePassword: true, status: 'offline', isActive: true, createdAt: new Date().toISOString() };
    store.riders.push(rider); persist(); return send(res, 201, { rider: safeRider(rider) });
  }
  if (req.method === 'PATCH' && route === '/api/admin/dispatch-settings') {
    const body = await readBody(req);
    const riderId = body.designatedRiderId == null || body.designatedRiderId === '' ? null : String(body.designatedRiderId);
    if (riderId && !store.riders.some(row => row.id === riderId && row.isActive !== false && (!isProduction || isPasswordHash(row.passwordHash)))) return send(res, 400, { error: 'Select an active Rider with configured login credentials for new-order dispatch.' });
    store.dispatchSettings = { designatedRiderId: riderId, updatedAt: new Date().toISOString(), updatedBy: admin.id };
    persist();
    return send(res, 200, { dispatchSettings: store.dispatchSettings });
  }
  const riderResetMatch = route.match(/^\/api\/admin\/riders\/([^/]+)\/reset-password$/);
  if (riderResetMatch && req.method === 'POST') {
    const rider = store.riders.find(row => row.id === decodeURIComponent(riderResetMatch[1])); if (!rider) return send(res, 404, { error: 'Rider not found' });
    const temporaryPassword = crypto.randomBytes(15).toString('base64url');
    rider.passwordHash = await hashPassword(temporaryPassword); rider.mustChangePassword = true; rider.passwordResetAt = new Date().toISOString();
    for (const [sid, session] of Object.entries(store.riderSessions)) if ((typeof session === 'string' ? session : session?.riderId) === rider.id) delete store.riderSessions[sid];
    persist(); return send(res, 200, { ok: true, temporaryPassword });
  }
  const riderMatch = route.match(/^\/api\/admin\/riders\/([^/]+)$/);
  if (riderMatch) {
    const rider = store.riders.find(row => row.id === decodeURIComponent(riderMatch[1])); if (!rider) return send(res, 404, { error: 'Rider not found' });
    if (req.method === 'DELETE') {
      if (store.orders.some(order => order.riderId === rider.id && !['Delivered', 'Cancelled'].includes(order.status))) return send(res, 409, { error: 'Reassign or complete this rider’s active deliveries first.' });
      store.riders = store.riders.filter(row => row.id !== rider.id);
      for (const [sessionId, session] of Object.entries(store.riderSessions)) if ((typeof session === 'string' ? session : session?.riderId) === rider.id) delete store.riderSessions[sessionId];
      if (store.dispatchSettings?.designatedRiderId === rider.id) store.dispatchSettings = { ...store.dispatchSettings, designatedRiderId: null, updatedAt: new Date().toISOString(), updatedBy: admin.id };
      persist(); return send(res, 200, { ok: true });
    }
    if (req.method !== 'PATCH') return send(res, 405, { error: 'Method not allowed' });
    const body = await readBody(req);
    if (body.isActive === false && store.orders.some(order => order.riderId === rider.id && !['Delivered', 'Cancelled'].includes(order.status))) return send(res, 409, { error: 'Complete or cancel this rider’s active deliveries before deactivation.' });
    const next = { ...rider };
    if (body.name !== undefined) { next.name = String(body.name).trim().slice(0, 50); if (!next.name) return send(res, 400, { error: 'Rider name is required.' }); }
    if (body.vehicle !== undefined) next.vehicle = String(body.vehicle).trim().slice(0, 40);
    if (body.isActive !== undefined) { next.isActive = Boolean(body.isActive); if (!next.isActive) next.status = 'offline'; }
    Object.assign(rider, next);
    if (body.isActive === false) {
      for (const [sessionId, session] of Object.entries(store.riderSessions)) if ((typeof session === 'string' ? session : session?.riderId) === rider.id) delete store.riderSessions[sessionId];
      if (store.dispatchSettings?.designatedRiderId === rider.id) store.dispatchSettings = { ...store.dispatchSettings, designatedRiderId: null, updatedAt: new Date().toISOString(), updatedBy: admin.id };
    }
    persist(); return send(res, 200, { rider: safeRider(rider) });
  }

  if (req.method === 'GET' && route === '/api/admin/customers') return send(res, 200, { customers: store.users.map(customerListForAdmin) });
  const customerMatch = route.match(/^\/api\/admin\/customers\/([^/]+)$/);
  if (customerMatch) {
    const user = store.users.find(row => row.id === decodeURIComponent(customerMatch[1])); if (!user) return send(res, 404, { error: 'Customer not found' });
    if (req.method === 'GET') {
      const orders = store.orders.filter(order => order.userId === user.id).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
      const assignedCoupons = Object.values(store.coupons || {}).filter(coupon => coupon.userId === user.id).map(coupon => ({ ...coupon, ...customerCouponStatus(coupon, user.id) }));
      const eligibleCoupons = Object.values(store.coupons || {}).filter(coupon => !coupon.userId && !coupon.rewardId && couponEligible(coupon, user.id, 0, { allowBelowMinimum: true }));
      const audit = (store.adminAuditLog || []).filter(row => row.userId === user.id).slice(0, 100);
      return send(res, 200, { customer: customerForAdmin(user), addresses: addressesFor(user).map(addressForCustomer), orders, coupons: assignedCoupons, eligibleCoupons, audit, notifications: publicCustomerNotifications(user.id) });
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req), updates = {};
      if (Object.keys(body).some(key => !['name','email'].includes(key))) return send(res, 400, { error: 'Only customer name and email can be edited here.' });
      if (body.name !== undefined) { const name = String(body.name || '').trim(); if (name.length < 2 || name.length > 50) return send(res, 400, { error: 'Name must be between 2 and 50 characters.' }); updates.name = name; }
      if (body.email !== undefined) { const email = String(body.email || '').trim().toLowerCase(); if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return send(res, 400, { error: 'Enter a valid email address.' }); if (email && store.users.some(row => row.id !== user.id && row.email?.toLowerCase() === email)) return send(res, 409, { error: 'That email address is already linked to another customer.' }); updates.email = email || null; }
      if (!Object.keys(updates).length) return send(res, 400, { error: 'No supported customer details were supplied.' });
      const before = Object.fromEntries(Object.keys(updates).map(key => [key, user[key] || null])); Object.assign(user, updates);
      recordAdminAudit(admin, 'customer.details_updated', user.id, { before, after: Object.fromEntries(Object.keys(updates).map(key => [key, user[key] || null])) });
      persist(); return send(res, 200, { customer: customerForAdmin(user) });
    }
    return send(res, 405, { error: 'Method not allowed' });
  }
  const customerBlockMatch = route.match(/^\/api\/admin\/customers\/([^/]+)\/(block|unblock)$/);
  if (customerBlockMatch && req.method === 'POST') {
    const user = store.users.find(row => row.id === decodeURIComponent(customerBlockMatch[1])); if (!user) return send(res, 404, { error: 'Customer not found' });
    const action = customerBlockMatch[2], body = await readBody(req);
    if (action === 'block') {
      const reason = String(body.reason || '').trim().slice(0, 300); if (reason.length < 3) return send(res, 400, { error: 'Provide a reason of at least 3 characters to block this customer.' });
      if (!user.blockedAt) { user.blockedAt = new Date().toISOString(); user.blockReason = reason; for (const [sid, session] of Object.entries(store.sessions || {})) if (session.userId === user.id) delete store.sessions[sid]; recordAdminAudit(admin, 'customer.blocked', user.id, { reason }); }
    } else if (user.blockedAt) { recordAdminAudit(admin, 'customer.unblocked', user.id, { previousReason: user.blockReason || '' }); delete user.blockedAt; delete user.blockReason; }
    persist(); return send(res, 200, { customer: customerForAdmin(user) });
  }
  const customerCouponMatch = route.match(/^\/api\/admin\/customers\/([^/]+)\/coupons(?:\/([^/]+)\/(revoke|notify))?$/);
  if (customerCouponMatch) {
    const user = store.users.find(row => row.id === decodeURIComponent(customerCouponMatch[1])); if (!user) return send(res, 404, { error: 'Customer not found' });
    const [, , couponCodeEncoded, action] = customerCouponMatch;
    if (req.method === 'POST' && !action) {
      const body = await readBody(req), originCode = String(body.code || '').trim().toUpperCase(), source = store.coupons[originCode];
      if (!source || source.userId || source.rewardId || !couponEligible(source, user.id, 0, { allowBelowMinimum: true })) return send(res, 409, { error: 'Choose an existing eligible coupon.' });
      if (Object.values(store.coupons).some(row => row.userId === user.id && row.assignmentOriginCode === originCode && !row.revokedAt)) return send(res, 409, { error: 'This coupon has already been assigned to this customer.' });
      let code; do { code = `${originCode.slice(0, 22)}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; } while (store.coupons[code]);
      const coupon = { ...source, code, label: source.label || `${originCode} offer`, userId: user.id, assignmentOriginCode: originCode, assignedAt: new Date().toISOString(), assignedBy: admin.id, isActive: true, redemptionCount: 0, maxRedemptions: 1 };
      store.coupons[code] = coupon; recordAdminAudit(admin, 'customer.coupon_assigned', user.id, { code, sourceCode: originCode });
      let notification = null; if (body.notify === true) notification = createCustomerCouponNotification(admin, user, coupon);
      persist(); if (notification) scheduleNotificationWorkers();
      return send(res, 201, { coupon: { ...coupon, ...customerCouponStatus(coupon, user.id) }, notification: notification ? { created: true, id: notification.id, pushStatus: store.notificationOutbox.some(row => row.ownerId === user.id && row.eventId.includes(`customer-coupon:${code}:notify`)) ? 'queued' : 'not_queued' } : null });
    }
    if (!couponCodeEncoded || !action || req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    const coupon = store.coupons[decodeURIComponent(couponCodeEncoded).toUpperCase()];
    if (!coupon || coupon.userId !== user.id) return send(res, 404, { error: 'Assigned coupon not found.' });
    if (action === 'revoke') {
      if (customerCouponStatus(coupon, user.id).status === 'Used') return send(res, 409, { error: 'A redeemed coupon cannot be revoked.' });
      coupon.isActive = false; coupon.revokedAt = new Date().toISOString(); coupon.revokedBy = admin.id;
      if (store.appliedCoupon?.[user.id] === coupon.code) delete store.appliedCoupon[user.id];
      recordAdminAudit(admin, 'customer.coupon_revoked', user.id, { code: coupon.code }); persist(); return send(res, 200, { coupon: { ...coupon, ...customerCouponStatus(coupon, user.id) } });
    }
    if (action === 'notify') {
      if (customerCouponStatus(coupon, user.id).status !== 'Available') return send(res, 409, { error: 'Only an available coupon can be notified.' });
      const eventId = `customer-coupon:${coupon.code}:notify`;
      if (store.notificationEvents[`customer:${user.id}:${eventId}`]) return send(res, 409, { error: 'This customer has already been notified about this coupon.' });
      const notification = createCustomerCouponNotification(admin, user, coupon); persist(); scheduleNotificationWorkers();
      return send(res, 202, { created: Boolean(notification), notificationId: notification?.id || null, pushStatus: store.notificationOutbox.some(row => row.eventId === `customer:${user.id}:${eventId}`) ? 'queued' : 'not_queued' });
    }
  }

  const assignMatch = route.match(/^\/api\/admin\/orders\/([^/]+)\/assign$/);
  if (req.method === 'POST' && assignMatch) {
    const body = await readBody(req); const order = store.orders.find(row => row.id === decodeURIComponent(assignMatch[1]));
    const rider = store.riders.find(row => row.id === body.riderId && row.isActive !== false);
    if (!order) return send(res, 404, { error: 'Order not found' });
    if (!rider) return send(res, 404, { error: 'Choose an active rider account.' });
    if (order.status !== 'Ready for pickup' || order.riderId) return send(res, 409, { error: 'Only ready, unassigned orders can be assigned.' });
    order.riderId = rider.id; order.assignedAt = new Date().toISOString(); if (!isProduction) order.riderEarning ||= 35; order.status = 'Rider assigned'; adminEvent(order, 'Accepted by rider');
    addNotification(order.userId, { type: 'order',eventType:'rider_assigned',eventId:`order:${order.id}:rider_assigned`, title: 'Your rider is assigned', message: `A delivery partner is preparing to collect order ${order.displayId}.`, orderId: order.id,destination:'/#orders' });
    addRiderNotification(rider.id,{eventType:'rider_order',eventId:`order:${order.id}:assigned:${rider.id}`,title:'Delivery assigned',message:`Order ${order.displayId} is assigned to you.`,orderId:order.id,destination:`/rider?order=${encodeURIComponent(order.id)}`});
    persist(); return send(res, 200, { order: orderForAdmin(order) });
  }
  const orderStatusMatch = route.match(/^\/api\/admin\/orders\/([^/]+)\/status$/);
  if (req.method === 'PATCH' && orderStatusMatch) {
    const body = await readBody(req); const order = store.orders.find(row => row.id === decodeURIComponent(orderStatusMatch[1]));
    if (!order) return send(res, 404, { error: 'Order not found' });
    const next = String(body.status || ''); const reason = String(body.reason || '').trim().slice(0, 300);
    const referralRewardIssued = (store.referrals || []).some(referral => referral.qualifyingOrderId === order.id && referral.rewardId);
    const transitions = { 'Order received': ['Being packed', 'Cancelled'], 'Being packed': ['Ready for pickup', 'Cancelled'], 'Ready for pickup': ['Cancelled'], 'Rider assigned': ['Cancelled'], 'Picked up': ['Cancelled'], 'Out for delivery': ['Cancelled'], ...(order.status === 'Delivered' && referralRewardIssued ? { Delivered: ['Cancelled'] } : {}) };
    if (!transitions[order.status]?.includes(next)) return send(res, 409, { error: 'That order status transition is not allowed.' });
    if (next === 'Cancelled' && !reason) return send(res, 400, { error: 'Enter a cancellation reason.' });
    if (next !== 'Cancelled') {
      const at = new Date().toISOString(); order.status = next; order.history ||= []; order.history.push({ status: next, at, actorType: 'admin', actorId: admin.id });
      adminEvent(order, next, '');
      if (next === 'Ready for pickup') order.readyAt = at;
      addNotification(order.userId, { type: 'order',eventType:'order_status',eventId:`order:${order.id}:status:${next}`, title: next === 'Ready for pickup' ? 'Your order is ready' : 'Your order is being prepared', message: `Order ${order.displayId} is now ${next.toLowerCase()}.`, orderId: order.id,destination:'/#orders' });
      if (next === 'Ready for pickup') notifyDesignatedRider(order);
      persist(); return send(res, 200, { order: orderForAdmin(order) });
    }
    const wasDelivered = order.status === 'Delivered';
    const cancelledAt = cancelOrder(order, { actorType: 'admin', actorId: currentAdmin(req).id, reason });
    if (wasDelivered && !order.paymentReconciliation) { order.paymentStatus = order.paymentMethod === 'Demo UPI' ? 'Simulated refund review required' : 'COD collection review required'; order.paymentReconciliation = { status: order.paymentMethod === 'Demo UPI' ? 'simulated_refund_review_required' : 'cod_collection_review_required', reason: 'Delivered order correction requires manual review', amount: order.total, flaggedAt: cancelledAt }; }
    if (order.rewardId) { const reward = store.rewards.find(row => row.id === order.rewardId); if (reward && ['redeemed','available'].includes(reward.status)) { reward.redemptionCount = Math.max(0, Number(reward.redemptionCount || 1) - 1); reward.redemptionHistory ||= []; const history = reward.redemptionHistory.find(row => row.orderId === order.id); if (history) { history.status = 'cancelled'; history.cancelledAt = order.cancelledAt; } reward.orderId = reward.redemptionHistory.find(row => row.status === 'redeemed')?.orderId || null; reward.redeemedAt = reward.redemptionHistory.find(row => row.status === 'redeemed')?.redeemedAt || null; const expired = reward.expiresAt && Date.parse(reward.expiresAt) <= Date.now(); reward.status = expired ? 'expired' : reward.redemptionCount >= Number(reward.redemptionLimit || 1) ? 'redeemed' : 'available'; if (reward.couponCode && store.coupons[reward.couponCode]) { const coupon = store.coupons[reward.couponCode]; coupon.redemptionCount = reward.redemptionCount; coupon.isActive = !expired && reward.redemptionCount < Number(reward.redemptionLimit || 1); } } }
    for (const referral of store.referrals) if (referral.qualifyingOrderId === order.id) { const reward = store.rewards.find(row => row.id === referral.rewardId); if (reward?.status === 'available' && Number(reward.redemptionCount || 0) === 0) { reward.status = 'cancelled'; reward.cancelledAt = order.cancelledAt; } else if (reward && ['available','redeemed'].includes(reward.status)) { reward.status = 'review_required'; reward.reviewReason = 'Qualifying order was cancelled after reward use'; } if (reward?.couponCode && store.coupons[reward.couponCode]) store.coupons[reward.couponCode].isActive = false; referral.status = 'cancelled'; }
    addNotification(order.userId, { type: 'order',eventType:'order_status',eventId:`order:${order.id}:status:Cancelled`, title: 'Order cancelled', message: `Order ${order.displayId} was cancelled by an administrator. ${reason}`, orderId: order.id,destination:'/#orders' });
    if(order.riderId)addRiderNotification(order.riderId,{eventType:'rider_order',eventId:`order:${order.id}:cancelled`,title:'Delivery cancelled',message:`Order ${order.displayId} was cancelled by the store.`,orderId:order.id,destination:`/rider?order=${encodeURIComponent(order.id)}`});
    persist(); return send(res, 200, { order: orderForAdmin(order) });
  }

  return send(res, 404, { error: 'Admin API route not found' });
}

const databaseRequestQueue = createSerialRequestQueue();
let notificationWorkerRunning = false;
function enqueueDatabaseOperation(callback) {
  return databaseRequestQueue.enqueue(callback);
}
async function withNotificationStateTransaction(callback) {
  if(!usePostgres){const changed=await callback(store);if(changed)persist();return changed;}
  return enqueueDatabaseOperation(async()=>{
    const client=await pool.connect();
    try{
      await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock($1)',[1718343473]);
      store=await readPostgresStore(client);products=store.products;categories=store.categories;
      const changed=await callback(store);
      if(changed)await writePostgresStore(client,store,{replace:true});
      await client.query('COMMIT');return changed;
    }catch(error){try{await client.query('ROLLBACK');}catch{}throw error;}finally{client.release();}
  });
}
async function processDueCampaigns() {
  try { return await withNotificationStateTransaction(()=>processDueNotificationCampaignsInStore()); }
  catch(error){console.error('Notification scheduler failed; queued campaigns remain stored.');return false;}
}
function updateCampaignDeliveryStatus(campaignId) {
  if(!campaignId)return;
  const campaign=store.notificationCampaigns.find(row=>row.id===campaignId);if(!campaign||['cancelled','draft'].includes(campaign.status))return;
  const jobs=store.notificationOutbox.filter(row=>row.campaignId===campaignId);
  campaign.acceptedCount=store.notificationDeliveryLogs.filter(row=>row.campaignId===campaignId&&row.status==='accepted').length;
  campaign.failedCount=store.notificationDeliveryLogs.filter(row=>row.campaignId===campaignId&&['failed','invalid_device'].includes(row.status)).length;
  campaign.status=jobs.some(row=>['queued','processing'].includes(row.status))?'queued':campaign.failedCount?(campaign.acceptedCount?'partial':'failed'):campaign.acceptedCount?'accepted':jobs.length&&jobs.every(row=>row.status==='skipped')?'no_devices':'recorded';
  if(!['queued','processing','scheduled'].includes(campaign.status))campaign.deliveryFinishedAt=new Date().toISOString();
}
async function claimNotificationJob() {
  return withNotificationStateTransaction(()=>{
    const now=Date.now();
    for(const row of store.notificationOutbox)if(row.status==='processing'&&now-Date.parse(row.claimedAt||row.createdAt)>10*60*1000){row.status='queued';row.nextAttemptAt=new Date(now).toISOString();}
    const job=store.notificationOutbox.find(row=>row.status==='queued'&&(!row.nextAttemptAt||Date.parse(row.nextAttemptAt)<=now));
    if(!job)return false;
    job.status='processing';job.attempts=Number(job.attempts||0)+1;job.claimedAt=new Date(now).toISOString();
    const event=store.notificationEvents[job.eventId];
    const accepted=new Set(store.notificationDeliveryLogs.filter(row=>row.eventId===job.eventId&&row.ownerType===job.ownerType&&row.ownerId===job.ownerId&&row.status==='accepted').map(row=>row.deviceId));
    const devices=store.notificationDevices.filter(row=>row.ownerType===job.ownerType&&row.ownerId===job.ownerId&&row.status==='active'&&!accepted.has(row.id)).slice(0,20);
    return {job:structuredClone(job),event:structuredClone(event||{}),devices:structuredClone(devices)};
  });
}
async function finishNotificationJob(claim,outcomes,errorCode=null) {
  return withNotificationStateTransaction(()=>{
    const job=store.notificationOutbox.find(row=>row.id===claim.job.id);if(!job||job.status!=='processing')return false;
    const now=new Date().toISOString();
    for(const result of outcomes){
      const {device,ok,messageId,code}=result;
      if(!ok&&isInvalidFirebaseInstallation({code})) { const live=store.notificationDevices.find(row=>row.id===device.id);if(live){live.status='invalid';live.updatedAt=now;} }
      store.notificationDeliveryLogs.unshift({id:crypto.randomUUID(),campaignId:job.campaignId||null,eventId:job.eventId,ownerType:job.ownerType,ownerId:job.ownerId,deviceId:device.id,status:ok?'accepted':isInvalidFirebaseInstallation({code})?'invalid_device':'failed',attemptedAt:now,providerMessageId:ok?String(messageId||'').slice(0,180):null,errorCode:ok?null:String(code||'fcm_error').slice(0,80)});
    }
    const remaining=store.notificationDevices.some(row=>row.ownerType===job.ownerType&&row.ownerId===job.ownerId&&row.status==='active'&&!store.notificationDeliveryLogs.some(log=>log.eventId===job.eventId&&log.ownerType===job.ownerType&&log.ownerId===job.ownerId&&log.deviceId===row.id&&log.status==='accepted'));
    const pendingFailure=outcomes.some(row=>!row.ok&&!isInvalidFirebaseInstallation({code:row.code}))||errorCode;
    if(!claim.devices.length){job.status='skipped';job.skipReason='no_active_device';job.processedAt=now;store.notificationDeliveryLogs.unshift({id:crypto.randomUUID(),campaignId:job.campaignId||null,eventId:job.eventId,ownerType:job.ownerType,ownerId:job.ownerId,deviceId:null,status:'skipped',attemptedAt:now,providerMessageId:null,errorCode:null});}
    else if(pendingFailure&&job.attempts<8){job.status='queued';job.nextAttemptAt=new Date(Date.now()+Math.min(6*3600000,30000*2**Math.max(0,job.attempts-1))).toISOString();job.lastErrorCode=String(errorCode||outcomes.find(row=>!row.ok)?.code||'fcm_error').slice(0,80);}
    else if(pendingFailure){job.status='failed';job.processedAt=now;job.lastErrorCode=String(errorCode||outcomes.find(row=>!row.ok)?.code||'fcm_error').slice(0,80);}
    else {job.status=remaining?'queued':outcomes.some(row=>row.ok)?'accepted':'failed';job.processedAt=job.status==='queued'?null:now;}
    updateCampaignDeliveryStatus(job.campaignId);
    return true;
  });
}
async function drainNotificationOutbox() {
  if(notificationWorkerRunning)return;
  notificationWorkerRunning=true;
  try{
    for(let count=0;count<20;count++){
      const claim=await claimNotificationJob();if(!claim)break;
      if(!claim.devices.length){await finishNotificationJob(claim,[]);continue;}
      const event=claim.event||{},outcomes=[];
      for(const device of claim.devices){
        try{
          const messageId=await sendFirebaseInstallationMessage(device.fid,{title:event.title||'Zepto update',body:event.message||'You have a new update.',destination:notificationDestination(event.destination),notificationId:event.notificationId,eventId:claim.job.eventId});
          outcomes.push({device,ok:true,messageId});
        }catch(error){outcomes.push({device,ok:false,code:String(error?.code||error?.message||'firebase_error').replace(/[^A-Za-z0-9_/-]/g,'').slice(0,80)||'firebase_error'});}
      }
      await finishNotificationJob(claim,outcomes);
    }
  }catch(error){console.error('Notification delivery worker failed; pending jobs remain persisted.');}
  finally{notificationWorkerRunning=false;}
}
let notificationWorkerTimer=null;
function scheduleNotificationWorkers() {
  if(notificationWorkerTimer)return;
  notificationWorkerTimer=setTimeout(async()=>{notificationWorkerTimer=null;await processDueCampaigns();await drainNotificationOutbox();},250);
  notificationWorkerTimer.unref?.();
}
const notificationWorkerInterval=setInterval(scheduleNotificationWorkers,3000);notificationWorkerInterval.unref?.();
const server = http.createServer((req, res) => {
  req.res = res;
  const path = requestPath(req);
  if (req.method === 'GET' && ['/api/health', '/api/health/ready'].includes(path)) {
    void handleIndependentHealth(req, res);
    return;
  }
  if (usePostgres && req.url?.startsWith('/api/')) {
    let expired = false;
    const timeoutMs = boundedTimeoutMs('API_QUEUE_WAIT_TIMEOUT_MS', 20000);
    const operation = enqueueWithDeadline(databaseRequestQueue, metrics => runPostgresRequest(req, res, metrics), {
      timeoutMs,
      onTimeout: () => {
        expired = true;
        console.warn(JSON.stringify({ event: 'api_queue_wait_timeout', method: req.method, path, waitMs: timeoutMs, queuedRequests: databaseRequestQueue.depth }));
        directJson(res, 503, { error: 'The application is busy processing other requests. Please retry shortly.', code: 'DATABASE_QUEUE_TIMEOUT' });
      },
      shouldSkip: () => expired || res.destroyed || res.writableEnded
    });
    operation.finally(scheduleNotificationWorkers).catch(()=>{});
    return;
  }
  return handleRequest(req, res).finally(scheduleNotificationWorkers);
});

function requestPath(req) {
  try { return new URL(req.url || '/', 'http://localhost').pathname; }
  catch { return ''; }
}

function directJson(res, status, body) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(self)',
    'content-security-policy': "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' https://accounts.google.com https://www.gstatic.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://accounts.google.com https://firebaseinstallations.googleapis.com https://fcmregistrations.googleapis.com https://fcm.googleapis.com https://www.googleapis.com https://api.cloudinary.com; frame-src https://accounts.google.com" + (isProduction ? '; upgrade-insecure-requests' : '')
  };
  if (isProduction) headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

async function handleIndependentHealth(req, res) {
  const path = requestPath(req);
  if (path === '/api/health') {
    directJson(res, 200, {
      status: 'ok',
      mode: isProduction ? 'production' : 'development',
      ...(usePostgres ? { database: 'configured' } : {}),
      authConfigured: { google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) },
      payments: { cod: true, online: false }
    });
    return;
  }
  if (!usePostgres) {
    directJson(res, 200, { status: 'ready', database: 'not_configured', ready: true });
    return;
  }
  let timeout;
  try {
    const result = await Promise.race([
      pool.query({ text: 'SELECT 1 AS ok', query_timeout: 1200 }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(Object.assign(new Error('database readiness timeout'), { code: 'DB_READINESS_TIMEOUT' })), 1500);
        timeout.unref?.();
      })
    ]);
    directJson(res, 200, { status: 'ready', database: 'connected', ready: true, check: Number(result.rows[0]?.ok) === 1 ? 'passed' : 'unknown' });
  } catch (error) {
    directJson(res, 503, { status: 'not_ready', database: 'unavailable', ready: false, code: error?.code === 'DB_READINESS_TIMEOUT' ? 'DB_READINESS_TIMEOUT' : 'DB_READINESS_FAILED' });
  } finally {
    clearTimeout(timeout);
  }
}

async function runPostgresRequest(req, res, queueMetrics = {}) {
  let client;
  const requestStartedAt = Date.now();
  const timings = { queueWaitMs: Number(queueMetrics.queueWaitMs || 0), queueDepthAtStart: Number(queueMetrics.queueDepthAtStart || 0) };
  let phase = 'pool_connect';
  let phaseStartedAt = Date.now();
  let context = null;
  try {
    client = await pool.connect();
    timings.poolConnectMs = Date.now() - phaseStartedAt;
    phase = 'begin_transaction';
    phaseStartedAt = Date.now();
    await client.query('BEGIN');
    timings.beginTransactionMs = Date.now() - phaseStartedAt;
    phase = 'advisory_lock';
    phaseStartedAt = Date.now();
    await client.query('SELECT pg_advisory_xact_lock($1)', [1718343473]);
    timings.advisoryLockWaitMs = Date.now() - phaseStartedAt;
    phase = 'read_store_snapshot';
    phaseStartedAt = Date.now();
    const latest = await readPostgresStore(client);
    timings.readStoreSnapshotMs = Date.now() - phaseStartedAt;
    if (!latest) throw new Error('PostgreSQL store unexpectedly has no initialized records.');
    store = latest;
    products = store.products;
    categories = store.categories;
    activeDatabaseRequest = { res, dirty: false, response: null };
    phase = 'request_handler';
    phaseStartedAt = Date.now();
    await handleRequest(req, res);
    timings.handlerMs = Date.now() - phaseStartedAt;
    context = activeDatabaseRequest;
    if (context.response?.status >= 500) {
      phase = 'rollback';
      phaseStartedAt = Date.now();
      await client.query('ROLLBACK');
      timings.rollbackMs = Date.now() - phaseStartedAt;
    }
    else {
      if (context.dirty) {
        phase = 'write_store';
        phaseStartedAt = Date.now();
        await writePostgresStore(client, store, { replace: true });
        timings.writeStoreMs = Date.now() - phaseStartedAt;
      } else timings.writeStoreMs = 0;
      phase = 'commit';
      phaseStartedAt = Date.now();
      await client.query('COMMIT');
      timings.commitMs = Date.now() - phaseStartedAt;
    }
    if (context.response && !res.writableEnded) { res.writeHead(context.response.status, context.response.headers); res.end(context.response.responseBody); }
    else if (!res.writableEnded) { res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: 'The request did not produce a response.' })); }
  } catch (error) {
    console.error('PostgreSQL request failed:', JSON.stringify({ path: requestPath(req), method: req.method, phase, code: error?.code || 'UNKNOWN' }));
    try { if (client) await client.query('ROLLBACK'); } catch {}
    if (!res.headersSent && !res.writableEnded) {
      const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
      res.writeHead(503, headers); res.end(JSON.stringify({ error: 'The application data store is temporarily unavailable. Please retry.', code: phase === 'advisory_lock' ? 'DATABASE_LOCK_TIMEOUT' : 'DATABASE_OPERATION_FAILED' }));
    }
  } finally {
    const totalMs = Date.now() - requestStartedAt;
    timings.totalMs = totalMs;
    if (totalMs >= 1500 || timings.queueWaitMs >= 500) {
      console.warn(JSON.stringify({ event: 'slow_postgres_api_request', method: req.method, path: requestPath(req), status: context?.response?.status || res.statusCode, phase, ...timings }));
    }
    activeDatabaseRequest = null;
    client?.release();
  }
}

async function handleRequest(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
  if (isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  const contentSecurityPolicy = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' https://accounts.google.com https://www.gstatic.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://accounts.google.com https://firebaseinstallations.googleapis.com https://fcmregistrations.googleapis.com https://fcm.googleapis.com https://www.googleapis.com https://api.cloudinary.com; frame-src https://accounts.google.com";
  res.setHeader('Content-Security-Policy', `${contentSecurityPolicy}${isProduction ? '; upgrade-insecure-requests' : ''}`);
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/api/notifications/config') {
      const config=publicWebMessagingConfig();
      return send(res,200,{...config,serverConfigured:Boolean(process.env.FCM_PROJECT_ID)});
    }
    if (req.method === 'GET' && url.pathname === '/api/notifications/firebase-config.js') {
      const config=publicWebMessagingConfig();
      const source=`self.ZEPTO_FCM_CONFIG=${JSON.stringify(config.firebase||{})};`;
      res.writeHead(200,{'content-type':'application/javascript; charset=utf-8','cache-control':'no-store'});return res.end(source);
    }
    if (isProduction && url.pathname.startsWith('/api/') && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
      if (!googleRequestOrigin(req) || !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return send(res, 403, { error: 'Request origin could not be verified.' });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/config') { if (!requireAdmin(req, res)) return; return send(res, 200, { configured: Boolean(adminPhone && isPasswordHash(adminPasswordHash)) }); }
    if (req.method === 'GET' && url.pathname === '/api/admin/session') {
      const admin = currentAdmin(req);
      return admin ? send(res, 200, { admin }) : send(res, 401, { error: 'Sign in as an authorized local administrator', code: 'ADMIN_AUTH_REQUIRED' });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/auth/login') {
      const body = await readBody(req), phone = normalizePhone(body.phone), key = phone || 'invalid';
      if (authRateLimited(req, key)) return send(res, 429, { error: 'Too many sign-in attempts. Try again in 15 minutes.' });
      if (!isPasswordHash(adminPasswordHash) || !adminPhone) return send(res, 401, { error: 'Unable to sign in with those credentials.' });
      const okPhone = phone === adminPhone, okPassword = await verifyPassword(String(body.password || ''), adminPasswordHash);
      if (!okPhone || !okPassword) { recordAuthFailure(req, key); return send(res, 401, { error: 'Unable to sign in with those credentials.' }); }
      clearAuthFailures(req, key);
      const sid = crypto.randomBytes(32).toString('base64url'); store.adminSessions[sid] = { adminId: 'configured-admin', authMethod: 'password', createdAt: Date.now(), expiresAt: Date.now() + 8 * 3600_000 }; persist();
      return send(res, 200, { admin: currentAdmin({ headers: { cookie: `asid=${encodeURIComponent(sid)}` } }) }, { 'set-cookie': sessionCookie('asid', sid, req, 8 * 3600) });
    }
    if (testAuthEnabled && req.method === 'POST' && url.pathname === '/api/admin/auth/request-otp') {
      const body = await readBody(req); const phone = normalizePhone(body.phone);
      if (phone !== '9000000001') return send(res, 403, { error: 'Test administrator is unavailable.' });
      const challengeId = crypto.randomUUID(); store.adminChallenges[challengeId] = { phone, createdAt: Date.now() }; persist();
      return send(res, 200, { challengeId, message: 'Test-only sign-in challenge', testCode: demoOtp, expiresInSeconds: 300 });
    }
    if (testAuthEnabled && req.method === 'POST' && url.pathname === '/api/admin/auth/verify-otp') {
      const body = await readBody(req); const challenge = store.adminChallenges[body.challengeId];
      if (!challenge || Date.now() - challenge.createdAt > 300_000 || challenge.phone !== '9000000001') return send(res, 400, { error: 'Code expired. Request a new one.' });
      if (String(body.code) !== demoOtp) return send(res, 401, { error: 'That code is not correct.' });
      const sid = crypto.randomBytes(32).toString('base64url'); store.adminSessions[sid] = { adminId: 'test-admin', authMethod: 'test-otp', createdAt: Date.now(), expiresAt: Date.now() + 8 * 3600_000 }; delete store.adminChallenges[body.challengeId]; persist();
      return send(res, 200, { admin: currentAdmin({ headers: { cookie: `asid=${encodeURIComponent(sid)}` } }) }, { 'set-cookie': sessionCookie('asid', sid, req, 8 * 3600) });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/auth/logout') {
      const sid = cookieMap(req).asid; if (sid) delete store.adminSessions[sid]; persist();
      return send(res, 200, { ok: true }, { 'set-cookie': sessionCookie('asid', '', req, 0) });
    }
    if (url.pathname.startsWith('/api/admin/')) return await handleAdminApi(req, res, url);
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { status: 'ok', mode: isProduction ? 'production' : 'development', authConfigured: { google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) }, payments: { cod: true, online: false } });
    if (req.method === 'GET' && url.pathname === '/api/referrals/validate') {
      const code = String(url.searchParams.get('code') || '').trim().toUpperCase(); const referrer = findReferrerByCode(code);
      return send(res, 200, { valid: Boolean(store.referralCampaign?.enabled && referrer), campaignEnabled: Boolean(store.referralCampaign?.enabled), reason: !store.referralCampaign?.enabled ? 'campaign_unavailable' : !referrer ? 'invalid_code' : null });
    }
    if (req.method === 'GET' && url.pathname === '/api/referrals/me') {
      const user = requireUser(req, res); if (!user) return;
      return send(res, 200, referralDashboard(user));
    }
    if (req.method === 'GET' && url.pathname === '/api/referrals/qr') {
      const user = requireUser(req, res); if (!user) return;
      if (!store.referralCampaign?.enabled) return send(res, 409, { error: 'Referral campaign is not active.' });
      const base = canonicalPublicBaseUrl(store.referralCampaign.publicBaseUrl);
      if (!base) return send(res, 503, { error: 'Referral links are not configured.' });
      const link = new URL('/referral', base); link.searchParams.set('code', user.referralCode);
      const svg = await QRCode.toString(link.toString(), { type: 'svg', width: 280, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#321044', light: '#FFFFFF' } });
      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'private, no-store', 'content-disposition': 'inline; filename="zepto-referral-qr.svg"' }); return res.end(svg);
    }
    const rewardQuoteMatch = url.pathname.match(/^\/api\/rewards\/([^/]+)\/quote$/);
    if (req.method === 'GET' && rewardQuoteMatch) {
      const user = requireUser(req, res); if (!user) return;
      expireAvailableRewards();
      const reward = store.rewards.find(row => row.id === decodeURIComponent(rewardQuoteMatch[1]) && row.userId === user.id && row.status === 'available' && row.type === 'free_product');
      if (!reward) return send(res, 409, { error: 'This reward is no longer available.' });
      const product = products.find(row => row.id === reward.productId && row.isActive !== false && Number(row.stock) > 0);
      if (!product) return send(res, 409, { error: 'The reward product is currently unavailable.' });
      const address = addressesFor(user).find(row => row.id === url.searchParams.get('addressId'));
      if (!address) return send(res, 400, { error: 'Choose a saved delivery address.' });
      const area = findDeliveryArea(address, address.deliveryAreaId || store.selectedDeliveryAreas?.[user.id]);
      if (!area) return send(res, 409, { error: 'Delivery is unavailable for this address.' });
      const quote = quoteDelivery(req, 0, { address, areaId: area.id });
      return send(res, 200, { rewardId: reward.id, product: { id: product.id, name: product.name, detail: product.detail, description: product.description, image: product.image, emoji: product.emoji, price: product.price, mrp: product.mrp }, delivery: quote.delivery, platform: 0, total: quote.delivery, area: quote.area, eta: quote.estimate, available: quote.available, rewardExpiresAt: reward.expiresAt });
    }
    const rewardRedeemMatch = url.pathname.match(/^\/api\/rewards\/([^/]+)\/redeem$/);
    if (req.method === 'POST' && rewardRedeemMatch) {
      const user = requireUser(req, res); if (!user) return;
      const body = await readBody(req);
      if (!['cod', 'upi'].includes(body.paymentMethod)) return send(res, 400, { error: 'Choose a supported payment method.' });
      if (isProduction && body.paymentMethod === 'upi') return send(res, 503, { error: 'Online payment is not configured. Choose Cash on Delivery.' });
      expireAvailableRewards();
      const reward = store.rewards.find(row => row.id === decodeURIComponent(rewardRedeemMatch[1]) && row.userId === user.id);
      if (!reward) return send(res, 404, { error: 'Reward not found.' });
      if (reward.status !== 'available' || Number(reward.redemptionCount || 0) >= Number(reward.redemptionLimit || 1)) return send(res, 409, { error: 'This reward is no longer available.' });
      if (reward.type !== 'free_product') return send(res, 409, { error: 'Apply this referral coupon from your cart.' });
      const address = addressesFor(user).find(row => row.id === body.addressId);
      if (!address) return send(res, 400, { error: 'Choose a saved delivery address.' });
      const product = products.find(row => row.id === reward.productId && row.isActive !== false && Number(row.stock) > 0);
      if (!product) return send(res, 409, { error: 'The reward product is currently unavailable.' });
      const area = findDeliveryArea(address, body.deliveryAreaId || address.deliveryAreaId || store.selectedDeliveryAreas?.[user.id]);
      if (!area) return send(res, 409, { error: 'Delivery is unavailable for this address.' });
      const quote = quoteDelivery(req, 0, { address, areaId: area.id });
      if (!quote.available) return send(res, 409, { error: 'Delivery is unavailable for this address.' });
      const deliverySnapshot = { id: area.id, name: area.name, pinCodes: [...(area.pinCodes || [])], deliveryCharge: quote.delivery, standardDeliveryCharge: Number(area.deliveryCharge || 0), minimumOrder: quote.minimumOrder, freeDeliveryThreshold: quote.freeDeliveryThreshold, etaMinMinutes: Number(area.etaMinMinutes), etaMaxMinutes: Number(area.etaMaxMinutes), isDemoFallback: Boolean(area.isDemoFallback) };
      const createdAt = new Date().toISOString(), paidBy = body.paymentMethod === 'upi' ? 'Demo UPI' : 'Cash on delivery';
      const order = { id: crypto.randomUUID(), displayId: createUniqueOrderDisplayId(), userId: user.id, rewardId: reward.id, orderType: 'Referral free-product reward', items: [{ id: product.id, name: product.name, detail: product.detail, description: product.description, image: product.image, emoji: product.emoji, color: product.color, quantity: 1, price: 0, mrp: Number(product.price || 0), lineTotal: 0 }], address: { ...address, deliveryAreaId: area.id, deliveryAreaName: area.name }, deliveryArea: deliverySnapshot, paymentMethod: paidBy, paymentStatus: paidBy === 'Demo UPI' ? 'Demo payment complete (simulated)' : 'Pay on delivery', subtotal: 0, discount: 0, couponCode: null, delivery: quote.delivery, platform: 0, total: quote.delivery, status: 'Ready for pickup', eta: quote.estimate, createdAt, readyAt: createdAt, riderId: null, timeline: [{ label: 'Reward claimed', at: createdAt, complete: true }, { label: 'Ready for pickup', at: createdAt, complete: true }, { label: 'Accepted by rider', at: null, complete: false }, { label: 'Picked up', at: null, complete: false }, { label: 'Out for delivery', at: null, complete: false }, { label: 'Delivered', at: null, complete: false }] };
      product.stock = Number(product.stock) - 1; reward.status = 'redeemed'; reward.redemptionCount = Number(reward.redemptionCount || 0) + 1; reward.redeemedAt = createdAt; reward.orderId = order.id;
      if (isProduction) { order.status = 'Order received'; order.readyAt = null; for (const step of order.timeline) if (['Being packed', 'Ready for pickup'].includes(step.label)) { step.complete = false; step.at = null; } }
      store.orders.push(order); addNotification(user.id, { type: 'order',eventType:'order_received',eventId:`order:${order.id}:received`, title: 'Free reward order placed', message: isProduction ? `Your ${product.name} reward order was received. We’ll update you when it is being prepared.` : 'Your ' + product.name + ' reward order is confirmed. Delivery charges may apply.', orderId: order.id,destination:'/#orders' });
      if(order.status==='Ready for pickup')notifyDesignatedRider(order);
      persist();
      return send(res, 201, { order, reward });
    }
    if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
      const user = currentUser(req);
      ensureOfferNotification(user);
      const addressRows = user ? addressesFor(user) : [];
      const owner = user?.id || 'guest';
      const cart = cartSummary(req);
      const userNotifications = user ? publicCustomerNotifications(user.id) : [];
      const decoratedAddresses = addressRows.map(addressForCustomer);
      const selectedAddress = decoratedAddresses.find(row => row.id === store.selectedDeliveryAddresses?.[owner]) || decoratedAddresses.find(row => row.isDefault) || decoratedAddresses[0] || null;
      return send(res, 200, { mode: isProduction ? 'production' : 'development', categories: categories.filter(row => row.id === 'all' || row.isActive !== false), products: products.filter(productHasSellableStock), homepageBanners: (store.homepageBanners || defaultHomepageBanners()).filter(row => row.enabled).sort((a, b) => a.order - b.order), homepageHeroFruitImage: store.homepageHeroFruitImage || null, cart, wishlist: wishlistProducts(req), user: safeUser(user), addresses: decoratedAddresses, activeAddress: selectedAddress, orders: user ? store.orders.filter(row => row.userId === user.id).slice(0, 5) : [], notifications: userNotifications.slice(0, 30), notificationUnread: userNotifications.filter(row => !row.readAt).length, coupons: Object.values(store.coupons).filter(row => couponEligible(row, cartOwner(req), 0, { allowBelowMinimum: true })), activeCoupon: cart.activeCoupon, deliveryAreas: activeDeliveryAreas().map(area => ({ id: area.id, name: area.name, deliveryCharge: Number(area.deliveryCharge || 0), minimumOrder: Number(area.minimumOrder || 0), freeDeliveryThreshold: area.freeDeliveryThreshold ?? null, etaMinMinutes: area.etaMinMinutes, etaMaxMinutes: area.etaMaxMinutes })), selectedDeliveryAreaId: cart.deliveryArea?.id || null, deliveryQuote: cart, deliveryCopy: isProduction ? 'Delivery eligibility and charges are configured for the selected area.' : 'Fast doorstep delivery · local demo' });
    }
    if (req.method === 'GET' && url.pathname === '/api/delivery-areas') return send(res, 200, { areas: activeDeliveryAreas().map(area => ({ id: area.id, name: area.name, deliveryCharge: Number(area.deliveryCharge || 0), minimumOrder: Number(area.minimumOrder || 0), freeDeliveryThreshold: area.freeDeliveryThreshold ?? null, etaMinMinutes: area.etaMinMinutes, etaMaxMinutes: area.etaMaxMinutes })) });
    if (req.method === 'POST' && url.pathname === '/api/delivery-area/select') {
      const body = await readBody(req), user = currentUser(req), owner = cartOwner(req);
      const area = activeDeliveryAreas().find(row => row.id === String(body.areaId || ''));
      if (!area) return send(res, 409, { error: 'That delivery area is unavailable. Select an enabled area.' });
      if (user) {
        const address = addressesFor(user).find(row => row.id === body.addressId) || addressesFor(user).find(row => row.isDefault);
        if (!address || address.deliveryAreaId !== area.id) return send(res, 409, { error: 'Choose a saved address that belongs to this delivery area.' });
        store.selectedDeliveryAddresses[user.id] = address.id;
      }
      store.selectedDeliveryAreas ||= {}; store.selectedDeliveryAreas[owner] = area.id;
      persist(); return send(res, 200, { area: { id: area.id, name: area.name }, cart: cartSummary(req) });
    }
    if (url.pathname === '/api/notifications/devices' && req.method === 'POST') {
      const user=requireUser(req,res);if(!user)return;const result=savePushDevice('customer',user.id,await readBody(req));if(result.error)return send(res,400,result);persist();scheduleNotificationWorkers();return send(res,200,{ok:true,status:'active'});
    }
    if (url.pathname === '/api/notifications/devices/deactivate' && req.method === 'POST') {
      const user=requireUser(req,res);if(!user)return;deactivatePushDevice('customer',user.id,await readBody(req));persist();return send(res,200,{ok:true});
    }
    if (url.pathname === '/api/notifications/preferences' && req.method === 'GET') {
      const user=requireUser(req,res);if(!user)return;return send(res,200,{preferences:getNotificationPreferences('customer',user.id)});
    }
    if (url.pathname === '/api/notifications/preferences' && req.method === 'PATCH') {
      const user=requireUser(req,res);if(!user)return;const result=saveNotificationPreferences('customer',user.id,await readBody(req));if(result.error)return send(res,400,result);persist();return send(res,200,result);
    }
    if (req.method === 'GET' && url.pathname === '/api/notifications') {
      const user = requireUser(req, res); if (!user) return;
      const notifications = publicCustomerNotifications(user.id);
      return send(res, 200, { notifications, unread: notifications.filter(row => !row.readAt).length });
    }
    const notificationReadMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
    if (req.method === 'POST' && notificationReadMatch) {
      const user = requireUser(req, res); if (!user) return;
      const notification = (store.notifications[user.id] || []).find(row => row.id === notificationReadMatch[1]);
      if (!notification) return send(res, 404, { error: 'Notification not found' });
      notification.readAt ||= new Date().toISOString();
      persist();
      const notifications = store.notifications[user.id];
      return send(res, 200, { notification, unread: notifications.filter(row => !row.readAt).length });
    }
    if (req.method === 'POST' && url.pathname === '/api/notifications/read-all') {
      const user = requireUser(req, res); if (!user) return;
      const readAt = new Date().toISOString();
      for (const notification of store.notifications[user.id] || []) notification.readAt ||= readAt;
      persist();
      return send(res, 200, { unread: 0 });
    }
    if (req.method === 'GET' && url.pathname === '/api/products') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const category = url.searchParams.get('category') || 'all';
      const rows = products.filter(p => productHasSellableStock(p) && (category === 'all' || p.category === category) && (!q || `${p.name} ${p.detail} ${p.category}`.toLowerCase().includes(q)));
      return send(res, 200, { products: rows, count: rows.length });
    }
    if (req.method === 'GET' && url.pathname === '/api/cart') return send(res, 200, cartSummary(req));
    if (req.method === 'POST' && url.pathname === '/api/rider/auth/login') {
      const body = await readBody(req), phone = normalizePhone(body.phone), identity = phone || 'invalid';
      if (authRateLimited(req, identity)) return send(res, 429, { error: 'Too many sign-in attempts. Try again in 15 minutes.' });
      const rider = store.riders.find(row => row.phone === phone && row.isActive !== false);
      const ok = await verifyPassword(String(body.password || ''), rider?.passwordHash || dummyPasswordHash) && Boolean(rider?.passwordHash);
      if (!/^\d{10}$/.test(phone) || !ok) { recordAuthFailure(req, identity); return send(res, 401, { error: 'Unable to sign in with those credentials. Contact an administrator if you need access restored.' }); }
      clearAuthFailures(req, identity);
      const sid = crypto.randomBytes(32).toString('base64url'); store.riderSessions[sid] = { riderId: rider.id, authMethod: 'password', createdAt: Date.now(), expiresAt: Date.now() + 7 * 86400_000 }; persist();
      return send(res, 200, { rider: safeRider(rider) }, { 'set-cookie': sessionCookie('rsid', sid, req, 7 * 86400) });
    }
    if (req.method === 'POST' && url.pathname === '/api/rider/auth/password') {
      const rider = currentRider(req); if (!rider) return send(res, 401, { error: 'Sign in with your rider account first.' });
      const body = await readBody(req), nextPassword = String(body.newPassword || '');
      if (passwordError(nextPassword)) return send(res, 400, { error: 'Use a password between 12 and 128 characters.' });
      if (body.confirmPassword !== nextPassword) return send(res, 400, { error: 'Passwords do not match.' });
      if (!rider.mustChangePassword && !(await verifyPassword(String(body.currentPassword || ''), rider.passwordHash))) return send(res, 401, { error: 'Current password is incorrect.' });
      rider.passwordHash = await hashPassword(nextPassword); rider.mustChangePassword = false; rider.passwordChangedAt = new Date().toISOString(); persist();
      const sid = cookieMap(req).rsid, rawSid = cookieMap(req, { hashSessions: false }).rsid;
      if (sid && store.riderSessions[sid]) store.riderSessions[sid].expiresAt = Date.now() + 7 * 86400_000;
      persist();
      return send(res, 200, { rider: safeRider(rider) }, { 'set-cookie': sessionCookie('rsid', rawSid, req, 7 * 86400) });
    }
    if (testAuthEnabled && req.method === 'POST' && url.pathname === '/api/rider/auth/request-otp') {
      const normalized = normalizePhone((await readBody(req)).phone);
      const rider = store.riders.find(row => row.phone === normalized && row.isActive !== false);
      if (!rider) return send(res, 403, { error: 'Test rider is unavailable' });
      const challengeId = crypto.randomUUID(); store.riderChallenges[challengeId] = { riderId: rider.id, createdAt: Date.now() }; persist();
      return send(res, 200, { challengeId, testCode: demoOtp });
    }
    if (testAuthEnabled && req.method === 'POST' && url.pathname === '/api/rider/auth/verify-otp') {
      const { challengeId, code } = await readBody(req), challenge = store.riderChallenges[challengeId];
      if (!challenge || Date.now() - challenge.createdAt > 300_000 || String(code) !== demoOtp) return send(res, 401, { error: 'Invalid or expired test challenge.' });
      const rider = store.riders.find(row => row.id === challenge.riderId && row.isActive !== false); if (!rider) return send(res, 403, { error: 'Rider account is unavailable' });
      rider.mustChangePassword = false;
      const sid = crypto.randomBytes(32).toString('base64url'); store.riderSessions[sid] = { riderId: rider.id, authMethod: 'test-otp', createdAt: Date.now(), expiresAt: Date.now() + 7 * 86400_000 }; delete store.riderChallenges[challengeId]; persist();
      return send(res, 200, { rider: safeRider(rider) }, { 'set-cookie': sessionCookie('rsid', sid, req, 7 * 86400) });
    }
    if (req.method === 'POST' && url.pathname === '/api/rider/auth/logout') {
      const sid = cookieMap(req).rsid;
      if (sid) delete store.riderSessions[sid];
      persist();
      return send(res, 200, { ok: true }, { 'set-cookie': sessionCookie('rsid', '', req, 0) });
    }
    if (url.pathname === '/api/rider/notifications/devices' && req.method === 'POST') {
      const rider=requireRider(req,res);if(!rider)return;const result=savePushDevice('rider',rider.id,await readBody(req));if(result.error)return send(res,400,result);persist();scheduleNotificationWorkers();return send(res,200,{ok:true,status:'active'});
    }
    if (url.pathname === '/api/rider/notifications/devices/deactivate' && req.method === 'POST') {
      const rider=requireRider(req,res);if(!rider)return;deactivatePushDevice('rider',rider.id,await readBody(req));persist();return send(res,200,{ok:true});
    }
    if (req.method === 'GET' && url.pathname === '/api/rider/notifications') {
      const rider=requireRider(req,res);if(!rider)return;const notifications=store.riderNotifications[rider.id]||[];return send(res,200,{notifications,unread:notifications.filter(row=>!row.readAt).length});
    }
    const riderNotificationReadMatch=url.pathname.match(/^\/api\/rider\/notifications\/([^/]+)\/read$/);
    if(req.method==='POST'&&riderNotificationReadMatch){const rider=requireRider(req,res);if(!rider)return;const item=(store.riderNotifications[rider.id]||[]).find(row=>row.id===riderNotificationReadMatch[1]);if(!item)return send(res,404,{error:'Notification not found.'});item.readAt||=new Date().toISOString();persist();return send(res,200,{ok:true});}
    if (req.method === 'GET' && url.pathname === '/api/rider/bootstrap') {
      const rider = currentRider(req); if (!rider) return send(res, 401, { error: 'Sign in with an authorized rider account', code: 'RIDER_AUTH_REQUIRED' });
      if (rider.isActive === false) return send(res, 403, { error: 'This rider account is inactive' });
      if (rider.mustChangePassword) return send(res, 200, { rider: safeRider(rider), needsPasswordChange: true });
      const month = url.searchParams.get('month') || new Date().toISOString().slice(0, 7);
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      if (!isValidSummaryMonth(month)) return send(res, 400, { error: 'Month must use YYYY-MM format.' });
      if (!isValidSummaryDate(date) || date > new Date().toISOString().slice(0, 10)) return send(res, 400, { error: 'Choose a valid date no later than today.' });
      const available = store.orders.filter(order => order.status === 'Ready for pickup' && !order.riderId && store.dispatchSettings?.designatedRiderId === rider.id && !(order.riderRejections || []).some(row => row.riderId === rider.id)).map(riderOrderSummary);
      const assigned = store.orders.filter(order => order.riderId === rider.id && !['Delivered', 'Cancelled'].includes(order.status)).map(riderOrderDetails);
      const delivered = store.orders.filter(order => order.riderId === rider.id && order.status === 'Delivered').sort((a, b) => (b.deliveredAt || '').localeCompare(a.deliveredAt || '')).map(riderOrderSummary);
      const deliverySummary = summarizeRiderDeliveries(store.orders, rider.id, month, date);
      const riderNotifications=store.riderNotifications[rider.id]||[];
      return send(res, 200, { rider: safeRider(rider), availableOrders: available, assignedOrders: assigned, deliveredOrders: delivered, deliverySummary, notifications:riderNotifications.slice(0,50),notificationUnread:riderNotifications.filter(row=>!row.readAt).length });
    }
    if (req.method === 'POST' && url.pathname === '/api/rider/status') {
      const rider = requireRider(req, res); if (!rider) return;
      const { status } = await readBody(req);
      if (!['online', 'offline'].includes(status)) return send(res, 400, { error: 'Choose online or offline' });
      const active = store.orders.some(order => order.riderId === rider.id && !['Delivered', 'Cancelled'].includes(order.status));
      if (status === 'offline' && active) return send(res, 409, { error: 'Complete your active delivery before going offline' });
      rider.status = status;
      persist();
      return send(res, 200, { rider: safeRider(rider) });
    }
    if (req.method === 'GET' && url.pathname === '/api/rider/orders') {
      const rider = requireRider(req, res); if (!rider) return;
      return send(res, 200, {
        availableOrders: store.orders.filter(order => order.status === 'Ready for pickup' && !order.riderId && store.dispatchSettings?.designatedRiderId === rider.id && !(order.riderRejections || []).some(row => row.riderId === rider.id)).map(riderOrderSummary),
        assignedOrders: store.orders.filter(order => order.riderId === rider.id && !['Delivered', 'Cancelled'].includes(order.status)).map(riderOrderDetails),
        deliveredOrders: store.orders.filter(order => order.riderId === rider.id && order.status === 'Delivered').map(riderOrderSummary)
      });
    }
    const riderAcceptMatch = url.pathname.match(/^\/api\/rider\/orders\/([^/]+)\/accept$/);
    if (req.method === 'POST' && riderAcceptMatch) {
      const rider = requireRider(req, res); if (!rider) return;
      const order = store.orders.find(row => row.id === riderAcceptMatch[1]);
      if (!order || order.status !== 'Ready for pickup' || order.riderId) return send(res, 409, { error: 'This delivery is no longer available' });
      if (store.dispatchSettings?.designatedRiderId !== rider.id) return send(res, 403, { error: 'Only the designated rider can accept new orders. Ask an administrator to update dispatch settings.' });
      if ((order.riderRejections || []).some(row => row.riderId === rider.id)) return send(res, 409, { error: 'You rejected this delivery earlier. Ask an administrator to assign it if that decision should be reversed.' });
      if (rider.status !== 'online') return send(res, 409, { error: 'Go online before accepting a delivery' });
      order.riderId = rider.id;
      order.assignedAt = new Date().toISOString();
      order.status = 'Rider assigned';
      markOrderMilestone(order, 'Accepted by rider', order.assignedAt);
      addNotification(order.userId, { type: 'order',eventType:'rider_assigned',eventId:`order:${order.id}:rider_assigned`, title: 'Your rider is assigned', message: `A delivery partner is preparing to collect order ${order.displayId}.`, orderId: order.id,destination:'/#orders' });
      addRiderNotification(rider.id,{eventType:'rider_order',eventId:`order:${order.id}:assigned:${rider.id}`,title:'Delivery assigned',message:`Order ${order.displayId} is assigned to you.`,orderId:order.id,destination:`/rider?order=${encodeURIComponent(order.id)}`});
      persist();
      return send(res, 200, { order: riderOrderDetails(order) });
    }
    const riderRejectMatch = url.pathname.match(/^\/api\/rider\/orders\/([^/]+)\/reject$/);
    if (req.method === 'POST' && riderRejectMatch) {
      const rider = requireRider(req, res); if (!rider) return;
      const order = store.orders.find(row => row.id === decodeURIComponent(riderRejectMatch[1]));
      const { reason: rawReason } = await readBody(req);
      const reason = String(rawReason || '').trim().slice(0, 300);
      if (!order || order.status !== 'Ready for pickup' || order.riderId) return send(res, 409, { error: 'This delivery is no longer available to reject.' });
      if (store.dispatchSettings?.designatedRiderId !== rider.id) return send(res, 403, { error: 'Only the designated rider can reject new orders.' });
      if (!reason) return send(res, 400, { error: 'Enter a rejection reason.' });
      order.riderRejections ||= [];
      if (order.riderRejections.some(row => row.riderId === rider.id)) return send(res, 409, { error: 'You have already rejected this delivery.' });
      const at = new Date().toISOString();
      order.riderRejections.push({ riderId: rider.id, reason, at });
      order.history ||= []; order.history.push({ status: 'Rejected by rider', at, actorType: 'rider', actorId: rider.id, reason });
      persist();
      return send(res, 200, { order: riderOrderSummary(order) });
    }
    const riderCancelMatch = url.pathname.match(/^\/api\/rider\/orders\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && riderCancelMatch) {
      const rider = requireRider(req, res); if (!rider) return;
      const order = store.orders.find(row => row.id === decodeURIComponent(riderCancelMatch[1]) && row.riderId === rider.id);
      if (!order) return send(res, 404, { error: 'Assigned delivery not found' });
      const { reason: rawReason } = await readBody(req);
      const reason = String(rawReason || '').trim().slice(0, 300);
      if (!reason) return send(res, 400, { error: 'Enter a cancellation reason.' });
      if (!['Rider assigned', 'Picked up', 'Out for delivery'].includes(order.status)) return send(res, 409, { error: 'Only an active delivery can be cancelled by its rider.' });
      cancelOrder(order, { actorType: 'rider', actorId: rider.id, reason });
      addNotification(order.userId, { type: 'order',eventType:'order_status',eventId:`order:${order.id}:rider_cancelled`, title: 'Delivery cancelled', message: `The delivery partner cancelled order ${order.displayId}. ${reason}`, orderId: order.id,destination:'/#orders' });
      persist();
      return send(res, 200, { order: riderOrderDetails(order) });
    }
    const riderPaymentMatch = url.pathname.match(/^\/api\/rider\/orders\/([^/]+)\/payment$/);
    if (req.method === 'POST' && riderPaymentMatch) {
      const rider = requireRider(req, res); if (!rider) return;
      const order = store.orders.find(row => row.id === decodeURIComponent(riderPaymentMatch[1]) && row.riderId === rider.id);
      if (!order) return send(res, 404, { error: 'Assigned delivery not found' });
      const body = await readBody(req);
      if (order.status !== 'Out for delivery') return send(res, 409, { error: 'Payment collection is available during the delivery handoff.' });
      if (order.paymentMethod !== 'Cash on delivery' || body.method !== 'cash') {
        return send(res, 503, { error: 'Rider-collected UPI is unavailable: configure a merchant payment provider with server-side transaction verification first.', code: 'PAYMENT_PROVIDER_NOT_CONFIGURED' });
      }
      if (order.paymentCollection?.collectedAt) return send(res, 409, { error: 'Cash collection has already been recorded for this order.' });
      if (body.confirmed !== true) return send(res, 400, { error: 'Confirm that the customer physically handed over the cash.' });
      const at = new Date().toISOString();
      order.paymentCollection = { amount: Number(order.total), method: 'cash', riderId: rider.id, collectedAt: at };
      order.paymentStatus = 'Cash collected by rider';
      order.history ||= []; order.history.push({ status: 'Payment collected', at, actorType: 'rider', actorId: rider.id, amount: Number(order.total), method: 'cash' });
      order.timeline.push({ label: 'Cash collected', at, complete: true });
      addNotification(order.userId, { type: 'order',eventType:'payment_update',eventId:`order:${order.id}:cash_collected`, title: 'Cash collected', message: `The delivery partner recorded cash collection for order ${order.displayId}.`, orderId: order.id,destination:'/#orders' });
      persist();
      return send(res, 200, { order: riderOrderDetails(order) });
    }
    const riderOrderMatch = url.pathname.match(/^\/api\/rider\/orders\/([^/]+)$/);
    if (req.method === 'GET' && riderOrderMatch) {
      const rider = requireRider(req, res); if (!rider) return;
      let orderId; try { orderId = decodeURIComponent(riderOrderMatch[1]); } catch { return send(res, 400, { error: 'Invalid delivery ID' }); }
      const candidate = store.orders.find(row => row.id === orderId);
      const isAssigned = candidate?.riderId === rider.id;
      const isAvailable = candidate?.status === 'Ready for pickup' && !candidate.riderId && store.dispatchSettings?.designatedRiderId === rider.id && !(candidate.riderRejections || []).some(row => row.riderId === rider.id);
      const order = isAssigned || isAvailable ? candidate : null;
      return order ? send(res, 200, { order: riderOrderDetails(order, { preview: isAvailable }) }) : send(res, 404, { error: 'Delivery not found' });
    }
    if (req.method === 'POST' && riderOrderMatch) {
      const rider = requireRider(req, res); if (!rider) return;
      let orderId; try { orderId = decodeURIComponent(riderOrderMatch[1]); } catch { return send(res, 400, { error: 'Invalid delivery ID' }); }
      const order = store.orders.find(row => row.id === orderId && row.riderId === rider.id);
      if (!order) return send(res, 404, { error: 'Assigned delivery not found' });
      const { action } = await readBody(req);
      const transition = {
        pickup: { from: 'Rider assigned', status: 'Picked up', milestone: 'Picked up' },
        out_for_delivery: { from: 'Picked up', status: 'Out for delivery', milestone: 'Out for delivery' },
        delivered: { from: 'Out for delivery', status: 'Delivered', milestone: 'Delivered' }
      }[action];
      if (!transition) return send(res, 400, { error: 'Unknown delivery action' });
      if (order.status !== transition.from) return send(res, 409, { error: `Delivery must be ${transition.from.toLowerCase()} before this step` });
      if (action === 'delivered' && !paymentAllowsDelivery(order)) return send(res, 409, { error: order.paymentMethod === 'Cash on delivery' ? 'Collect and record the exact COD amount before marking this order delivered.' : 'Delivery is blocked until the backend confirms payment. A provider-verified payment reference is required.' });
      order.status = transition.status;
      order[`${action}At`] = new Date().toISOString();
      markOrderMilestone(order, transition.milestone, order[`${action}At`]);
      order.history ||= []; order.history.push({ status: transition.status, at: order[`${action}At`], actorType: 'rider', actorId: rider.id });
      if (action === 'delivered' && order.paymentMethod === 'Cash on delivery') order.paymentStatus = 'Cash collected';
      const customerMessages = {
        pickup: ['Order picked up', `Your order ${order.displayId} has been picked up by the delivery partner.`],
        out_for_delivery: ['Your order is on the way', `Order ${order.displayId} is out for delivery.`],
        delivered: ['Order delivered', `Order ${order.displayId} has been marked delivered. Enjoy!`]
      };
      const [title, message] = customerMessages[action];
      addNotification(order.userId, { type: 'delivery',eventType:'delivery_status',eventId:`order:${order.id}:status:${transition.to}`, title, message, orderId: order.id,destination:'/#orders' });
      if (action === 'delivered') { const referral = (store.referrals || []).find(row => row.referredUserId === order.userId && row.status === 'pending'); if (referral) issueReferralReward(referral, order); }
      persist();
      return send(res, 200, { order: riderOrderDetails(order) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/google/start') {
      if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return send(res, 503, { error: 'Google sign-in is not configured yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the server environment.', code: 'GOOGLE_AUTH_NOT_CONFIGURED' });
      if (!googleRequestOrigin(req)) return send(res, 403, { error: 'Google sign-in must start from this application.', code: 'INVALID_ORIGIN' });
      const state = crypto.randomBytes(32).toString('base64url');
      return send(res, 200, { clientId: process.env.GOOGLE_CLIENT_ID, state }, { 'set-cookie': `google_oauth_state=${encodeURIComponent(state)}; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=300${secureCookie(req)}` });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/google/callback') {
      if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return send(res, 503, { error: 'Google sign-in is not configured yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the server environment.', code: 'GOOGLE_AUTH_NOT_CONFIGURED' });
      const origin = googleRequestOrigin(req);
      if (!origin || req.headers['x-requested-with'] !== 'XMLHttpRequest') return send(res, 403, { error: 'Google sign-in request could not be validated.', code: 'INVALID_ORIGIN' });
      const body = await readBody(req);
      const suppliedState = String(body.state || ''), cookieState = cookieMap(req).google_oauth_state || '';
      const stateValid = suppliedState.length === cookieState.length && suppliedState.length >= 32 && crypto.timingSafeEqual(Buffer.from(suppliedState), Buffer.from(cookieState));
      const clearStateCookie = { 'set-cookie': `google_oauth_state=; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie(req)}` };
      if (!stateValid) return send(res, 401, { error: 'Google sign-in expired. Please try again.', code: 'GOOGLE_STATE_INVALID' }, clearStateCookie);
      const code = String(body.code || '');
      if (!code || code.length > 4096) return send(res, 400, { error: 'Google did not return an authorization code. Please try again.' }, clearStateCookie);
      let tokenResponse;
      try {
        const exchanged = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: origin, grant_type: 'authorization_code' }),
          signal: AbortSignal.timeout(12000)
        });
        if (!exchanged.ok) return send(res, 401, { error: 'Google could not verify this sign-in. Please try again.', code: 'GOOGLE_CODE_REJECTED' }, clearStateCookie);
        tokenResponse = await exchanged.json();
      } catch {
        return send(res, 502, { error: 'Google sign-in is temporarily unavailable. Check your connection and try again.', code: 'GOOGLE_PROVIDER_UNAVAILABLE' }, clearStateCookie);
      }
      let identity;
      try { identity = await verifyGoogleIdToken(tokenResponse.id_token, process.env.GOOGLE_CLIENT_ID); }
      catch { return send(res, 401, { error: 'Google returned an invalid or unverified identity. Please try again.', code: 'GOOGLE_ID_TOKEN_INVALID' }, clearStateCookie); }
      let user, isNewUser;
      try { ({ user, isNewUser } = resolveGoogleCustomer(store.users, identity, { createReferralCode: makeReferralCode })); }
      catch (error) { return send(res, 409, { error: 'This verified email is already linked to another customer account. Sign in with the linked account or contact support.', code: error.code || 'GOOGLE_ACCOUNT_CONFLICT' }, clearStateCookie); }
      if (user.blockedAt) return send(res, 403, { error: 'This account is blocked. Contact PurainaMart support.' }, clearStateCookie);

      let referralResult = isNewUser ? { status: 'none' } : { status: 'existing_account' };
      const submittedReferralCode = String(body.referralCode || '').trim().toUpperCase();
      if (isNewUser && submittedReferralCode) {
        const referrer = findReferrerByCode(submittedReferralCode);
        if (!store.referralCampaign?.enabled) referralResult = { status: 'campaign_unavailable' };
        else if (!referrer) referralResult = { status: 'invalid_code' };
        else if (referrer.id === user.id) referralResult = { status: 'self_referral_blocked' };
        else if (user.referredBy) referralResult = { status: 'already_attributed' };
        else { const referral = { id: crypto.randomUUID(), referrerUserId: referrer.id, referredUserId: user.id, referralCode: submittedReferralCode, attributedAt: new Date().toISOString(), status: 'pending', qualifyingOrderId: null, rewardId: null }; user.referredBy = referrer.id; user.referredAt = referral.attributedAt; store.referrals.push(referral); referralResult = { status: 'linked' }; }
        if (!['linked', 'none'].includes(referralResult.status)) { store.referralEvents ||= []; store.referralEvents.push({ id: crypto.randomUUID(), code: submittedReferralCode.slice(0, 20), userId: user.id, status: referralResult.status, at: new Date().toISOString() }); store.referralEvents = store.referralEvents.slice(-500); }
      }
      const sid = createCustomerSession(user, 'google', req);
      return send(res, 200, { user: safeUser(user), referral: referralResult }, { ...clearStateCookie, 'set-cookie': [`google_oauth_state=; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie(req)}`, `sid=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secureCookie(req)}`, ...(res.guestCookie ? [res.guestCookie] : [])] });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/password/login') {
      const body = await readBody(req), phone = normalizePhone(body.phone), identity = phone || 'invalid';
      if (!/^\d{10}$/.test(phone)) return send(res, 400, { error: 'Unable to sign in with those credentials.' });
      if (authRateLimited(req, identity)) return send(res, 429, { error: 'Too many sign-in attempts. Try again in 15 minutes.' });
      const user = store.users.find(row => row.phone === phone);
      if (user?.blockedAt) return send(res, 403, { error: 'This account is blocked. Contact PurainaMart support.' });
      const ok = await verifyPassword(String(body.password || ''), user?.passwordHash || dummyPasswordHash) && Boolean(user?.passwordHash);
      if (!ok) { recordAuthFailure(req, identity); return send(res, 401, { error: 'Unable to sign in with those credentials. Older accounts without a password must use a linked Google sign-in or an existing signed-in session to set one.' }); }
      clearAuthFailures(req, identity);
      const sid = createCustomerSession(user, 'password', req);
      return send(res, 200, { user: safeUser(user) }, { 'set-cookie': sessionCookie('sid', sid, req, 7 * 86400) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/register') {
      const body = await readBody(req), phone = normalizePhone(body.phone), name = String(body.name || '').trim(), password = String(body.password || ''), identity = phone || 'invalid';
      if (!/^\d{10}$/.test(phone) || name.length < 2 || name.length > 50 || /[\u0000-\u001f\u007f]/.test(name) || passwordError(password) || body.confirmPassword !== password) return send(res, 400, { error: 'Unable to create an account. Check your details, or sign in if you already have an account.' });
      if (authRateLimited(req, identity)) return send(res, 429, { error: 'Too many sign-in attempts. Try again in 15 minutes.' });
      if (store.users.some(row => row.phone === phone)) { recordAuthFailure(req, identity); return send(res, 400, { error: 'Unable to create an account. Check your details, or sign in if you already have an account.' }); }
      const user = { id: crypto.randomUUID(), phone, name, passwordHash: await hashPassword(password), referralCode: makeReferralCode(), createdAt: new Date().toISOString() };
      store.users.push(user);
      let referral = { status: 'none' };
      const code = String(body.referralCode || '').trim().toUpperCase();
      if (code) {
        const referrer = findReferrerByCode(code);
        if (!store.referralCampaign?.enabled) referral = { status: 'campaign_unavailable' };
        else if (!referrer) referral = { status: 'invalid_code' };
        else if (referrer.id === user.id) referral = { status: 'self_referral_blocked' };
        else { const at = new Date().toISOString(); user.referredBy = referrer.id; user.referredAt = at; store.referrals.push({ id: crypto.randomUUID(), referrerUserId: referrer.id, referredUserId: user.id, referralCode: code, attributedAt: at, status: 'pending', qualifyingOrderId: null, rewardId: null }); referral = { status: 'linked' }; }
      }
      clearAuthFailures(req, identity);
      const sid = createCustomerSession(user, 'password', req);
      return send(res, 201, { user: safeUser(user), referral }, { 'set-cookie': sessionCookie('sid', sid, req, 7 * 86400) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/password/set') {
      const user = requireUser(req, res); if (!user) return;
      const body = await readBody(req), nextPassword = String(body.newPassword || '');
      if (passwordError(nextPassword)) return send(res, 400, { error: 'Use a password between 12 and 128 characters.' });
      if (body.confirmPassword !== nextPassword) return send(res, 400, { error: 'Passwords do not match.' });
      if (user.passwordHash && !(await verifyPassword(String(body.currentPassword || ''), user.passwordHash))) return send(res, 401, { error: 'Current password is incorrect.' });
      if (!/^\d{10}$/.test(user.phone || '')) return send(res, 409, { error: 'A verified mobile number is required before password sign-in can be used for this account.' });
      user.passwordHash = await hashPassword(nextPassword); user.passwordChangedAt = new Date().toISOString(); persist();
      return send(res, 200, { ok: true });
    }
    if (testAuthEnabled && req.method === 'POST' && url.pathname === '/api/auth/request-otp') {
      const { phone } = await readBody(req);
      const normalized = normalizePhone(phone);
      if (normalized.length !== 10) return send(res, 400, { error: 'Enter a valid 10 digit mobile number' });
      const challengeId = crypto.randomUUID();
      store.challenges[challengeId] = { phone: normalized, createdAt: Date.now() };
      persist();
      return send(res, 200, { challengeId, message: 'Test-only authentication challenge', testCode: demoOtp, expiresInSeconds: 300 });
    }
    if (testAuthEnabled && req.method === 'POST' && url.pathname === '/api/auth/verify-otp') {
      const { challengeId, code, name, referralCode } = await readBody(req);
      const challenge = store.challenges[challengeId];
      if (!challenge || Date.now() - challenge.createdAt > 300_000) return send(res, 400, { error: 'Code expired. Request a new one.' });
      if (String(code) !== demoOtp) return send(res, 401, { error: 'That code is not correct' });
      let user = store.users.find(row => row.phone === challenge.phone);
      if (user?.blockedAt) return send(res, 403, { error: 'This account is blocked. Contact PurainaMart support.' });
      const isNewUser = !user;
      if (!user) { user = { id: crypto.randomUUID(), phone: challenge.phone, name: String(name || '').trim().slice(0, 50) || 'Zepto member', referralCode: makeReferralCode(), createdAt: new Date().toISOString() }; store.users.push(user); }
      let referralResult = isNewUser ? { status: 'none' } : { status: 'existing_account' };
      const submittedReferralCode = String(referralCode || '').trim().toUpperCase();
      if (isNewUser && submittedReferralCode) {
        const referrer = findReferrerByCode(submittedReferralCode);
        if (!store.referralCampaign?.enabled) referralResult = { status: 'campaign_unavailable' };
        else if (!referrer) referralResult = { status: 'invalid_code' };
        else if (referrer.id === user.id) referralResult = { status: 'self_referral_blocked' };
        else if (user.referredBy) referralResult = { status: 'already_attributed' };
        else { const referral = { id: crypto.randomUUID(), referrerUserId: referrer.id, referredUserId: user.id, referralCode: submittedReferralCode, attributedAt: new Date().toISOString(), status: 'pending', qualifyingOrderId: null, rewardId: null }; user.referredBy = referrer.id; user.referredAt = referral.attributedAt; store.referrals.push(referral); referralResult = { status: 'linked' }; }
        if (!['linked','none'].includes(referralResult.status)) { store.referralEvents ||= []; store.referralEvents.push({ id: crypto.randomUUID(), code: submittedReferralCode.slice(0, 20), userId: user.id, status: referralResult.status, at: new Date().toISOString() }); store.referralEvents = store.referralEvents.slice(-500); }
      }
      delete store.challenges[challengeId];
      const sid = createCustomerSession(user, 'test-otp', req);
      return send(res, 200, { user: safeUser(user), referral: referralResult }, { 'set-cookie': sessionCookie('sid', sid, req, 7 * 86400) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const sid = cookieMap(req).sid;
      if (sid) delete store.sessions[sid];
      persist();
      return send(res, 200, { ok: true }, { 'set-cookie': sessionCookie('sid', '', req, 0) });
    }
    if (req.method === 'POST' && url.pathname === '/api/cart/items') {
      const { productId, variantId, delta } = await readBody(req);
      const product = products.find(p => p.id === productId);
      if (!product) return send(res, 404, { error: 'Product not found' });
      const change = Number(delta);
      if (!Number.isInteger(change) || change === 0) return send(res, 400, { error: 'Choose a valid quantity change' });
      if (product.variants?.length) {
        if (!variantId) return send(res, 400, { error: 'Choose a quantity option first.' });
        const customMatch = product.saleType === 'loose' && product.measurementUnit === 'g' && /^custom-\d{1,6}$/.test(String(variantId)) ? String(variantId).match(/^custom-(\d{1,6})$/) : null;
        const customGrams = customMatch ? Number(customMatch[1]) : 0;
        const variant = customMatch ? { id: variantId, label: `${customGrams} g`, quantityBase: customGrams, unit: 'g', price: fromMoneyCents(Math.round((toMoneyCents(product.price) || 0) * customGrams / 1000)), mrp: null, stock: Number(product.stock || 0), isActive: customGrams > 0 } : product.variants.find(row => row.id === variantId);
        if (!variant) return send(res, 404, { error: 'That quantity option is no longer available. Remove it from your cart.' });
        if (customMatch && (customGrams < 50 || customGrams > 100000)) return send(res, 400, { error: 'Enter a custom weight between 50 g and 100,000 g.' });
        const cart = variantCartFor(req); cart[productId] ||= {};
        const currentQuantity = Number(cart[productId][variantId]) || 0;
        const next = Math.max(0, Math.min(10, currentQuantity + change));
        if (change > 0) {
          if (product.isActive === false || variant.isActive === false) return send(res, 409, { error: 'This quantity option is currently unavailable.' });
          const required = product.saleType === 'packed' ? next : variant.quantityBase * next;
          if (required > Number(variant.stock)) return send(res, 409, { error: `Only ${variant.stock} ${product.saleType === 'packed' ? 'pack(s)' : product.measurementUnit} remain for this option.` });
        }
        if (next) cart[productId][variantId] = next;
        else { delete cart[productId][variantId]; if (!Object.keys(cart[productId]).length) delete cart[productId]; }
        clearIneligibleCoupon(req); persist(); return send(res, 200, cartSummary(req));
      }
      if (variantId) return send(res, 409, { error: 'This product does not have configured quantity options.' });
      const cart = cartFor(req);
      if (product.isActive === false || Number(product.stock) < 1) return send(res, 409, { error: 'This product is currently unavailable' });
      const currentQuantity = Number(cart[productId]) || 0;
      if (change > 0 && currentQuantity + change > Number(product.stock)) return send(res, 409, { error: `Only ${product.stock} unit${Number(product.stock) === 1 ? '' : 's'} available` });
      const next = Math.max(0, Math.min(10, currentQuantity + change));
      if (next) cart[productId] = next; else delete cart[productId];
      clearIneligibleCoupon(req);
      persist();
      return send(res, 200, cartSummary(req));
    }
    if (req.method === 'DELETE' && url.pathname === '/api/cart') {
      store.carts[cartOwner(req)] = {};
      store.variantCarts[cartOwner(req)] = {};
      if (store.appliedCoupon) delete store.appliedCoupon[cartOwner(req)];
      persist();
      return send(res, 200, cartSummary(req));
    }
    if (req.method === 'POST' && url.pathname === '/api/coupons/apply') {
      const { code } = await readBody(req);
      const coupon = store.coupons[String(code || '').toUpperCase()];
      const cart = cartSummary(req);
      if (!couponEligible(coupon, cartOwner(req), cart.subtotal, { allowBelowMinimum: true })) return send(res, 400, { error: 'That coupon is not available' });
      if (cart.subtotal < Number(coupon.minimum || 0)) return send(res, 400, { error: `Add items worth ₹${Number(coupon.minimum || 0) - cart.subtotal} more to use this code` });
      if (coupon.discountType === 'free_delivery' && (!cart.deliveryAvailable || cart.minimumOrderMet === false)) return send(res, 400, { error: 'Choose an eligible delivery area and meet its minimum order to use this offer.' });
      if (coupon.discountType === 'free_delivery' && cart.freeDeliveryUnlocked) return send(res, 409, { error: 'Free delivery is already included for this order.' });
      store.appliedCoupon ||= {};
      store.appliedCoupon[cartOwner(req)] = coupon.code;
      persist();
      return send(res, 200, { coupon, cart: cartSummary(req) });
    }
    if (req.method === 'DELETE' && url.pathname === '/api/coupons') {
      store.appliedCoupon ||= {};
      delete store.appliedCoupon[cartOwner(req)];
      persist();
      return send(res, 200, cartSummary(req));
    }
    if (req.method === 'GET' && url.pathname === '/api/wishlist') return send(res, 200, { items: wishlistProducts(req) });
    if (req.method === 'POST' && url.pathname === '/api/wishlist/toggle') {
      const { productId } = await readBody(req);
      if (!products.some(product => product.id === productId && product.isActive !== false)) return send(res, 404, { error: 'Product not found' });
      const saved = wishlistFor(req);
      const exists = saved.includes(productId);
      store.wishlists[cartOwner(req)] = exists ? saved.filter(id => id !== productId) : [...saved, productId];
      persist();
      return send(res, 200, { items: wishlistProducts(req), added: !exists });
    }
    if (req.method === 'GET' && url.pathname === '/api/addresses') {
      const user = requireUser(req, res); if (!user) return;
      return send(res, 200, { addresses: addressesFor(user) });
    }
    if (req.method === 'POST' && url.pathname === '/api/addresses') {
      const user = requireUser(req, res); if (!user) return;
      const body = await readBody(req);
      if (!String(body.line1 || '').trim() || !String(body.city || '').trim()) return send(res, 400, { error: 'Add a street or building and city.' });
      const recipientName = String(body.recipientName || '').trim().slice(0, 80);
      const phone = String(body.phone || '').replace(/\D/g, '').slice(-10);
      if (!recipientName || !/^\d{10}$/.test(phone)) return send(res, 400, { error: 'Enter the recipient name and a valid 10-digit mobile number.' });
      const areaId = String(body.deliveryAreaId || '').trim();
      if (!areaId) return send(res, 400, { error: 'Select a delivery area.' });
      const area = activeDeliveryAreas().find(row => row.id === areaId);
      if (!area) return send(res, 409, { error: 'That delivery area is unavailable. Select a currently enabled area.' });
      const list = addressesFor(user);
      const address = { id: crypto.randomUUID(), label: String(body.label || 'Home').slice(0, 24), recipientName, phone, line1: String(body.line1).trim().slice(0, 100), line2: String(body.line2 || '').trim().slice(0, 100), landmark: String(body.landmark || '').trim().slice(0, 100), city: String(body.city).trim().slice(0, 60), deliveryAreaId: area.id, isDefault: list.length === 0, createdAt: new Date().toISOString() };
      store.addresses[user.id] ||= [];
      store.addresses[user.id].push(address);
      store.selectedDeliveryAreas ||= {}; store.selectedDeliveryAreas[user.id] = area.id;
      store.selectedDeliveryAddresses ||= {}; store.selectedDeliveryAddresses[user.id] = address.id;
      persist();
      return send(res, 201, { address: addressForCustomer(address), addresses: store.addresses[user.id].map(addressForCustomer), cart: cartSummary(req) });
    }
    const defaultMatch = url.pathname.match(/^\/api\/addresses\/([^/]+)\/default$/);
    if (req.method === 'PATCH' && defaultMatch) {
      const user = requireUser(req, res); if (!user) return;
      const list = addressesFor(user);
      const address = list.find(row => row.id === defaultMatch[1]);
      if (!address) return send(res, 404, { error: 'Address not found' });
      list.forEach(row => { row.isDefault = row.id === defaultMatch[1]; });
      const area = findDeliveryArea(address, address.deliveryAreaId);
      store.selectedDeliveryAreas ||= {};
      if (area) { address.deliveryAreaId = area.id; store.selectedDeliveryAreas[user.id] = area.id; }
      else delete store.selectedDeliveryAreas[user.id];
      store.selectedDeliveryAddresses ||= {}; store.selectedDeliveryAddresses[user.id] = address.id;
      persist();
      return send(res, 200, { addresses: list.map(addressForCustomer), activeAddress: addressForCustomer(address), cart: cartSummary(req) });
    }
    if (req.method === 'GET' && url.pathname === '/api/orders') {
      const user = requireUser(req, res); if (!user) return;
      return send(res, 200, { orders: store.orders.filter(row => row.userId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
    }
    const orderMatch = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
    if (req.method === 'GET' && orderMatch) {
      const user = requireUser(req, res); if (!user) return;
      const order = store.orders.find(row => row.id === orderMatch[1] && row.userId === user.id);
      return order ? send(res, 200, { order }) : send(res, 404, { error: 'Order not found' });
    }
  const customerCancelMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && customerCancelMatch) {
    const user = requireUser(req, res); if (!user) return;
    const order = store.orders.find(row => row.id === decodeURIComponent(customerCancelMatch[1]) && row.userId === user.id);
    if (!order) return send(res, 404, { error: 'Order not found' });
    if (order.status === 'Cancelled') return send(res, 409, { error: 'This order has already been cancelled.' });
    if (!['Order received', 'Being packed', 'Ready for pickup'].includes(order.status) || order.riderId) return send(res, 409, { error: 'This order can no longer be cancelled because a rider has accepted it or fulfillment has advanced.' });
    cancelOrder(order, { actorType: 'customer', actorId: user.id, reason: 'Cancelled by customer' });
    addNotification(order.userId, { type: 'order',eventType:'order_status',eventId:`order:${order.id}:customer_cancelled`, title: 'Order cancelled', message: `Your order ${order.displayId} was cancelled.`, orderId: order.id,destination:'/#orders' });
    persist();
    return send(res, 200, { order });
  }
    if (req.method === 'POST' && url.pathname === '/api/orders') {
      const user = requireUser(req, res); if (!user) return;
      const body = await readBody(req);
      const idempotencyKey = String(body.idempotencyKey || '').trim();
      if (idempotencyKey && !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) return send(res, 400, { error: 'The checkout request key is invalid.' });
      if (idempotencyKey) {
        const previousOrder = store.orders.find(row => row.userId === user.id && row.idempotencyKey === idempotencyKey);
        if (previousOrder) return send(res, 200, { order: previousOrder, idempotentReplay: true });
      }
      const previouslyAppliedCode = store.appliedCoupon?.[user.id];
      const previouslyAppliedCoupon = previouslyAppliedCode ? store.coupons[previouslyAppliedCode] : null;
      if (!['cod', 'upi'].includes(body.paymentMethod)) return send(res, 400, { error: 'Choose a supported payment method.' });
      if (isProduction && body.paymentMethod === 'upi') return send(res, 503, { error: 'Online payment is not configured. Choose Cash on Delivery.' });
      if (previouslyAppliedCode && !couponEligible(previouslyAppliedCoupon, user.id, cartSummary(req).subtotal)) return send(res, 409, { error: 'The applied coupon is no longer eligible. Choose another offer before checkout.', code: 'COUPON_INELIGIBLE' });
      clearIneligibleCoupon(req);
      const cart = cartSummary(req);
      if (!cart.items.length) return send(res, 400, { error: 'Your cart is empty' });
      const unavailable = cart.items.find(item => !item.isAvailable || !products.some(row => row.id === item.id && row.isActive !== false));
      if (unavailable) return send(res, 409, { error: unavailable.availabilityError || `${unavailable.name} no longer has enough stock. Update your cart and try again.` });
      const address = body.addressId ? addressesFor(user).find(row => row.id === body.addressId) : addressesFor(user).find(row => row.isDefault);
      if (body.addressId && !address) return send(res, 400, { error: 'Choose a saved delivery address' });
      if (!address) return send(res, 400, { error: 'Add a delivery address first' });
      const requestedAreaId = body.deliveryAreaId == null || body.deliveryAreaId === '' ? address.deliveryAreaId : String(body.deliveryAreaId);
      const deliveryArea = findDeliveryArea(address, requestedAreaId);
      if (!deliveryArea || (body.deliveryAreaId && String(body.deliveryAreaId) !== address.deliveryAreaId)) return send(res, 409, { error: 'Delivery area is unavailable or does not match this address. Select a currently enabled area for this address.' });
      const baseDeliveryQuote = quoteDelivery(req, cart.subtotal, { address, areaId: deliveryArea.id });
      if (!baseDeliveryQuote.available) return send(res, 409, { error: 'Delivery area is unavailable. Select a currently enabled area for this address.' });
      if (!baseDeliveryQuote.minimumOrderMet) return send(res, 409, { error: `This area requires a minimum order of ₹${baseDeliveryQuote.minimumOrder}. Add ₹${baseDeliveryQuote.minimumOrder - cart.subtotal} more to continue.` });
      if (cart.activeCoupon?.discountType === 'free_delivery' && baseDeliveryQuote.free) return send(res, 409, { error: 'The delivery coupon is no longer needed because this area already includes free delivery. Remove it and try again.', code: 'COUPON_INELIGIBLE' });
      const deliveryQuote = { ...baseDeliveryQuote, delivery: cart.delivery, free: cart.freeDeliveryUnlocked };
      const orderTotal = fromMoneyCents(Math.max(0, (toMoneyCents(cart.subtotal) ?? 0) - (toMoneyCents(cart.discount) ?? 0) + (toMoneyCents(deliveryQuote.delivery) ?? 0) + (toMoneyCents(cart.platform) ?? 0)));
      const createdAt = new Date().toISOString();
      const deliveryAreaSnapshot = { id: deliveryArea.id, name: deliveryArea.name, pinCodes: [...(deliveryArea.pinCodes || [])], deliveryCharge: deliveryQuote.delivery, standardDeliveryCharge: Number(deliveryArea.deliveryCharge || 0), minimumOrder: deliveryQuote.minimumOrder, freeDeliveryThreshold: deliveryQuote.freeDeliveryThreshold, etaMinMinutes: Number(deliveryArea.etaMinMinutes), etaMaxMinutes: Number(deliveryArea.etaMaxMinutes), isDemoFallback: Boolean(deliveryArea.isDemoFallback) };
      const orderAddress = { ...address, deliveryAreaId: deliveryArea.id, deliveryAreaName: deliveryArea.name };
      const order = { id: crypto.randomUUID(), displayId: createUniqueOrderDisplayId(), ...(idempotencyKey ? { idempotencyKey } : {}), userId: user.id, rewardId: cart.activeCoupon?.rewardId || null, items: cart.items, address: orderAddress, deliveryArea: deliveryAreaSnapshot, paymentMethod: body.paymentMethod === 'upi' ? 'Demo UPI' : 'Cash on delivery', paymentStatus: body.paymentMethod === 'upi' ? 'Demo payment complete (simulated)' : 'Pay on delivery', subtotal: cart.subtotal, discount: cart.discount, couponCode: cart.activeCoupon?.code || null, delivery: deliveryQuote.delivery, platform: cart.platform, total: orderTotal, status: 'Ready for pickup', eta: deliveryQuote.estimate, createdAt, readyAt: createdAt, riderId: null, timeline: [{ label: 'Order placed', at: createdAt, complete: true }, { label: 'Being packed', at: createdAt, complete: true }, { label: 'Ready for pickup', at: createdAt, complete: true }, { label: 'Accepted by rider', at: null, complete: false }, { label: 'Picked up', at: null, complete: false }, { label: 'Out for delivery', at: null, complete: false }, { label: 'Delivered', at: null, complete: false }] };
      if (isProduction) { order.status = 'Order received'; order.readyAt = null; for (const step of order.timeline) if (['Being packed', 'Ready for pickup'].includes(step.label)) { step.complete = false; step.at = null; } }
      store.orders.push(order);
      if (cart.activeCoupon && !cart.activeCoupon.rewardId) { cart.activeCoupon.redemptionCount = Number(cart.activeCoupon.redemptionCount || 0) + 1; if (cart.activeCoupon.maxRedemptions && cart.activeCoupon.redemptionCount >= Number(cart.activeCoupon.maxRedemptions)) cart.activeCoupon.isActive = false; }
      if (cart.activeCoupon?.rewardId) { const reward = store.rewards.find(row => row.id === cart.activeCoupon.rewardId && row.userId === user.id && row.status === 'available'); if (reward) { reward.redemptionCount = Number(reward.redemptionCount || 0) + 1; reward.redemptionHistory ||= []; reward.redemptionHistory.push({ orderId: order.id, redeemedAt: createdAt, status: 'redeemed' }); reward.orderId = order.id; reward.lastRedeemedAt = createdAt; cart.activeCoupon.redemptionCount = Number(cart.activeCoupon.redemptionCount || 0) + 1; if (reward.redemptionCount >= Number(reward.redemptionLimit || 1)) { reward.status = 'redeemed'; reward.redeemedAt = createdAt; cart.activeCoupon.isActive = false; } } }
      for (const item of cart.items) {
        const product = products.find(row => row.id === item.id);
        const consumed = item.saleType === 'packed' ? item.quantity : item.saleType === 'loose' ? item.totalBaseQuantity : item.quantity;
        if (item.variantId && !String(item.variantId).startsWith('custom-')) { const variant = product.variants.find(row => row.id === item.variantId); if (variant) variant.stock -= consumed; }
        product.stock -= consumed;
      }
      addNotification(user.id, { type: 'order',eventType:'order_received',eventId:`order:${order.id}:received`, title: 'Order confirmed', message: isProduction ? `Order ${order.displayId} was received. We’ll notify you as it is prepared.` : `Order ${order.displayId} is confirmed and ready for pickup.`, orderId: order.id,destination:'/#orders' });
      if(order.status==='Ready for pickup')notifyDesignatedRider(order);
      store.carts[user.id] = {};
      store.variantCarts[user.id] = {};
      if (store.appliedCoupon) delete store.appliedCoupon[user.id];
      persist();
      return send(res, 201, { order });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
    let requested;
    try { requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); }
    catch { if (!url.pathname.startsWith('/api/')) { res.writeHead(302, { location: '/', 'cache-control': 'no-store' }); return res.end(); } return send(res, 400, { error: 'Malformed URL' }); }
    if (requested === '/rider' || requested === '/rider/') requested = '/rider.html';
    if (requested === '/admin' || requested === '/admin/') requested = '/admin.html';
    if (requested === '/referral' || requested === '/referral/') requested = '/index.html';
    const file = path.resolve(publicDir, `.${requested}`);
    if (!file.startsWith(path.resolve(publicDir) + path.sep) && file !== path.join(publicDir, 'index.html')) return send(res, 403, { error: 'Forbidden' });
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      if (!url.pathname.startsWith('/api/') && !path.extname(requested)) { res.writeHead(302, { location: '/', 'cache-control': 'no-store' }); return res.end(); }
      return send(res, 404, { error: 'Not found' });
    }
    const stat = fs.statSync(file);
    const etag = `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
    const lastModified = stat.mtime.toUTCString();
    const isAsset = requested.startsWith('/assets/');
    const isVersionedAsset = isAsset && /-v\d+\.(?:avif|webp|jpe?g|png)$/i.test(requested);
    const cacheControl = isVersionedAsset ? 'public, max-age=31536000, immutable' : isAsset ? 'public, max-age=86400, stale-while-revalidate=604800' : 'no-cache';
    const requestEtags = String(req.headers['if-none-match'] || '').split(',').map(value => value.trim()).filter(Boolean);
    const notModifiedSince = Date.parse(req.headers['if-modified-since'] || '');
    const matchesEtag = requestEtags.includes('*') || requestEtags.includes(etag);
    const matchesDate = Number.isFinite(notModifiedSince) && Math.floor(stat.mtimeMs / 1000) * 1000 <= notModifiedSince;
    const responseHeaders = { 'content-type': mime(file), 'content-length': stat.size, 'cache-control': cacheControl, etag, 'last-modified': lastModified };
    if (matchesEtag || (!requestEtags.length && matchesDate)) { res.writeHead(304, responseHeaders); return res.end(); }
    res.writeHead(200, responseHeaders);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    console.error(error);
    if (error instanceof URIError && !res.headersSent && !String(req.url || '').startsWith('/api/')) { res.writeHead(302, { location: '/', 'cache-control': 'no-store' }); return res.end(); }
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong. Please try again.' });
    else res.end();
  }
}

const listenHost = isProduction ? (process.env.HOST || '0.0.0.0') : devHost;
server.listen(port, listenHost, () => console.log(`Zepto local recreation listening at ${listenHost}:${port} (${isProduction ? 'production' : 'development'} mode)`));
