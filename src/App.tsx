import { FormEvent, useEffect, useRef, useState } from "react";
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User
} from "@firebase/auth";
import { auth, firebaseEnabled, googleProvider } from "./firebase";

const site = {
  name: "A Moving Service",
  contactEmail: import.meta.env.VITE_CONTACT_EMAIL?.trim() ?? "",
  contactPhone: import.meta.env.VITE_CONTACT_PHONE?.trim() ?? "",
  serviceArea: import.meta.env.VITE_SERVICE_AREA?.trim() ?? ""
};

type QuoteData = {
  name: string;
  email: string;
  phone: string;
  moveDate: string;
  from: string;
  to: string;
  details: string;
};

const blankQuote: QuoteData = {
  name: "",
  email: "",
  phone: "",
  moveDate: "",
  from: "",
  to: "",
  details: ""
};

const navigation = [
  ["How it works", "#how-it-works"],
  ["Move details", "#move-details"],
  ["Questions", "#questions"],
  ["Contact", "#contact"]
] as const;

function ArrowUpRight() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="icon icon-arrow">
      <path d="M5 19 19 5M8 5h11v11" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}

function RouteMark() {
  return (
    <svg aria-hidden="true" className="route-mark" viewBox="0 0 48 48">
      <path d="M7 37c5.8 4 12.4 4.7 18.7 1.6C32.5 35.4 32.7 26 39 18" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="3" />
      <circle cx="8" cy="37" fill="currentColor" r="3.5" />
      <circle cx="39" cy="18" fill="currentColor" r="3.5" />
    </svg>
  );
}

function Brand() {
  return (
    <a className="brand" href="#top" aria-label="A Moving Service home">
      <span className="brand-mark" aria-hidden="true">A</span>
      <span>
        <strong>A Moving</strong>
        <small>Service</small>
      </span>
    </a>
  );
}

function scrollToQuote() {
  document.getElementById("contact")?.scrollIntoView({ behavior: "smooth", block: "start" });
  window.setTimeout(() => document.getElementById("quote-name")?.focus(), 550);
}

function Header() {
  const dialogRef = useRef<HTMLDialogElement>(null);

  const openMenu = () => dialogRef.current?.showModal();
  const closeMenu = () => dialogRef.current?.close();

  return (
    <header className="site-header">
      <div className="shell header-inner">
        <Brand />
        <nav className="desktop-nav" aria-label="Primary navigation">
          {navigation.map(([label, href]) => <a href={href} key={href}>{label}</a>)}
        </nav>
        <div className="header-actions">
          <button className="button button-small button-primary" type="button" onClick={scrollToQuote}>
            Request a quote <ArrowUpRight />
          </button>
          <button className="menu-button" type="button" onClick={openMenu} aria-label="Open navigation menu">
            <span />
            <span />
          </button>
        </div>
      </div>
      <dialog className="mobile-dialog" ref={dialogRef} aria-label="Mobile navigation">
        <div className="mobile-dialog__inner">
          <div className="mobile-dialog__top"><Brand /><button className="menu-button menu-button--close" type="button" onClick={closeMenu} aria-label="Close navigation menu">×</button></div>
          <nav className="mobile-nav" aria-label="Mobile navigation">
            {navigation.map(([label, href]) => <a href={href} key={href} onClick={closeMenu}>{label}</a>)}
          </nav>
          <button className="button button-primary mobile-quote" type="button" onClick={() => { closeMenu(); scrollToQuote(); }}>
            Request a quote <ArrowUpRight />
          </button>
        </div>
      </dialog>
    </header>
  );
}

function HeroIllustration() {
  return (
    <div className="hero-visual" aria-hidden="true">
      <div className="hero-grid" />
      <div className="sun-disc" />
      <svg className="hero-route" viewBox="0 0 600 520" fill="none">
        <path d="M12 468C89 388 113 312 187 297c76-15 103 86 194 42 75-36 81-143 192-194" stroke="currentColor" strokeDasharray="3 13" strokeLinecap="round" strokeWidth="4" />
        <circle cx="12" cy="468" fill="currentColor" r="8" />
        <circle cx="573" cy="145" fill="currentColor" r="8" />
      </svg>
      <div className="box box-one"><span>01</span></div>
      <div className="box box-two"><span>02</span></div>
      <div className="box box-three"><span>03</span></div>
      <div className="move-note"><RouteMark /><span>Your move,<br />mapped out.</span></div>
    </div>
  );
}

