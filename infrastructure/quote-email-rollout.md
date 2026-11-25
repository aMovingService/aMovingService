# A Moving Service staff quote pilot

The quote-created Firebase trigger in us-west2 writes the dashboard alert and a deterministic outbox document in one Firestore transaction when enabled. The worker uses a fixed template. No quote details or customer addresses are sent. A verified permanent bounce or complaint suppresses the staff recipient until an operator investigates. An ambiguous send or expired worker claim enters needs_review. Only explicit throttling retries, at most five attempts. SNS events are deduplicated and cannot regress a confirmed delivery to accepted or delayed.

## Proposed deployment

1. Compare the production quote function with the release checkout before deployment. Preserve concurrent application work. Target project amovingservice-web-2026. Create keyless service accounts ams-email-worker and ams-email-feedback. Grant the scheduled worker and feedback handler Firestore data access (roles/datastore.user on the application database). This grants database-level data access. Only the scheduled worker can assume the AWS role. The quote producer retains its existing runtime identity. Limit deployer actAs to the required service accounts. Use the worker's runtime identity token and numeric Google subject.
2. Create stack amovingservice-ses-quote-alerts in us-east-2 using quote-email.yaml, supplying the worker's numeric subject and ConnectFeedback=false. Simulate allowed sender and explicit cross-business/recipient denial before sending.
3. Add the two emailOutbox indexes to the live index inventory. Deploy only notifyStaffOfNewQuote, processQuoteEmailQueue, and quoteEmailFeedback, with quote-email.env.example values and STAFF_QUOTE_EMAIL_ENABLED=false. The scheduled function runs every five minutes. Check its invoker and OIDC authentication. Require a public HTTPS endpoint for signed SNS callbacks.
4. Set ConnectFeedback=true after the callback is reachable. Verify the confirmed HTTPS subscription, an unsigned request rejected, and the scheduler's first successful invocation. No quote alert is queued while disabled.
5. Obtain test-send approval. Seed three server-only sesPilotOutbox entries and deliver via the dedicated worker identity to the SES success, bounce and complaint simulator addresses. Verify signed feedback, event correlation, pilot suppression and duplicate handling. Then send one separately approved labeled test to contact@amovingservice.com and verify inbox receipt, authentication and reply address.
6. Activate only after owner approval by deploying the quote producer and scheduler with STAFF_QUOTE_EMAIL_ENABLED=true. Observe the next real quote. For an emergency pause set emailDeliveryControls/settings.sesPaused=true. For rollback turn off the queue producer and worker and redeploy both; inspect outstanding entries and in-flight sends before any later reactivation.

## Cost assumptions

The SES à la carte base price is $0.10 per thousand outbound messages. The worker caps reservations at 100 per conservative 24-hour window and one per second. A five-minute scheduler runs about 8,640 times per 30-day month; one job costs up to $0.10 per month before free allowances. Firebase compute, Firestore reads/writes, logs, builds, network and SNS requests/deliveries depend on actual usage and shared free allowances. No dedicated IP, paid reputation metrics or plan change is proposed.

[SES pricing](https://aws.amazon.com/ses/pricing/) · [Cloud Scheduler pricing](https://cloud.google.com/scheduler/pricing)

## Production deployment on November 24, 2026

CloudFormation reached UPDATE_COMPLETE in us-east-2 with the HTTPS subscription confirmed. The sender and recipient restrictions passed regional IAM simulation. The three named Firebase functions are ACTIVE with STAFF_QUOTE_EMAIL_ENABLED=false. The quote producer retains its existing identity. Both emailOutbox indexes reached READY. The callback returned HTTP 400 for an unsigned POST. The authenticated scheduler initially received HTTP 403, then returned HTTP 200 twice. The Firebase CLI added an artifact cleanup policy during deployment. That new policy was removed to restore the previous retention configuration.

The three SES simulator cases produced the expected delivery, bounce and complaint outcomes. On November 24 at 8:37 p.m. Pacific, the approved owner test reached contact@amovingservice.com and appeared in the jonathan@w3develops.org Zoho Inbox. Firestore recorded delivery. Zoho reported SPF, DKIM and DMARC pass and displayed contact@amovingservice.com as the reply address. After owner approval, both notifyStaffOfNewQuote and processQuoteEmailQueue were deployed and verified ACTIVE with STAFF_QUOTE_EMAIL_ENABLED=true. First real quote delivery is pending observation.
