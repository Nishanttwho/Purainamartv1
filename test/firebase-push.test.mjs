import test from 'node:test';
import assert from 'node:assert/strict';
import { isInvalidFirebaseInstallation, publicWebMessagingConfig, firebaseMessagingStatus, sendFirebaseInstallationMessage } from '../lib/firebase-push.mjs';

test('web Firebase configuration is absent until every public key is provided', () => {
  assert.deepEqual(publicWebMessagingConfig({}), { enabled: false, vapidKey: null, firebase: null });
  const env = { FCM_WEB_API_KEY: 'web-api', FCM_WEB_AUTH_DOMAIN: 'project.firebaseapp.com', FCM_WEB_PROJECT_ID: 'project', FCM_WEB_MESSAGING_SENDER_ID: '123', FCM_WEB_APP_ID: 'app-id', FCM_WEB_VAPID_KEY: 'public-vapid' };
  const result = publicWebMessagingConfig(env);
  assert.equal(result.enabled, true);
  assert.equal(result.firebase.projectId, 'project');
  assert.equal('privateKey' in result.firebase, false);
  assert.equal(firebaseMessagingStatus({ ...env, FCM_PROJECT_ID: '' }).serverConfigured, false);
  assert.equal(firebaseMessagingStatus({ ...env, FCM_PROJECT_ID: 'project' }).serverConfigured, true);
});

test('unregistered Firebase installations are identifiable for cleanup', () => {
  assert.equal(isInvalidFirebaseInstallation({ code: 'messaging/installation-id-not-registered' }), true);
  assert.equal(isInvalidFirebaseInstallation({ code: 'messaging/registration-token-not-registered' }), true);
  assert.equal(isInvalidFirebaseInstallation({ code: 'messaging/invalid-argument' }), false);
});

test('missing server project configuration fails push delivery without attempting a provider send', async () => {
  await assert.rejects(sendFirebaseInstallationMessage('fake-installation-id', { title: 'Test', body: 'No send' }, {}), /firebase_push_not_configured/);
});
