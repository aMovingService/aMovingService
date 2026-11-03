import { FormEvent, useEffect, useRef, useState } from "react";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  type User
} from "@firebase/auth";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc
} from "@firebase/firestore";
import { httpsCallable } from "@firebase/functions";
import { auth, db, firebaseEnabled, functions, googleProvider } from "./firebase";

const site = {
  name: "A Moving Service"
};
const HOURLY_RATE_CENTS = 12_500;
const DEPOSIT_CENTS = 25_000;
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const hourlyRate = money.format(HOURLY_RATE_CENTS / 100);
const deposit = money.format(DEPOSIT_CENTS / 100);

type MoveSize = "studio" | "one-bedroom" | "two-bedroom" | "three-bedroom" | "four-plus" | "commercial" | "unknown";
type MoveForm = {
  fullName: string; email: string; phone: string; password: string; moveDate: string;
  moveSize: MoveSize; origin: string; destination: string; details: string;
  callWindow: string; arrivalWindow: string;
};
type RecordItem = { id: string; status?: string; paymentStatus?: string; moveDate?: { toDate?: () => Date } };
const blankMove: MoveForm = { fullName: "", email: "", phone: "", password: "", moveDate: "", moveSize: "unknown", origin: "", destination: "", details: "", callWindow: "", arrivalWindow: "" };

function ArrowUpRight() { return <svg aria-hidden="true" viewBox="0 0 24 24" className="icon icon-arrow"><path d="M5 19 19 5M8 5h11v11" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /></svg>; }
function RouteMark() { return <svg aria-hidden="true" className="route-mark" viewBox="0 0 48 48"><path d="M7 37c5.8 4 12.4 4.7 18.7 1.6C32.5 35.4 32.7 26 39 18" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="3" /><circle cx="8" cy="37" fill="currentColor" r="3.5" /><circle cx="39" cy="18" fill="currentColor" r="3.5" /></svg>; }
function Brand() { return <a className="brand" href="/" aria-label="A Moving Service home"><span className="brand-mark" aria-hidden="true">A</span><span><strong>A Moving</strong><small>Service</small></span></a>; }

function useUser() {
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => auth ? onAuthStateChanged(auth, setUser) : undefined, []);
  return user;
}

function errorMessage(error: unknown) {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  if (code === "auth/email-already-in-use") return "An account already exists for that email. Please sign in instead.";
  if (code === "auth/invalid-credential" || code === "auth/wrong-password") return "That email or password did not match an account.";
  if (code === "auth/weak-password") return "Please choose a password with at least 8 characters.";
  return "Something did not go through. Please try again.";
}

async function createCustomerAccount(data: MoveForm) {
  if (!auth) throw new Error("Firebase is not configured.");
  const result = await createUserWithEmailAndPassword(auth, data.email.trim(), data.password);
  await updateProfile(result.user, { displayName: data.fullName.trim() });
  await sendEmailVerification(result.user);
  return result.user;
}

async function saveProfile(user: User, data: MoveForm) {
  if (!db) throw new Error("Firebase is not configured.");
  const profile = doc(db, "customers", user.uid);
  const dataToSave = { schemaVersion: 1, uid: user.uid, fullName: data.fullName.trim(), email: data.email.trim().toLowerCase(), phone: data.phone.trim(), updatedAt: serverTimestamp() };
  if ((await getDoc(profile)).exists()) await updateDoc(profile, dataToSave);
  else await setDoc(profile, { ...dataToSave, createdAt: serverTimestamp() });
}

function Header({ user }: { user: User | null }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const close = () => dialogRef.current?.close();
  return <header className="site-header"><div className="shell header-inner"><Brand /><nav className="desktop-nav" aria-label="Primary navigation"><a href="/#how-it-works">How it works</a><a href="/#pricing">Pricing</a><a href="/quote">Get a quote</a></nav><div className="header-actions"><a className="header-account" href={user ? "/account" : "/login"}>{user ? "My account" : "Customer login"}</a><a className="button button-small button-primary" href="/book">Book a move <ArrowUpRight /></a><button className="menu-button" type="button" onClick={() => dialogRef.current?.showModal()} aria-label="Open navigation menu"><span /><span /></button></div></div><dialog className="mobile-dialog" ref={dialogRef} aria-label="Mobile navigation"><div className="mobile-dialog__inner"><div className="mobile-dialog__top"><Brand /><button className="menu-button menu-button--close" type="button" onClick={close} aria-label="Close navigation menu">×</button></div><nav className="mobile-nav" aria-label="Mobile navigation"><a href="/#how-it-works" onClick={close}>How it works</a><a href="/#pricing" onClick={close}>Pricing</a><a href="/quote" onClick={close}>Get a quote</a><a href={user ? "/account" : "/login"} onClick={close}>{user ? "My account" : "Customer login"}</a></nav><a className="button button-primary mobile-quote" href="/book" onClick={close}>Book a move <ArrowUpRight /></a></div></dialog></header>;
}

