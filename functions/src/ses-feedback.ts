import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import MessageValidator from 'sns-validator';
import { getFirestore as adminDb } from 'firebase-admin/firestore';
import { emailRecipientId } from './email-outbox.js';
import { SES_BUSINESS } from './email-provider.js';

export type SnsMessage = {
  Type?: string;
  MessageId?: string;
  TopicArn?: string;
  Message?: string;
  SubscribeURL?: string;
  Signature?: string;
  SignatureVersion?: string;
  SigningCertURL?: string;
  Timestamp?: string;
  Token?: string;
  Subject?: string;
};

type SnsValidator = { validate(message: Record<string, unknown>, callback: (error: Error | null) => void): void };
const SNS_REGION = process.env.SES_AWS_REGION || 'us-east-2';
const MAX_SNS_BODY_BYTES = 1024 * 1024;
const SNS_HOST = `sns.${SNS_REGION}.amazonaws.com`;
const VALID_EVENTS = ['send', 'delivery', 'bounce', 'complaint', 'reject', 'deliverydelay', 'renderingfailure'];
export class SesFeedbackInputError extends Error {}

function allowedTopics() {
  return new Set((process.env.SES_ALLOWED_SNS_TOPIC_ARNS || '').split(',').map(value => value.trim()).filter(Boolean));
}

export async function validateSnsMessage(message: SnsMessage, validator: SnsValidator = new MessageValidator()) {
  if (!message?.TopicArn || !allowedTopics().has(message.TopicArn)) throw new SesFeedbackInputError('SNS_TOPIC_NOT_ALLOWED');
  if (!['Notification', 'SubscriptionConfirmation'].includes(message.Type || '')) throw new SesFeedbackInputError('SNS_MESSAGE_TYPE_NOT_ALLOWED');
  if (message.SignatureVersion !== '2') throw new SesFeedbackInputError('SNS_SIGNATURE_VERSION_INVALID');
  if (typeof message.SigningCertURL !== 'string' || !message.SigningCertURL.startsWith(`https://${SNS_HOST}/`) ||
      !/^SimpleNotificationService-[a-f0-9]+\.pem$/i.test(message.SigningCertURL.slice(`https://${SNS_HOST}/`.length))) {
    throw new SesFeedbackInputError('SNS_SIGNING_CERT_INVALID');
  }
  const { Type, TopicArn, MessageId, Message, Timestamp, Signature, SignatureVersion, SigningCertURL, SubscribeURL, Token, Subject } = message;
  if (![MessageId, Message, Timestamp, Signature].every(value => typeof value === 'string' && value.length > 0) ||
      (Type === 'SubscriptionConfirmation' && ![SubscribeURL, Token].every(value => typeof value === 'string' && value.length > 0)) ||
      (Subject !== undefined && typeof Subject !== 'string')) throw new SesFeedbackInputError('SNS_BODY_INVALID');
  // Pass only canonical HTTP envelope fields to the validator.
  const envelope = { Type, TopicArn, MessageId, Message, Timestamp, Signature, SignatureVersion, SigningCertURL,
    ...(Type === 'SubscriptionConfirmation' ? { SubscribeURL, Token } : {}), ...(Subject !== undefined ? { Subject } : {}) };
  await new Promise<void>((resolve, reject) => validator.validate(envelope, error => {
    if (!error) return resolve();
    if (error.message === 'Certificate could not be retrieved' || 'code' in error) return reject(error);
    reject(new SesFeedbackInputError('SNS_SIGNATURE_INVALID'));
  }));
  return message;
}

export async function readVerifiedSnsRequest(req: Request, validator?: SnsValidator) {
  const reader = req.body?.getReader();
  if (!reader || Number(req.headers.get('content-length')) > MAX_SNS_BODY_BYTES) throw new SesFeedbackInputError('SNS_BODY_INVALID');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_SNS_BODY_BYTES) {
      void reader.cancel().catch(() => {});
      throw new SesFeedbackInputError('SNS_BODY_INVALID');
    }
    chunks.push(value);
  }
  let message: SnsMessage;
  try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new SesFeedbackInputError('SNS_BODY_INVALID'); }
  return validateSnsMessage(message, validator);
}

