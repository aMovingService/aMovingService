import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { createHash } from "node:crypto";
import Stripe from "stripe";

initializeApp();

const REGION = "us-west2";
const SITE_URL = "https://amovingservice.com";
const HOURLY_RATE_CENTS = 12_500;
const DEPOSIT_CENTS = 25_000;
const INITIAL_ADMIN_EMAIL = "w3develops@gmail.com";
const stripeSecret = defineSecret("STRIPE_SECRET_KEY");
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");
const db = getFirestore();

type CheckoutInput = { bookingId?: unknown };
type ReviewInput = { uid?: unknown; bookingId?: unknown; decision?: unknown };
type AccountRole = "admin" | "employee" | "customer";

function stripeClient(secret: string) {
  return new Stripe(secret);
}

function bookingRef(uid: string, bookingId: string) {
  return db.collection("customers").doc(uid).collection("bookingRequests").doc(bookingId);
}

async function createStaffNotification(id: string, title: string, message: string) {
  const reference = db.collection("staffNotifications").doc(id);
  if ((await reference.get()).exists) return;
  await reference.set({
    schemaVersion: 1,
    title,
    message,
    createdAt: FieldValue.serverTimestamp()
  });
}

function checkoutIntegrationIdentifier(bookingId: string) {
  const suffix = Array.from(
    createHash("sha256").update(bookingId).digest().subarray(0, 8),
    (byte) => String.fromCharCode(97 + (byte % 26))
  ).join("");
  return `a_moving_service_${suffix}`;
}

function verifiedEmail(request: { auth?: { token: Record<string, unknown>; uid: string } }) {
  return request.auth?.token.email_verified === true && typeof request.auth.token.email === "string";
}

function isStaff(request: { auth?: { token: Record<string, unknown>; uid: string } }) {
  return verifiedEmail(request) && request.auth?.token.staff === true;
}

function storedRole(customClaims: Record<string, unknown> | undefined): AccountRole {
  if (customClaims?.role === "admin" || customClaims?.role === "employee") return customClaims.role;
  // Preserve previously issued staff access while migrating to named roles.
  return customClaims?.staff === true ? "employee" : "customer";
}

async function recordAccount(user: Awaited<ReturnType<ReturnType<typeof getAuth>["getUser"]>>, role: AccountRole) {
  const reference = db.collection("accountProfiles").doc(user.uid);
  const existing = await reference.get();
  await reference.set({
    schemaVersion: 1,
    uid: user.uid,
    email: user.email?.toLowerCase() ?? null,
    displayName: user.displayName ?? null,
    role,
    emailVerified: user.emailVerified,
    updatedAt: FieldValue.serverTimestamp(),
    ...(existing.exists ? {} : { createdAt: FieldValue.serverTimestamp() })
  }, { merge: true });
}

// This runs after every successful website login. It creates a server-owned
// Firestore account record for real users and grants elevated roles only to an
// approved identity or to a role that a trusted admin process issued earlier.
export const bootstrapAccountAccess = onCall({ region: REGION }, async (request) => {
  if (!request.auth || !verifiedEmail(request)) {
    throw new HttpsError("unauthenticated", "Sign in with a verified email address first.");
  }

  const user = await getAuth().getUser(request.auth.uid);
  const email = user.email?.toLowerCase();
  if (!email || !user.emailVerified) {
    throw new HttpsError("permission-denied", "This account has not completed email verification.");
  }

  const role = email === INITIAL_ADMIN_EMAIL ? "admin" : storedRole(user.customClaims);
  if (role !== "customer") {
    await getAuth().setCustomUserClaims(user.uid, {
      ...user.customClaims,
      role,
      staff: true
    });
  }

  await recordAccount(user, role);
  return { role, staff: role !== "customer" };
});

// Retained for existing signed-in staff sessions while the website moves to
// the unified login flow above. New traffic uses bootstrapAccountAccess.
export const bootstrapStaffAccess = onCall({ region: REGION }, async (request) => {
  if (!request.auth || !verifiedEmail(request)) {
    throw new HttpsError("unauthenticated", "Sign in with a verified email address first.");
  }

  const email = (request.auth.token.email as string).toLowerCase();
  if (email !== INITIAL_ADMIN_EMAIL) {
    throw new HttpsError("permission-denied", "This account is not approved for staff access.");
  }

  const user = await getAuth().getUser(request.auth.uid);
  if (user.email?.toLowerCase() !== INITIAL_ADMIN_EMAIL || !user.emailVerified) {
    throw new HttpsError("permission-denied", "This account has not completed email verification.");
  }

  await getAuth().setCustomUserClaims(user.uid, { ...user.customClaims, role: "admin", staff: true });
  await recordAccount(user, "admin");
  return { role: "admin", staff: true };
});

// The alert deliberately excludes customer contact and move details. Those
// remain in the restricted customer records that staff can open when needed.
export const notifyStaffOfNewQuote = onDocumentCreated(
  { region: REGION, document: "customers/{uid}/quotes/{quoteId}" },
  async (event) => {
    await createStaffNotification(
      `quote-${event.params.uid}-${event.params.quoteId}`,
      "New quote request",
      "A customer requested a planning call. Review the customer workspace for details."
    );
  }
);

