import { orderStatus } from './order-status.js';
import { riderOrderView } from './rider-order-view.js';
import { createApiClient } from './api-client.js';
const state = {
  authLoading: true, page: 0, view: 'home', rider: null, availableOrders: [], assignedOrders: [], deliveredOrders: [],
  deliverySummary: { completedDeliveries: 0, codCollected: 0, month: new Date().toISOString().slice(0,7), monthCompletedDeliveries: 0, monthCodCollected: 0, date: new Date().toISOString().slice(0,10), today: new Date().toISOString().slice(0,10), dailyCompletedDeliveries: 0, dailyCodCollected: 0 },
  authStep: 'login', selectedOrder: null,
  orderTab: 'available', busy: false, notifications: [], notificationUnread: 0, pushEnabled: false, deepLinkHandled: false
};

const $ = (selector, root = document) => root.querySelector(selector);
const money = value => `₹${Number(value || 0).toLocaleString('en-IN')}`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const icon = (name, size = 20) => {
  const paths = {
    profile: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.2 3.2-5 7-5s6.2 1.8 7 5"/>',
    pin: '<path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
    box: '<path d="m3 7 9-4 9 4-9 4-9-4Z"/><path d="M3 7v10l9 4 9-4V7M12 11v10"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
  };
  return `<svg class="rider-inline-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.box}</svg>`;
};

const api = createApiClient(request);
async function request(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.body ? {'content-type':'application/json'} : {}), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || 'Could not complete the request'); error.status = response.status; throw error; }
  return data;
}
const post = (url, body = {}) => api(url, { method: 'POST', body: JSON.stringify(body) });
const pushErrorMessage = error => error instanceof TypeError || /failed to fetch|dynamically imported module|networkerror/i.test(String(error?.message||'')) ? 'Could not reach Firebase notifications. Check your internet connection and Firebase setup, then try again.' : error?.message || 'Could not enable browser alerts.';

function toast(message) {
  const node = $('#rider-toast'); node.textContent = message; node.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove('show'), 2600);
}

let loadPending, loadSequence = 0;
function load(quiet = false, month = state.deliverySummary?.month, date = state.deliverySummary?.date) {
  const page = state.page, key = JSON.stringify([page, month, date]);
  if (loadPending?.key === key) return loadPending.promise;
  const sequence = ++loadSequence;
  const promise = loadPage(quiet, month, date, page, sequence).finally(() => {
    if (loadPending?.promise === promise) loadPending = null;
  });
  loadPending = { key, promise };
  return promise;
}
async function loadPage(quiet, month, date, page, sequence) {
  try {
    const query=new URLSearchParams({limit:"24",offset:String(page*24)});if(month)query.set('month',month);if(date)query.set('date',date);
    const data = await api(`/api/rider/bootstrap${query.size ? `?${query}` : ''}`);
    if (sequence !== loadSequence) return;
    const previous = JSON.stringify([state.rider?.status, state.availableOrders.map(o => o.id), state.assignedOrders.map(o => `${o.id}:${o.status}`), state.deliveredOrders.map(o => o.id)]);
    Object.assign(state, data); state.authLoading=false;
    state.rider = data.rider;
    if (state.rider?.mustChangePassword) {
      state.availableOrders=[]; state.assignedOrders=[]; state.deliveredOrders=[]; state.selectedOrder=null;
      render(); return;
    }
    if (state.rider && /^\/staff\/rider\/login\/?$/.test(location.pathname)) history.replaceState(null, '', '/rider' + location.search + location.hash);
    if(state.rider && localStorage.getItem('zepto.push.enabled.rider')==='1') import('/push-client.js').then(push=>push.syncGrantedWebPush('rider')).catch(()=>{});
    state.pushEnabled=localStorage.getItem('zepto.push.enabled.rider')==='1';
    if (state.selectedOrder?.id) {
      const fresh = [...data.assignedOrders, ...data.deliveredOrders].find(order => order.id === state.selectedOrder.id);
      if (fresh) state.selectedOrder = fresh;
      else {
        try { state.selectedOrder = (await api(`/api/rider/orders/${encodeURIComponent(state.selectedOrder.id)}`)).order; }
        catch { state.selectedOrder = null; }
      }
    }
    if (sequence !== loadSequence) return;
    const next = JSON.stringify([state.rider?.status, state.availableOrders.map(o => o.id), state.assignedOrders.map(o => `${o.id}:${o.status}`), state.deliveredOrders.map(o => o.id)]);
    if (!quiet || previous !== next || JSON.stringify(data.deliverySummary)!==loadPage.lastSummary) render();
    loadPage.lastSummary=JSON.stringify(data.deliverySummary);
    const deepOrderId=new URLSearchParams(location.search).get('order');
    if(deepOrderId&&state.rider&&!state.rider.mustChangePassword&&!state.deepLinkHandled){state.deepLinkHandled=true;try{const result=await api(`/api/rider/orders/${encodeURIComponent(deepOrderId)}`);state.selectedOrder=result.order;state.view='detail';render();}catch{toast('This delivery is no longer available to this rider.');}}
    if (quiet && previous !== next) toast('Deliveries updated');
  } catch (error) {
    if (sequence !== loadSequence) return;
    state.authLoading=false;
    if (error.status === 401) { state.rider = null; render(); }
    else if (!quiet) toast(error.message);
  }
}

