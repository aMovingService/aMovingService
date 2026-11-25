import { createHash, randomUUID } from 'node:crypto';
import { FieldValue, Timestamp, type DocumentData } from 'firebase-admin/firestore';
import { getFirestore as adminDb } from 'firebase-admin/firestore';
import { safeTransientEmailError, sendSes, SES_BUSINESS } from './email-provider.js';

export const SES_SETTINGS_PATH = 'emailDeliveryControls/settings';
const SES_USAGE_PATH = 'emailDeliveryControls/aws-us-east-2';
const LEASE_MS = 2 * 60_000;
const HOUR_MS = 60 * 60_000;
const MAX_AUTOMATIC_ATTEMPTS = 5;

export const emailRecipientId = (email: string) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

function limitSetting(value: unknown, ceiling: number) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? Math.min(ceiling, value) : ceiling;
}

// Reserve quota before calling the provider. Count all attempted sends conservatively.
function reserveSesSlot(now: number, settings: DocumentData, usage: DocumentData) {
  const recent = (Array.isArray(usage.recent) ? usage.recent : []).filter((time: number) => time > now - 1_000);
  if (recent.length >= limitSetting(settings.sesPerSecond, 1)) return null;
  const hour = Math.floor(now / HOUR_MS);
  const hours = Object.fromEntries(Object.entries<{ account: number; businesses: Record<string, number> }>(usage.hours || {})
    .filter(([key]) => Number(key) >= hour - 24));
  const buckets = Object.values(hours);
  if (buckets.reduce((total, item) => total + item.account, 0) >= limitSetting(settings.sesAccountLimit, 100)) return null;
  if (buckets.reduce((total, item) => total + (item.businesses[SES_BUSINESS] || 0), 0) >= limitSetting(settings.sesBusinessLimit, 100)) return null;
  const current = hours[hour] ?? { account: 0, businesses: {} };
  hours[hour] = { account: current.account + 1, businesses: { ...current.businesses, [SES_BUSINESS]: (current.businesses[SES_BUSINESS] || 0) + 1 } };
  return { hours, recent: [...recent, now] };
}