function HeroIllustration() { return <div className="hero-visual" aria-hidden="true"><div className="hero-grid" /><div className="sun-disc" /><svg className="hero-route" viewBox="0 0 600 520" fill="none"><path d="M12 468C89 388 113 312 187 297c76-15 103 86 194 42 75-36 81-143 192-194" stroke="currentColor" strokeDasharray="3 13" strokeLinecap="round" strokeWidth="4" /><circle cx="12" cy="468" fill="currentColor" r="8" /><circle cx="573" cy="145" fill="currentColor" r="8" /></svg><div className="box box-one"><span>01</span></div><div className="box box-two"><span>02</span></div><div className="box box-three"><span>03</span></div><div className="move-note"><RouteMark /><span>Your move,<br />mapped out.</span></div></div>; }

function Footer() { return <footer className="site-footer"><div className="shell footer-inner"><Brand /><p>© {new Date().getFullYear()} {site.name}</p><div><a href="/login">Customer login</a><a href="/admin">Staff sign-in</a><a href="/quote">Get a quote</a></div></div></footer>; }

function Home({ user }: { user: User | null }) {
  return <><Header user={user} /><main id="main-content"><section className="hero shell"><div className="hero-copy"><p className="eyebrow"><RouteMark /> A considered start</p><h1>Start your move with a <em>clearer</em> plan.</h1><p className="hero-lede">Request a quote and choose a call time, or reserve your move online with a {deposit} deposit.</p><div className="hero-actions"><a className="button button-primary" href="/book">Book a move <ArrowUpRight /></a><a className="text-link" href="/quote">Get a quote <ArrowUpRight /></a></div></div><HeroIllustration /></section><section className="statement-section" id="how-it-works"><div className="shell"><div className="section-intro"><p className="eyebrow">How it works</p><h2>Choose the next step that fits your move.</h2></div><ol className="steps-grid"><li><span>01</span><h3>Share your move</h3><p>Tell us your timing, locations, and move details. We’ll save it privately to your account.</p></li><li><span>02</span><h3>Book a call</h3><p>Request a quote and select the best time for a quick planning call.</p></li><li><span>03</span><h3>Reserve online</h3><p>When you are ready, complete the two-hour deposit to start your booking.</p></li></ol></div></section><section className="pricing-section" id="pricing"><div className="shell pricing-grid"><div><p className="eyebrow">Simple starting rate</p><h2>{hourlyRate}/hour.</h2><p>Start with a two-hour minimum, reserved with a {deposit} booking deposit.</p></div><div className="pricing-card"><strong>{deposit}</strong><span>Two-hour booking deposit</span><p>Applied to your final moving bill. Fully refundable with 48+ hours’ notice; nonrefundable inside 48 hours.</p><a className="text-link" href="/book">Book your move <ArrowUpRight /></a></div></div></section><section className="details-section shell"><div className="details-art" aria-hidden="true"><div className="details-art__circle" /><div className="details-art__paper" /><span>Details<br />matter.</span></div><div className="details-copy"><p className="eyebrow">Built around your move</p><h2>Useful plans begin with useful details.</h2><p>Dates, access, distances, and the kind of help you have in mind all shape a move. Your account keeps your requests in one private place.</p><div className="detail-list"><div><span>01</span><strong>Your timing</strong><p>When the move needs to happen.</p></div><div><span>02</span><strong>Your locations</strong><p>Where the move begins and ends.</p></div><div><span>03</span><strong>Your priorities</strong><p>The details that deserve extra attention.</p></div></div></div></section><section className="faq-section"><div className="shell faq-layout"><div><p className="eyebrow eyebrow-light">Questions</p><h2>Know what you are reserving.</h2><p>We make the starting rate and booking policy clear before you pay.</p></div><div className="faq-list"><details open><summary>What is the booking deposit?<span>+</span></summary><p>The {deposit} deposit reserves the first two hours of moving time and is credited to your final moving bill.</p></details><details><summary>What is the cancellation policy?<span>+</span></summary><p>Your deposit is fully refundable with at least 48 hours’ notice. It is nonrefundable inside 48 hours of the scheduled move.</p></details><details><summary>Can I request a quote first?<span>+</span></summary><p>Yes. Share your move details and preferred call window; we’ll use your request to begin the conversation.</p></details></div></div></section><section className="quote-section"><div className="shell quote-layout"><div className="quote-intro"><p className="eyebrow eyebrow-light">Two ways to begin</p><h2>Talk first or reserve now.</h2><p>Both paths create a private customer account, so you can return to your move details later.</p></div><div className="path-actions"><a className="path-card" href="/quote"><span>01</span><h3>Get a quote</h3><p>Share details and request a call.</p><ArrowUpRight /></a><a className="path-card path-card--light" href="/book"><span>02</span><h3>Book a move</h3><p>Choose your move date and pay the {deposit} booking deposit.</p><ArrowUpRight /></a></div></div></section></main><Footer /></>;
}