export const reviewBookingAvailability = onCall({ region: REGION }, async (request) => {
  if (!request.auth || !isStaff(request)) {
    throw new HttpsError("permission-denied", "Staff access is required.");
  }

  const { uid, bookingId, decision } = request.data as ReviewInput;
  if (
    typeof uid !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(uid) ||
    typeof bookingId !== "string" ||
    !/^[A-Za-z0-9_-]{20,}$/.test(bookingId) ||
    (decision !== "approved" && decision !== "declined")
  ) {
    throw new HttpsError("invalid-argument", "A valid booking and availability decision are required.");
  }

  const reference = bookingRef(uid, bookingId);
  const snapshot = await reference.get();
  if (!snapshot.exists || snapshot.data()?.status !== "pending_availability_approval") {
    throw new HttpsError("failed-precondition", "Only paid bookings awaiting approval can be reviewed.");
  }

  await reference.update({
    status: decision === "approved" ? "confirmed" : "availability_declined",
    availabilityDecision: decision,
    availabilityReviewedByUid: request.auth.uid,
    availabilityReviewedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  });

  return { status: decision === "approved" ? "confirmed" : "availability_declined" };
});

export const createCheckoutSession = onCall(
  { region: REGION, secrets: [stripeSecret] },
  async (request) => {
    if (!request.auth || !verifiedEmail(request)) {
      throw new HttpsError("unauthenticated", "Verify your email before paying a booking deposit.");
    }

    const { bookingId } = request.data as CheckoutInput;
    if (typeof bookingId !== "string" || !/^[A-Za-z0-9_-]{20,}$/.test(bookingId)) {
      throw new HttpsError("invalid-argument", "A valid booking request is required.");
    }

    const reference = bookingRef(request.auth.uid, bookingId);
    const snapshot = await reference.get();
    if (!snapshot.exists) {
      throw new HttpsError("not-found", "That booking request was not found.");
    }

    const booking = snapshot.data();
    if (
      !booking ||
      booking.ownerUid !== request.auth.uid ||
      booking.status !== "awaiting_payment" ||
      booking.paymentStatus !== "unpaid" ||
      booking.depositCents !== DEPOSIT_CENTS ||
      booking.hourlyRateCents !== HOURLY_RATE_CENTS
    ) {
      throw new HttpsError("failed-precondition", "That booking request is not eligible for checkout.");
    }

    const stripe = stripeClient(stripeSecret.value());
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        integration_identifier: checkoutIntegrationIdentifier(bookingId),
        customer_email: request.auth.token.email as string,
        client_reference_id: bookingId,
        success_url: `${SITE_URL}/account?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${SITE_URL}/account?checkout=cancelled`,
        metadata: {
          bookingId,
          firebaseUid: request.auth.uid,
          bookingPolicy: "pending_availability_approval"
        },
        payment_intent_data: {
          metadata: {
            bookingId,
            firebaseUid: request.auth.uid,
            bookingPolicy: "pending_availability_approval"
          }
        },
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: "Two-hour moving deposit",
                description: "$125/hour with a two-hour minimum. Deposit is credited to the final bill."
              },
              unit_amount: DEPOSIT_CENTS
            },
            quantity: 1
          }
        ]
      },
      { idempotencyKey: `booking-checkout-${bookingId}` }
    );

    if (!session.url) {
      throw new HttpsError("internal", "Stripe did not return a secure checkout URL.");
    }

    await reference.update({
      checkoutSessionId: session.id,
      checkoutCreatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    return { checkoutUrl: session.url };
  }
);

export const stripeWebhook = onRequest(
  { region: REGION, secrets: [stripeSecret, stripeWebhookSecret] },
  async (request, response) => {
    if (request.method !== "POST") {
      response.status(405).send("Method not allowed");
      return;
    }

    const signature = request.header("stripe-signature");
    if (!signature) {
      response.status(400).send("Missing Stripe signature");
      return;
    }

    let event: Stripe.Event;
    try {
      event = stripeClient(stripeSecret.value()).webhooks.constructEvent(
        request.rawBody,
        signature,
        stripeWebhookSecret.value()
      );
    } catch {
      response.status(400).send("Invalid Stripe signature");
      return;
    }

    const session = event.data.object as Stripe.Checkout.Session;
    const bookingId = session.metadata?.bookingId;
    const firebaseUid = session.metadata?.firebaseUid;
    if (!bookingId || !firebaseUid) {
      response.status(200).send("Ignored");
      return;
    }

    const reference = bookingRef(firebaseUid, bookingId);
    if (
      (event.type === "checkout.session.completed" ||
        event.type === "checkout.session.async_payment_succeeded") &&
      session.payment_status !== "unpaid"
    ) {
      await reference.set({
        status: "pending_availability_approval",
        paymentStatus: "paid",
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
        stripeEventId: event.id,
        paidAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      await createStaffNotification(
        `booking-paid-${firebaseUid}-${bookingId}`,
        "Deposit paid — availability review needed",
        "A paid booking is awaiting your availability decision."
      );
    }

    if (event.type === "checkout.session.async_payment_failed") {
      await reference.set({
        status: "payment_failed",
        paymentStatus: "failed",
        stripeCheckoutSessionId: session.id,
        stripeEventId: event.id,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }

    if (event.type === "checkout.session.expired") {
      await reference.set({
        status: "payment_expired",
        paymentStatus: "expired",
        stripeEventId: event.id,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }

    response.status(200).send("OK");
  }
);
