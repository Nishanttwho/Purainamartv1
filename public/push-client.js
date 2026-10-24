import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js';
import { getMessaging, isSupported, onMessage, onRegistered, register } from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-messaging.js';

let appPromise;
const firebaseConfig = async () => {
  const response = await fetch('/api/notifications/config', { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error('Browser push is not configured for this site.');
  const value = await response.json();
  if (!value.enabled) throw new Error('Browser push is not configured for this site yet.');
  return value;
};
async function client() {
  if (!('serviceWorker' in navigator) || !('Notification' in window) || !await isSupported()) throw new Error('This browser does not support web push notifications.');
  const config = await firebaseConfig();
  if (!appPromise) appPromise = Promise.resolve(initializeApp(config.firebase));
  const app = await appPromise;
  const messaging = getMessaging(app);
  const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' });
  return { config, messaging, registration };
}
function deviceKey() {
  let value = localStorage.getItem('zepto.push.device');
  if (!value) { value = crypto.randomUUID(); localStorage.setItem('zepto.push.device', value); }
  return value;
}
async function registerFid(ownerType, messaging, registration, vapidKey) {
  const key = deviceKey();
  let settleInitial;
  let initialSettled = false;
  let initialError = null;
  const initialRegistration = new Promise(resolve => { settleInitial = resolve; });
  const onFid = onRegistered(messaging, async fid => {
    try {
      const response = await fetch(`/api/${ownerType === 'customer' ? 'notifications' : ownerType === 'rider' ? 'rider/notifications' : 'admin/notifications'}/devices`, {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fid, deviceKey: key, platform: 'web', metadata: { userAgent: navigator.userAgent.slice(0, 240), language: navigator.language.slice(0, 20) } })
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Could not save this browser registration.');
      if (!initialSettled) { initialSettled = true; settleInitial(); }
      window.dispatchEvent(new CustomEvent('zepto:push-registered'));
    } catch (error) { if (!initialSettled) { initialSettled = true; initialError = error; settleInitial(); } window.dispatchEvent(new CustomEvent('zepto:push-error', { detail: error.message })); }
  });
  let timeout;
  try {
    await register(messaging, { vapidKey, serviceWorkerRegistration: registration });
    await Promise.race([initialRegistration, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Firebase did not finish registering this browser. Check your network and VAPID configuration, then try again.')), 10000); })]);
    if (initialError) throw initialError;
  } finally { clearTimeout(timeout); }
  return onFid;
}
const listeners = new Set();
export async function enableWebPush(ownerType = 'customer') {
  if (!['customer','rider','admin'].includes(ownerType)) throw new Error('Invalid notification account type.');
  const service = await client();
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Notifications are blocked in browser settings. Enable them there to continue.' : 'Notification permission was not granted.');
  await registerFid(ownerType, service.messaging, service.registration, service.config.vapidKey);
  const subscriptionKey = `${ownerType}:${location.origin}`;
  if (!listeners.has(subscriptionKey)) {
    onMessage(service.messaging, payload => window.dispatchEvent(new CustomEvent('zepto:push-message', { detail: payload })));
    listeners.add(subscriptionKey);
  }
  localStorage.setItem(`zepto.push.enabled.${ownerType}`, '1');
  return true;
}
export async function syncGrantedWebPush(ownerType = 'customer') {
  if (!('Notification' in window) || Notification.permission !== 'granted' || localStorage.getItem(`zepto.push.enabled.${ownerType}`) !== '1') return false;
  const service = await client();
  await registerFid(ownerType, service.messaging, service.registration, service.config.vapidKey);
  return true;
}
export async function deactivateWebPush(ownerType = 'customer') {
  const key = localStorage.getItem('zepto.push.device');
  if (key) await fetch(`/api/${ownerType === 'customer' ? 'notifications' : ownerType === 'rider' ? 'rider/notifications' : 'admin/notifications'}/devices/deactivate`, {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceKey: key })
  }).catch(() => {});
  localStorage.removeItem(`zepto.push.enabled.${ownerType}`);
}
