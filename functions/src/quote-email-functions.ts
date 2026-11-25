import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onRequest } from 'firebase-functions/v2/https';
import { processEmailQueue } from './email-outbox.js';
import { confirmSnsSubscription, processSesNotification, validateSnsMessage, SesFeedbackInputError } from './ses-feedback.js';

export const processQuoteEmailQueue = onSchedule({
  region: 'us-west2', schedule: 'every 5 minutes', maxInstances: 1,
  serviceAccount: 'ams-email-worker@amovingservice-web-2026.iam.gserviceaccount.com',
}, async () => {
  if (process.env.STAFF_QUOTE_EMAIL_ENABLED === 'true') await processEmailQueue();
});

export const quoteEmailFeedback = onRequest({region: 'us-west2', invoker: 'public',
  serviceAccount: 'ams-email-feedback@amovingservice-web-2026.iam.gserviceaccount.com'}, async (req, res) => {
  if (req.method !== 'POST') { res.sendStatus(405); return; }
  if (req.rawBody.length > 1024 * 1024) { res.sendStatus(413); return; }
  let envelope;
  try { envelope = JSON.parse(req.rawBody.toString('utf8')); }
  catch { res.sendStatus(400); return; }
  try {
    const message = await validateSnsMessage(envelope);
    if (message.Type === 'SubscriptionConfirmation') await confirmSnsSubscription(message);
    else await processSesNotification(message);
    res.sendStatus(204);
  } catch (error) {
    res.sendStatus(error instanceof SesFeedbackInputError ? 400 : 503);
  }
});
