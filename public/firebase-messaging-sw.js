/* Handle clicks before Firebase installs its own notification listeners. */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const allowed = new Set(['/', '/#home', '/#orders', '/#notifications', '/#referrals', '/rider']);
  const candidate = event.notification.data?.destination;
  const destination = allowed.has(candidate) || /^\/rider\?order=[A-Za-z0-9_-]{1,100}$/.test(candidate || '') ? candidate : '/';
  event.waitUntil((async () => {
    const target = new URL(destination, self.location.origin).href;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) if (new URL(client.url).origin === self.location.origin) { await client.navigate(target); return client.focus(); }
    return self.clients.openWindow(target);
  })());
});

importScripts('https://www.gstatic.com/firebasejs/13.0.0/firebase-app-compat.js');
importScripts('/api/notifications/firebase-config.js');
if (self.ZEPTO_FCM_CONFIG?.messagingSenderId) {
  firebase.initializeApp(self.ZEPTO_FCM_CONFIG);
  firebase.messaging();
}