function renderNav() {
  const nav = $('#rider-nav');
  if (!state.rider) { nav.innerHTML = ''; return; }
  const current = state.view === 'detail' ? 'orders' : state.view;
  nav.innerHTML = [
    ['home',current === 'home' ? '/assets/rider/feed_active.png' : '/assets/rider/feed_inactive.png','Home'], ['orders','/assets/rider/new_task_active.png','Orders'], ['earnings','/assets/rider/bar_chart_active.png','Summary'], ['profile',null,'Profile']
  ].map(([id, src, label]) => `<button class="${current === id ? 'active' : ''}" data-view="${id}">${src ? `<img src="${src}" alt="" />` : icon('profile',19)}<span>${label}</span></button>`).join('');
}

function render() {
  const main = $('#rider-main');
  const header = $('#header-status');
  header.innerHTML = state.rider ? `Rider mode <strong>· ${state.rider.status === 'online' ? 'ONLINE' : 'OFFLINE'}</strong>` : 'Rider access';
  renderNav();
  if (!state.rider) { main.innerHTML = state.authLoading ? '<p role="status">Restoring your session…</p>' : renderAuth(); return; }
  if (state.rider.mustChangePassword) { main.innerHTML = renderPasswordChange(); return; }
  if (state.view === 'home') main.innerHTML = renderHome();
  else if (state.view === 'orders') main.innerHTML = renderOrders();
  else if (state.view === 'detail') main.innerHTML = renderDetail();
  else if (state.view === 'earnings') main.innerHTML = renderEarnings();
  else if (state.view === 'profile') main.innerHTML = renderProfile();
  else main.innerHTML = renderHome();
  if (['orders','earnings'].includes(state.view)) main.insertAdjacentHTML('beforeend', `<nav aria-label="Order pages"><button data-action="previous-page" ${state.page===0?'disabled':''}>Previous</button><span> Page ${state.page+1} </span><button data-action="next-page" ${Math.max(state.availableOrders.length,state.assignedOrders.length,state.deliveredOrders.length)<24?'disabled':''}>Next</button></nav>`);
}

function renderAuth() {
  return `<div class="auth-wrap"><section class="auth-card"><div class="auth-brand"><img src="/assets/puraina-mart-logo.png" alt="Puraina Mart logo" /><span>DELIVERY PARTNER</span></div><h1>Rider sign in</h1><p>Use the mobile number and password issued by an administrator.</p><form id="rider-login-form"><label>Mobile number<input name="phone" type="tel" inputmode="numeric" maxlength="10" autocomplete="username" required /></label><label>Password<input name="password" type="password" autocomplete="current-password" minlength="12" required /></label><p id="rider-auth-error" class="auth-error" role="alert"></p><button class="rider-button primary" type="submit" style="width:100%">Sign in&nbsp; →</button></form><p class="auth-note">If you lost access, contact an administrator to reset your password. OTP delivery is not configured.</p><p class="fineprint" style="margin-top:15px">Rider access is separate from customer sign-in. <a href="/" style="color:#6131a0;font-weight:800">Open customer app</a></p></section></div>`;
}

