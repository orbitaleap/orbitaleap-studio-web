/**
 * The one submit path for every lead form on this site.
 *
 * There are three — the contact modal, the /launch hero form and the test's
 * unlock form — and each had its own copy of "build the payload and post it".
 * They drifted: only /launch sent the timing stamp, only two of the three
 * carried a honeypot, only two reset the Turnstile token after a failure, and
 * the test form reported failures to the console and nowhere else.
 *
 * Every one of those is a security or delivery measure, so they are no longer
 * a per-form decision. A form supplies its `source` and, if it composes its
 * message from something other than a `message` field, a `buildMessage`. The
 * protections come with the helper whether the caller remembers them or not.
 */

/** What the form contributes; everything else is added here. */
export interface LeadFormOptions {
  /** Which form this is. Lands in the email subject and body verbatim. */
  source: string;
  /**
   * Builds the message body from the form's data. Defaults to the `message`
   * field. The test form overrides this to send the quiz answers.
   */
  buildMessage?: (fd: FormData) => string;
}

export interface LeadResult {
  ok: boolean;
  /** 0 when the request never reached the server. */
  status: number;
  /** Present when `ok` is false. Safe to show to the visitor as-is. */
  error?: string;
}

import { readAttribution } from './attribution';

const ENDPOINT = '/api/send-email';

const CONNECTION_ERROR =
  'No hemos podido conectar. Comprueba tu conexión e inténtalo de nuevo.';

const UNKNOWN_ERROR =
  'No se ha podido enviar. Inténtalo de nuevo en unos segundos.';

/**
 * Wires a form to the lead endpoint. Call once, at setup — NOT inside the
 * submit handler, because the returned function closes over the moment the
 * form became available, which is what the timing check measures against.
 */
export function createLeadSubmitter(form: HTMLFormElement, options: LeadFormOptions) {
  // Stamped when the form is wired, not when it is submitted. The endpoint
  // rejects anything completed in under 2.5s: a person cannot read the fields,
  // type and submit inside that, and a script posting at the endpoint has no
  // reason to wait.
  const openedAt = Date.now();

  const text = (fd: FormData, key: string) => String(fd.get(key) ?? '').trim();

  return async function submitLead(): Promise<LeadResult> {
    const fd = new FormData(form);

    const payload = {
      name: text(fd, 'name'),
      email: text(fd, 'email'),
      phone: text(fd, 'phone'),
      company: text(fd, 'company'),
      message: options.buildMessage ? options.buildMessage(fd) : text(fd, 'message'),
      source: options.source,
      // RGPD art. 7 — the endpoint refuses a submission without it.
      consent: fd.get('consent') === 'on',
      turnstileToken: text(fd, 'cf-turnstile-response'),
      // Hidden field. Anything in it means a bot filled the form blind.
      website_url: text(fd, 'website_url'),
      elapsed: Date.now() - openedAt,
      // Where this visit started. Read here rather than per-form so all three
      // report it the same way — see lib/attribution.ts for what is and is
      // not stored on the device.
      attribution: readAttribution(),
    };

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({} as { error?: string; delivered?: boolean }));

      // Turnstile tokens are single-use. None of these forms navigate on a
      // failed submit, so without a reset the next attempt re-sends a redeemed
      // token — Cloudflare rejects it as timeout-or-duplicate and the visitor
      // gets a second failure that has nothing to do with what they typed.
      if (!res.ok) resetTurnstile();

      // A conversion is a LEAD — somebody whose message actually reached the
      // inbox. Not merely a 200: the honeypot answers 200 on purpose so a bot
      // believes it succeeded, and counting those inflated the figure with
      // exactly the traffic the honeypot exists to discard. The endpoint says
      // which it was.
      // Awaited, not fired and forgotten: the caller may navigate the moment
      // this resolves, and an unsent conversion is indistinguishable from no
      // lead at all.
      if (res.ok && data?.delivered !== false) {
        await reportConversion(await userData(payload.email, payload.phone));
      }

      return { ok: res.ok, status: res.status, error: res.ok ? undefined : data?.error || UNKNOWN_ERROR };
    } catch {
      resetTurnstile();
      return { ok: false, status: 0, error: CONNECTION_ERROR };
    }
  };
}

function resetTurnstile() {
  (window as unknown as { turnstile?: { reset: () => void } }).turnstile?.reset();
}

