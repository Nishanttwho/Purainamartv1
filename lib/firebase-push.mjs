import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

const webKeys = ['FCM_WEB_API_KEY','FCM_WEB_AUTH_DOMAIN','FCM_WEB_PROJECT_ID','FCM_WEB_MESSAGING_SENDER_ID','FCM_WEB_APP_ID','FCM_WEB_VAPID_KEY'];
export function publicWebMessagingConfig(env = process.env) {
  const configured = webKeys.every(key => Boolean(String(env[key] || '').trim()));
  return {
    enabled: configured,
    vapidKey: configured ? env.FCM_WEB_VAPID_KEY : null,
    firebase: configured ? {
      apiKey: env.FCM_WEB_API_KEY,
      authDomain: env.FCM_WEB_AUTH_DOMAIN,
      projectId: env.FCM_WEB_PROJECT_ID,
      messagingSenderId: env.FCM_WEB_MESSAGING_SENDER_ID,
      appId: env.FCM_WEB_APP_ID
    } : null
  };
}

let messaging = null;
let initError = null;
export function firebaseMessaging(env = process.env) {
  if (messaging || initError) return messaging;
  const projectId = String(env.FCM_PROJECT_ID || '').trim();
  if (!projectId) { initError = 'missing_project_id'; return null; }
  try {
    const existing = getApps().find(app => app.name === 'zepto-fcm');
    const app = existing || initializeApp({ credential: applicationDefault(), projectId }, 'zepto-fcm');
    messaging = getMessaging(app);
    return messaging;
  } catch {
    initError = 'credentials_unavailable';
    return null;
  }
}

export function firebaseMessagingStatus(env = process.env) {
  const config = publicWebMessagingConfig(env);
  // ADC credential validity is only established by an actual send. Do not report
  // constructing the lazy Admin SDK client as proof that credentials work.
  return { webConfigured: config.enabled, serverConfigured: Boolean(String(env.FCM_PROJECT_ID || '').trim()), credentialsMode: env.GOOGLE_APPLICATION_CREDENTIALS ? 'explicit_adc_path' : 'application_default_credentials' };
}

export async function sendFirebaseInstallationMessage(fid, { title, body, destination = '/', notificationId, eventId }, env = process.env) {
  const service = firebaseMessaging(env);
  if (!service) throw new Error('firebase_push_not_configured');
  const origin = String(env.PUBLIC_APP_ORIGIN || '').replace(/\/$/, '');
  const webpush = origin && /^https:\/\//i.test(origin) ? { fcmOptions: { link: `${origin}${destination}` } } : undefined;
  return service.send({
    fid,
    notification: { title: String(title).slice(0, 100), body: String(body).slice(0, 400) },
    data: { notificationId: String(notificationId || ''), eventId: String(eventId || ''), destination: String(destination || '/') },
    ...(webpush ? { webpush } : {})
  });
}

export function isInvalidFirebaseInstallation(error) {
  return ['messaging/installation-id-not-registered','messaging/registration-token-not-registered'].includes(String(error?.code || ''));
}