function QuoteForm() {
  const [quote, setQuote] = useState<QuoteData>(blankQuote);
  const [status, setStatus] = useState<string>("");
  const quoteIntakeLive = Boolean(site.contactEmail);

  const update = (field: keyof QuoteData, value: string) => setQuote((current) => ({ ...current, [field]: value }));

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!quoteIntakeLive) {
      setStatus("Online quote delivery is being connected. Please check back once the business contact details are published.");
      return;
    }

    const subject = encodeURIComponent(`Quote request from ${quote.name}`);
    const body = encodeURIComponent([
      `Name: ${quote.name}`,
      `Email: ${quote.email}`,
      `Phone: ${quote.phone}`,
      `Move date: ${quote.moveDate || "Not supplied"}`,
      `Moving from: ${quote.from || "Not supplied"}`,
      `Moving to: ${quote.to || "Not supplied"}`,
      "",
      "Move details:",
      quote.details || "Not supplied"
    ].join("\n"));

    setStatus("Your email app will open with your request ready to send.");
    window.location.href = `mailto:${site.contactEmail}?subject=${subject}&body=${body}`;
  }

  return (
    <form className="quote-form" onSubmit={handleSubmit}>
      <div className="form-topline"><span className="eyebrow eyebrow-light">Start your request</span><span className="form-step">A few helpful details</span></div>
      <div className="form-grid">
        <label htmlFor="quote-name">Your name<input id="quote-name" autoComplete="name" maxLength={120} onChange={(event) => update("name", event.target.value)} required value={quote.name} /></label>
        <label htmlFor="quote-email">Email<input id="quote-email" autoComplete="email" maxLength={254} onChange={(event) => update("email", event.target.value)} required type="email" value={quote.email} /></label>
        <label htmlFor="quote-phone">Phone<input id="quote-phone" autoComplete="tel" inputMode="tel" maxLength={32} minLength={7} onChange={(event) => update("phone", event.target.value)} required value={quote.phone} /></label>
        <label htmlFor="quote-date">Move date<span className="optional">Optional</span><input id="quote-date" onChange={(event) => update("moveDate", event.target.value)} type="date" value={quote.moveDate} /></label>
        <label htmlFor="quote-from">Moving from<span className="optional">Optional</span><input id="quote-from" maxLength={160} onChange={(event) => update("from", event.target.value)} placeholder="City or neighborhood" value={quote.from} /></label>
        <label htmlFor="quote-to">Moving to<span className="optional">Optional</span><input id="quote-to" maxLength={160} onChange={(event) => update("to", event.target.value)} placeholder="City or neighborhood" value={quote.to} /></label>
        <label className="form-full" htmlFor="quote-details">Anything else we should know?<span className="optional">Optional</span><textarea id="quote-details" maxLength={4000} onChange={(event) => update("details", event.target.value)} placeholder="Home size, access details, or the help you have in mind" rows={4} value={quote.details} /></label>
      </div>
      <div className="form-footer">
        <p>By sending this request, you are asking {site.name} to contact you about your move. We do not publish your details.</p>
        <button className="button button-paper" type="submit">{quoteIntakeLive ? "Send quote request" : "Quote intake being connected"} <ArrowUpRight /></button>
      </div>
      {!quoteIntakeLive && <p className="form-status" aria-live="polite">Online quote delivery will be enabled after the business contact details are published.</p>}
      {status && <p className="form-status" aria-live="polite">{status}</p>}
    </form>
  );
}

function AdminView() {
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, setUser);
  }, []);

  async function handleSignIn() {
    if (!auth || !googleProvider) return;
    setError("");
    try {
      await signInWithPopup(auth, googleProvider);
    } catch {
      setError("Sign-in could not be completed. Confirm that this domain is authorized in Firebase Authentication.");
    }
  }

  return (
    <main className="admin-page">
      <div className="admin-card">
        <Brand />
        <p className="eyebrow">Staff portal</p>
        <h1>Lead workspace</h1>
        {!firebaseEnabled ? (
          <p>Firebase configuration is being connected. Staff sign-in will be available shortly.</p>
        ) : user ? (
          <>
            <p>Signed in as <strong>{user.email ?? "staff member"}</strong>.</p>
            <p>Lead access is intentionally locked until the secure intake service and staff role are activated.</p>
            <button className="button button-primary" onClick={() => auth && signOut(auth)} type="button">Sign out</button>
          </>
        ) : (
          <>
            <p>Use an approved Google account to access staff tools.</p>
            <button className="button button-primary" onClick={handleSignIn} type="button">Continue with Google <ArrowUpRight /></button>
          </>
        )}
        {error && <p className="form-status form-status--dark" role="alert">{error}</p>}
        <a className="text-link" href="/">Return to the site <ArrowUpRight /></a>
      </div>
    </main>
  );
}