function confirmedSubscriptionUrl(message: SnsMessage) {
  let url: URL;
  try { url = new URL(message.SubscribeURL || ''); } catch { throw new SesFeedbackInputError('SNS_SUBSCRIBE_URL_INVALID'); }
  if (url.origin !== `https://${SNS_HOST}` || url.username || url.password || url.hash || url.pathname !== '/' ||
      url.searchParams.size !== 3 || url.searchParams.get('Action') !== 'ConfirmSubscription' ||
      url.searchParams.get('TopicArn') !== message.TopicArn || !message.Token || url.searchParams.get('Token') !== message.Token) {
    throw new SesFeedbackInputError('SNS_SUBSCRIBE_URL_INVALID');
  }
  return url;
}

export async function confirmSnsSubscription(message: SnsMessage) {
  const url = confirmedSubscriptionUrl(message);
  const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('SNS_SUBSCRIPTION_CONFIRMATION_FAILED');
}

type SesEvent = {
  eventType?: string;
  notificationType?: string;
  mail?: { messageId?: string; destination?: string[]; tags?: Record<string, string[]> };
  bounce?: { bounceType?: string; bouncedRecipients?: Array<{ emailAddress?: string }> };
  complaint?: { complainedRecipients?: Array<{ emailAddress?: string }> };
  delivery?: { recipients?: string[] };
  deliveryDelay?: { delayedRecipients?: Array<{ emailAddress?: string }> };
};

function eventType(event: SesEvent) {
  return String(event.eventType || event.notificationType || '').toLowerCase().replace(/[^a-z]/g, '');
}

function addresses(values: unknown[] | undefined) {
  return (Array.isArray(values) ? values : []).filter((value): value is string => typeof value === 'string' && value.includes('@'))
    .map(value => value.trim().toLowerCase());
}

function eventRecipients(event: SesEvent, type: string) {
  switch (type) {
    case 'bounce': return addresses(event.bounce?.bouncedRecipients?.map(item => item?.emailAddress));
    case 'complaint': return addresses(event.complaint?.complainedRecipients?.map(item => item?.emailAddress));
    case 'deliverydelay': return addresses(event.deliveryDelay?.delayedRecipients?.map(item => item?.emailAddress));
    case 'delivery': return addresses(event.delivery?.recipients);
    default: return addresses(event.mail?.destination);
  }
}

const eventStatuses: Record<string, string> = {
  send: 'accepted', deliverydelay: 'delayed', delivery: 'delivered', reject: 'rejected', renderingfailure: 'rejected', bounce: 'bounced', complaint: 'complained',
};
const statusOrder = ['accepted', 'delayed', 'delivered', 'rejected', 'bounced', 'complained'];

function tag(event: SesEvent, name: string) {
  const values = event.mail?.tags?.[name];
  return Array.isArray(values) && values.length === 1 && typeof values[0] === 'string' ? values[0] : '';
}

