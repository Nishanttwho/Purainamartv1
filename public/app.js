import { distinctProductImageSources } from './product-images.js';

const state = {
  view: 'home', categories: [], products: [], cart: { items: [], count: 0, subtotal: 0, delivery: 0, platform: 0, discount: 0, total: 0 },
  user: null, addresses: [], activeAddress: null, deliveryAreas: [], selectedDeliveryAreaId: null, deliveryQuote: null, orders: [], coupons: [], wishlist: [], notifications: [], notificationUnread: 0, notificationConfig: null, notificationPushEnabled: false, selectedCategory: 'all', searchQuery: '', selectedProduct: null,
  auth: null, modal: null, returnView: 'home', checkoutPayment: 'cod', checkoutAddressId: null, addressNotice: null, activeOrder: null, busy: false, googleBusy: false,
  referralData: null, referralLoading: false, referralError: null, checkoutRequest: null, placingOrder: false, mode: 'development'
};

let pendingReferralCode = '';
const pendingQuantityRequests = new Set();
try {
  const referralParams = new URLSearchParams(window.location.search);
  pendingReferralCode = (referralParams.get('code') || referralParams.get('ref') || sessionStorage.getItem('zepto.pendingReferral') || '').trim().toUpperCase();
  if (pendingReferralCode && /^[A-Z0-9_-]{3,32}$/.test(pendingReferralCode)) sessionStorage.setItem('zepto.pendingReferral', pendingReferralCode);
  else pendingReferralCode = '';
} catch { pendingReferralCode = ''; }
const $ = (selector, root = document) => root.querySelector(selector);
const money = value => `₹${Number(value || 0).toLocaleString('en-IN')}`;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

async function api(url, options = {}) {
  // Bound read-only requests so a stalled bootstrap or navigation fetch cannot
  // leave the storefront indefinitely blank. Do not abort mutations client-side:
  // an aborted POST may still commit on the server and make its result ambiguous.
  const isReadOnly = String(options.method || 'GET').toUpperCase() === 'GET';
  const controller = isReadOnly ? new AbortController() : null;
  const timeout = controller ? window.setTimeout(() => controller.abort(), 25000) : null;
  try {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      ...(controller ? { signal: controller.signal } : {}),
      headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `Request failed (HTTP ${response.status}).`);
      error.code = data.code || 'HTTP_ERROR';
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (controller?.signal.aborted) throw new Error('The server took too long to respond. Check your connection and try again.');
    throw error;
  } finally {
    if (timeout !== null) window.clearTimeout(timeout);
  }
}
const post = (url, body = {}, headers = {}) => api(url, { method: 'POST', body: JSON.stringify(body), headers });
let initialHashHandled = false;
async function handleNotificationHash(initial = false) {
  const requested = location.hash.slice(1);
  if (!['home','orders','notifications','referrals','offers'].includes(requested)) return;
  if (requested === 'offers') { state.view = 'cart'; render(); return; }
  if (requested !== 'home' && !state.user) { state.view=requested; openAuth(); return; }
  state.view=requested;
  try {
    if(requested==='orders')state.orders=(await api('/api/orders')).orders;
    if(requested==='notifications'){const n=await api('/api/notifications');state.notifications=n.notifications;state.notificationUnread=n.unread;}
    if(requested==='referrals')await loadReferralData();
  } catch(error) { toast(error.message); }
  render();
}

async function bootstrap() {
  const data = await api('/api/bootstrap');
  Object.assign(state, data);
  if (state.user) import('/push-client.js').then(push => push.syncGrantedWebPush('customer')).catch(() => {});
  if (pendingReferralCode && !state.user) { try { state.referralInvite = await api('/api/referrals/validate?code=' + encodeURIComponent(pendingReferralCode)); } catch { state.referralInvite = { valid: false, reason: 'unavailable' }; } }
  if(!initialHashHandled){initialHashHandled=true;const requested=location.hash.slice(1);if(['orders','notifications','referrals','offers'].includes(requested)){await handleNotificationHash(true);return;}}
  render();
}
function renderBootstrapError(error) {
  const message = error?.message || 'The store could not be reached. Please try again.';
  $('#main-content').innerHTML = `<div class="empty-state"><div class="empty-art">☁</div><h2>Could not load Puraina Mart</h2><p>${escapeHtml(message)}</p><button type="button" class="primary-button" data-action="retry-bootstrap">Try again</button></div>`;
}
function toast(message) {
  const root = $('#toast-root');
  const item = document.createElement('div'); item.className = 'toast'; item.textContent = message; item.setAttribute('role', 'status');
  root.replaceChildren(item);
  window.clearTimeout(toast.dismissTimer);
  toast.dismissTimer = window.setTimeout(() => { if (item.isConnected) item.remove(); }, 3000);
}
function pushErrorMessage(error) { const message=String(error?.message||'');return error instanceof TypeError||/failed to fetch|dynamically imported module|networkerror/i.test(message)?'Could not reach Firebase notifications. Check your internet connection and Firebase setup, then try again.':message||'Could not enable browser notifications.'; }
function categoryById(id) { return state.categories.find(c => c.id === id) || state.categories[0]; }
function productQuantity(id, variantId = null) { return state.cart.items.find(row => row.id === id && (row.variantId || null) === (variantId || null))?.quantity || 0; }
function productQuantityLimit(product, variant = null) { const available = variant ? (product.saleType === 'packed' ? Number(variant.stock) : Math.floor(Number(variant.stock) / Number(variant.quantityBase || 1))) : Number(product?.stock); return Math.max(0, Math.min(10, available || 0)); }
function usableVariants(product) { return (product?.variants || []).filter(row => row.isActive !== false); }
function defaultVariant(product) { return usableVariants(product).find(row => Number(row.stock) > 0) || usableVariants(product)[0] || null; }
function quantityRequestKey(id, variantId) { return `${id}\u0000${variantId || ''}`; }
function quantityRequestPending(id, variantId) { return pendingQuantityRequests.has(quantityRequestKey(id, variantId)); }
function priceMarkup(price, mrp, large = false) { const hasReference = mrp != null && Number(mrp) > Number(price); return `<span class="${large?'quantity-price-large':'product-price'}">${money(price)}</span>${hasReference?` <s class="product-mrp">${money(mrp)}</s> <span class="discount-label">${Math.round((1-Number(price)/Number(mrp))*100)}% off</span>`:''}`; }
function productImage(product, className = 'product-photo', source = null) {
  const imageSource = source || distinctProductImageSources(product)[0];
  return imageSource
    ? `<img class="${className}" src="${escapeHtml(imageSource)}" alt="${escapeHtml(product.name)}" loading="lazy"/>`
    : `<span class="${className === 'product-photo' ? 'product-emoji' : 'product-emoji-fallback'}">${escapeHtml(product?.emoji || '🛍️')}</span>`;
}
function categoryImage(category) {
  return category?.image
    ? `<img class="category-photo" src="${escapeHtml(category.image)}" alt="" loading="lazy"/>`
    : escapeHtml(category?.icon || '🛍️');
}
function productForOrderItem(item) { return state.products.find(product => product.id === item.id) || item; }
function orderItemTitle(item) { return item.variantLabel ? `${item.name} · ${item.variantLabel}` : item.name; }
function setNav() {
  document.querySelectorAll('.nav-button').forEach(button => button.classList.toggle('active', button.dataset.view === (state.view === 'order-success' || state.view === 'checkout' ? 'cart' : state.view)));
  $('#account-label').textContent = state.user ? (state.user.name.split(' ')[0] || 'Account') : 'Sign in';
  const addressName = state.activeAddress ? `${state.activeAddress.label} · ${state.activeAddress.city}` : 'Choose your location';
  $('#address-title').textContent = addressName;
  const badge = $('#cart-badge'); badge.textContent = state.cart.count; badge.classList.toggle('hidden', !state.cart.count);
  const wishlistBadge = $('#wishlist-badge'); wishlistBadge.textContent = state.wishlist.length; wishlistBadge.classList.toggle('hidden', !state.wishlist.length);
  const notificationBadge = $('#notification-badge');
  if (notificationBadge) { notificationBadge.textContent = state.notificationUnread || ''; notificationBadge.classList.toggle('hidden', !state.notificationUnread); }
  const quick = $('#quick-cart');
  const visible = state.cart.count > 0 && ['home', 'categories', 'search'].includes(state.view);
  quick.classList.toggle('visible', visible);
  quick.innerHTML = visible ? `<div><strong>${state.cart.count} item${state.cart.count === 1 ? '' : 's'} · ${money(state.cart.total)}</strong><small>Added to your cart</small></div><button data-action="cart">View cart&nbsp; →</button>` : '';
}
function render() {
  setNav();
  const main = $('#main-content');
  main.classList.toggle('is-cart', state.view === 'cart');
  if (state.view === 'home') main.innerHTML = renderHome();
  else if (state.view === 'categories') main.innerHTML = renderCategories();
  else if (state.view === 'search') main.innerHTML = renderSearch();
  else if (state.view === 'cart') main.innerHTML = renderCart();
  else if (state.view === 'wishlist') main.innerHTML = renderWishlist();
  else if (state.view === 'checkout') main.innerHTML = renderCheckout();
  else if (state.view === 'account') main.innerHTML = renderAccount();
  else if (state.view === 'orders') main.innerHTML = renderOrders();
  else if (state.view === 'notifications') main.innerHTML = renderNotifications();
  else if (state.view === 'referrals') main.innerHTML = renderReferrals();
  else if (state.view === 'reward-checkout') main.innerHTML = renderRewardCheckout();
  else if (state.view === 'order-success') main.innerHTML = renderOrderSuccess();
  else main.innerHTML = renderHome();
  renderModal();
}