function renderPasswordChange() {
  return `<div class="auth-wrap"><section class="auth-card"><div class="auth-brand"><img src="/assets/puraina-mart-logo.png" alt="Puraina Mart logo" /><span>DELIVERY PARTNER</span></div><h1>Set a new password</h1><p>Your administrator issued a temporary credential. Change it before opening rider operations.</p><form id="rider-password-form"><label>New password<input name="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required /></label><label>Confirm new password<input name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required /></label><p id="rider-auth-error" class="auth-error" role="alert"></p><button class="rider-button primary" type="submit" style="width:100%">Save new password</button><button class="rider-button outline" type="button" data-action="logout" style="width:100%;margin-top:8px">Sign out</button></form></section></div>`;
}

const refreshAction = `<button class="rider-button outline" data-action="refresh">${icon('refresh',15)} Refresh</button>`;
const ordersAction = `<button class="rider-button outline" data-view="orders">${icon('back',15)} Deliveries</button>`;

function renderPageHead(title, subtitle, action = '') {
  return `<div class="rider-page-head"><div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>${action}</div>`;
}
function renderOrderCard(order, mode = 'available') {
  const assigned = mode === 'active';
  const delivered = mode === 'delivered';
  const review = mode === 'available';
  return `<article class="rider-card ${review ? 'reviewable-order' : ''}"><div class="delivery-card-top"><strong>Delivery ${esc(order.displayId)}</strong><span class="status-pill ${delivered ? '' : assigned ? 'amber' : 'green'}">${esc(orderStatus(order))}</span></div><p>${order.itemCount} item${order.itemCount === 1 ? '' : 's'} · ${esc(order.deliveryArea?.name || order.city)}${order.amountToCollect ? ` · Collect ${money(order.amountToCollect)}` : ''}</p><div class="card-actions">${review ? `<button class="rider-button lime" data-action="open-order" data-id="${esc(order.id)}">Review order</button>` : `<button class="rider-button outline" data-action="open-order" data-id="${esc(order.id)}">Details</button>`}</div></article>`;
}
function empty(title, copy, illustration = 'box') {
  return `<div class="empty-rider"><div class="empty-icon">${icon(illustration,31)}</div><h3>${esc(title)}</h3><p>${esc(copy)}</p></div>`;
}

function renderHome() {
  const active = state.assignedOrders[0];
  return `${renderPageHead(`Hi, ${state.rider.name.split(' ')[0]}`, 'New orders and your deliveries', refreshAction)}<section class="status-hero"><div><small>Delivery availability</small><h2>${state.rider.status === 'online' ? 'You are online' : 'You are offline'}</h2><p>${state.rider.status === 'online' ? 'New customer orders appear here automatically.' : 'Go online when you are ready to accept orders.'}</p></div><button class="switch-button ${state.rider.status === 'offline' ? 'offline' : ''}" data-action="toggle-status">${state.rider.status === 'online' ? 'Go offline' : 'Go online'}</button></section><section class="rider-metrics"><div class="metric-card"><small>New Orders</small><strong>${state.availableOrders.length}</strong></div><div class="metric-card"><small>Active deliveries</small><strong>${state.assignedOrders.length}</strong></div><div class="metric-card"><small>Completed deliveries</small><strong>${state.deliverySummary.completedDeliveries}</strong></div><div class="metric-card"><small>COD collected</small><strong>${money(state.deliverySummary.codCollected)}</strong></div></section>${active ? `<div class="rider-section-head"><h2>Your active delivery</h2><span>Continue your accepted delivery</span></div><div class="rider-grid">${renderOrderCard(active,'active')}</div>` : ''}<div class="rider-section-head"><h2>New Orders</h2><span>Shared customer orders</span></div>${state.availableOrders.length ? `<div class="rider-grid">${state.availableOrders.slice(0,4).map(order => renderOrderCard(order)).join('')}</div>` : empty('No deliveries waiting', state.rider.status === 'online' ? 'New customer orders will appear here automatically.' : 'Go online when you are ready to accept a delivery.', 'pin')}<p class="fineprint" style="margin-top:15px">Accept an order to reserve it. Other riders will no longer see it in New Orders.</p>`;
}

