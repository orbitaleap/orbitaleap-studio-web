/**
 * Where a lead came from, in our own records rather than Google's.
 *
 * The question this exists to answer is "did this person arrive from the ad
 * or from search?", and until now nothing could: the payload carried no
 * referrer, no gclid and no campaign, so a lead arrived with a name, a phone
 * number and no origin. Google Ads can say how many clicks happened; it
 * cannot say that a particular person was one of them, and the URL-based
 * conversion only ever watched /launch/deployed, so anyone converting through
 * the test form was invisible to it too.
 *
 * ─── On storage and consent ───────────────────────────────────────────────
 *
 * Two paths, and the difference is deliberate.
 *
 * Without analytics consent nothing is written to the device at all. The
 * origin is read at submit time from the URL that is open and from
 * document.referrer — both already in memory, neither stored. That keeps the
 * no-consent path exactly as it is today: no cookie, no localStorage, nothing
 * to add to the cookie policy.
 *
 * With analytics consent, first touch is remembered in sessionStorage for the
 * length of the visit. That is the only way to attribute a journey that
 * crosses pages — someone who lands on /launch from an ad and clicks through
 * to the test arrives at the form with our own hostname as the referrer, and
 * looks identical to direct traffic. gclid survives that hop on its own
 * (Consent Mode's url_passthrough appends it to same-domain links) but a
 * search referrer does not.
 *
 * sessionStorage rather than localStorage on purpose: first touch means first
 * touch of THIS visit, and a value that outlived the visit would start
 * crediting an old ad click for a lead that came from somewhere else.
 */

import { readConsent } from './consent';

export interface Attribution {
  /** Human-readable channel, ready to drop into the notification email. */
  channel: string;
  /** The evidence — a click id, a campaign, a hostname. May be empty. */
  detail: string;
  /** The page the visit started on. */
  landing: string;
}

const KEY = 'ol_first_touch';

/** Google's click identifiers: search, iOS, and web-to-app respectively. */
const CLICK_IDS = ['gclid', 'gbraid', 'wbraid'] as const;

const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;

/** Hosts whose referral means somebody searched, not that somebody linked. */
const SEARCH_HOST =
  /(^|\.)(google|bing|duckduckgo|ecosia|yahoo|yandex|qwant|startpage|search\.brave)\./i;

const PAID_MEDIUM = /^(cpc|ppc|paid|paidsearch|paid_search|display|retargeting)$/i;

/** Reads the origin out of the page as it stands. Stores nothing. */
function derive(): Attribution {
  const params = new URLSearchParams(window.location.search);
  const landing = window.location.pathname;

  const utm = UTM.map((k) => [k, params.get(k)] as const).filter(([, v]) => v);
  const utmText = utm.map(([k, v]) => `${k.slice(4)}=${v}`).join(' · ');

  const click = CLICK_IDS.map((k) => [k, params.get(k)] as const).find(([, v]) => v);
  if (click) {
    return {
      channel: 'Google Ads',
      detail: [`${click[0]}=${click[1]}`, utmText].filter(Boolean).join(' · '),
      landing,
    };
  }

  // A campaign tagged as paid but with no click id — another network, or an
  // ad click whose identifier was stripped somewhere along the way.
  if (PAID_MEDIUM.test(params.get('utm_medium') ?? '')) {
    return { channel: 'Campaña de pago', detail: utmText, landing };
  }
  if (utm.length) return { channel: 'Campaña', detail: utmText, landing };

  const ref = document.referrer;
  if (ref) {
    try {
      const host = new URL(ref).hostname;
      // Our own pages are not a source. Treating them as one is what makes
      // internal navigation look like a fresh referral.
      if (host !== window.location.hostname) {
        return SEARCH_HOST.test(host)
          ? { channel: 'Búsqueda orgánica', detail: host, landing }
          : { channel: 'Referido', detail: host, landing };
      }
    } catch {
      // A malformed referrer is not worth throwing a form submission over.
    }
  }

  return { channel: 'Directo', detail: '', landing };
}

/**
 * Call once per page load. Remembers first touch for the visit, but only if
 * the visitor has accepted analytics — see the note at the top.
 */
export function captureFirstTouch(): void {
  try {
    if (!readConsent()?.analytics) return;
    if (sessionStorage.getItem(KEY)) return; // first touch, not latest touch
    sessionStorage.setItem(KEY, JSON.stringify(derive()));
  } catch {
    // Private browsing, or storage disabled. Submitting still works; it just
    // falls back to reading the current page.
  }
}

/** The origin to send with a lead. First touch if we have it, else here-and-now. */
export function readAttribution(): Attribution {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.channel === 'string') return parsed as Attribution;
    }
  } catch {
    // Fall through to deriving it.
  }
  return derive();
}