function productCard(product) {
  const variant = defaultVariant(product), variantId = variant?.id || null;
  const quantity = productQuantity(product.id, variantId);
  const saved = state.wishlist.some(row => row.id === product.id);
  const category = categoryById(product.category);
  const unavailable = product.variants?.length ? !variant || productQuantityLimit(product, variant) <= 0 : Number(product.stock) <= 0;
  const pending = quantityRequestPending(product.id, variantId);
  const addControl = unavailable && !quantity ? '' : quantity
    ? `<span class="stepper"><button data-action="quantity" data-id="${escapeHtml(product.id)}" data-variant-id="${escapeHtml(variantId||'')}" data-delta="-1" aria-label="Remove one" ${pending?'disabled':''}>−</button><strong>${quantity}</strong><button data-action="quantity" data-id="${escapeHtml(product.id)}" data-variant-id="${escapeHtml(variantId||'')}" data-delta="1" aria-label="Add one" ${pending||quantity >= productQuantityLimit(product,variant) ? 'disabled' : ''}>+</button></span>`
    : `<button class="quick-add" data-action="quantity" data-id="${escapeHtml(product.id)}" data-variant-id="${escapeHtml(variantId||'')}" data-delta="1" aria-label="Add ${escapeHtml(product.name)}" ${pending?'disabled':''}>ADD</button>`;
  return `<article class="product-card">
    <div class="product-visual" style="background:${escapeHtml(product.color)}" data-action="product" data-id="${escapeHtml(product.id)}">
    ${product.badge ? `<span class="product-badge">${escapeHtml(product.badge)}</span>` : ''}${distinctProductImageSources(product).length ? productImage(product) : product.emoji ? `<span class="product-emoji">${escapeHtml(product.emoji)}</span>` : `<img class="product-fallback" src="/assets/customer/images/product-placeholder.png" alt=""/>`}${unavailable ? '<img class="sold-out-image" src="/assets/customer/images/sold-out.png" alt="Sold out"/>' : ''}<button class="favorite-button ${saved ? 'saved' : ''}" data-action="favorite" data-id="${escapeHtml(product.id)}" aria-label="${saved ? 'Remove' : 'Add'} ${escapeHtml(product.name)} ${saved ? 'from' : 'to'} wishlist" aria-pressed="${saved}">♥</button><div class="product-cart-control">${addControl}</div>
    </div>
    <div class="product-info"><small>${escapeHtml(category?.name || 'Grocery')}</small><h3>${escapeHtml(product.name)}</h3><div class="detail">${escapeHtml(variant?.label || product.detail)}</div>
      <div class="product-price-row">${priceMarkup(variant?.price ?? product.price, variant?.mrp ?? (variant ? null : product.mrp))}</div>
    </div>
  </article>`;
}
function sectionHead(title, subtitle = '', action = '') {
  return `<div class="section-head"><div><h2>${escapeHtml(title)}</h2>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}</div>${action ? `<button class="text-link" data-action="${action}">See all&nbsp; →</button>` : ''}</div>`;
}
function renderHomepageBanners() {
  return (state.homepageBanners || []).filter(row => row.enabled !== false).slice().sort((a,b)=>Number(a.order||0)-Number(b.order||0)).map(banner => {
    const image='<img src="'+escapeHtml(banner.image)+'" alt="'+escapeHtml(banner.alt||banner.title||'Homepage promotion')+'" loading="lazy"/>', action=banner.action||{type:'none'};
    if(action.type==='product'&&state.products.some(row=>row.id===action.id))return '<button type="button" class="homepage-banner-action" aria-label="'+escapeHtml(banner.title)+'" data-action="product" data-id="'+escapeHtml(action.id)+'">'+image+'</button>';
    if(action.type==='category'&&state.categories.some(row=>row.id===action.id))return '<button type="button" class="homepage-banner-action" aria-label="'+escapeHtml(banner.title)+'" data-action="category" data-id="'+escapeHtml(action.id)+'">'+image+'</button>';
    if(action.type==='page'&&['home','categories','cart','account'].includes(action.page))return '<button type="button" class="homepage-banner-action" aria-label="'+escapeHtml(banner.title)+'" data-view="'+action.page+'">'+image+'</button>';
    if(action.type==='external'){try{const url=new URL(action.url);if(url.protocol==='https:'&&!url.username&&!url.password)return '<a class="homepage-banner-action" href="'+escapeHtml(url.href)+'" target="_blank" rel="noopener noreferrer">'+image+'</a>';}catch{}}
    return '<div class="homepage-banner-action">'+image+'</div>';
  }).join('');
}
function renderHome() {
  const shelves = state.categories.filter(category => category.id !== 'all')
    .map(category => ({ category, products: state.products.filter(product => product.category === category.id).slice(0, 5) }))
    .filter(shelf => shelf.products.length);
  const coupon = state.coupons.find(item => item.code === 'DEMO50');
  const referralNote = pendingReferralCode ? `<section class="referral-invite-note ${state.referralInvite?.valid ? '' : 'invalid'}" role="status"><strong>${state.referralInvite?.valid ? 'A friend invited you to Zepto' : 'Referral link unavailable'}</strong><span>${state.referralInvite?.valid ? 'Browse first. Sign in when you’re ready to link this referral.' : 'You can continue shopping; this link can’t be applied.'}</span></section>` : '';
  return referralNote + `<section class="hero">
      <div class="hero-copy"><span class="eyebrow">Your neighbourhood, delivered</span><h1>Good things.<br/><em>Right on time.</em></h1><p>Everyday essentials, picked fresh and brought to your door.</p>
        <button class="hero-cta" data-action="browse">Start shopping&nbsp; →</button><div class="trust-row"><span><i>✓</i> Fresh picks</span><span><i>✓</i> Quick delivery</span><span><i>✓</i> Easy checkout</span></div></div>
      <div class="hero-art" aria-hidden="true"><div class="hero-orbit"></div><div class="hero-bag">${state.homepageHeroFruitImage ? `<img class="hero-fruit-image" src="${escapeHtml(state.homepageHeroFruitImage)}" alt=""/>` : '<span>🥑</span>'}<img class="hero-offer-mark" src="/assets/customer/images/offer-default.png" alt=""/></div><div class="hero-float one">Fresh picks <b>✦</b></div><div class="hero-float two">At your door&nbsp; 🚲</div></div>
    </section>
    <section class="homepage-banners" aria-label="Homepage promotions">${renderHomepageBanners()}</section>
    <section class="section">${sectionHead('Shop by category', 'Everything you need, all in one place', 'categories')}<div class="category-grid">${state.categories.filter(c => c.id !== 'all').map(c => `<button class="category-tile" data-action="category" data-id="${escapeHtml(c.id)}"><span class="category-emoji" style="background:${escapeHtml(c.color)}">${categoryImage(c)}</span><strong>${escapeHtml(c.name)}</strong></button>`).join('')}</div></section>
    ${coupon ? `<section class="section"><article class="home-coupon"><img src="/assets/customer/images/offer-default.png" alt=""/><div><small>TODAY’S OFFER</small><strong>${escapeHtml(coupon.label || 'Save on your order')}</strong><span>Use ${escapeHtml(coupon.code)} on orders over ${money(coupon.minimum)} in your cart.</span></div><button data-action="cart">View cart&nbsp; →</button></article></section>` : ''}
    ${shelves.map(({ category, products }) => `<section class="section home-shelf"><div class="section-head"><div><h2>${escapeHtml(category.name)}</h2><p>Available in your area</p></div><button class="text-link" data-action="category" data-id="${escapeHtml(category.id)}">Shop all&nbsp; →</button></div><div class="home-product-row">${products.map(productCard).join('')}</div></section>`).join('')}
    <div class="benefit-strip"><div class="benefit"><i>✦</i><div><strong>Fresh, every day</strong><small>Picked for your basket</small></div></div><div class="benefit"><i>⌖</i><div><strong>Easy address book</strong><small>Save delivery locations</small></div></div><div class="benefit"><i>▤</i><div><strong>Track your order</strong><small>See each order update</small></div></div></div>`;
}
function renderCategories() {
  const selected = categoryById(state.selectedCategory);
  const rows = state.products.filter(p => state.selectedCategory === 'all' || p.category === state.selectedCategory);
  return `<div class="page-title"><div><h1>Categories</h1><p>Browse by category</p></div></div><div class="category-layout"><aside class="category-side">${state.categories.map(c => `<button class="${c.id === state.selectedCategory ? 'active' : ''}" data-action="category" data-id="${escapeHtml(c.id)}"><span>${categoryImage(c)}</span>${escapeHtml(c.name)}</button>`).join('')}</aside><section><div class="category-main-head"><h2>${escapeHtml(selected?.name || 'All items')}</h2><span>${rows.length} items</span></div><div class="product-grid compact">${rows.length ? rows.map(productCard).join('') : emptyState('No items in this category yet', 'Try another category to keep browsing.', '🛍️')}</div></section></div>`;
}
function renderSearch() {
  const q = state.searchQuery.trim().toLowerCase();
  const rows = state.searchProducts ?? state.products.filter(p => !q || `${p.name} ${p.detail} ${categoryById(p.category)?.name || ''}`.toLowerCase().includes(q));
  return `<div class="page-title"><div><h1>${q ? `Results for “${escapeHtml(state.searchQuery)}”` : 'Search products'}</h1><p>${rows.length} items available now</p></div></div>${rows.length ? `<div class="product-grid compact">${rows.map(productCard).join('')}</div>` : emptyState('No matches found', 'Try a different product name or browse categories.', '⌕')}`;
}
function renderWishlist() {
  const items = state.wishlist;
  return `<div class="page-title"><div><h1>Wishlist</h1><p>${items.length} saved item${items.length === 1 ? '' : 's'}</p></div></div>${items.length ? `<div class="product-grid compact">${items.map(productCard).join('')}</div>` : `<div class="empty-state"><div class="empty-art">♡</div><h2>Your wishlist is empty</h2><p>Tap the heart on a product to save it here.</p><button class="primary-button" data-action="browse">Explore products&nbsp; →</button></div>`}`;
}
function emptyState(title, copy, art = '🛒') {
  return `<div class="empty-state"><div class="empty-art">${art}</div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(copy)}</p><button class="primary-button" data-action="browse">Explore products&nbsp; →</button></div>`;
}
function addressNoticeCopy(cart = state.cart) {
  if (cart.deliveryAvailable === false) return 'This saved address is outside an enabled delivery area. Select another valid address or add an address with an enabled area.';
  if (cart.minimumOrderMet === false) return `Add ${money(Math.max(0, Number(cart.minimumOrder || 0) - Number(cart.subtotal || 0)))} more to continue with delivery here.`;
  return 'Delivery is available at this address.';
}
function renderAddressNotice(addressId = state.activeAddress?.id) {
  if (!addressId) return '';
  if (state.cart.deliveryAvailable === false) return `<p class="address-service-note unavailable" role="status">${escapeHtml(addressNoticeCopy())}</p>`;
  if (state.cart.minimumOrderMet === false) return `<p class="address-service-note unavailable" role="status">${escapeHtml(addressNoticeCopy())}</p>`;
  if (state.addressNotice?.addressId === addressId) return `<p class="address-service-note available" role="status">${escapeHtml(state.addressNotice.message)}</p>`;
  return '';
}
function renderDeliveryDestination(address = state.activeAddress) {
  const title = address ? `${address.label} · ${address.line1}` : 'Select a delivery address';
  const detail = address ? [address.recipientName, address.line2, address.city].filter(Boolean).join(' · ') : 'Choose where you’d like your order delivered';
  const area = address ? (address.deliveryAreaName || (address.deliveryAreaUnavailable ? 'Area unavailable' : 'Area not selected')) : '';
  return `<section class="cart-destination"><span class="cart-destination-pin" aria-hidden="true">⌖</span><div class="cart-destination-copy"><small>DELIVER TO</small><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>${address ? `<span class="cart-delivery-area">Delivery area: ${escapeHtml(area)}</span>` : ''}</div><button type="button" data-action="address-picker">${address ? 'Change' : 'Select'}</button></section>${address ? renderAddressNotice(address.id) : ''}`;
}
function renderFreeDeliveryMessage() {
  if (state.cart.deliveryAvailable === false) return '';
  if (state.cart.freeDeliveryUnlocked) {
    const saved = Number(state.cart.freeDeliverySavings || 0);
    return `<div class="free-delivery-note unlocked"><span aria-hidden="true">✓</span><strong>Free delivery unlocked</strong>${saved > 0 ? `<small>You saved ${money(saved)} on delivery</small>` : ''}</div>`;
  }
  const remaining = state.cart.freeDeliveryRemaining;
  if (remaining == null || Number(remaining) <= 0) return '';
  const progress = Math.min(100, Math.max(0, Number(state.cart.freeDeliveryProgressPercent || 0)));
  return `<div class="free-delivery-note progress"><div><strong>${money(remaining)} away from free delivery</strong><span class="free-delivery-track"><i style="width:${progress}%"></i></span></div></div>`;
}
function renderCouponOffers() {
  const offers = state.cart.couponOffers || [];
  if (!offers.length) return '';
  return `<section class="coupon-offers"><h3>Coupons & offers</h3>${offers.map(offer => `<article class="coupon-offer ${offer.eligible ? '' : 'ineligible'}"><img src="/assets/customer/images/offer-default.png" alt=""/><div><strong>${escapeHtml(offer.label || offer.code)}</strong><small>${offer.discountType === 'percentage' ? `${Number(offer.discount)}% off` : `${money(offer.discount)} off`}${offer.maximumDiscount ? ` · up to ${money(offer.maximumDiscount)}` : ''} · min. ${money(offer.minimum)}</small>${!offer.eligible ? `<small class="offer-remaining">Add ${money(offer.remaining)} more to use</small>` : ''}</div><button type="button" data-action="apply-coupon" data-code="${escapeHtml(offer.code)}" ${!offer.eligible || state.cart.activeCoupon?.code === offer.code ? 'disabled' : ''}>${state.cart.activeCoupon?.code === offer.code ? 'Applied' : offer.eligible ? 'Apply' : 'Unavailable'}</button></article>`).join('')}</section>`;
}
function renderDeliveryLine() {
  return `<div class="bill-row"><span>Delivery</span><strong>${state.cart.deliveryAvailable === false ? 'Unavailable' : Number(state.cart.delivery || 0) === 0 ? '<span class="free-fee">FREE</span>' : money(state.cart.delivery)}</strong></div>`;
}
function renderDiscountLines() {
  return `${Number(state.cart.itemSavings || 0) > 0 ? `<div class="bill-row savings"><span>Product savings</span><strong>− ${money(state.cart.itemSavings)}</strong></div>` : ''}${Number(state.cart.discount || 0) > 0 ? `<div class="bill-row discount"><span>${escapeHtml(state.cart.activeCoupon?.label || 'Coupon discount')}</span><strong>− ${money(state.cart.discount)}</strong></div>` : ''}`;
}
function renderCart() {
  const rows = state.cart.items;
  if (!rows.length) return `<div class="page-title"><div><h1>Your cart</h1><p>Every good plan starts somewhere</p></div></div>${emptyState('Your cart is waiting', 'Add a few favourites and they’ll show up here.', '🛍️')}`;
  const rowHtml = rows.map(item => `<div class="cart-line ${item.isAvailable===false?'cart-line-unavailable':''}"><div class="cart-line-visual" style="background:${escapeHtml(item.color)}">${item.image ? productImage(item, 'cart-product-photo') : escapeHtml(item.emoji)}</div><div class="cart-line-main"><div class="cart-line-title">${escapeHtml(item.name)}</div><div class="cart-line-sub">${item.variantLabel?`${item.quantity} × ${escapeHtml(item.variantLabel)}`:escapeHtml(item.detail)}</div>${item.isAvailable===false?`<p class="cart-availability-error" role="alert">${escapeHtml(item.availabilityError||'This item is unavailable. Remove it to continue.')}</p>`:''}<div class="cart-line-pricing"><span class="cart-line-price">${priceMarkup(item.price,item.mrp)}</span><strong>${money(item.lineTotal)}</strong></div><div class="cart-line-controls"><span class="stepper" aria-label="Quantity for ${escapeHtml(item.name)}"><button aria-label="Remove one ${escapeHtml(item.name)}" data-action="quantity" data-id="${escapeHtml(item.id)}" data-variant-id="${escapeHtml(item.variantId||'')}" data-delta="-1" ${quantityRequestPending(item.id,item.variantId||null)?'disabled':''}>−</button><strong>${item.quantity}</strong><button aria-label="Add one ${escapeHtml(item.name)}" data-action="quantity" data-id="${escapeHtml(item.id)}" data-variant-id="${escapeHtml(item.variantId||'')}" data-delta="1" ${quantityRequestPending(item.id,item.variantId||null)||item.isAvailable===false||item.quantity>=(item.variantId?(item.saleType==='packed'?Number(item.variantStock):Math.floor(Number(item.variantStock)/Number(item.quantityPerUnit))):productQuantityLimit(productForOrderItem(item)))?'disabled':''}>+</button></span><button class="remove-line" data-action="remove" data-id="${escapeHtml(item.id)}" data-variant-id="${escapeHtml(item.variantId||'')}" ${quantityRequestPending(item.id,item.variantId||null)?'disabled':''}>Remove</button></div></div></div>`).join('');
  const coupon = state.activeCoupon;
  const canCheckout = !state.activeAddress || state.cart.deliveryAvailable === false || state.cart.minimumOrderMet !== false;
  const savingsNote = Number(state.cart.totalSavings || 0) > 0 ? `<p class="cart-savings-note">You’re saving ${money(state.cart.totalSavings)} on this order</p>` : '';
  return `<div class="cart-page"><div class="page-title"><div><h1>Your cart</h1><p>${state.cart.count} item${state.cart.count === 1 ? '' : 's'} in your bag</p></div></div>${renderDeliveryDestination()}<div class="cart-layout"><section class="cart-list"><div class="cart-list-head"><h2>Items in your cart</h2><button class="clear-cart" data-action="clear-cart">Clear cart</button></div>${rowHtml}<button class="continue-shopping" data-action="browse">＋ Add more items</button></section><aside class="summary-card"><h2>Bill details</h2><form id="coupon-form" class="coupon-row"><input name="code" placeholder="Enter coupon code" value="${coupon ? escapeHtml(coupon.code) : ''}" aria-label="Coupon code"/><button type="submit" ${coupon ? 'disabled' : ''}>Apply</button></form>${coupon ? `<div class="coupon-success"><img src="/assets/customer/images/offer-default.png" alt=""/> ✓ ${escapeHtml(coupon.label)} <button class="remove-line" data-action="remove-coupon">Remove</button></div>` : ''}${renderCouponOffers()}${renderFreeDeliveryMessage()}<div class="bill-row"><span>Item total</span><strong>${money(state.cart.subtotal)}</strong></div>${renderDiscountLines()}${renderDeliveryLine()}<div class="bill-row"><span>Platform fee</span><strong>${money(state.cart.platform)}</strong></div><div class="bill-divider"></div><div class="bill-row bill-total"><span>To pay</span><strong>${money(state.cart.total)}</strong></div>${savingsNote}<button class="primary-button checkout-button" data-action="checkout" ${canCheckout ? '' : 'disabled'}><span>Continue to checkout</span><span>${money(state.cart.total)}&nbsp; →</span></button><p class="fineprint">Sample prices and checkout only. No real payment will be taken.</p></aside></div><div class="cart-mobile-checkout"><div><small>${state.cart.count} item${state.cart.count === 1 ? '' : 's'} · total payable</small><strong>${money(state.cart.total)}</strong></div><button data-action="checkout" ${canCheckout ? '' : 'disabled'}>Proceed&nbsp; →</button></div></div>`;
}
function renderCheckout() {
  const rows = state.addresses;
  const selectedAddress = rows.find(address => address.id === (state.checkoutAddressId || state.activeAddress?.id)) || null;
  return `<div class="page-title"><button class="back-button" data-action="cart">‹</button><div><h1>Checkout</h1><p>Delivery and payment details</p></div></div><div class="checkout-layout"><section class="panel-card">
    <div class="checkout-section"><h2><span class="step-number">1</span> Delivery address</h2>${rows.length ? rows.map(a => `<label class="address-option ${a.id === (state.checkoutAddressId || state.activeAddress?.id) ? 'selected' : ''}"><input type="radio" name="checkout-address" value="${escapeHtml(a.id)}" ${a.id === (state.checkoutAddressId || state.activeAddress?.id) ? 'checked' : ''}/><span><strong>${escapeHtml(a.label)} · ${escapeHtml(a.deliveryAreaName || (a.deliveryAreaUnavailable ? 'Area unavailable' : 'Area not selected'))}</strong><p>${escapeHtml(a.recipientName || '')}${a.recipientName ? ' · ' : ''}${escapeHtml(a.line1)}${a.line2 ? `, ${a.line2}` : ''}, ${escapeHtml(a.city)}</p></span></label>`).join('') : `<p class="form-hint">No saved address yet. Add a delivery location to continue.</p>`}<button class="add-address-link" data-action="add-address">＋ Add a new address</button>${renderAddressNotice(selectedAddressId())}</div>
    <div class="checkout-section"><h2><span class="step-number">2</span> Payment method</h2><label class="payment-option ${state.checkoutPayment === 'cod' ? 'selected' : ''}"><input type="radio" name="payment" value="cod" ${state.checkoutPayment === 'cod' ? 'checked' : ''}/><span class="payment-brand">💵</span><span><strong>Cash on delivery</strong><p>Pay the delivery partner when your order arrives</p></span></label>${state.mode === 'production' ? '<p class="fineprint">Online payment is unavailable until merchant processing and server verification are configured.</p>' : `<label class="payment-option ${state.checkoutPayment === 'upi' ? 'selected' : ''}"><input type="radio" name="payment" value="upi" ${state.checkoutPayment === 'upi' ? 'checked' : ''}/><span class="payment-brand">↗</span><span><strong>UPI · demo payment</strong><p>Simulated confirmation. No payment app or bank is contacted.</p></span></label><p class="fineprint">Real payment integrations require merchant credentials and a payment provider.</p>`}</div>
  </section><aside class="summary-card"><h2>Order summary</h2><div class="checkout-summary-items">${state.cart.items.map(item => `<div class="mini-item checkout-mini-item"><span class="checkout-item-label">${item.image ? `<img class="checkout-item-photo" src="${escapeHtml(item.image)}" alt="" loading="lazy"/>` : `<span class="checkout-item-emoji" aria-hidden="true">${escapeHtml(item.emoji || '🛍️')}</span>`}<span class="checkout-item-name">${item.quantity} × ${escapeHtml(item.name)}</span></span><strong>${money(item.lineTotal)}</strong></div>`).join('')}</div>${renderFreeDeliveryMessage()}<div class="bill-row"><span>Items</span><strong>${money(state.cart.subtotal)}</strong></div>${renderDiscountLines()}${renderDeliveryLine()}<div class="bill-row"><span>Platform fee</span><strong>${money(state.cart.platform)}</strong></div><div class="bill-divider"></div><div class="bill-row bill-total"><span>To pay</span><strong>${money(state.cart.total)}</strong></div>${Number(state.cart.totalSavings || 0) > 0 ? `<p class="cart-savings-note">You’re saving ${money(state.cart.totalSavings)} on this order</p>` : ''}<button class="primary-button checkout-button" data-action="place-order" ${rows.length && state.cart.deliveryAvailable !== false && state.cart.minimumOrderMet !== false ? '' : 'disabled'}><span>${state.mode === 'production' ? 'Place order' : 'Place demo order'}</span><span>${money(state.cart.total)}&nbsp; →</span></button>${state.mode === 'production' ? '<p class="fineprint">Payment is due on delivery. This app is not connected to a live payment provider.</p>' : '<p class="fineprint">This creates a local demo order. It does not contact Zepto or collect payment.</p>'}</aside></div>`;
}
async function loadReferralData() {
  state.referralLoading = true;
  state.referralError = null;
  try {
    state.referralData = await api('/api/referrals/me');
    return true;
  } catch (error) {
    state.referralData = null;
    state.referralError = error.message || 'Referral details are temporarily unavailable.';
    return false;
  } finally {
    state.referralLoading = false;
  }
}
async function openReferrals() {
  if (!state.user) { openAuth(); state.returnView = 'referrals'; return; }
  state.view = 'referrals';
  state.referralData = null;
  state.referralError = null;
  state.referralLoading = true;
  render();
  await loadReferralData();
  if (state.view === 'referrals') render();
}
function referralUrl() {
  const data = state.referralData || {}, base = data.referralUrlBase;
  if (!base) return '';
  try { const url = new URL('/referral', base); url.searchParams.set('code', data.referralCode || ''); return url.toString(); } catch { return ''; }
}
function renderReferrals() {
  if (!state.user) return `<div class="page-title"><div><h1>Refer & Earn</h1><p>Invite friends and earn rewards after their qualifying delivery.</p></div></div><section class="referral-panel"><h2>Browse first, join when ready</h2><p>${pendingReferralCode && state.referralInvite?.valid ? 'Your friend’s referral is saved for this browser session. Sign in or create an account to link it.' : 'Sign in to get your own referral code and track rewards.'}</p><button class="primary-button" data-action="login">Sign in with phone</button><button class="text-link" data-action="browse">Continue shopping</button></section>`;
  const data = state.referralData;
  if (state.referralLoading) return `<div class="page-title"><button class="back-button" data-action="account">‹</button><div><h1>Refer & Earn</h1><p>Invite friends and see referral progress</p></div></div><div class="referral-panel referral-load-state" role="status" aria-live="polite"><span class="referral-loader" aria-hidden="true"></span><strong>Loading referral details…</strong></div>`;
  if (state.referralError || !data) return `<div class="page-title"><button class="back-button" data-action="account">‹</button><div><h1>Refer & Earn</h1><p>Invite friends and see referral progress</p></div></div><section class="referral-panel referral-load-state" role="alert"><h2>Referral details couldn’t be loaded</h2><p>${escapeHtml(state.referralError || 'The referral service did not return any details.')}</p><button class="primary-button" data-action="retry-referrals">Try again</button></section>`;
  const friends = data.referrals || [], rewards = data.rewards || [], invite = referralUrl();
  return `<div class="page-title"><button class="back-button" data-action="account">‹</button><div><h1>Refer & Earn</h1><p>Invite friends and see referral progress</p></div></div>${!data.campaign.enabled ? '<p class="referral-campaign-off">The referral campaign is currently paused.</p>' : ''}<section class="referral-hero"><span class="referral-spark">✦</span><small>YOUR REFERRAL CODE</small><h2>${escapeHtml(data.referralCode)}</h2><p>Friends can browse first. You earn after their first delivered order qualifies.</p><div class="referral-actions"><button class="primary-button" data-action="share-referral" ${data.campaign.enabled && invite ? '' : 'disabled'}>Share invite</button><button class="secondary-button" data-action="copy-referral" ${data.campaign.enabled && invite ? '' : 'disabled'}>Copy link</button></div><button class="referral-qr-link" data-action="show-referral-qr" ${data.campaign.enabled && invite ? '' : 'disabled'}>▦ &nbsp; View my QR code</button>${invite ? `<small class="referral-link-preview">${escapeHtml(invite)}</small>` : '<small class="fineprint">Referral sharing is unavailable until the public app URL is configured.</small>'}</section><div class="referral-stats"><article><strong>${friends.length}</strong><span>Friends invited</span></article><article><strong>${friends.filter(row => row.status === 'qualified').length}</strong><span>Qualifying deliveries</span></article><article><strong>${rewards.filter(row => ['available','redeemed'].includes(row.status)).length}</strong><span>Rewards earned</span></article></div><section class="referral-section"><div class="section-head"><div><h2>My Rewards</h2><p>Rewards unlock after a qualifying delivered order of ${money(data.campaign.minimumOrder)} or more.</p></div></div>${rewards.length ? rewards.map(reward => { const product = reward.product; return `<article class="reward-card">${product?.image ? productImage(product, 'reward-photo') : `<div class="reward-placeholder">${escapeHtml(product?.emoji || '🎁')}</div>`}<div class="reward-info"><span class="reward-status ${escapeHtml(reward.status)}">${escapeHtml(reward.status.replaceAll('_',' '))}</span>${reward.type === 'free_product' ? `<h3>${escapeHtml(product?.name || 'Free product')}</h3><p>${escapeHtml(product?.detail || product?.description || '')}</p><div><s>${money(product?.price || 0)}</s> <strong class="free-label">FREE · ₹0</strong></div>` : `<h3>Referral coupon</h3><p>Code <strong>${escapeHtml(reward.couponCode || '')}</strong> · ${money(reward.amount)} off your cart</p>`}<small>${reward.status === 'available' && reward.expiresAt ? 'Expires ' + escapeHtml(new Date(reward.expiresAt).toLocaleDateString()) : reward.status === 'redeemed' ? 'Redeemed ' + (reward.redeemedAt ? escapeHtml(new Date(reward.redeemedAt).toLocaleDateString()) : '') : 'Reward from a completed referral'}</small>${reward.redemptionHistory?.length ? `<small>Redemption history: ${reward.redemptionHistory.map(entry => `${escapeHtml(entry.orderId?.slice(-6) || 'order')} · ${escapeHtml(entry.status)}`).join(', ')}</small>` : ''}${reward.status === 'available' && reward.type === 'free_product' ? `<button class="primary-button" data-action="get-reward" data-id="${escapeHtml(reward.id)}">GET NOW</button>` : reward.status === 'available' && reward.type === 'coupon' ? `<button class="primary-button" data-action="apply-reward-coupon" data-code="${escapeHtml(reward.couponCode || '')}">Apply coupon</button>` : ''}</div></article>`; }).join('') : '<div class="referral-empty">No rewards yet. Invite a friend to get started.</div>'}</section><section class="referral-section"><div class="section-head"><div><h2>Referred friends</h2><p>See who joined and whether their qualifying order is delivered.</p></div></div>${friends.length ? friends.map(friend => `<article class="referral-friend"><span class="referral-avatar">${escapeHtml((friend.name || 'F').slice(0,1).toUpperCase())}</span><div><strong>${escapeHtml(friend.name)}</strong><small>${escapeHtml(friend.phone)} · Joined ${new Date(friend.attributedAt).toLocaleDateString()}</small>${friend.qualifyingOrder ? `<small>Order ${escapeHtml(friend.qualifyingOrder.displayId)} · ${money(friend.qualifyingOrder.subtotal)} · ${escapeHtml(friend.qualifyingOrder.status)}</small>` : '<small>Waiting for a qualifying delivered order</small>'}</div><span class="friend-status">${escapeHtml(friend.status.replaceAll('_',' '))}</span></article>`).join('') : '<div class="referral-empty">No friends have joined with your code yet.</div>'}</section>${!data.referralUrlBase && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1' ? '' : '<p class="fineprint">Local demo: configure a public HTTPS referral URL in Admin before sharing links outside this device.</p>'}`;
}
function renderRewardCheckout() {
  const quote = state.rewardQuote, addressId = state.checkoutAddressId || state.activeAddress?.id;
  if (!state.rewardCheckout) return '<div class="empty-state"><h2>Reward unavailable</h2><button class="primary-button" data-view="referrals">Back to My Rewards</button></div>';
  const reward = state.referralData?.rewards?.find(row => row.id === state.rewardCheckout), product = quote?.product || reward?.product;
  if (!product) return '<div class="empty-state"><h2>Loading reward checkout…</h2></div>';
  return `<div class="page-title"><button class="back-button" data-view="referrals">‹</button><div><h1>Reward checkout</h1><p>Your selected referral product is free</p></div></div><section class="reward-checkout-card">${product.image ? productImage(product, 'reward-checkout-photo') : `<span>${escapeHtml(product.emoji || '🎁')}</span>`}<div><small>REFERRAL REWARD</small><h2>${escapeHtml(product.name)}</h2><p>${escapeHtml(product.detail || '')}</p><s>${money(product.price)}</s> <strong class="free-label">₹0</strong></div></section><section class="checkout-section"><h2>Delivery address</h2>${state.addresses.length ? `<select id="reward-address-select" aria-label="Delivery address">${state.addresses.map(row => `<option value="${escapeHtml(row.id)}" ${row.id === addressId ? 'selected' : ''}>${escapeHtml(row.label)} · ${escapeHtml(row.line1)}, ${escapeHtml(row.city)}</option>`).join('')}</select><button class="text-link" data-action="add-address">＋ Add a new address</button>` : '<p>Add a saved address before continuing.</p><button class="secondary-button" data-action="add-address">＋ Add a new address</button>'}</section><section class="checkout-section"><h2>Payment for delivery</h2><label class="payment-option"><input type="radio" name="payment" value="cod" ${state.checkoutPayment === 'cod' ? 'checked' : ''}/><span>Cash on delivery</span></label><label class="payment-option"><input type="radio" name="payment" value="upi" ${state.checkoutPayment === 'upi' ? 'checked' : ''}/><span>UPI · simulated</span></label></section><section class="summary-card"><h2>Bill summary</h2><div class="bill-row"><span>Reward product</span><strong>₹0</strong></div><div class="bill-row"><span>Delivery</span><strong>${quote ? Number(quote.delivery) ? money(quote.delivery) : 'FREE' : 'Calculating…'}</strong></div><div class="bill-row bill-total"><span>To pay</span><strong>${money(quote?.total || 0)}</strong></div><p class="fineprint">Delivery charge is based on your selected area. The reward does not guarantee free delivery.</p><button class="primary-button" data-action="place-reward-order" data-id="${escapeHtml(state.rewardCheckout)}" ${!addressId || !quote?.available ? 'disabled' : ''}>Place reward order · ${money(quote?.total || 0)}</button></section>`;
}