/**
 * The "Solicitud de presupuesto" conversion, fired on a submission the server
 * accepted — every form, not just the paid one.
 *
 * The account's other conversion action is URL-based and watches
 * /launch/deployed, so it only ever counted the /launch funnel. A lead
 * through the contact modal or the autodiagnóstico test recorded nothing at
 * all, which is why a real lead this month could not be traced to a channel.
 * Firing on the submit itself counts the thing that actually happened.
 *
 * Guarded because gtag is absent by design on /launch/deployed, which loads
 * its own gated tag; there, this is a no-op and that page's own conversion
 * still fires. Consent Mode governs the rest: while advertising is denied the
 * tag sends a cookieless ping rather than writing anything.
 */
// The conversion action this fires.
//
// This label is a hard dependency on a specific action existing in Google Ads:
// delete the action and every conversion is still accepted by the browser and
// then silently discarded, with nothing in either system to say why. It has
// now been rebuilt twice, so if the action is ever recreated again this line
// has to change with it.
const CONVERSION_ID = 'AW-18312929105/rAIrCP7Z2N0cENG-pJxE';

/**
 * Resolves once the conversion has actually left the browser — or after a
 * short grace period, whichever comes first.
 *
 * gtag('event', …) issues a network request and returns immediately. On
 * /launch the caller then navigates to the thank-you page, and the browser
 * cancels the in-flight request on the way out: the lead arrived, the email
 * was sent, and Google never heard about it. That is what kept the conversion
 * action reporting no data despite real submissions.
 *
 * event_callback is gtag's answer — it runs once the hit is away. The timeout
 * is the safety net Google's own documentation recommends: if the tag is
 * blocked or slow, a visitor must not be stranded on a form that appears to
 * have done nothing, so the redirect goes ahead regardless.
 */
/**
 * Enhanced conversions: the email and phone the visitor typed, hashed, sent
 * alongside the conversion so Google can match it to the click that earned it.
 *
 * It recovers attribution that cookies lose — Safari's restrictions, a click on
 * a phone and a form filled on a laptop — typically 5-15% more conversions
 * credited to the campaign that actually produced them. At this volume, where
 * bidding is still trying to leave learning phase, those are the conversions
 * that matter most.
 *
 * ─── What leaves the browser ─────────────────────────────────────────────
 *
 * SHA-256 of a normalised value, and nothing else. Never the address itself.
 * Google's own matching works on the same digest, so hashing costs nothing in
 * accuracy and means the plaintext never crosses the wire.
 *
 * Normalisation is Google's, not ours, and it has to match exactly or the
 * hash matches nothing: trim, lowercase, and for phones E.164 — digits with a
 * leading +, no spaces or punctuation. A Spanish number typed as
 * "623 94 75 98" becomes "+34623947598".
 *
 * ─── Why this is done manually ───────────────────────────────────────────
 *
 * The automatic mode scans the page for anything that looks like an email
 * field and sends what it finds. That is a lot of guessing about which inputs
 * on a page are a customer's own address, and it would apply to every page the
 * tag loads on. Sending exactly the field the visitor filled in, at exactly
 * the moment they submitted it, is both more accurate and easier to describe
 * in a privacy policy.
 *
 * Consent still governs it: Consent Mode denies ad_user_data until the visitor
 * accepts the banner, and Google drops the user data when it is denied.
 */
async function sha256(value: string): Promise<string | undefined> {
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // No SubtleCrypto (an insecure context, essentially never in production).
    // The conversion still fires; it just goes without the extra matching.
    return undefined;
  }
}

/** E.164, which is what Google matches on: +34623947598, not "623 94 75 98". */
function toE164(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return '+' + digits.slice(1).replace(/\D/g, '');
  const bare = digits.replace(/\D/g, '');
  if (!bare) return '';
  // Spanish numbers are nine digits and the forms are Spanish-facing; anything
  // already carrying a country code is left alone above.
  return bare.length === 9 ? '+34' + bare : '+' + bare;
}

async function userData(email: string, phone: string): Promise<Record<string, string> | undefined> {
  const [sha256_email_address, sha256_phone_number] = await Promise.all([
    sha256(email),
    sha256(toE164(phone)),
  ]);
  const data: Record<string, string> = {};
  if (sha256_email_address) data.sha256_email_address = sha256_email_address;
  if (sha256_phone_number) data.sha256_phone_number = sha256_phone_number;
  return Object.keys(data).length ? data : undefined;
}

function reportConversion(identifiers?: Record<string, string>): Promise<void> {
  return new Promise((resolve) => {
    const gtag = (window as unknown as { gtag?: (...args: unknown[]) => void }).gtag;
    if (typeof gtag !== 'function') return resolve();

    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    setTimeout(finish, 1200);

    gtag('event', 'conversion', {
      send_to: CONVERSION_ID,
      ...(identifiers ? { user_data: identifiers } : {}),
      event_callback: finish,
    });
  });
}