function MoveFields({ data, setData, booking }: { data: MoveForm; setData: (next: MoveForm) => void; booking: boolean }) {
  const update = (field: keyof MoveForm, value: string) => setData({ ...data, [field]: value });
  return <div className="form-grid"><label htmlFor="name">Your name<input id="name" autoComplete="name" maxLength={120} onChange={(event) => update("fullName", event.target.value)} required value={data.fullName} /></label><label htmlFor="email">Email<input id="email" autoComplete="email" maxLength={254} onChange={(event) => update("email", event.target.value)} required type="email" value={data.email} /></label><label htmlFor="phone">Phone<input id="phone" autoComplete="tel" inputMode="tel" maxLength={32} minLength={7} onChange={(event) => update("phone", event.target.value)} required value={data.phone} /></label><label htmlFor="move-date">Move date<input id="move-date" min={new Date().toISOString().slice(0, 10)} onChange={(event) => update("moveDate", event.target.value)} required type="date" value={data.moveDate} /></label><label htmlFor="move-size">Move size<select id="move-size" onChange={(event) => update("moveSize", event.target.value)} value={data.moveSize}><option value="unknown">Not sure yet</option><option value="studio">Studio</option><option value="one-bedroom">One bedroom</option><option value="two-bedroom">Two bedrooms</option><option value="three-bedroom">Three bedrooms</option><option value="four-plus">Four+ bedrooms</option><option value="commercial">Commercial</option></select></label><label htmlFor={booking ? "arrival-window" : "call-window"}>{booking ? "Preferred arrival window" : "Best call time"}<select id={booking ? "arrival-window" : "call-window"} onChange={(event) => update(booking ? "arrivalWindow" : "callWindow", event.target.value)} required value={booking ? data.arrivalWindow : data.callWindow}><option value="">Select one</option><option value="morning">Morning</option><option value="midday">Midday</option><option value="afternoon">Afternoon</option>{!booking && <option value="evening">Evening</option>}</select></label><label htmlFor="origin">Moving from<input id="origin" maxLength={160} onChange={(event) => update("origin", event.target.value)} placeholder="City or neighborhood" required value={data.origin} /></label><label htmlFor="destination">Moving to<input id="destination" maxLength={160} onChange={(event) => update("destination", event.target.value)} placeholder="City or neighborhood" required value={data.destination} /></label><label className="form-full" htmlFor="details">Anything else we should know?<span className="optional">Optional</span><textarea id="details" maxLength={4000} onChange={(event) => update("details", event.target.value)} placeholder="Home size, access details, or the help you have in mind" rows={4} value={data.details} /></label></div>;
}

function AccountPassword({ data, setData, user }: { data: MoveForm; setData: (next: MoveForm) => void; user: User | null }) {
  if (user) return null;
  return <label className="account-password" htmlFor="password">Create a password<span className="optional">8+ characters — creates your private customer account</span><input id="password" autoComplete="new-password" minLength={8} onChange={(event) => setData({ ...data, password: event.target.value })} required type="password" value={data.password} /></label>;
}