function renderAccount() {
  if (!state.user) return `<div class="page-title"><div><h1>Your account</h1><p>Sign in to save addresses and view your orders</p></div></div><div class="empty-state"><div class="empty-art">♙</div><h2>Welcome to Zepto</h2><p>Sign in to save addresses, favorites, and order history.</p><button class="primary-button" data-action="login">Continue with phone&nbsp; →</button></div>`;
  const addressLabel = state.activeAddress ? `${state.activeAddress.line1}, ${state.activeAddress.city}` : 'Add a delivery address';
  return `<div class="page-title"><div><h1>Your account</h1><p>Manage your profile and recent activity</p></div></div><div class="account-layout"><section class="profile-card"><div class="profile-avatar"><img src="/assets/customer/images/user-profile.webp" alt=""/></div><h2>${escapeHtml(state.user.name)}</h2><p>${state.user.phone ? ('+91 ' + escapeHtml(state.user.phone)) : escapeHtml(state.user.email || 'Google account')}</p><div class="profile-actions"><button class="profile-action" data-action="open-orders"><span>▤</span> Your orders</button><button class="profile-action" data-action="address-picker"><span>⌖</span> Addresses</button></div></section><section class="panel-card"><h3>Account</h3><button class="account-link" data-view="notifications"><i class="bell-small"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg></i><span><strong>Notifications</strong><small>${state.notificationUnread || 0} unread order updates and offers</small></span>${state.notificationUnread ? `<b class="inline-unread">${state.notificationUnread}</b>` : ''}<em>›</em></button><button class="account-link" data-view="referrals"><i>✦</i><span><strong>Refer & Earn</strong><small>Share your code and track rewards</small></span><em>›</em></button><button class="account-link" data-view="wishlist"><i>♡</i><span><strong>Wishlist</strong><small>${state.wishlist.length} saved item${state.wishlist.length === 1 ? '' : 's'}</small></span><em>›</em></button><button class="account-link" data-action="open-orders"><i>▤</i><span><strong>Orders</strong><small>Track or review your recent orders</small></span><em>›</em></button><button class="account-link" data-action="address-picker"><i>⌖</i><span><strong>Saved addresses</strong><small>${escapeHtml(addressLabel)}</small></span><em>›</em></button><button class="account-link" data-action="wallet"><i>◈</i><span><strong>Payments & coupons</strong><small>Payment options and active offers</small></span><em>›</em></button><button class="account-link" data-action="support"><i>♡</i><span><strong>Help & support</strong><small>Support integration is not configured</small></span><em>›</em></button><button class="account-link" data-action="logout"><i>↪</i><span><strong>Sign out</strong><small>${state.mode === 'production' ? 'End this session' : 'End this local demo session'}</small></span><em>›</em></button></section></div>`;
}
function renderOrders() {
  if (!state.user) return `<div class="page-title"><div><h1>Your orders</h1><p>Order history</p></div></div><div class="empty-state"><div class="empty-art">▤</div><h2>Sign in to see orders</h2><p>Your orders are saved to this project’s server.</p><button class="primary-button" data-action="login">Sign in&nbsp; →</button></div>`;
  const orders = [...state.orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return `<div class="page-title"><button class="back-button" data-action="account">‹</button><div><h1>Your orders</h1><p>${orders.length} recent demo order${orders.length === 1 ? '' : 's'}</p></div></div>${orders.length ? `<div class="orders-list">${orders.map(order => `<article class="order-card"><div class="order-item-thumbs">${order.items.slice(0, 3).map(item => { const product = productForOrderItem(item); return product.image ? `<img src="${escapeHtml(product.image)}" alt="" loading="lazy"/>` : ''; }).join('') || '<div class="order-icon">▤</div>'}</div><div class="order-main"><strong>Order ${escapeHtml(order.displayId)}</strong><p>${order.items.length} item${order.items.length === 1 ? '' : 's'} · ${money(order.total)} · ${new Date(order.createdAt).toLocaleDateString()}</p><small>● ${escapeHtml(order.status)} · ${escapeHtml(order.deliveryArea?.name || order.address.deliveryAreaName || 'Delivery area')} · ${escapeHtml(order.eta)}</small><small>Delivery ${money(order.delivery)}</small></div><button data-action="open-order" data-id="${escapeHtml(order.id)}">Details&nbsp; →</button></article>`).join('')}</div>` : emptyState('No orders yet', 'Place a demo order and it will appear here.', '📦')}`;
}
function renderNotifications() {
  if (!state.user) return `<div class="page-title"><div><h1>Notifications</h1><p>Order and offer updates</p></div></div><div class="empty-state"><div class="empty-art">♧</div><h2>Sign in to view updates</h2><p>Your demo order updates are saved with your account.</p><button class="primary-button" data-action="login">Sign in&nbsp; →</button></div>`;
  const rows = state.notifications || [];
  const pushStatus = notificationStatusText();
  const permission = 'Notification' in window ? Notification.permission : 'unsupported';
  const unavailable = permission === 'denied' || permission === 'unsupported' || state.notificationConfig === false;
  return `<div class="page-title"><button class="back-button" data-action="account">‹</button><div><h1>Notifications</h1><p>${state.notificationUnread || 0} unread update${state.notificationUnread === 1 ? '' : 's'}</p></div>${state.notificationUnread ? '<button class="secondary-button mark-all-read" data-action="mark-notifications-read">Mark all read</button>' : ''}</div><section class="panel-card push-settings"><div><h2>Browser notifications</h2><p>Enable notifications to receive order and delivery updates on this device.</p></div><button class="primary-button" data-action="enable-push" ${unavailable ? 'disabled' : ''}>${state.notificationPushEnabled ? 'Refresh this device' : 'Enable notifications'}</button><small class="fineprint" data-push-status role="status" aria-live="polite">${escapeHtml(pushStatus)}</small></section><div data-notification-history>${rows.length ? `<div class="notification-list">${rows.map(item => `<article class="notification-card ${item.readAt ? 'read' : 'unread'}"><span class="notification-icon">${item.type === 'offer' ? '<img src="/assets/customer/images/offer-default.png" alt=""/>' : item.type === 'delivery' ? '⌖' : '▤'}</span><div class="notification-copy"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.message)}</p><small>${new Date(item.createdAt).toLocaleString()}</small></div>${!item.readAt ? `<button class="notification-mark" data-action="mark-notification-read" data-id="${escapeHtml(item.id)}" aria-label="Mark as read">●</button>` : ''}${item.orderId ? `<button class="text-link" data-action="notification-order" data-id="${escapeHtml(item.orderId)}">View order&nbsp; →</button>` : ''}</article>`).join('')}</div>` : `<div class="empty-state"><div class="empty-art">♧</div><h2>You’re all caught up</h2><p>Order updates and offers will appear here.</p></div>`}</div><p class="fineprint notification-footnote">In-app notification history remains available if browser push is unavailable.</p>`;
}

function notificationStatusText() {
  if (!('Notification' in window)) return 'Browser notifications are not supported on this device.';
  if (Notification.permission === 'denied') return 'Notifications are blocked in browser settings. Allow them there to enable delivery updates.';
  if (state.notificationConfig === false) return 'Browser notifications are waiting for Firebase configuration. In-app updates remain available.';
  if (state.notificationPushEnabled && Notification.permission === 'granted') return 'Notifications are allowed and this device is registered.';
  if (Notification.permission === 'granted') return 'Permission is allowed; this device still needs registration.';
  return 'Notifications are not enabled on this device yet.';
}

async function refreshNotificationConfig() {
  try { const config = await api('/api/notifications/config'); state.notificationConfig = Boolean(config.enabled); }
  catch { state.notificationConfig = false; }
}

function updateNotificationHistory() {
  const target = $('[data-notification-history]');
  if (!target || state.view !== 'notifications') return;
  target.innerHTML = state.notifications?.length ? `<div class="notification-list">${state.notifications.map(item => `<article class="notification-card ${item.readAt ? 'read' : 'unread'}"><span class="notification-icon">${item.type === 'offer' ? '<img src="/assets/customer/images/offer-default.png" alt=""/>' : item.type === 'delivery' ? '⌖' : '▤'}</span><div class="notification-copy"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.message)}</p><small>${new Date(item.createdAt).toLocaleString()}</small></div>${!item.readAt ? `<button class="notification-mark" data-action="mark-notification-read" data-id="${escapeHtml(item.id)}" aria-label="Mark as read">●</button>` : ''}${item.orderId ? `<button class="text-link" data-action="notification-order" data-id="${escapeHtml(item.orderId)}">View order&nbsp; →</button>` : ''}</article>`).join('')}</div>` : `<div class="empty-state"><div class="empty-art">♧</div><h2>You’re all caught up</h2><p>Order updates and offers will appear here.</p></div>`;
  const title = $('#main-content .page-title p');
  if (title) title.textContent = `${state.notificationUnread || 0} unread update${state.notificationUnread === 1 ? '' : 's'}`;
  const markAll = $('[data-action="mark-notifications-read"]');
  if (state.notificationUnread && !markAll) $('#main-content .page-title')?.insertAdjacentHTML('beforeend', '<button class="secondary-button mark-all-read" data-action="mark-notifications-read">Mark all read</button>');
  else if (!state.notificationUnread) markAll?.remove();
}
function renderOrderSuccess() {
  const order = state.activeOrder;
  if (!order) return `<div class="empty-state"><h2>Order details unavailable</h2><button class="primary-button" data-action="open-orders">View orders</button></div>`;
  return `<div class="page-title"><div><h1>Order updates</h1><p>${state.mode === 'production' ? 'Your order history' : 'Sample order history saved locally'}</p></div></div><section class="tracking-hero"><div><small>Order ${escapeHtml(order.displayId)}</small><h2>${escapeHtml(order.status)}</h2><p>${escapeHtml(order.deliveryArea?.name || 'Delivery area')} · ${escapeHtml(order.eta)}</p></div><span>🛵</span></section><div class="cart-layout"><section class="panel-card"><h2 style="font-size:14px;margin:0 0 17px">Order updates</h2><div class="timeline">${order.timeline.map((step,i) => `<div class="timeline-row ${step.complete ? 'done' : ''}"><div class="timeline-marker"><i></i>${i < order.timeline.length - 1 ? '<b></b>' : ''}</div><div class="timeline-copy"><strong>${escapeHtml(step.label)}</strong><small>${step.complete ? new Date(step.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : 'Waiting for the next update'}</small></div></div>`).join('')}</div>${order.cancellation ? `<p class="form-hint">Cancelled by ${escapeHtml(order.cancellation.actorType)} · ${escapeHtml(order.cancellation.reason)}</p>` : ''}</section><aside class="summary-card"><h2>Delivery details</h2><div class="delivery-address"><strong>${escapeHtml(order.deliveryArea?.name || order.address.deliveryAreaName || 'Delivery area')}</strong><br/>${escapeHtml(order.address.label)} · ${escapeHtml(order.address.line1)}, ${escapeHtml(order.address.city)}${order.address.pincode ? ` · ${escapeHtml(order.address.pincode)}` : ''}</div><div class="bill-divider"></div><div class="bill-row"><span>Delivery</span><strong>${money(order.delivery)}</strong></div><div class="bill-row"><span>Payment</span><strong>${escapeHtml(order.paymentStatus || order.paymentMethod)}</strong></div><div class="bill-row"><span>Total</span><strong>${money(order.total)}</strong></div>${['Order received', 'Being packed', 'Ready for pickup'].includes(order.status) && !order.riderId ? `<button class="secondary-button" style="width:100%;margin-top:12px" data-action="cancel-order" data-id="${escapeHtml(order.id)}">Cancel order</button><p class="fineprint">Cancellation is available until a rider accepts the order.</p>` : ''}<button class="secondary-button" style="width:100%;margin-top:12px" data-action="open-orders">View all orders</button></aside></div>`;
}

let modalLockState = null;
let activeModalFocusKey = null;
function syncModalPageState(open) {
  const root = $('#overlay-root');
  if (open && !modalLockState) {
    modalLockState = { scrollY: window.scrollY, focused: document.activeElement, inert: [] };
    for (const element of [document.querySelector('.app-shell'), $('#quick-cart')]) {
      if (!element) continue;
      modalLockState.inert.push({ element, inert: element.inert, ariaHidden: element.getAttribute('aria-hidden') });
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    }
    document.documentElement.classList.add('modal-open');
    document.body.classList.add('modal-open');
    requestAnimationFrame(() => root.querySelector('.dialog .close-button, .dialog input, .dialog button')?.focus({ preventScroll: true }));
    return;
  }
  if (!open && modalLockState) {
    for (const saved of modalLockState.inert) {
      saved.element.inert = saved.inert;
      if (saved.ariaHidden === null) saved.element.removeAttribute('aria-hidden'); else saved.element.setAttribute('aria-hidden', saved.ariaHidden);
    }
    const { scrollY, focused } = modalLockState;
    modalLockState = null;
    document.documentElement.classList.remove('modal-open');
    document.body.classList.remove('modal-open');
    window.scrollTo({ top: scrollY, behavior: 'instant' });
    if (focused?.isConnected && !focused.inert) requestAnimationFrame(() => focused.focus({ preventScroll: true }));
  }
}

function productDetailThumbnails(product, sources, selectedSource) {
  if (sources.length < 2) return '';
  return `<div class="detail-product-gallery" aria-label="More product images">${productDetailThumbnailButtons(product, sources, selectedSource)}</div>`;
}
function productDetailThumbnailButtons(product, sources, selectedSource) {
  return sources.filter(source => source !== selectedSource).map(source => `<button type="button" class="detail-product-thumbnail" data-action="product-image" data-id="${escapeHtml(product.id)}" data-image-src="${escapeHtml(source)}" aria-label="Show product image ${sources.indexOf(source) + 1}"><img src="${escapeHtml(source)}" alt="" loading="lazy"/></button>`).join('');
}
function productDetailVisual(product, saved) {
  const sources = distinctProductImageSources(product);
  const selectedSource = sources.includes(state.modal?.imageSrc) ? state.modal.imageSrc : sources[0];
  const image = selectedSource ? productImage(product, 'detail-product-photo', selectedSource) : escapeHtml(product.emoji || '🛒');
  return `<div class="dialog-product-visual ${sources.length > 1 ? 'has-gallery' : ''}" style="background:${escapeHtml(product.color)}">${image}${productDetailThumbnails(product, sources, selectedSource)}<button class="favorite-button detail-heart ${saved ? 'saved' : ''}" data-action="favorite" data-id="${escapeHtml(product.id)}" aria-label="${saved ? 'Remove' : 'Add'} ${escapeHtml(product.name)} ${saved ? 'from' : 'to'} wishlist" aria-pressed="${saved}">♥</button></div>`;
}
function productDetailInfo(product) {
  const choices = usableVariants(product);
  let variant = choices.find(row => row.id === state.modal?.variantId) || defaultVariant(product);
  if (variant && state.modal?.variantId !== variant.id) state.modal.variantId = variant.id;
  const configured = Boolean(product.variants?.length);
  const variantId = variant?.id || null, quantity = productQuantity(product.id, variantId);
  const price = configured ? variant?.price : product.price, mrp = configured ? variant?.mrp : product.mrp;
  const limit = productQuantityLimit(product, variant);
  const options = choices.length ? `<section class="quantity-tier-section"><div class="quantity-tier-heading"><strong>Select quantity</strong><small>Price per option</small></div><div class="quantity-tier-grid">${choices.map(row => `<button type="button" class="quantity-tier-chip ${row.id===variantId?'selected':''}" data-action="select-variant" data-id="${escapeHtml(product.id)}" data-variant-id="${escapeHtml(row.id)}" aria-pressed="${row.id===variantId}"><strong>${escapeHtml(row.label)}</strong><span>${priceMarkup(row.price,row.mrp)}</span>${row.stock<=0||row.isActive===false?'<small class="tier-stock-out">Unavailable</small>':''}</button>`).join('')}</div></section>` : configured ? '<p class="quantity-note">No quantity options are currently available.</p>' : '';
  const quantityLabel = variant ? `${variant.label} per ${product.saleType==='packed'?'pack':'portion'}` : product.detail || 'Unit';
  const pending = quantityRequestPending(product.id, variantId);
  const addDisabled = configured ? !variant || limit<=0 : Number(product.stock)<=0;
  const stepper = quantity > 0 ? `<div class="quantity-stepper-row"><span>${escapeHtml(quantityLabel)} &middot; in cart</span><span class="stepper"><button data-action="quantity" data-id="${escapeHtml(product.id)}" data-variant-id="${escapeHtml(variantId||'')}" data-delta="-1" aria-label="Remove one ${escapeHtml(quantityLabel)}" ${pending?'disabled':''}>−</button><strong>${quantity}</strong><button data-action="quantity" data-id="${escapeHtml(product.id)}" data-variant-id="${escapeHtml(variantId||'')}" data-delta="1" aria-label="Add one ${escapeHtml(quantityLabel)}" ${pending||quantity>=limit?'disabled':''}>+</button></span></div>` : '';
  const addButton = quantity > 0 ? '' : `<button class="primary-button detail-add-button" data-action="quantity" data-id="${escapeHtml(product.id)}" data-variant-id="${escapeHtml(variantId||'')}" data-delta="1" ${pending||addDisabled?'disabled':''}>Add to cart${price!=null?` &middot; ${money(price)}`:''}</button>`;
  const detailNote = variant ? product.saleType==='loose' ? `<small class="quantity-note">${variant.quantityBase} ${escapeHtml(product.measurementUnit)} per portion &middot; final measured weight may vary slightly.</small>` : `<small class="quantity-note">One selected unit is one ${escapeHtml(variant.label)} pack.</small>` : '';
  const selectedPriceMarkup = variant || !configured ? priceMarkup(price,mrp,true) : '<span class="quantity-note">Choose an available quantity option.</span>';
  return `<div class="dialog-product-info"><span class="tag">${escapeHtml(categoryById(product.category)?.name || 'Grocery')}</span><h2>${escapeHtml(product.name)}</h2><small class="detail-product-size">${escapeHtml(variant?.label || product.detail)}</small><p>${escapeHtml(product.description)}</p><div class="detail-selected-price">${selectedPriceMarkup}</div>${options}${stepper}${detailNote}${variant&&quantity>0?`<small class="quantity-cart-total">${quantity} &times; ${money(price)} = ${money(price*quantity)}</small>`:''}${addButton}</div>`;
}

function renderModal() {
  const root = $('#overlay-root');
  if (!state.modal) { root.innerHTML = ''; syncModalPageState(false); activeModalFocusKey = null; return; }
  syncModalPageState(true);
  const modal = state.modal;
  let title = '', content = '';
  if (modal.type === 'auth') {
    title = modal.step === 'register' ? 'Create your account' : 'Sign in with your phone';
    content = modal.step === 'password' ? `<p class="form-hint">Continue as <strong>+91 ${escapeHtml(modal.phone)}</strong>.</p><form id="auth-password-form" class="form-stack"><label>Password<input name="password" type="password" autocomplete="current-password" minlength="12" maxlength="128" required/></label><p id="auth-error" class="form-error" role="alert"></p><button class="primary-button" type="submit">Sign in&nbsp; →</button><button class="text-link" type="button" data-action="auth-register">Create a new account</button><button class="text-link" type="button" data-action="auth-back">Change mobile number</button></form><p class="fineprint">Older accounts without a password can use a linked Google account or set one from an existing signed-in session. Phone recovery is unavailable until an OTP provider is configured.</p>` : modal.step === 'register' ? `<p class="form-hint">Create a new account for <strong>+91 ${escapeHtml(modal.phone)}</strong>.</p><form id="auth-register-form" class="form-stack"><label>Full name<input name="name" autocomplete="name" maxlength="50" required/></label><label>Password<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required/></label><label>Confirm password<input name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required/></label><p id="auth-error" class="form-error" role="alert"></p><button class="primary-button" type="submit">Create account&nbsp; →</button><button class="text-link" type="button" data-action="auth-back-password">Back to sign in</button></form><p class="fineprint">Use at least 12 characters. Existing accounts cannot be claimed through registration.</p>` : `<p class="form-hint">Enter a mobile number to continue.</p><form id="auth-phone-form" class="form-stack"><label>Mobile number<div style="display:flex;align-items:center;gap:7px"><span class="tag">+91</span><input name="phone" type="tel" inputmode="numeric" maxlength="10" placeholder="10 digit number" required/></div></label><button class="google-signin-button" type="button" data-action="google-login"><span class="google-mark" aria-hidden="true">G</span>Continue with Google</button><p id="google-auth-error" class="form-error" role="status" aria-live="polite"></p><p id="auth-error" class="form-error"></p><button class="primary-button" type="submit">Continue&nbsp; →</button></form>`;
  } else if (modal.type === 'address') {
    title = modal.mode === 'form' ? 'Add delivery address' : 'Your delivery address';
    const list = state.addresses;
    content = modal.mode === 'form' ? `<form id="address-form" class="form-stack"><label>Save as<select name="label"><option>Home</option><option>Work</option><option>Other</option></select></label><label>Recipient name<input name="recipientName" autocomplete="name" value="${escapeHtml(state.user?.name || '')}" required/></label><label>Mobile number<input name="phone" type="tel" inputmode="numeric" autocomplete="tel" maxlength="14" value="${escapeHtml(state.user?.phone || '')}" placeholder="10 digit mobile number" required/></label><label>Flat, house or building<input name="line1" placeholder="e.g. 12 Green Park" required/></label><label>Street or locality details<input name="line2" placeholder="Optional"/></label><label>Landmark<input name="landmark" placeholder="Optional"/></label><label>City<input name="city" placeholder="e.g. Bengaluru" required/></label><label>Area *<select name="deliveryAreaId" required><option value="" selected disabled>${state.deliveryAreas.length ? 'Select an enabled area' : 'No active areas configured'}</option>${state.deliveryAreas.map(area => `<option value="${escapeHtml(area.id)}">${escapeHtml(area.name)}</option>`).join('')}</select></label>${state.deliveryAreas.length ? '' : '<p class="form-hint">Delivery areas are not configured yet. Please try again after an admin enables an area.</p>'}<p id="address-error" class="form-error"></p><button class="primary-button" type="submit" ${state.deliveryAreas.length ? '' : 'disabled'}>Save address</button></form>` : `${list.length ? list.map(a => `<label class="address-option ${a.id === state.activeAddress?.id ? 'selected' : ''}"><input type="radio" name="selected-address" value="${escapeHtml(a.id)}" ${a.id === state.activeAddress?.id ? 'checked' : ''}/><span><strong>${escapeHtml(a.label)} · ${escapeHtml(a.deliveryAreaName || (a.deliveryAreaUnavailable ? 'Area unavailable' : 'Area not selected'))}</strong><p>${escapeHtml(a.line1)}${a.line2 ? `, ${escapeHtml(a.line2)}` : ''}, ${escapeHtml(a.city)}${a.pincode ? ` · ${escapeHtml(a.pincode)}` : ''}</p></span><button class="text-link" type="button" data-action="set-address" data-id="${escapeHtml(a.id)}">Use</button></label>`).join('') : `<p class="form-hint">Save a home or work address for faster checkout.</p>`}<button class="secondary-button" style="width:100%;margin-top:8px" data-action="add-address">＋ Add a new address</button>`;
  } else if (modal.type === 'product') {
    const product = state.products.find(p => p.id === modal.id);
    if (!product) { state.modal = null; return renderModal(); }
    title = 'Product details';
    const qty = productQuantity(product.id);
    const saved = state.wishlist.some(row => row.id === product.id);
    content = `<div class="dialog-product">${productDetailVisual(product, saved)}${productDetailInfo(product)}</div>`;
  } else if (modal.type === 'order') {
    const order = state.orders.find(row => row.id === modal.id) || state.activeOrder;
    title = 'Order details';
    content = order ? `<section class="tracking-hero" style="margin-bottom:13px"><div><small>Order ${escapeHtml(order.displayId)}</small><h2>${escapeHtml(order.status)}</h2><p>${escapeHtml(order.deliveryArea?.name || 'Delivery area')} · ${escapeHtml(order.eta)}</p></div><span>🛵</span></section><div class="delivery-address"><strong>${escapeHtml(order.deliveryArea?.name || order.address.deliveryAreaName || 'Delivery area')}</strong><br/>${escapeHtml(order.address.label)} · ${escapeHtml(order.address.line1)}, ${escapeHtml(order.address.city)}${order.address.pincode ? ` · ${escapeHtml(order.address.pincode)}` : ''}</div><div class="bill-divider"></div>${order.items.map(item => { const product = productForOrderItem(item); return `<div class="mini-item order-detail-item"><span>${product.image ? `<img src="${escapeHtml(product.image)}" alt="" loading="lazy"/>` : ''}${item.quantity} &times; ${escapeHtml(orderItemTitle(item))}<small>${priceMarkup(item.price,item.mrp)} each</small></span><strong>${money(item.lineTotal)}</strong></div>`; }).join('')}<div class="bill-divider"></div><div class="bill-row"><span>Delivery charge</span><strong>${money(order.delivery)}</strong></div><div class="bill-row"><span>Payment status</span><strong>${escapeHtml(order.paymentStatus || 'Pending')}</strong></div>${(order.timeline || []).map(step => `<div class="bill-row"><span>${escapeHtml(step.label)}</span><strong>${step.complete ? '✓' : '·'}</strong></div>`).join('')}<div class="bill-divider"></div><div class="bill-row bill-total"><span>Total</span><strong>${money(order.total)}</strong></div>${order.cancellation ? `<p class="form-hint">Cancelled by ${escapeHtml(order.cancellation.actorType)} · ${escapeHtml(order.cancellation.reason)}</p>` : ['Order received', 'Being packed', 'Ready for pickup'].includes(order.status) && !order.riderId ? `<button class="secondary-button" style="width:100%;margin-top:12px" data-action="cancel-order" data-id="${escapeHtml(order.id)}">Cancel order</button><p class="fineprint">Cancellation is available until a rider accepts the order.</p>` : order.status === 'Rider assigned' || order.riderId ? '<p class="fineprint">A rider has accepted this order, so customer cancellation is no longer available.</p>' : ''}<p class="fineprint">Order updates are shared with the local Rider app. Payment services remain simulated unless a provider is configured.</p>` : `<p class="form-hint">Order details are unavailable.</p>`;
  } else if (modal.type === 'qr') {
    title = 'Your referral QR code'; content = `<div class="referral-qr-modal"><img src="/api/referrals/qr" alt="Scannable referral QR code for ${escapeHtml(modal.code)}"/><p>Friends can scan this code and browse before signing in.</p><a class="secondary-button" href="/api/referrals/qr" download="zepto-referral-qr.svg">Download QR image</a></div>`;
  } else if (modal.type === 'info') {
    title = modal.title || 'Information'; content = `<p class="form-hint">${escapeHtml(modal.message || 'This feature requires an external service that is not configured.')}</p>${modal.actionLabel ? `<button class="primary-button" style="width:100%;margin-top:15px" data-action="login">${escapeHtml(modal.actionLabel)}</button>` : ''}<button class="secondary-button" style="width:100%;margin-top:10px" data-action="close-modal">Got it</button>`;
  }
  const modalKey = [modal.type, modal.step || '', modal.mode || '', modal.id || '', title].join('|');
  const existingDialog = root.querySelector('.dialog');
  if (modalKey === activeModalFocusKey && existingDialog) {
    if (modal.type === 'product') {
      const product = state.products.find(row => row.id === modal.id);
      const info = root.querySelector('.dialog-product-info');
      if (product && info) {
        const nextInfo = productDetailInfo(product);
        if (info.innerHTML !== nextInfo) info.innerHTML = nextInfo;
      }
    }
    return;
  }
  root.innerHTML = `<div class="scrim" data-action="scrim-close"><section class="dialog ${modal.type === 'product' ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}" tabindex="-1"><header class="dialog-head"><h2>${escapeHtml(title)}</h2><button class="close-button" data-action="close-modal" aria-label="Close">×</button></header><div class="dialog-content">${content}</div></section></div>`;
  const focusKey = [modal.type, modal.step || '', modal.mode || '', modal.id || '', title].join('|');
  if (focusKey !== activeModalFocusKey) { activeModalFocusKey = focusKey; requestAnimationFrame(() => root.querySelector('.dialog .close-button')?.focus({ preventScroll: true })); }
}

function openAuth() { state.returnView = state.view; state.modal = { type: 'auth', step: 'phone' }; renderModal(); }
let googleIdentityScriptPromise;
function loadGoogleIdentityServices() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!googleIdentityScriptPromise) googleIdentityScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client'; script.async = true; script.defer = true;
    script.onload = () => window.google?.accounts?.oauth2 ? resolve() : reject(new Error('Google sign-in could not be loaded. Check your connection and try again.'));
    script.onerror = () => reject(new Error('Google sign-in could not be loaded. Check your connection and try again.'));
    document.head.append(script);
  });
  return googleIdentityScriptPromise;
}
function googleAuthMessage(message) {
  const node = $('#google-auth-error');
  if (node) node.textContent = message || '';
}
async function completeGoogleSignIn(response) {
  try {
    if (response.error) {
      googleAuthMessage(/access_denied|cancel/i.test(response.error) ? 'Sign-in cancelled. You can try again or continue with your phone.' : 'Google sign-in did not complete. Please try again.');
      return;
    }
    if (response.state !== state.googleOAuthState) throw new Error('Google sign-in could not be verified. Please try again.');
    googleAuthMessage('Verifying your Google account…');
    const result = await post('/api/auth/google/callback', {
      code: response.code,
      state: response.state,
      referralCode: pendingReferralCode || sessionStorage.getItem('zepto.pendingReferral') || ''
    }, { 'X-Requested-With': 'XMLHttpRequest' });
    state.user = result.user; state.modal = null;
    if (pendingReferralCode) { try { sessionStorage.removeItem('zepto.pendingReferral'); } catch {} pendingReferralCode = ''; }
    await bootstrap();
    state.view = state.returnView;
    if (state.view === 'orders') state.orders = (await api('/api/orders')).orders;
    if (state.view === 'referrals') await loadReferralData();
    render(); toast('You’re signed in with Google');
    if (state.view === 'checkout' && !state.addresses.length) openAddress('form');
  } catch (error) {
    googleAuthMessage(error.message || 'Google sign-in failed. Please try again.');
  } finally {
    state.googleBusy = false;
    const button = $('[data-action="google-login"]');
    if (button) { button.disabled = false; button.innerHTML = '<span class="google-mark" aria-hidden="true">G</span>Continue with Google'; }
  }
}
async function startGoogleSignIn(button) {
  if (state.googleBusy) return;
  state.googleBusy = true; button.disabled = true; button.innerHTML = '<span class="google-mark" aria-hidden="true">G</span>Connecting to Google…'; googleAuthMessage('');
  try {
    const config = await post('/api/auth/google/start');
    state.googleOAuthState = config.state;
    await loadGoogleIdentityServices();
    const client = window.google.accounts.oauth2.initCodeClient({
      client_id: config.clientId, scope: 'openid email profile', ux_mode: 'popup', state: config.state,
      callback: response => { void completeGoogleSignIn(response); },
      error_callback: error => {
        state.googleBusy = false;
        const action = error.type === 'popup_closed' ? 'Sign-in cancelled. You can try again or continue with your phone.' : 'The Google sign-in window could not be opened. Allow pop-ups and try again.';
        googleAuthMessage(action);
        const current = $('[data-action="google-login"]');
        if (current) { current.disabled = false; current.innerHTML = '<span class="google-mark" aria-hidden="true">G</span>Continue with Google'; }
      }
    });
    client.requestCode();
  } catch (error) {
    state.googleBusy = false;
    googleAuthMessage(error.message || 'Google sign-in could not start. Please try again.');
    button.disabled = false; button.innerHTML = '<span class="google-mark" aria-hidden="true">G</span>Continue with Google';
  }
}
async function refreshDeliveryAreas() {
  const result = await api('/api/delivery-areas');
  state.deliveryAreas = result.areas || [];
}
async function openAddress(mode = 'list') {
  if (!state.user) { state.returnView = state.view; state.modal = { type: 'info', title: 'Sign in to save an address', message: 'You can browse and add products without signing in. Sign in with phone and password or Google to save a delivery location and continue to checkout.', actionLabel: 'Sign in with phone' }; renderModal(); return; }
  state.modal = { type: 'address', mode }; renderModal();
  try { await refreshDeliveryAreas(); if (state.modal?.type === 'address' && state.modal.mode === 'form') updateAddressAreaOptions(); }
  catch (error) { const node = $('#address-error'); if (node) node.textContent = `Delivery areas could not be loaded: ${error.message}`; }
}
function updateAddressAreaOptions() {
  const select = $('#address-form select[name="deliveryAreaId"]');
  if (!select) return;
  const selected = select.value;
  select.replaceChildren(new Option(state.deliveryAreas.length ? 'Select an enabled area' : 'No active areas configured', '', true, !selected), ...state.deliveryAreas.map(area => new Option(area.name, area.id)));
  if (state.deliveryAreas.some(area => area.id === selected)) select.value = selected;
  const submit = $('#address-form [type="submit"]');
  if (submit) submit.disabled = state.deliveryAreas.length === 0;
}
async function refreshCart() { state.cart = await api('/api/cart'); render(); }
function syncProductQuantity(id) {
  const product = state.products.find(row => row.id === id);
  if (!product) return;
  if (state.modal?.type === 'product' && state.modal.id === id) {
    const info = $('#overlay-root .dialog-product-info');
    if (info) info.innerHTML = productDetailInfo(product);
  }
  const variant = defaultVariant(product), variantId = variant?.id || null;
  const quantity = productQuantity(id, variantId), control = document.querySelectorAll('.product-card .product-visual');
  control.forEach(visual => {
    if (visual.dataset.id !== id) return;
    const root = visual.querySelector('.product-cart-control'); if (!root) return;
    const unavailable = variant ? productQuantityLimit(product, variant) <= 0 : Number(product.stock) <= 0;
    const pending = quantityRequestPending(id, variantId);
    root.innerHTML = unavailable && !quantity ? '' : quantity
      ? `<span class="stepper"><button data-action="quantity" data-id="${escapeHtml(id)}" data-variant-id="${escapeHtml(variantId||'')}" data-delta="-1" aria-label="Remove one" ${pending?'disabled':''}>−</button><strong>${quantity}</strong><button data-action="quantity" data-id="${escapeHtml(id)}" data-variant-id="${escapeHtml(variantId||'')}" data-delta="1" aria-label="Add one" ${pending||quantity >= productQuantityLimit(product,variant) ? 'disabled' : ''}>+</button></span>`
      : `<button class="quick-add" data-action="quantity" data-id="${escapeHtml(id)}" data-variant-id="${escapeHtml(variantId||'')}" data-delta="1" aria-label="Add ${escapeHtml(product.name)}" ${pending?'disabled':''}>ADD</button>`;
  });
}
async function changeQuantity(id, delta, variantId = null) {
  const requestKey = quantityRequestKey(id, variantId);
  if (pendingQuantityRequests.has(requestKey)) return;
  pendingQuantityRequests.add(requestKey);
  try {
    if (state.modal?.type === 'product' || ['home', 'categories', 'search'].includes(state.view)) syncProductQuantity(id);
    else if (state.view === 'cart') render();
    state.cart = await post('/api/cart/items', { productId: id, variantId, delta: Number(delta) }); state.activeCoupon = state.cart.activeCoupon;
    setNav();
  }
  catch (error) { toast(error.message); }
  finally {
    pendingQuantityRequests.delete(requestKey);
    try {
      if (state.modal?.type === 'product' || ['home', 'categories', 'search'].includes(state.view)) syncProductQuantity(id);
      if (state.view === 'cart') render();
    } catch (error) { toast(error.message); }
  }
}
async function toggleWishlist(id) {
  try {
    const result = await post('/api/wishlist/toggle', { productId: id });
    state.wishlist = result.items;
    const saved = state.wishlist.some(row => row.id === id);
    document.querySelectorAll('[data-action="favorite"]').forEach(button => {
      if (button.dataset.id !== id) return;
      button.classList.toggle('saved', saved);
      button.setAttribute('aria-pressed', String(saved));
      button.setAttribute('aria-label', `${saved ? 'Remove' : 'Add'} ${state.products.find(row => row.id === id)?.name || 'product'} ${saved ? 'from' : 'to'} wishlist`);
    });
    setNav();
    toast(result.added ? 'Added to wishlist' : 'Removed from wishlist');
  }
  catch (error) { toast(error.message); }
}
function setView(view) {
  state.view = view;
  state.modal = null;
  if (view === 'account' && !state.user) { render(); return; }
  render(); window.scrollTo({ top: 0, behavior: 'smooth' });
}
function selectedAddressId() { return $('input[name="checkout-address"]:checked')?.value || state.checkoutAddressId || state.activeAddress?.id; }
async function placeOrder() {
  if (state.placingOrder) return;
  if (!state.user) { openAuth(); return; }
  if (!state.addresses.length) { openAddress('form'); return; }
  const addressId = selectedAddressId();
  const signature = JSON.stringify([state.user.id, state.cart.items.map(item => [item.id, item.quantity]), addressId, state.cart.deliveryArea?.id || state.selectedDeliveryAreaId, state.checkoutPayment, state.cart.activeCoupon?.code || null]);
  if (state.checkoutRequest?.signature !== signature) {
    const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    state.checkoutRequest = { signature, key: random };
  }
  state.placingOrder = true;
  try {
    const response = await post('/api/orders', { addressId, paymentMethod: state.checkoutPayment, idempotencyKey: state.checkoutRequest.key });
    state.activeOrder = response.order; state.orders.unshift(response.order); state.cart = await api('/api/cart'); state.view = 'order-success'; state.modal = null; render(); window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) { toast(error.message); await bootstrap(); if (state.view === 'checkout') render(); }
  finally { state.placingOrder = false; }
}
async function openOrderDetails(id) {
  try {
    const { order } = await api(`/api/orders/${encodeURIComponent(id)}`);
    state.orders = [order, ...state.orders.filter(row => row.id !== order.id)];
    if (state.activeOrder?.id === order.id) state.activeOrder = order;
    state.modal = { type: 'order', id: order.id }; renderModal();
  } catch (error) { toast(error.message); }
}
async function cancelCustomerOrder(id) {
  if (!confirm('Cancel this order? This is available only until a rider accepts it.')) return;
  try {
    const { order } = await post(`/api/orders/${encodeURIComponent(id)}/cancel`, {});
    state.orders = [order, ...state.orders.filter(row => row.id !== order.id)];
    if (state.activeOrder?.id === order.id) state.activeOrder = order;
    state.modal = { type: 'order', id: order.id }; renderModal();
    toast('Order cancelled');
  } catch (error) {
    await openOrderDetails(id);
    toast(error.message);
  }
}

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action],[data-view]'); if (!button) return;
  if (button.dataset.view) {
    if (button.matches('a')) event.preventDefault();
    if (button.dataset.view === 'home') { history.replaceState(null, '', '/'); return setView('home'); }
    if (button.dataset.view === 'referrals') return openReferrals();
    if (button.dataset.view === 'notifications' && state.user) { try { const n=await api('/api/notifications');state.notifications=n.notifications;state.notificationUnread=n.unread;state.notificationPushEnabled=localStorage.getItem('zepto.push.enabled.customer')==='1'; } catch(error) { toast(error.message); } }
    setView(button.dataset.view); return;
  }
  const action = button.dataset.action;
  if (action === 'scrim-close' && event.target === button) { state.modal = null; return renderModal(); }
  if (action === 'close-modal') { state.modal = null; return renderModal(); }
  if (action === 'retry-bootstrap') {
    button.disabled = true;
    button.textContent = 'Retrying…';
    try { await bootstrap(); }
    catch (error) { renderBootstrapError(error); }
    return;
  }
  if (action === 'google-login') return startGoogleSignIn(button);
  if (action === 'auth-back') { state.modal = { type: 'auth', step: 'phone' }; return renderModal(); }
  if (action === 'auth-register') { state.modal.step = 'register'; return renderModal(); }
  if (action === 'auth-back-password') { state.modal.step = 'password'; return renderModal(); }
  if (action === 'browse') { state.selectedCategory = 'all'; return setView('categories'); }
  if (action === 'categories') return setView('categories');
  if (action === 'cart') return setView('cart');
  if (action === 'account') return setView('account');
  if (action === 'open-referrals') return openReferrals();
  if (action === 'retry-referrals') { state.referralLoading = true; state.referralError = null; render(); await loadReferralData(); if (state.view === 'referrals') render(); return; }
  if (action === 'share-referral' || action === 'copy-referral' || action === 'show-referral-qr') { const link = referralUrl(); if (!link) { toast('Referral sharing is unavailable until the public app URL is configured.'); return; } if (action === 'show-referral-qr') { state.modal = { type: 'qr', code: state.referralData?.referralCode }; return renderModal(); } if (action === 'share-referral' && navigator.share) { try { await navigator.share({ title: 'Join me on Puraina Mart', text: 'Shop with my referral link', url: link }); } catch (error) { if (error.name !== 'AbortError') toast('Sharing was unavailable. Copy the invite link instead.'); } return; } try { await navigator.clipboard.writeText(link); toast('Referral link copied'); } catch { toast(link); } return; }
  if (action === 'get-reward') { state.rewardCheckout = button.dataset.id; state.view = 'reward-checkout'; state.checkoutAddressId = state.activeAddress?.id || state.addresses[0]?.id || null; try { state.rewardQuote = state.checkoutAddressId ? await api('/api/rewards/' + encodeURIComponent(button.dataset.id) + '/quote?addressId=' + encodeURIComponent(state.checkoutAddressId)) : null; } catch (error) { state.rewardQuote = null; toast(error.message); } return render(); }
  if (action === 'place-reward-order') { const rewardId = button.dataset.id; try { const response = await post('/api/rewards/' + encodeURIComponent(rewardId) + '/redeem', { addressId: state.checkoutAddressId || state.activeAddress?.id, deliveryAreaId: state.rewardQuote?.area?.id, paymentMethod: state.checkoutPayment }); state.activeOrder = response.order; state.orders.unshift(response.order); state.view = 'order-success'; await loadReferralData(); render(); toast('Reward order placed'); } catch (error) { toast(error.message); try { await loadReferralData(); } catch {} render(); } return; }
  if (action === 'apply-reward-coupon') { try { await post('/api/coupons/apply', { code: button.dataset.code }); state.cart = await api('/api/cart'); state.activeCoupon = state.cart.activeCoupon; setView('cart'); toast('Referral coupon applied'); } catch (error) { toast(error.message); } return; }
  if (action === 'open-orders') { if (!state.user) { state.returnView = 'orders'; state.modal = { type: 'auth', step: 'phone' }; return renderModal(); } try { state.orders = (await api('/api/orders')).orders; } catch {} return setView('orders'); }
  if (action === 'open-notifications') { if (!state.user) { state.returnView = 'notifications'; state.modal = { type: 'auth', step: 'phone' }; return renderModal(); } try { const result = await api('/api/notifications'); state.notifications = result.notifications; state.notificationUnread = result.unread; state.notificationPushEnabled=localStorage.getItem('zepto.push.enabled.customer')==='1'; } catch (error) { toast(error.message); } return setView('notifications'); }
  if (action === 'enable-push') { button.disabled = true; button.textContent = 'Enabling…'; try { await import('/push-client.js').then(push=>push.enableWebPush('customer')); state.notificationPushEnabled=true; localStorage.setItem('zepto.push.enabled.customer','1'); updateNotificationPushStatus(); toast('This browser is registered for notifications'); } catch(error) { toast(pushErrorMessage(error)); updateNotificationPushStatus(); } finally { if (button.isConnected) button.disabled = false; } return; }
  if (action === 'mark-notification-read') { try { await post(`/api/notifications/${encodeURIComponent(button.dataset.id)}/read`); const result = await api('/api/notifications'); state.notifications = result.notifications; state.notificationUnread = result.unread; updateNotificationHistory(); setNav(); } catch (error) { toast(error.message); } return; }
  if (action === 'mark-notifications-read') { try { await post('/api/notifications/read-all'); const result = await api('/api/notifications'); state.notifications = result.notifications; state.notificationUnread = result.unread; updateNotificationHistory(); setNav(); } catch (error) { toast(error.message); } return; }
  if (action === 'notification-order') { try { const { order } = await api(`/api/orders/${encodeURIComponent(button.dataset.id)}`); state.orders = [order, ...state.orders.filter(row => row.id !== order.id)]; state.modal = { type: 'order', id: order.id }; renderModal(); } catch (error) { toast(error.message); } return; }
  if (action === 'category') { state.selectedCategory = button.dataset.id; return setView('categories'); }
  if (action === 'product') { const product=state.products.find(row=>row.id===button.dataset.id);state.modal={type:'product',id:button.dataset.id,variantId:defaultVariant(product)?.id||null};return renderModal(); }
  if (action === 'product-image') {
    const product = state.products.find(row => row.id === button.dataset.id), source = button.dataset.imageSrc;
    if (state.modal?.type === 'product' && state.modal.id === button.dataset.id && product && distinctProductImageSources(product).includes(source)) {
      state.modal.imageSrc = source;
      const image = $('#overlay-root .detail-product-photo'); if (image) image.src = source;
      const gallery = $('#overlay-root .detail-product-gallery'); if (gallery) gallery.innerHTML = productDetailThumbnailButtons(product, distinctProductImageSources(product), source);
    }
    return;
  }
  if (action === 'select-variant') { if(state.modal?.type==='product'&&state.modal.id===button.dataset.id){state.modal.variantId=button.dataset.variantId;const product=state.products.find(row=>row.id===button.dataset.id),info=$('#overlay-root .dialog-product-info');if(product&&info)info.innerHTML=productDetailInfo(product);}return; }
  if (action === 'favorite') return toggleWishlist(button.dataset.id);
  if (action === 'quantity') return changeQuantity(button.dataset.id, button.dataset.delta, button.dataset.variantId||null);
  if (action === 'remove') { const variantId=button.dataset.variantId||null;return changeQuantity(button.dataset.id,-productQuantity(button.dataset.id,variantId),variantId); }
  if (action === 'clear-cart') { try { state.cart = await api('/api/cart', { method: 'DELETE' }); state.activeCoupon = null; render(); toast('Cart cleared'); } catch (error) { toast(error.message); } return; }
  if (action === 'remove-coupon') { try { state.cart = await api('/api/coupons', { method: 'DELETE' }); state.activeCoupon = state.cart.activeCoupon; render(); toast('Coupon cleared'); } catch (error) { toast(error.message); } return; }
  if (action === 'apply-coupon') { try { const result = await post('/api/coupons/apply', { code: button.dataset.code }); state.cart = result.cart; state.activeCoupon = result.cart.activeCoupon || result.coupon; render(); toast('Coupon applied'); } catch (error) { toast(error.message); } return; }
  if (action === 'checkout') { if (!state.user) { state.returnView = 'checkout'; state.modal = { type: 'auth', step: 'phone' }; renderModal(); return; } state.view = 'checkout'; try { await refreshDeliveryAreas(); } catch (error) { toast(`Delivery areas could not be refreshed: ${error.message}`); } if (!state.addresses.length) { render(); openAddress('form'); return; } return render(); }
  if (action === 'place-order') return placeOrder();
  if (action === 'address-picker') return openAddress('list');
  if (action === 'add-address') return openAddress('form');
  if (action === 'set-address') {
    try { const data = await api(`/api/addresses/${encodeURIComponent(button.dataset.id)}/default`, { method: 'PATCH' }); state.addresses = data.addresses; state.activeAddress = data.activeAddress || state.addresses.find(row => row.isDefault); state.cart = data.cart; state.addressNotice = { addressId: button.dataset.id, message: addressNoticeCopy(data.cart) }; state.modal = null; await bootstrap(); toast(data.cart.deliveryAvailable === false ? 'This address is outside the delivery area' : 'Delivery address updated'); render(); }
    catch (error) { toast(error.message); await bootstrap(); }
    return;
  }
  if (action === 'login') return openAuth();
  if (action === 'logout') { try { await import('/push-client.js').then(push=>push.deactivateWebPush('customer')); } catch {} await post('/api/auth/logout', {}); state.user = null; state.addresses = []; state.activeAddress = null; state.orders = []; state.notifications = []; state.notificationUnread = 0; state.cart = null; state.wishlist = []; state.coupons = []; state.activeCoupon = null; state.referralData = null; state.activeOrder = null; state.checkoutAddressId = null; state.addressNotice = null; state.rewardCheckout = null; state.rewardQuote = null; state.selectedDeliveryAreaId = null; state.view = 'home'; await bootstrap(); toast('Signed out'); return; }
  if (action === 'open-order') return openOrderDetails(button.dataset.id);
  if (action === 'cancel-order') return cancelCustomerOrder(button.dataset.id);
  if (action === 'wallet') {
    const offers = state.coupons.length ? state.coupons.map(item => `${escapeHtml(item.code)} · ${escapeHtml(item.label || 'Offer')}`).join('\n') : 'No active coupons are configured.';
    const paymentCopy = state.mode === 'production' ? 'Cash on delivery is available. Online payment is not configured.' : 'Cash on delivery and simulated UPI are available in this local environment.';
    state.modal = { type: 'info', title: 'Payments & coupons', message: `${paymentCopy}\n\n${offers}\n\nWallet balances and payment services are not connected.` };
    return renderModal();
  }
  if (action === 'support') { state.modal = { type: 'info', title: 'Help & support', message: 'Support contact details have not been configured. Orders, addresses and cart updates are handled by this application.' }; return renderModal(); }
});