export async function deliverEmail(id: string, pilot = false, send = sendSes) {
  const db = adminDb(), ref = db.doc(`${pilot ? 'sesPilotOutbox' : 'emailOutbox'}/${id}`);
  const attemptId = randomUUID();
  const claim = await db.runTransaction(async tx => {
    const data = (await tx.get(ref)).data();
    if (!data || !['pending', 'retry'].includes(data.status)) return { state: data?.status || 'missing' };
    const now = Date.now();
    if (data.nextAttemptAt?.toMillis() > now) return { state: 'retry' };
    const provider = 'ses';
    if (!pilot && process.env.STAFF_QUOTE_EMAIL_ENABLED !== 'true') return { state: 'paused' };
    const recipients = pilot ? ['success@simulator.amazonses.com', 'bounce@simulator.amazonses.com', 'complaint@simulator.amazonses.com', 'contact@amovingservice.com'] : ['contact@amovingservice.com'];
    if (data.business !== SES_BUSINESS || data.category !== 'staff_quote' || data.template !== 'new_quote' || !recipients.includes(data.to)) {
      tx.update(ref, {status: 'needs_review', failureCode: 'INVALID_QUOTE_ALERT'});
      return {state: 'needs_review'};
    }
    const suppression = await tx.get(db.doc(`emailSuppressions/${emailRecipientId(data.to || '')}`));
    if (suppression.exists) {
      tx.update(ref, { status: 'suppressed', suppressionReason: suppression.data()?.reason || 'recipient_suppressed', suppressedAt: FieldValue.serverTimestamp() });
      return { state: 'suppressed' };
    }
    function defer(state: string, delayMs: number) {
      if (!pilot && data?.nextAttemptAt) tx.update(ref, { nextAttemptAt: Timestamp.fromMillis(now + delayMs) });
      return { state };
    }
    if (!['SES_ASSUME_ROLE_ARN','SES_WEB_IDENTITY_AUDIENCE'].every(key => process.env[key]) || process.env.SES_CONFIGURATION_SET !== 'amovingservice-transactional') return defer('pending_configuration', 5 * 60_000);
    const usageRef = db.doc(SES_USAGE_PATH);
    const settings = (await tx.get(db.doc(SES_SETTINGS_PATH))).data() || {};
    if (settings.sesPaused === true) return defer('paused', 60_000);
    const reservation = reserveSesSlot(now, settings, (await tx.get(usageRef)).data() || {});
    if (!reservation) return defer('rate_limited', 60_000);
    const attempts = Number(data.attempts || 0) + 1;
    tx.set(usageRef, reservation);
    tx.update(ref, {
      status: 'sending', attemptId, attempts, provider, leaseUntil: Timestamp.fromMillis(now + LEASE_MS),
      attemptedAt: FieldValue.serverTimestamp(), nextAttemptAt: FieldValue.delete(), providerMessageId: FieldValue.delete(),
      sesConfigurationSet: process.env.SES_CONFIGURATION_SET,
    });
    return { state: 'claimed', data, provider, attempts, leaseExpiresAt: now + LEASE_MS };
  });
  if (!claim.data || !claim.provider) return claim.state;
  if (Date.now() >= claim.leaseExpiresAt) return 'sending';

  let result: Awaited<ReturnType<typeof sendSes>> | undefined;
  let failureCode = '';
  let retry = false;
  try {
    result = await send(id, attemptId, claim.data.to, pilot);
  } catch (error) {
    const throttled = safeTransientEmailError(error);
    retry = throttled && claim.attempts < MAX_AUTOMATIC_ATTEMPTS;
    failureCode = throttled ? 'SES_THROTTLED' : 'SES_DELIVERY_AMBIGUOUS';
  }

  return db.runTransaction(async tx => {
    const data = (await tx.get(ref)).data();
    // Feedback can report delivery before SES returns. The attempt ID also
    // prevents an old worker from changing a newer attempt's state.
    if (data?.attemptId !== attemptId || (data.status !== 'sending' && !(result && data.status === 'needs_review' && data.failureCode === 'EMAIL_SEND_LEASE_EXPIRED'))) {
      return data?.status || 'missing';
    }
    if (result) {
      tx.update(ref, {
        status: result.status, providerMessageId: result.providerMessageId || FieldValue.delete(),
        acceptedAt: FieldValue.serverTimestamp(),
        failureCode: FieldValue.delete(), leaseUntil: FieldValue.delete(),
      });
      return result.status;
    }
    const status = retry ? 'retry' : 'needs_review';
    tx.update(ref, {
      status, failureCode, leaseUntil: FieldValue.delete(),
      ...(retry ? { nextAttemptAt: Timestamp.fromMillis(Date.now() + 30_000 * 2 ** (claim.attempts - 1)) } : {}),
    });
    return status;
  });
}

export async function processEmailQueue(limit = 10) {
  const db = adminDb(), outbox = db.collection('emailOutbox'), now = Timestamp.now();
  const batchSize = Math.min(Math.max(limit, 1), 25);
  const [due, expired] = await Promise.all([
    outbox.where('status', 'in', ['pending', 'retry']).where('nextAttemptAt', '<=', now).orderBy('nextAttemptAt').limit(batchSize).get(),
    outbox.where('status', '==', 'sending').where('leaseUntil', '<=', now).limit(batchSize).get(),
  ]);
  const expiredResults = await Promise.all(expired.docs.map(doc => db.runTransaction(async tx => {
    const data = (await tx.get(doc.ref)).data();
    if (data?.status !== 'sending' || !data.leaseUntil || data.leaseUntil.toMillis() > now.toMillis()) return false;
    tx.update(doc.ref, { status: 'needs_review', failureCode: 'EMAIL_SEND_LEASE_EXPIRED', leaseUntil: FieldValue.delete() });
    return true;
  })));
  const results = await Promise.all(due.docs.map(doc => deliverEmail(doc.id)));
  return {
    checked: due.size,
    processed: results.length,
    accepted: results.filter(status => ['accepted', 'sent', 'delivered'].includes(status)).length,
    retrying: results.filter(status => status === 'retry').length,
    needsReview: results.filter(status => status === 'needs_review').length + expiredResults.filter(Boolean).length,
    suppressed: results.filter(status => status === 'suppressed').length,
    paused: results.filter(status => status === 'paused').length,
    rateLimited: results.filter(status => status === 'rate_limited').length,
  };
}
