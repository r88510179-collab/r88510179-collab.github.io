// Web Push delivery (RFC 8030 / 8291 aes128gcm / 8292 VAPID) through the pinned web-push library. Returns the push
// service's HTTP status (0 for a network failure) and any Retry-After; never throws.
import webpush from 'web-push';
import {parseRetryAfter} from './core.mjs';

export function createPushSender({publicKey, privateKey, subject, timeoutMs = 15000, agent, now = () => Date.now()}) {
  const vapidDetails = {subject, publicKey, privateKey};
  return async function send(subscription, payload, {topic, urgency, ttl}) {
    try {
      const response = await webpush.sendNotification(subscription, JSON.stringify(payload), {
        vapidDetails, TTL: ttl, urgency, topic, timeout: timeoutMs, contentEncoding: 'aes128gcm', ...(agent ? {agent} : {})
      });
      return {status: response.statusCode, retryAfterSeconds: null};
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 0;
      const header = error?.headers?.['retry-after'] ?? error?.headers?.['Retry-After'];
      return {status, retryAfterSeconds: parseRetryAfter(header, now())};
    }
  };
}

export function generateVapidKeys() { return webpush.generateVAPIDKeys(); }