function renderOrders() {
  const rows = ({ available: state.availableOrders, active: state.assignedOrders, delivered: state.deliveredOrders })[state.orderTab] || [];
  const mine = state.orderTab !== 'available';
  return renderPageHead('Orders', 'Accept a new order or continue your deliveries', refreshAction) +
    '<div class="rider-tabs"><button data-tab="available" class="'+(!mine?'active':'')+'">New Orders</button><button data-tab="active" class="'+(mine?'active':'')+'">My Deliveries</button></div>' +
    (mine ? '<div class="rider-tabs delivery-history-tabs"><button data-tab="active" class="'+(state.orderTab==='active'?'active':'')+'">Active</button><button data-tab="delivered" class="'+(state.orderTab==='delivered'?'active':'')+'">Completed</button></div>' : '') +
    (rows.length ? '<div class="rider-grid">'+rows.map(order=>renderOrderCard(order,state.orderTab)).join('')+'</div>' : empty(mine?'No deliveries here':'No new orders', mine?'Your accepted deliveries appear here.':'New orders appear automatically while you are online.'));
}

function renderDetail() {
  const order = state.selectedOrder;
  if (!order) return renderPageHead('Delivery details', 'This delivery is no longer available', ordersAction) + empty('Delivery unavailable', 'Refresh New Orders or My Deliveries to continue.');
  return renderPageHead('Order ' + order.displayId, orderStatus(order), ordersAction) + riderOrderView(order, state.rider);
}

function renderEarnings() {
  const summary=state.deliverySummary||{};
  const month=summary.month||new Date().toISOString().slice(0,7);
  const date=summary.date||new Date().toISOString().slice(0,10),today=summary.today||new Date().toISOString().slice(0,10);
  return `${renderPageHead('Delivery summary','Completed deliveries and verified COD collections')}<section class="earnings-hero"><small>ALL-TIME DELIVERY SUMMARY</small><strong>${summary.completedDeliveries||0} completed</strong><p>COD collected: ${money(summary.codCollected||0)} - order funds, separate from Rider wages.</p></section><section class="rider-panel"><h2>Date-wise delivery history</h2><div class="summary-date-controls"><label class="field">Select date<input type="date" data-summary-date value="${esc(date)}" max="${esc(today)}"></label><button class="rider-button outline" data-summary-day="yesterday">Yesterday</button><button class="rider-button outline" data-summary-day="today">Today</button></div><section class="rider-metrics"><div class="metric-card"><small>Completed deliveries (${esc(date)})</small><strong>${summary.dailyCompletedDeliveries||0}</strong></div><div class="metric-card"><small>COD collected (${esc(date)})</small><strong>${money(summary.dailyCodCollected||0)}</strong></div></section><p class="fineprint">Only completed orders are counted. COD collected is order money, separate from Rider salary or wages.</p></section><section class="rider-panel"><h2>Monthly summary</h2><label class="field">Select month<input type="month" data-summary-month value="${esc(month)}"></label><section class="rider-metrics"><div class="metric-card"><small>Completed deliveries (${esc(month)})</small><strong>${summary.monthCompletedDeliveries||0}</strong></div><div class="metric-card"><small>COD collected (${esc(month)})</small><strong>${money(summary.monthCodCollected||0)}</strong></div></section><p class="fineprint">Monthly totals use each order's delivery completion date and verified cash collection record.</p></section><div class="rider-section-head"><h2>Recent completed deliveries</h2></div>${state.deliveredOrders.length ? `<div class="rider-grid">${state.deliveredOrders.map(order => renderOrderCard(order,'delivered')).join('')}</div>` : empty('No completed deliveries yet','Completed deliveries appear here when available.')}`;
}