export async function processSesNotification(message: SnsMessage) {
  if (message.Type !== 'Notification' || !message.TopicArn || !message.MessageId || !message.Message) throw new SesFeedbackInputError('SES_NOTIFICATION_INVALID');
  let event: SesEvent;
  try { event = JSON.parse(message.Message); } catch { throw new SesFeedbackInputError('SES_EVENT_INVALID'); }
  if (!event || typeof event !== 'object') throw new SesFeedbackInputError('SES_EVENT_INVALID');
  const type = eventType(event);
  if (!VALID_EVENTS.includes(type)) throw new SesFeedbackInputError('SES_EVENT_TYPE_INVALID');
  const providerMessageId = event.mail?.messageId;
  const outboxId = tag(event, 'outboxId'), attemptId = tag(event, 'attemptId'), config = tag(event, 'ses:configuration-set');
  if (typeof providerMessageId !== 'string' || !providerMessageId || !/^[a-f0-9]{64}$/.test(outboxId) ||
      !/^[a-f0-9-]{36}$/.test(attemptId) || tag(event, 'business') !== SES_BUSINESS || config !== 'amovingservice-transactional') throw new SesFeedbackInputError('SES_EVENT_METADATA_INVALID');
  const pilot = tag(event, 'test') === 'pilot';
  const destination = addresses(event.mail?.destination);
  if (destination.length !== 1) throw new SesFeedbackInputError('SES_RECIPIENT_INVALID');
  const [recipient] = destination;
  const eventId = createHash('sha256').update(`${message.TopicArn}:${message.MessageId}`).digest('hex');
  if (!eventRecipients(event, type).includes(recipient)) throw new SesFeedbackInputError('SES_RECIPIENT_INVALID');
  const suppress = type === 'complaint' || (type === 'bounce' && event.bounce?.bounceType === 'Permanent');
  const db = adminDb(), eventRef = db.doc(`sesWebhookEvents/${eventId}`), outboxRef = db.doc(`${pilot ? 'sesPilotOutbox' : 'emailOutbox'}/${outboxId}`);
  return db.runTransaction(async tx => {
    if ((await tx.get(eventRef)).exists) return { duplicate: true, eventType: type, outboxId, suppressed: 0 };
    const outbox = (await tx.get(outboxRef)).data();
    if (!outbox || outbox.provider !== 'ses' || outbox.sesConfigurationSet !== config || outbox.attemptId !== attemptId ||
      outbox.to?.trim().toLowerCase() !== recipient || (outbox.providerMessageId && outbox.providerMessageId !== providerMessageId)) {
      throw new SesFeedbackInputError('SES_OUTBOX_MISMATCH');
    }
    tx.create(eventRef, {
      topicArn: message.TopicArn,
      snsMessageId: message.MessageId,
      providerMessageId,
      eventType: type,
      outboxId, pilot,
      recipientHashes: [emailRecipientId(recipient)],
      createdAt: FieldValue.serverTimestamp(),
    });
    const status = eventStatuses[type];
    if (outbox.status !== 'dismissed' && statusOrder.indexOf(status) > statusOrder.indexOf(outbox.status)) {
      const failureCode = type === 'renderingfailure'
        ? 'SES_RENDERING_FAILURE'
        : status && ['bounced', 'complained', 'rejected'].includes(status) ? `SES_${status.toUpperCase()}` : null;
      tx.update(outboxRef, {
        status, providerMessageId,
        leaseUntil: FieldValue.delete(), nextAttemptAt: FieldValue.delete(),
        lastSesEvent: type,
        lastSesEventAt: FieldValue.serverTimestamp(),
        ...(status === 'delivered' ? { deliveredAt: FieldValue.serverTimestamp() } : {}),
        ...(outbox.acceptedAt ? {} : { acceptedAt: FieldValue.serverTimestamp() }),
        failureCode: failureCode || FieldValue.delete(),
      });
    }
    if (suppress && (type === 'complaint' || outbox.status !== 'complained' || pilot)) {
      tx.set(pilot ? db.doc(`sesPilotSuppressions/${eventId}`) : db.doc(`emailSuppressions/${emailRecipientId(recipient)}`), {
        reason: type === 'complaint' ? 'ses_complaint' : 'ses_hard_bounce',
        source: 'amazon_ses',
        providerMessageId,
        eventId, ...(pilot ? { recipientHash: emailRecipientId(recipient), outboxId } : {}),
        createdAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    return { duplicate: false, eventType: type, outboxId, suppressed: suppress ? 1 : 0 };
  });
}
