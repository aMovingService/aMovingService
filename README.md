# A Moving Service

The public site for A Moving Service, built with React, Vite, Firebase
Authentication, Cloud Firestore, and Firebase Hosting.

## What is live

- Marketing site: Firebase Hosting serves the static React build.
- Staff shell: /admin uses Google sign-in. Firestore access requires a
  server-issued staff: true custom claim and a verified email.
- Firestore: Standard edition in us-west2 (Los Angeles), with client access
  closed by default and protected lead rules.

The public quote form intentionally does not write to Firestore. It can open a
pre-addressed email only after a real public contact address is configured.
Never allow an anonymous browser to write leads directly to Firestore.

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

## Required business inputs before enabling live lead delivery

- Owner-approved public email and phone number
- Verified service areas and real services offered
- Privacy/contact policy and permitted follow-up channels
- A trusted server-side intake endpoint (typically requires a billing-enabled
  Firebase backend)