function renderProfile() {
  const notifications=state.notifications||[];
  return `${renderPageHead('Rider profile','Account and availability')}<div class="profile-grid"><section class="rider-panel"><h2>Account details</h2><div class="profile-line"><span>Name</span><strong>${esc(state.rider.name)}</strong></div><div class="profile-line"><span>Mobile</span><strong>+91 ${esc(state.rider.phone)}</strong></div><div class="profile-line"><span>Vehicle</span><strong>${esc(state.rider.vehicle)}</strong></div><div class="profile-line"><span>Availability</span><strong>${state.rider.status === 'online' ? 'Online' : 'Offline'}</strong></div></section><section class="rider-panel"><h2>Delivery alerts</h2><p style="font-size:11px;line-height:1.6;color:#716c79">In-app alerts are saved to your rider account. Browser push needs notification permission and Firebase configuration.</p><button class="rider-button primary" data-action="enable-push">${state.pushEnabled?'Refresh this device':'Enable browser alerts'}</button><h3 style="margin-top:17px">Recent alerts${state.notificationUnread?` · ${state.notificationUnread} unread`:''}</h3>${notifications.length?notifications.slice(0,8).map(n=>`<article class="rider-alert-item ${n.readAt?'':'unread'}"><strong>${esc(n.title)}</strong><p>${esc(n.message)}</p><small>${new Date(n.createdAt).toLocaleString()}</small>${!n.readAt?`<button class="rider-button outline" data-action="read-notification" data-id="${esc(n.id)}">Mark read</button>`:''}</article>`).join(''):'<p class="fineprint">No alerts yet. New order and delivery updates will appear here.</p>'}</section><section class="rider-panel"><h2>Service configuration</h2><p style="font-size:11px;line-height:1.6;color:#716c79">Rider sign-in uses an Admin-issued password. Profile documents, bank details, identity verification, support, GPS, and payout services are not configured.</p><a class="rider-button outline" href="/" style="display:block;text-decoration:none;text-align:center">Open customer app</a><button class="rider-button danger" style="width:100%;margin-top:9px" data-action="logout">Sign out</button></section></div>`;
}

async function openOrder(id) {
  try { const data = await api(`/api/rider/orders/${encodeURIComponent(id)}`); state.selectedOrder = data.order; state.view = 'detail'; render(); window.scrollTo({top:0,behavior:'smooth'}); }
  catch (error) { toast(error.message); await load(); }
}
async function acceptOrder(id) {
  try { const result = await post(`/api/rider/orders/${encodeURIComponent(id)}/accept`); state.selectedOrder = result.order; state.view = 'detail'; await load(); state.selectedOrder = state.assignedOrders.find(order => order.id === id) || result.order; render(); }
  catch (error) { toast(error.message); await load(); }
}
async function updateOrder(action, id) {
  try { const result = await post(`/api/rider/orders/${encodeURIComponent(id)}`, { action }); state.selectedOrder = result.order; if (action === 'delivered') { state.orderTab = 'delivered'; state.view = 'orders'; toast('Delivery marked complete'); } await load(); if (action !== 'delivered') { state.selectedOrder = state.assignedOrders.find(order => order.id === id) || result.order; state.view = 'detail'; render(); } }
  catch (error) { toast(error.message); await load(); }
}
async function rejectOrder(id) {
  if (!confirm('Reject this delivery? It will leave your available list.')) return;
  const reason = prompt('Why are you rejecting this delivery?'); if (reason === null) return;
  try { await post(`/api/rider/orders/${encodeURIComponent(id)}/reject`, { reason }); state.selectedOrder=null; state.view='orders'; state.orderTab='available'; await load(); toast('Delivery rejected; the order remains available to other riders'); }
  catch (error) { toast(error.message); await load(); }
}
async function cancelDelivery(id) {
  const reason = prompt('Reason for releasing this delivery (required):'); if (reason === null) return;
  try { await post(`/api/rider/orders/${encodeURIComponent(id)}/release`, { reason }); state.view = 'orders'; await load(); toast('Delivery released. The customer order remains open.'); }
  catch (error) { toast(error.message); await load(); }
}
async function collectCash(id) {
  const entered = document.querySelector('[data-cash-amount]')?.value;
  const amount = Number(entered);
  if (!entered || !Number.isFinite(amount) || amount !== state.selectedOrder?.total) { toast('Enter the exact amount of cash received.'); return; }
  if (!confirm('Confirm that you physically received ₹' + amount + ' from the customer?')) return;
  try { const result = await post(`/api/rider/orders/${encodeURIComponent(id)}/payment`, { method: 'cash', confirmed: true, amount }); state.selectedOrder = result.order; await load(); state.selectedOrder = state.assignedOrders.find(order => order.id === id) || result.order; state.view = 'detail'; render(); toast('Cash collection recorded'); }
  catch (error) { toast(error.message); await load(); }
}