document.addEventListener('change', async event => {
  if (event.target.name === 'payment') { state.checkoutPayment = event.target.value; render(); }
  if (event.target.name === 'checkout-address') {
    state.checkoutAddressId = event.target.value;
    try { const result = await api(`/api/addresses/${encodeURIComponent(state.checkoutAddressId)}/default`, { method: 'PATCH' }); state.addresses = result.addresses; state.activeAddress = result.activeAddress || state.addresses.find(row => row.isDefault); state.cart = result.cart; state.addressNotice = { addressId: state.checkoutAddressId, message: addressNoticeCopy(result.cart) }; await bootstrap(); state.checkoutAddressId = event.target.value; }
    catch (error) { toast(error.message); }
    render();
  }
  if (event.target.id === 'reward-address-select') { state.checkoutAddressId = event.target.value; try { state.rewardQuote = await api('/api/rewards/' + encodeURIComponent(state.rewardCheckout) + '/quote?addressId=' + encodeURIComponent(state.checkoutAddressId)); } catch (error) { state.rewardQuote = null; toast(error.message); } render(); }
});

function updateNotificationPushStatus() {
  const status = $('[data-push-status]');
  if (status) status.textContent = notificationStatusText();
  const button = $('[data-action="enable-push"]');
  if (button) {
    const permission = 'Notification' in window ? Notification.permission : 'unsupported';
    button.disabled = permission === 'denied' || permission === 'unsupported' || state.notificationConfig === false;
    button.textContent = state.notificationPushEnabled ? 'Refresh this device' : 'Enable notifications';
  }
}
window.addEventListener('zepto:push-registered',()=>{state.notificationPushEnabled=true;try{localStorage.setItem('zepto.push.enabled.customer','1');}catch{}updateNotificationPushStatus();});
window.addEventListener('zepto:push-error',event=>toast(pushErrorMessage(new Error(event.detail||'Could not register this browser for notifications'))));
window.addEventListener('zepto:push-message',async()=>{if(!state.user)return;try{const data=await api('/api/notifications');state.notifications=data.notifications;state.notificationUnread=data.unread;if(state.view==='notifications')updateNotificationHistory();else setNav();}catch{}});