function MovePage({ user, booking }: { user: User | null; booking: boolean }) {
  const [data, setData] = useState<MoveForm>({ ...blankMove, fullName: user?.displayName ?? "", email: user?.email ?? "" });
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => setData((current) => ({ ...current, fullName: current.fullName || user?.displayName || "", email: current.email || user?.email || "" })), [user]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth || !db || !firebaseEnabled || (booking && !functions)) { setStatus("The secure customer service is being connected. Please try again shortly."); return; }
    setSaving(true); setStatus("");
    try {
      const activeUser = user ?? await createCustomerAccount(data);
      if (booking && !activeUser.emailVerified) { await sendEmailVerification(activeUser); setStatus("Check your email and verify your address before paying the deposit. Your move details have not been submitted or charged."); setSaving(false); return; }
      await saveProfile(activeUser, data);
      const common = { schemaVersion: 1, ownerUid: activeUser.uid, fullName: data.fullName.trim(), email: data.email.trim().toLowerCase(), phone: data.phone.trim(), moveDate: new Date(`${data.moveDate}T12:00:00`), moveSize: data.moveSize, origin: data.origin.trim(), destination: data.destination.trim(), details: data.details.trim(), createdAt: serverTimestamp() };
      if (!booking) {
        await addDoc(collection(db, "customers", activeUser.uid, "quotes"), { ...common, status: "submitted", preferredCallWindow: data.callWindow, submittedAt: serverTimestamp() });
        window.location.assign("/account?notice=quote-saved");
      } else {
        const record = await addDoc(collection(db, "customers", activeUser.uid, "bookingRequests"), { ...common, status: "awaiting_payment", paymentStatus: "unpaid", arrivalWindow: data.arrivalWindow, hourlyRateCents: HOURLY_RATE_CENTS, depositCents: DEPOSIT_CENTS, updatedAt: serverTimestamp() });
        const checkout = httpsCallable<{ bookingId: string }, { checkoutUrl: string }>(functions!, "createCheckoutSession");
        const checkoutResult = await checkout({ bookingId: record.id });
        window.location.assign(checkoutResult.data.checkoutUrl);
      }
    } catch (error) { setStatus(errorMessage(error)); setSaving(false); }
  }
  const title = booking ? "Reserve your starting time." : "Tell us what your move needs.";
  const description = booking ? <><strong>{hourlyRate}/hour</strong> with a <strong>{deposit} two-hour booking deposit</strong>, credited toward your final bill.</> : <>We’ll create a private account for you, save your request, and use your preferred time to schedule a call.</>;
  return <><Header user={user} /><main className="form-page shell" id="main-content"><a className="back-link" href="/"><span>←</span> Back home</a><div className="form-page__intro"><p className="eyebrow">{booking ? "Book a move" : "Get a quote"}</p><h1>{title}</h1><p>{description}</p>{booking && <p className="form-page__hint">Fully refundable with 48+ hours’ notice; nonrefundable inside 48 hours.</p>}{!user && <p className="form-page__hint">Already have an account? <a href={`/login?next=${booking ? "book" : "quote"}`}>Sign in</a>.</p>}</div><form className="customer-form" onSubmit={submit}><MoveFields booking={booking} data={data} setData={setData} /><AccountPassword data={data} setData={setData} user={user} /><div className="form-footer form-footer--page"><p>{booking ? `You will continue to Stripe’s secure checkout to pay the ${deposit} deposit. Payment places your move in pending availability approval; it is not an automatic confirmation.` : "We use these details to prepare your quote and call. Your account keeps them private."}</p><button className="button button-primary" disabled={saving} type="submit">{saving ? "Saving your request…" : booking ? `Continue to ${deposit} payment` : "Save request & book a call"} <ArrowUpRight /></button></div>{status && <p className="form-status form-status--page" role="alert">{status}</p>}</form></main><Footer /></>;
}

function Login({ user }: { user: User | null }) {
  const destination = new URLSearchParams(window.location.search).get("next") === "book" ? "/book" : new URLSearchParams(window.location.search).get("next") === "quote" ? "/quote" : "/account";
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [status, setStatus] = useState(""); const [submitting, setSubmitting] = useState(false);
  useEffect(() => { if (user) window.location.replace(destination); }, [destination, user]);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!auth) return; setSubmitting(true); setStatus(""); try { await signInWithEmailAndPassword(auth, email, password); window.location.assign(destination); } catch (error) { setStatus(errorMessage(error)); setSubmitting(false); } }
  return <><Header user={user} /><main className="auth-page shell" id="main-content"><div className="auth-card"><p className="eyebrow">Customer login</p><h1>Welcome back.</h1><p>Sign in to view your quote requests and bookings.</p><form onSubmit={submit}><label>Email<input autoComplete="email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} /></label><label>Password<input autoComplete="current-password" minLength={8} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label><button className="button button-primary" disabled={submitting} type="submit">{submitting ? "Signing in…" : "Sign in"} <ArrowUpRight /></button></form><p className="form-page__hint">New here? Start with a <a href="/quote">quote request</a> or <a href="/book">move booking</a>.</p>{status && <p className="form-status form-status--page" role="alert">{status}</p>}</div></main><Footer /></>;
}

