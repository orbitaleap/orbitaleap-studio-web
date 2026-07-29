/**
 * Cookie consent, in one place.
 *
 * Consent Mode "advanced": the Google tag loads on every page but every
 * storage type starts DENIED, so nothing is written until someone says yes.
 * Google still receives cookieless pings while denied and models the
 * conversions it cannot observe — which is what makes denied-by-default
 * affordable rather than a measurement blackout.
 *
 * Two categories are offered, because that is what the four Google signals
 * actually collapse into:
 *
 *   advertising → ad_storage, ad_user_data, ad_personalization
 *   analytics   → analytics_storage
 *
 * Strictly necessary cookies are not offered, because they are not a choice:
 * Turnstile's anti-abuse check is required to deliver a form the visitor
 * asked to send, and is exempt from prior consent under art. 22.2 LSSI-CE.
 */

export const CONSENT_KEY = 'ol_cookie_consent';

export interface ConsentChoice {
  advertising: boolean;
  analytics: boolean;
  /** ISO timestamp. Proof of when consent was given, which the RGPD expects. */
  at: string;
}

export type ConsentSignals = Record<
  'ad_storage' | 'ad_user_data' | 'ad_personalization' | 'analytics_storage',
  'granted' | 'denied'
>;

/** Maps a choice onto the four signals Google actually reads. */
export function toSignals(choice: Pick<ConsentChoice, 'advertising' | 'analytics'>): ConsentSignals {
  const ads = choice.advertising ? 'granted' : 'denied';
  return {
    ad_storage: ads,
    ad_user_data: ads,
    ad_personalization: ads,
    analytics_storage: choice.analytics ? 'granted' : 'denied',
  };
}

/**
 * Reads the stored decision, or null if there isn't one yet.
 *
 * Understands the two values the previous version wrote — the plain strings
 * 'accepted' and 'rejected' — so nobody who already answered is asked again
 * just because the storage format grew categories.
 */
export function readConsent(): ConsentChoice | null {
  try {
    const raw = localStorage.getItem(CONSENT_KEY);
    if (!raw) return null;

    if (raw === 'accepted') return { advertising: true, analytics: true, at: '' };
    if (raw === 'rejected') return { advertising: false, analytics: false, at: '' };

    const parsed = JSON.parse(raw);
    if (typeof parsed?.advertising !== 'boolean') return null;
    return parsed as ConsentChoice;
  } catch {
    return null;
  }
}

export function writeConsent(choice: Pick<ConsentChoice, 'advertising' | 'analytics'>): ConsentChoice {
  const stored: ConsentChoice = { ...choice, at: new Date().toISOString() };
  try {
    localStorage.setItem(CONSENT_KEY, JSON.stringify(stored));
  } catch {
    // Storage disabled. The consent update below still applies for this page
    // view; it simply will not be remembered.
  }
  return stored;
}

/** Pushes a decision to the tag. Safe on pages where no tag is loaded. */
export function applyConsent(choice: Pick<ConsentChoice, 'advertising' | 'analytics'>) {
  (window as any).gtag?.('consent', 'update', toSignals(choice));
}
