import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { notifyStaffOfNewQuote } from '../lib/index.js';
import { deliverEmail } from '../lib/email-outbox.js';
import { processSesNotification, validateSnsMessage } from '../lib/ses-feedback.js';

assert.match(process.env.FIRESTORE_EMULATOR_HOST ?? '', /^(localhost|127\.0\.0\.1):\d+$/);
Object.assign(process.env, {
  STAFF_QUOTE_EMAIL_TO: 'contact@amovingservice.com', SES_CONFIGURATION_SET: 'amovingservice-transactional',
  SES_ASSUME_ROLE_ARN: 'local', SES_WEB_IDENTITY_AUDIENCE: 'local', SES_ALLOWED_SNS_TOPIC_ARNS: 'local-topic'
});
const db = getFirestore();
const to = process.env.STAFF_QUOTE_EMAIL_TO;
async function quote(quoteId) {
  const document = 'customers/test-user/quotes/' + quoteId;
  await notifyStaffOfNewQuote.run({document, params: {uid: 'test-user', quoteId}});
  return db.doc('emailOutbox/' + createHash('sha256').update(document).digest('hex'));
}
async function resetQuota() { await db.doc('emailDeliveryControls/aws-us-east-2').delete(); }
function envelope(type, id, attemptId) {
  return {Type:'Notification', TopicArn:'local-topic', MessageId:type + id,
    Message: JSON.stringify({eventType:type, mail:{messageId:'provider-id',destination:[to],tags:{
      business:['amovingservice'],outboxId:[id],attemptId:[attemptId],
      'ses:configuration-set':['amovingservice-transactional']}},
      delivery:{recipients:[to]}, bounce:{bounceType:'Permanent',bouncedRecipients:[{emailAddress:to}]}})};
}
test('disabled quote creates dashboard alert only', async () => {
  process.env.STAFF_QUOTE_EMAIL_ENABLED='false';
  assert.equal((await (await quote('disabled')).get()).exists,false);
  assert.equal((await db.doc('staffNotifications/quote-test-user-disabled').get()).exists,true);
});
test('replayed quote and concurrent delivery issue one send; early delivery and duplicate feedback are safe',async () => {
  process.env.STAFF_QUOTE_EMAIL_ENABLED='true';
  const [ref] = await Promise.all([quote('duplicate'),quote('duplicate')]);
  let calls=0;
  const send = async (id,attemptId,recipient) => {
    calls++; assert.equal(recipient,to);
    const event=envelope('Delivery',id,attemptId);
    await processSesNotification(event);
    assert.equal((await processSesNotification(event)).duplicate,true);
    return {status:'accepted',providerMessageId:'provider-id'};
  };
  await Promise.all([deliverEmail(ref.id,false,send),deliverEmail(ref.id,false,send)]);
  assert.equal(calls,1);
  assert.equal((await ref.get()).data().status,'delivered');
});
test('throttling retries with backoff; ambiguous send stops for review', async () => {
  await resetQuota(); const ref=await quote('failures');
  assert.equal(await deliverEmail(ref.id,false,async()=>{throw {$metadata:{httpStatusCode:429}}}),'retry');
  assert.ok((await ref.get()).data().nextAttemptAt.toMillis()>Date.now());
  await ref.update({nextAttemptAt:Timestamp.fromMillis(0)}); await resetQuota();
  assert.equal(await deliverEmail(ref.id,false,async()=>{throw new Error('timeout')}),'needs_review');
});
test('hard bounce suppresses the next quote; unsigned SNS input rejected',async () => {
  await resetQuota(); const ref=await quote('bounce');
  await deliverEmail(ref.id,false,async()=>({status:'accepted',providerMessageId:'provider-id'}));
  const event=envelope('Bounce',ref.id,(await ref.get()).data().attemptId);
  await assert.rejects(validateSnsMessage(event));
  await processSesNotification(event);
  assert.equal((await ref.get()).data().status,'bounced');
  assert.equal(await deliverEmail((await quote('suppressed')).id,false,async()=>assert.fail()),'suppressed');
});
test('simulated complaint stays in pilot suppression records',async () => {
  const recipient='complaint@simulator.amazonses.com';
  const id='f'.repeat(64);
  await resetQuota();
  const ref=db.doc('sesPilotOutbox/'+id);
  await ref.create({business:'amovingservice',category:'staff_quote',template:'new_quote',to:recipient,status:'pending'});
  await deliverEmail(id,true,async()=>({status:'accepted',providerMessageId:'provider-id'}));
  const event=envelope('Complaint',id,(await ref.get()).data().attemptId);
  const body=JSON.parse(event.Message);
  body.mail.destination=[recipient];
  body.mail.tags.test=['pilot'];
  body.complaint={complainedRecipients:[{emailAddress:recipient}]};
  event.Message=JSON.stringify(body);
  await processSesNotification(event);
  assert.equal((await ref.get()).data().status,'complained');
  assert.equal((await db.collection('sesPilotSuppressions').get()).size,1);
  const hash=createHash('sha256').update(recipient).digest('hex');
  assert.equal((await db.doc('emailSuppressions/'+hash).get()).exists,false);
});