function Account({ user }: { user: User | null }) {
  const [quotes, setQuotes] = useState<RecordItem[]>([]); const [bookings, setBookings] = useState<RecordItem[]>([]); const [status, setStatus] = useState("");
  useEffect(() => { if (!user || !db) return; const stopQuotes = onSnapshot(query(collection(db, "customers", user.uid, "quotes"), orderBy("createdAt", "desc")), (snapshot) => setQuotes(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))), () => setStatus("We could not load your quote requests.")); const stopBookings = onSnapshot(query(collection(db, "customers", user.uid, "bookingRequests"), orderBy("createdAt", "desc")), (snapshot) => setBookings(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))), () => setStatus("We could not load your booking requests.")); return () => { stopQuotes(); stopBookings(); }; }, [user]);
  if (!user) return <Login user={user} />;
  const notice = new URLSearchParams(window.location.search).get("notice");
  const printDate = (item: RecordItem) => item.moveDate?.toDate?.().toLocaleDateString() ?? "Move date pending";
  const bookingLabel = (item: RecordItem) => item.paymentStatus === "paid" ? "Deposit paid — pending approval" : item.paymentStatus === "expired" ? "Payment link expired" : item.paymentStatus === "failed" ? "Payment unsuccessful — please try again" : "Awaiting payment";
  return <><Header user={user} /><main className="account-page shell" id="main-content"><div className="account-heading"><p className="eyebrow">Customer account</p><h1>Your move details, in one place.</h1><p>Signed in as <strong>{user.email}</strong>.</p>{!user.emailVerified && <div className="verification-note"><strong>Verify your email before paying a booking deposit.</strong><button type="button" onClick={() => sendEmailVerification(user).then(() => setStatus("Verification email sent. Check your inbox, then refresh this page.")).catch(() => setStatus("We could not send a verification email. Please try again later."))}>Send verification email</button></div>}{notice === "quote-saved" && <p className="account-success">Your quote request was saved. We’ll use your preferred call window to follow up.</p>}{new URLSearchParams(window.location.search).get("checkout") === "success" && <p className="account-success">Stripe is confirming your deposit. Your move remains pending availability approval.</p>}</div><div className="account-actions"><a className="button button-primary" href="/book">Book a move <ArrowUpRight /></a><a className="button button-outline" href="/quote">Request another quote</a><button className="text-button" type="button" onClick={() => auth && signOut(auth).then(() => window.location.assign("/"))}>Sign out</button></div><section className="account-section"><h2>Quote requests</h2>{quotes.length ? <ul className="record-list">{quotes.map((item) => <li key={item.id}><strong>{printDate(item)}</strong><span>{item.status ?? "submitted"}</span></li>)}</ul> : <p>You have not submitted a quote request yet.</p>}</section><section className="account-section"><h2>Bookings</h2>{bookings.length ? <ul className="record-list">{bookings.map((item) => <li key={item.id}><strong>{printDate(item)}</strong><span>{bookingLabel(item)}</span></li>)}</ul> : <p>You have not started a booking yet.</p>}</section>{status && <p className="form-status form-status--page" role="status">{status}</p>}</main><Footer /></>;
}

function Admin() {
  const user = useUser(); const [error, setError] = useState("");
  async function login() { if (!auth || !googleProvider) return; try { await signInWithPopup(auth, googleProvider); } catch { setError("Sign-in could not be completed. Confirm that this domain is authorized in Firebase Authentication."); } }
  return <main className="admin-page"><div className="admin-card"><Brand /><p className="eyebrow">Staff portal</p><h1>Lead workspace</h1>{!firebaseEnabled ? <p>Firebase configuration is being connected. Staff sign-in will be available shortly.</p> : user ? <><p>Signed in as <strong>{user.email ?? "staff member"}</strong>.</p><p>Lead access is intentionally locked until the secure staff role is activated.</p><button className="button button-primary" onClick={() => auth && signOut(auth)} type="button">Sign out</button></> : <><p>Use an approved Google account to access staff tools.</p><button className="button button-primary" onClick={login} type="button">Continue with Google <ArrowUpRight /></button></>}{error && <p className="form-status form-status--dark" role="alert">{error}</p>}<a className="text-link" href="/">Return to the site <ArrowUpRight /></a></div></main>;
}

function App() {
  const user = useUser(); const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/admin") return <Admin />;
  if (path === "/quote") return <MovePage user={user} booking={false} />;
  if (path === "/book") return <MovePage user={user} booking />;
  if (path === "/login") return <Login user={user} />;
  if (path === "/account") return <Account user={user} />;
  return <><a className="skip-link" href="#main-content">Skip to content</a><Home user={user} /></>;
}

export default App;