function App() {
  if (window.location.pathname.replace(/\/+$/, "") === "/admin") return <AdminView />;

  return (
    <div id="top">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <Header />
      <main id="main-content">
        <section className="hero shell">
          <div className="hero-copy reveal">
            <p className="eyebrow"><RouteMark /> A considered start</p>
            <h1>Start your move with a <em>clearer</em> plan.</h1>
            <p className="hero-lede">Tell us a little about your move. We’ll help you begin the conversation with the details that matter.</p>
            <div className="hero-actions">
              <button className="button button-primary" type="button" onClick={scrollToQuote}>Request a quote <ArrowUpRight /></button>
              <a className="text-link" href="#how-it-works">See how it works <ArrowUpRight /></a>
            </div>
            {site.serviceArea && <p className="service-area-note">Serving {site.serviceArea}</p>}
          </div>
          <HeroIllustration />
        </section>

        <section className="statement-section" id="how-it-works">
          <div className="shell">
            <div className="section-intro"><p className="eyebrow">How it works</p><h2>A move has a lot of pieces. Start with the ones that shape the plan.</h2></div>
            <ol className="steps-grid">
              <li><span>01</span><h3>Share the essentials</h3><p>Your timeline, locations, and a few important details give the conversation a useful starting point.</p></li>
              <li><span>02</span><h3>Describe the move</h3><p>Every move is different. Tell us what matters so the next step is built around your situation.</p></li>
              <li><span>03</span><h3>Request a quote</h3><p>Send your request when you are ready to discuss the move in more detail.</p></li>
            </ol>
          </div>
        </section>

        <section className="details-section shell" id="move-details">
          <div className="details-art" aria-hidden="true"><div className="details-art__circle" /><div className="details-art__paper" /><span>Details<br />matter.</span></div>
          <div className="details-copy"><p className="eyebrow">Built around your move</p><h2>Useful plans begin with useful details.</h2><p>Dates, access, distances, and the kind of help you have in mind all shape a move. Start by sharing what you know—there is room to work through the rest.</p><div className="detail-list"><div><span>01</span><strong>Your timing</strong><p>When the move needs to happen.</p></div><div><span>02</span><strong>Your locations</strong><p>Where the move begins and ends.</p></div><div><span>03</span><strong>Your priorities</strong><p>The details that deserve extra attention.</p></div></div></div>
        </section>

        <section className="faq-section" id="questions">
          <div className="shell faq-layout"><div><p className="eyebrow eyebrow-light">Questions</p><h2>What should you have ready?</h2><p>These are a few helpful starting points. Specific service and scheduling details will be confirmed directly.</p></div><div className="faq-list"><details open><summary>What information should I have ready when requesting a quote?<span>+</span></summary><p>A move date, your starting and ending locations, and the basics of what you are moving are a useful place to begin.</p></details><details><summary>What can affect the scope of a move?<span>+</span></summary><p>Access, timing, the size of the move, and anything requiring special handling can all help shape the conversation.</p></details><details><summary>How should I describe my move?<span>+</span></summary><p>Share what you know now. A clear note about your timing, locations, and priorities helps guide the next step.</p></details></div></div>
        </section>

        <section className="quote-section" id="contact">
          <div className="shell quote-layout"><div className="quote-intro"><p className="eyebrow eyebrow-light">Request a quote</p><h2>Ready to talk through your move?</h2><p>Share a few details and we’ll use them to begin the conversation.</p>{site.contactPhone && <a className="phone-link" href={`tel:${site.contactPhone.replace(/[^+\d]/g, "")}`}>{site.contactPhone}</a>}{site.contactEmail && <a className="email-link" href={`mailto:${site.contactEmail}`}>{site.contactEmail}</a>}</div><QuoteForm /></div>
        </section>
      </main>
      <footer className="site-footer"><div className="shell footer-inner"><Brand /><p>© {new Date().getFullYear()} {site.name}</p><div><a href="/admin">Staff sign-in</a><a href="#contact">Request a quote</a></div></div></footer>
    </div>
  );
}

export default App;
