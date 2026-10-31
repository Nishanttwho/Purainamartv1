import { orderStatus } from './order-status.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = value => `₹${Number(value || 0).toLocaleString('en-IN')}`;
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Time not recorded';
export function riderOrderView(order, rider) {
  const status = orderStatus(order), address = order.address || {};
  const assigned = order.assignedToRiderId === rider.id;
  const available = !order.assignedToRiderId && status === 'New';
  const cash = order.paymentMethod === 'Cash on delivery';
  const collected = order.paymentCollection;
  const paid = cash ? collected?.method === 'cash' && collected.collectedAt && collected.riderId === rider.id && collected.amount === order.total : order.paymentVerification?.status === 'verified' && order.paymentVerification.transactionReference;
  const bill = (label, value) => `<div class="profile-line"><span>${label}</span><strong>${value}</strong></div>`;
  const action = (id, label, css = 'primary', disabled = false) => `<button class="rider-button ${css}" data-action="${id}" data-id="${esc(order.id)}" ${disabled ? 'disabled' : ''}>${label}</button>`;
  return `<div class="order-detail-layout"><section>
    <article class="rider-panel"><h2>Customer & delivery</h2><div class="rider-address"><strong>${esc(order.customerContact?.name || address.recipientName || 'Customer')}</strong>
    ${order.customerContact?.phone || address.phone ? `<a href="tel:${esc(order.customerContact?.phone || address.phone)}">${esc(order.customerContact?.phone || address.phone)}</a>` : '<small>Phone unavailable</small>'}
    <p>${[address.line1,address.line2,address.landmark,address.city,address.state,address.pincode || address.postalCode].filter(Boolean).map(esc).join(', ')}</p>
    <small>${esc(order.deliveryArea?.name || address.deliveryAreaName || 'Delivery area unavailable')}</small></div>
    ${order.deliveryInstructions ? `<p><strong>Instructions</strong><br>${esc(order.deliveryInstructions)}</p>` : ''}</article>
    <article class="rider-panel"><h2>Order items</h2>${(order.items || []).map(item => `<div class="rider-item"><span><b>${esc(item.name)}</b><small>${item.saleType === 'loose' ? 'Loose' : 'Packed'} · ${esc(item.variantLabel || item.detail || '')}${item.totalBaseQuantity ? ` · ${item.totalBaseQuantity} ${esc(item.measurementUnit || item.unit || '')} total` : ''}</small><small>${money(item.price)} × ${item.quantity}</small></span><strong>${money(item.lineTotal)}</strong></div>`).join('')}</article>
    <article class="rider-panel"><h2>Bill summary</h2>${bill('Subtotal',money(order.subtotal))}${bill('Delivery',money(order.delivery))}${bill('Platform fee',money(order.platform))}${bill(`Discount${order.couponCode ? ' · '+esc(order.couponCode) : ''}`,'−'+money(order.discount))}${bill('Total',money(order.total))}</article>
    <article class="rider-panel"><h2>Payment</h2>${bill('Method',esc(order.paymentMethod))}${bill('Status',esc(order.paymentStatus || 'Pending'))}
    ${collected?.collectedAt ? `<p class="order-alert">Cash received: ${money(collected.amount)}<br>${date(collected.collectedAt)}</p>` : assigned && cash && status === 'Out for Delivery' ? `<label class="cash-amount">Cash received (₹)<input data-cash-amount type="number" inputmode="decimal" min="0" step="0.01" autocomplete="off" placeholder="Enter amount received"></label><p>Amount due: ${money(order.total)}. Confirm only after receiving the cash.</p>${action('collect-cash','Confirm cash received')}` : ''}
    ${order.paymentVerification ? bill('Payment verification',esc(order.paymentVerification.status)+' · '+esc(order.paymentVerification.transactionReference || '')) : ''}
    ${order.paymentReconciliation ? `<p class="order-alert">${esc(order.paymentReconciliation.reason)}</p>` : ''}</article>
  </section><aside><article class="rider-panel"><h2>Delivery progress</h2><ol class="step-list">${(order.timeline || []).map((step,index)=>`<li class="${step.complete?'done':''}"><b>${step.complete?'✓':index+1}</b><span>${esc(step.label)}<small>${step.complete?date(step.at):'Awaiting update'}</small>${step.reason?`<small>${esc(step.reason)}</small>`:''}</span></li>`).join('')}</ol>
  <div class="delivery-actions">${available ? action('accept-order','Accept Order','lime',rider.status!=='online')+action('reject-order','Reject Order','outline') : assigned && status === 'Accepted' ? action('out_for_delivery','Start Delivery','lime') : assigned && status === 'Out for Delivery' ? action('delivered',paid?'Mark Delivered':'Confirm payment before delivery','primary',!paid) : ''}
  ${assigned && ['Accepted','Out for Delivery'].includes(status) && !collected?.collectedAt ? action('cancel-delivery','Release delivery','danger')+'<small>Releases your assignment so another rider can accept. The customer order stays open.</small>' : ''}</div>
  ${order.cancellation ? `<p class="order-alert">Cancelled: ${esc(order.cancellation.reason)}<br>${date(order.cancellation.at)}</p>` : status==='Delivered' ? '<p class="order-alert">Delivery completed.</p>' : ''}
  ${order.inventoryReconciliationRequired ? '<p class="order-alert">This delivery was released after delivery started. Check the item handoff with the store.</p>' : ''}
  ${order.status !== status ? `<p class="fineprint">Historical status: ${esc(order.status)}</p>` : ''}
  </article></aside></div>`;
}