document.addEventListener('submit', async event => {
  event.preventDefault();
  if (event.target.id === 'auth-phone-form') {
    const phone = new FormData(event.target).get('phone');
    const normalized = String(phone || '').replace(/\D/g, '').slice(-10);
    if (!/^\d{10}$/.test(normalized)) { $('#auth-error').textContent = 'Enter a valid 10 digit mobile number.'; return; }
    state.modal = { type: 'auth', step: 'password', phone: normalized }; renderModal();
  }
  if (event.target.id === 'auth-password-form' || event.target.id === 'auth-register-form') {
    const values = Object.fromEntries(new FormData(event.target).entries());
    const isRegistration = event.target.id === 'auth-register-form';
    if (isRegistration && values.password !== values.confirmPassword) { $('#auth-error').textContent = 'Passwords do not match.'; return; }
    const form = event.target;
    const submitButton = form.querySelector('button[type="submit"]');
    const originalLabel = submitButton?.textContent || (isRegistration ? 'Create account' : 'Sign in');
    if (submitButton) { submitButton.disabled = true; submitButton.textContent = isRegistration ? 'Creating account…' : 'Signing in…'; }
    const endpoint = isRegistration ? '/api/auth/register' : '/api/auth/password/login';
    let authRequestSucceeded = false;
    try {
      const result = await post(endpoint, { ...values, phone: state.modal.phone, referralCode: pendingReferralCode || sessionStorage.getItem('zepto.pendingReferral') || '' });
      authRequestSucceeded = true;
      state.user = result.user; state.modal = null;
      const referralStatus = result.referral?.status;
      if (pendingReferralCode) { try { sessionStorage.removeItem('zepto.pendingReferral'); } catch {} pendingReferralCode = ''; }
      await bootstrap(); state.view = state.returnView;
      if (state.view === 'orders') state.orders = (await api('/api/orders')).orders;
      if (state.view === 'referrals') await loadReferralData();
      if (state.view === 'notifications') { const n=await api('/api/notifications');state.notifications=n.notifications;state.notificationUnread=n.unread; }
      render(); toast(referralStatus === 'linked' ? 'Your friend’s referral was linked' : referralStatus === 'invalid_code' ? 'That referral link is invalid' : 'You’re signed in');
      if (state.view === 'checkout' && !state.addresses.length) openAddress('form');
    } catch (error) {
      const authError = $('#auth-error');
      if (authError) authError.textContent = error.message;
      else if (authRequestSucceeded) renderBootstrapError(error);
      else toast(error.message);
    } finally {
      if (submitButton?.isConnected) { submitButton.disabled = false; submitButton.textContent = originalLabel; }
    }
  }
  if (event.target.id === 'address-form') {
    const body = Object.fromEntries(new FormData(event.target).entries());
    try { const result = await post('/api/addresses', body); state.addresses = result.addresses; state.activeAddress = result.address; state.cart = result.cart; state.addressNotice = { addressId: result.address.id, message: addressNoticeCopy(result.cart) }; state.modal = null; await bootstrap(); if (state.view === 'checkout') { state.checkoutAddressId = result.address.id; state.view = 'checkout'; } if (state.view === 'reward-checkout') { state.checkoutAddressId = result.address.id; try { state.rewardQuote = await api('/api/rewards/' + encodeURIComponent(state.rewardCheckout) + '/quote?addressId=' + encodeURIComponent(result.address.id)); } catch (error) { state.rewardQuote = null; toast(error.message); } } render(); toast('Address saved'); }
    catch (error) { $('#address-error').textContent = error.message; }
  }
  if (event.target.id === 'coupon-form') {
    const code = new FormData(event.target).get('code');
    try { const result = await post('/api/coupons/apply', { code }); state.cart = result.cart; state.activeCoupon = result.cart.activeCoupon || result.coupon; render(); toast('Coupon applied'); }
    catch (error) { toast(error.message); }
  }
});

