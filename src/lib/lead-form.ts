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

const ENDPOINT = '/api/send-email';

/** Ad click identifiers. Their presence is what makes a visit "paid". */
const CLICK_IDS = ['gclid', 'gbraid', 'wbraid'] as const;

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;

/** Where the campaign parameters seen on landing are kept for this tab. */
const ATTRIBUTION_KEY = 'ol_attribution';

/**
 * Records the campaign parameters from the current URL, once per tab.
 *
 * Called on every page load. The parameters only exist on the landing URL —
 * by the time someone has clicked through to another page and submitted a
 * form, they are long gone from the address bar, which is why the lead emails
 * could never say where anyone came from.
 *
 * First write wins: the landing parameters describe the visit, and a later
 * page should not overwrite them with nothing.
 */
export function captureAttribution() {
  try {
    if (sessionStorage.getItem(ATTRIBUTION_KEY)) return;

    const url = new URL(window.location.href);
    const found: Record<string, string> = {};
    for (const k of [...CLICK_IDS, ...UTM_KEYS]) {
      const v = url.searchParams.get(k);
      if (v) found[k] = v;
    }

    // The referrer is worth keeping even with no parameters at all — it is
    // what distinguishes a Google organic visit from a direct one.
    if (document.referrer && !document.referrer.startsWith(window.location.origin)) {
      found.referrer = document.referrer;
    }
    if (Object.keys(found).length) sessionStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(found));
  } catch {
    // Private mode with storage disabled. Attribution is a nice-to-have.
  }
}

function readAttribution(): Record<string, string> {
  try {
    return JSON.parse(sessionStorage.getItem(ATTRIBUTION_KEY) || '{}');
  } catch {
    return {};
  }
}

/**
 * Whether this visit came from a Google ad, i.e. carries a click identifier.
 *
 * This is what decides whether a submission may count as an Ads conversion.
 * It reads stored state rather than the URL so it cannot be forged by typing
 * a query string onto the thank-you page.
 */
export function isPaidVisit(): boolean {
  const attribution = readAttribution();
  return CLICK_IDS.some((k) => attribution[k]);
}

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

      // Context for the lead email. None of this is asked of the visitor;
      // it is what the browser already knows, and it is the difference
      // between "a lead came in" and knowing which campaign paid for it.
      context: {
        page: window.location.pathname + window.location.search,
        attribution: readAttribution(),
        paid: isPaidVisit(),
        // How long the form was open before it was sent. A useful signal
        // next to the message: thirty seconds reads differently to ten
        // minutes, and it is already measured for the anti-bot floor.
        filledInSeconds: Math.round((Date.now() - openedAt) / 1000),
        screen: `${window.screen?.width || 0}x${window.screen?.height || 0}`,
        language: navigator.language,
      },
    };

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({} as { error?: string }));

      // Turnstile tokens are single-use. None of these forms navigate on a
      // failed submit, so without a reset the next attempt re-sends a redeemed
      // token — Cloudflare rejects it as timeout-or-duplicate and the visitor
      // gets a second failure that has nothing to do with what they typed.
      if (!res.ok) resetTurnstile();

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
