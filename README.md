# A Moving Service

The public site for A Moving Service, built with React, Vite, Firebase
Authentication, Cloud Firestore, and Firebase Hosting.

## What is live

- Marketing site: Firebase Hosting serves the static React build.
- Customer accounts: email/password Authentication supports private customer
  profiles, quote/call requests, and booking requests.
- Staff shell: /admin uses Google sign-in. Firestore access requires a
  server-issued staff: true custom claim and a verified email.
- Firestore: Standard edition in us-west2 (Los Angeles), with client access
  closed by default and protected lead rules.

Customer quote requests require a Firebase account and are private to that
customer and staff with the server-issued staff claim. Browser-created booking
requests remain `awaiting_payment`; a browser may never mark a deposit paid.

## Local development

1. Use Node 20 or later.
2. Copy .env.example to .env, then fill in the public Firebase Web App
   identifiers and only owner-approved business contact values.
3. Install packages and run the app:

    npm install
    npm run dev

Run the production checks with:

    npm run check
    npm run build

## Deploy

The Firebase project alias is configured in .firebaserc. Build before
deploying:

    npm run build
    firebase deploy --only firestore,auth,hosting

The deployed rules live in firestore.rules. A future trusted intake service
must validate all lead fields, rate-limit requests, perform bot protection, and
write via the Firebase Admin SDK. It must not add a public Firestore rule.

## Staff access

Signing in with Google does not grant lead access by itself. A privileged local
Admin SDK workflow must explicitly set the Firebase Auth custom claim
staff: true for a verified staff user, then the user must refresh their ID
token. Service-account credentials must never be committed.

## Stripe deposits

The pricing policy is $125 per hour, with a $250 two-hour booking deposit.
The deposit is credited to the final bill and is refundable with 48+ hours'
notice.

Do not put Stripe secret keys into a Vite variable or this repository. A public
Stripe Payment Link may be placed in `VITE_STRIPE_DEPOSIT_PAYMENT_LINK` for
navigation to Stripe Checkout, but production payment confirmation must use a
trusted server endpoint and Stripe webhook. That endpoint should create a
Checkout Session with the Firebase UID and booking ID in metadata, verify the
webhook signature using its endpoint secret, and then update the booking with
the Admin SDK. Firebase Functions or Cloud Run normally requires a
billing-enabled Firebase project.

## Required business inputs before enabling live lead delivery

- Owner-approved public email and phone number
- Verified service areas and real services offered
- Privacy/contact policy and permitted follow-up channels
- Billing approval for the Firebase server component and Stripe webhook
- Stripe secret and webhook signing secrets entered directly into a server-side
  secret manager, never pasted into source control