let searchTimer;
let searchSequence = 0;
$('#global-search').addEventListener('input', event => {
  const requestSequence = ++searchSequence;
  state.searchQuery = event.target.value;
  state.searchProducts = null;
  state.view = 'search'; render();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    try { const result = await api(`/api/products?q=${encodeURIComponent(state.searchQuery)}`); if (requestSequence !== searchSequence) return; state.searchProducts = result.products; render(); }
    catch {}
  }, 120);
});
$('#global-search').addEventListener('keydown', event => { if (event.key === 'Escape') { searchSequence++; clearTimeout(searchTimer); event.target.value = ''; state.searchQuery = ''; state.searchProducts = null; setView('home'); } });
window.addEventListener('hashchange',()=>{handleNotificationHash(false).catch(()=>{});});
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !state.modal) { event.preventDefault(); $('#global-search').focus(); } if (!state.modal) return; if (event.key === 'Escape') { event.preventDefault(); state.modal = null; renderModal(); return; } if (event.key === 'Tab') { const dialog = $('#overlay-root .dialog'); const focusable = [...(dialog?.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]') || [])].filter(el => el.getClientRects().length); if (!focusable.length) { event.preventDefault(); dialog?.focus(); return; } const first = focusable[0], last = focusable[focusable.length - 1]; if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } } });

bootstrap().catch(renderBootstrapError);
window.setInterval(async () => {
  if (!state.user || !['orders', 'order-success'].includes(state.view)) return;
  try {
    const nextOrders = (await api('/api/orders')).orders;
    const activeId = state.activeOrder?.id;
    const previousStatuses = state.orders.map(order => `${order.id}:${order.status}`).join('|');
    const previousActiveStatus = state.activeOrder?.status;
    state.orders = nextOrders;
    if (activeId) state.activeOrder = nextOrders.find(order => order.id === activeId) || state.activeOrder;
    const nextStatuses = nextOrders.map(order => `${order.id}:${order.status}`).join('|');
    if (nextStatuses !== previousStatuses || state.activeOrder?.status !== previousActiveStatus) render();
  } catch {}
}, 5000);
window.setInterval(async () => {
  if (!state.user) return;
  try {
    const result = await api('/api/notifications');
    const previousUnread = state.notificationUnread;
    const changed = result.unread !== previousUnread || (state.view === 'notifications' && JSON.stringify(result.notifications) !== JSON.stringify(state.notifications));
    state.notifications = result.notifications;
    state.notificationUnread = result.unread;
    setNav();
    if (changed && state.view === 'notifications') updateNotificationHistory();
    else if (changed && state.view === 'account') {
      const unread = $('#main-content .account-link[data-view="notifications"] small');
      if (unread) unread.textContent = `${state.notificationUnread || 0} unread order updates and offers`;
    }
  } catch {}
}, 7000);

refreshNotificationConfig().then(updateNotificationPushStatus);