document.addEventListener('click', async event => {
  const target = event.target.closest('[data-action],[data-view],[data-tab],[data-summary-day]'); if (!target || target.disabled) return;
  if (target.dataset.view) { state.view = target.dataset.view; render(); window.scrollTo({top:0,behavior:'smooth'}); return; }
  if (target.dataset.tab) { state.orderTab = target.dataset.tab; render(); return; }
  if (target.dataset.summaryDay) { const base=state.deliverySummary.today||new Date().toISOString().slice(0,10),day=new Date(`${base}T00:00:00.000Z`);if(target.dataset.summaryDay==='yesterday')day.setUTCDate(day.getUTCDate()-1);return load(false,state.deliverySummary.month,day.toISOString().slice(0,10)); }
  const action = target.dataset.action;
  if (action === 'previous-page' || action === 'next-page') { state.page=Math.max(0,state.page+(action==='next-page'?1:-1));return load(); }
  if (action === 'change-number') { state.authStep = 'phone'; state.challengeId = null; return render(); }
  if (action === 'refresh') return load();
  if (action === 'open-order') return openOrder(target.dataset.id);
  if (action === 'accept-order') return acceptOrder(target.dataset.id);
  if (action === 'reject-order') return rejectOrder(target.dataset.id);
  if (action === 'cancel-delivery') return cancelDelivery(target.dataset.id);
  if (action === 'collect-cash') return collectCash(target.dataset.id);
  if (['out_for_delivery','delivered'].includes(action)) return updateOrder(action,target.dataset.id);
  if (action === 'toggle-status') {
    try { const data = await post('/api/rider/status',{status:state.rider.status === 'online' ? 'offline' : 'online'}); state.rider=data.rider; await load(); toast(`You are ${state.rider.status}`); }
    catch (error) { toast(error.message); }
    return;
  }
  if (action === 'enable-push') { try { await import('/push-client.js').then(push=>push.enableWebPush('rider'));state.pushEnabled=true;render();toast('This browser is registered for rider alerts'); } catch(error) { toast(pushErrorMessage(error)); } return; }
  if (action === 'read-notification') { try { await post(`/api/rider/notifications/${encodeURIComponent(target.dataset.id)}/read`);await load(); } catch(error) { toast(error.message); } return; }
  if (action === 'logout') {
    await post('/api/rider/auth/logout',{deviceKey:localStorage.getItem('zepto.push.device')||''}); api.clear();
    loadSequence++; loadPending = null;
    state.rider=null; state.availableOrders=[]; state.assignedOrders=[]; state.deliveredOrders=[]; state.selectedOrder=null; state.view='home'; state.authStep='phone'; render(); return;
  }
});

document.addEventListener('change',event=>{
  const month=event.target.closest('[data-summary-month]');
  if(month&&/^\d{4}-(0[1-9]|1[0-2])$/.test(month.value)) load(false,month.value,state.deliverySummary.date);
  const date=event.target.closest('[data-summary-date]');
  if(date&&/^\d{4}-\d{2}-\d{2}$/.test(date.value)&&date.value<=(state.deliverySummary.today||new Date().toISOString().slice(0,10))) load(false,state.deliverySummary.month,date.value);
});

document.addEventListener('submit', async event => {
  if (event.target.id === 'rider-login-form') {
    event.preventDefault(); const body=Object.fromEntries(new FormData(event.target).entries());
    try { const data=await post('/api/rider/auth/login',body); state.rider=data.rider; state.view='home'; await load(); if (!state.rider?.mustChangePassword) toast(`Welcome, ${state.rider.name.split(' ')[0]}`); }
    catch (error) { const el=$('#rider-auth-error'); if(el) el.textContent=error.message; }
  }
  if (event.target.id === 'rider-password-form') {
    event.preventDefault(); const body=Object.fromEntries(new FormData(event.target).entries());
    if (body.newPassword !== body.confirmPassword) { $('#rider-auth-error').textContent='Passwords do not match.'; return; }
    try { const data=await post('/api/rider/auth/password',body); state.rider=data.rider; await load(); toast('Password changed'); }
    catch (error) { const el=$('#rider-auth-error'); if(el) el.textContent=error.message; }
  }
});

window.setInterval(() => { if(state.rider && !document.hidden && !state.busy && !document.querySelector('[data-cash-amount]:focus')) load(true); }, 15000);
window.addEventListener('zepto:push-registered',()=>{if(!state.rider)return;state.pushEnabled=true;render();toast('Browser alerts enabled');});
window.addEventListener('zepto:push-error',event=>toast(pushErrorMessage(new Error(event.detail||'Could not register this browser for alerts'))));
window.addEventListener('zepto:push-message',async()=>{if(!state.rider)return;try{await load(true);toast('New delivery alert');}catch{}});
(async () => { await load(); })();
