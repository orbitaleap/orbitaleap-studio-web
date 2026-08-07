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
      if (res.ok && data?.delivered !== false) reportConversion();

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
const CONVERSION_ID = 'AW-18312929105/IONoCPbWwtgcENG-pJxE';

function reportConversion() {
  const gtag = (window as unknown as { gtag?: (...args: unknown[]) => void }).gtag;
  if (typeof gtag !== 'function') return;
  gtag('event', 'conversion', { send_to: CONVERSION_ID });
}
