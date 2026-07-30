/**
 * The email the person who filled the form receives.
 *
 * Until now they got nothing: a line of status text in the page and silence in
 * their inbox. That silence is the worst moment in the funnel — someone has
 * just decided to trust us with their project and the first thing they get is
 * not knowing whether it arrived.
 *
 * ── The copy rule ────────────────────────────────────────────────────────────
 * It says what happened, what we do next, and when. Nothing else.
 *
 * An earlier draft explained that a person would read the message "entera",
 * that it was not a template, and that no automated filter was involved. Every
 * one of those lines is an automated email protesting that it is not one, which
 * is the fastest way to sound like a machine. If the reply is written by a
 * person, they will notice when it arrives; saying so in advance only invites
 * doubt.
 *
 * The register is the one already shipped on the site — launch.astro,
 * test-autodiagnostico.astro and launch/deployed.astro: `tú`, `nosotros` verbs,
 * a short fragment then a short sentence, one hard number (<24 h), and a `sin …`
 * reassurance. No hedging, no adjectives doing a verb's job.
 *
 * ── Why the markup looks like 2004 ───────────────────────────────────────────
 * Email clients are not browsers. Outlook on Windows renders with Word: no
 * flexbox, no grid, and border-radius is dropped. Gmail strips <style> in some
 * contexts and all data: URIs in <img>. So: tables for layout, every style
 * inline, and anything decorative built from coloured divs that degrade to
 * squares rather than disappear.
 *
 * The logo is the one hosted image, referenced by absolute URL because a data:
 * URI would simply not render in Gmail. It carries width, height and alt so a
 * client with images off still shows the wordmark as text rather than a hole.
 *
 * The alt is two words, on one line, with a line-height equal to the reserved
 * height. It said "Orbital Leap Studio", which wrapped to two lines inside the
 * 148px box and then overlapped itself against the forced 25px height — so the
 * images-off fallback, the one case the alt exists for, was the broken one.
 */

export type LeadSource = string;

export interface ConfirmationInput {
    name: string;
    message: string;
    /** The form it came from — 'studio · contacto' | 'studio · /launch' | 'studio · autodiagnóstico'. */
    source: LeadSource;
    /** Short human-quotable reference, e.g. OL-4F2K. */
    reference: string;
    /** Already formatted for Europe/Madrid by the caller. */
    receivedAt: string;
}

export interface BuiltEmail {
    subject: string;
    html: string;
    text: string;
}

const LOGO_URL = 'https://studio.orbitaleap.com/brand/ol-email-logo.png';

const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

// Just the first name. "Gracias, María del Carmen Fernández de la Vega" is a
// database talking.
const firstName = (full: string): string => {
    const first = full.trim().split(/\s+/)[0] ?? '';
    if (!first) return '';
    return first.charAt(0).toLocaleUpperCase('es-ES') + first.slice(1);
};

const INK = {
    // Measured, not eyeballed. The previous scale bottomed out at #4A4A4A on a
    // #0B0B0B card — 2.2:1 for the labels, the footer and the reference code,
    // and 1.3:1 for the timeline rail, which meant the pending steps were very
    // nearly invisible. Every text tier now clears 4.5:1 and the rail clears
    // the 3:1 that WCAG asks of anything carrying state.
    //
    // The card also sat 1.03:1 off the page behind it, so the rounded edge was
    // doing all the work of separating them. Lifting the card gives the whole
    // scale room and lets the border be a real hairline rather than a hint.
    page: '#08080A',
    card: '#131417',
    hairline: '#383C42',
    rail: '#666C75',
    white: '#FFFFFF',
    soft: '#C3C7CE',
    faint: '#9BA1A9',
    ghost: '#7D848D',
};

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

/**
 * What changes between the three forms: the noun for the thing they sent, and
 * the thing we owe them back. Everything else is shared, so the three
 * confirmations are recognisably one email.
 */
function variant(source: LeadSource) {
    const s = source.toLowerCase();

    if (s.includes('launch')) {
        return {
            eyebrow: 'Solicitud recibida',
            noun: 'tu solicitud',
            lead: 'Te responderemos en menos de 24 horas con un presupuesto concreto. Sin compromiso.',
            preheader: 'Presupuesto concreto en menos de 24 horas. Sin compromiso.',
            owed: 'Presupuesto concreto',
        };
    }

    if (s.includes('autodiagn') || s.includes('test')) {
        return {
            eyebrow: 'Test recibido',
            noun: 'tus respuestas',
            lead: 'Te enviaremos tu recomendación personalizada en menos de 24 horas.',
            preheader: 'Tu recomendación personalizada, en menos de 24 horas.',
            owed: 'Tu recomendación',
        };
    }

    return {
        eyebrow: 'Mensaje recibido',
        noun: 'tu mensaje',
        lead: 'Te responderemos en menos de 24 horas.',
        preheader: 'Te responderemos en menos de 24 horas.',
        owed: 'Nuestra respuesta',
    };
}

/**
 * One step of the timeline: when, and what happens. No description line — that
 * is where the last draft went to explain itself.
 */
function step(opts: { done: boolean; last: boolean; when: string; what: string }): string {
    const dot = opts.done
        ? `<div style="width:9px;height:9px;border-radius:50%;background:${INK.white};margin:6px auto 0;font-size:0;line-height:0;">&nbsp;</div>`
        : `<div style="width:7px;height:7px;border-radius:50%;border:1px solid ${INK.rail};margin:6px auto 0;font-size:0;line-height:0;">&nbsp;</div>`;

    // Fixed-height connector rather than a border down the cell: Word will not
    // draw the latter but will happily paint a 1px-wide div.
    //
    // The height is not a guess, and the order of the two lines matters to it.
    //
    // The step NAME comes first and the timing sits beneath it, because the dot
    // marks the step and the name is the step. With the timing first the dot
    // aligned to the faint mono line and every marker read as floating a line
    // too high above the bold text the eye actually lands on.
    //
    // So: a 20px name + 3px gap + 12px timing + 22px bottom padding = a 57px
    // pitch between dots. The 9px dot starts 5px down to centre on the name's
    // line box.
    //
    // A rail that touches both dots is not achievable here, and it is worth
    // saying why rather than rediscovering it: a rail can only reach the bottom
    // of its own row, while the next dot is inset 5px from the top of the next
    // one. Growing the rail past that just makes the left cell govern the row
    // height and pushes the next dot down by the same amount — it recurses.
    //
    // So the break is deliberate and symmetric instead: 6 + 9 + 6 + 36 = 57,
    // exactly the right cell's 20 + 3 + 12 + 22, so neither cell governs and
    // the gap above the rail equals the gap below it. An even break reads as
    // intentional; short at one end reads as a mistake.
    //
    // The 6px is measured off the painted pixels, not the box model. The target
    // is the name's CAP MIDLINE — (cap top + baseline) / 2 — which at this size
    // sits 10.06px down, within 0.06px of the line-box centre. Cap midline
    // rather than ink centre because two of the three names carry descenders
    // ('proyecto', 'respuesta') and aligning to ink would drop their dots
    // relative to the first one. A 9px dot cannot land exactly on 10.06 with an
    // integer margin: 5px rendered its centre at 9.25, 6px lands within 0.2px.
    //
    // Both line boxes are set in px, not ratios: the mobile query drops the name
    // to 14px and a ratio would move the pitch with it, pulling the rail out of
    // alignment on exactly the screens that are hardest to check.
    const rail = opts.last
        ? ''
        : `<div style="width:1px;height:36px;background:${INK.rail};margin:6px auto 0;font-size:0;line-height:0;">&nbsp;</div>`;

    return `
      <tr>
        <td width="26" align="center" valign="top" style="padding:0;width:26px;">
          ${dot}${rail}
        </td>
        <td valign="top" style="padding:0 0 ${opts.last ? '0' : '22px'} 14px;">
          <div class="ol-step" style="font-family:${SANS};font-size:15px;font-weight:600;color:${opts.done ? INK.white : INK.soft};line-height:20px;">${opts.what}</div>
          <div style="font-family:${MONO};font-size:10px;line-height:12px;letter-spacing:0.14em;text-transform:uppercase;color:${opts.done ? INK.soft : INK.ghost};padding-top:3px;">${opts.when}</div>
        </td>
      </tr>`;
}

export function buildConfirmationEmail(input: ConfirmationInput): BuiltEmail {
    const who = firstName(input.name);
    const v = variant(input.source);
    const greeting = who ? `Gracias, ${escapeHtml(who)}.` : 'Gracias.';

    const subject = who
        ? `Ya tenemos ${v.noun}, ${who} — respuesta en menos de 24 h`
        : `Ya tenemos ${v.noun} — respuesta en menos de 24 h`;

    const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<!-- Declares the email as dark so Apple Mail and Outlook stop trying to
     "helpfully" invert a design that is already dark. -->
<meta name="color-scheme" content="dark" />
<meta name="supported-color-schemes" content="dark" />
<title>${escapeHtml(subject)}</title>
<style>
  /* Fluid-hybrid. The card is width:100% with max-width:600px, so it shrinks on
     its own even in a client that throws this block away; Outlook reads the
     width="600" attribute instead and gets a fixed 600px, which is correct
     there because Outlook is never on a phone.

     These queries are the enhancement on top: below 480px the side padding
     drops from 34px to 20px (34 either side of a 360px screen leaves 292px for
     content, which is too tight for a 30px headline) and the type comes down a
     step. Longhand + !important because it has to beat an inline shorthand. */
  @media only screen and (max-width: 480px) {
    .ol-out { padding-left: 10px !important; padding-right: 10px !important; padding-top: 18px !important; padding-bottom: 18px !important; }
    .ol-px  { padding-left: 20px !important; padding-right: 20px !important; }
    .ol-h1  { font-size: 24px !important; }
    .ol-lead { font-size: 15px !important; }
    .ol-logo { width: 124px !important; height: 21px !important; }
    .ol-ref { font-size: 10px !important; }
    .ol-step { font-size: 14px !important; }
  }
  /* Stops iOS inflating small type and breaking the measured layout. */
  body, table, td, p, div, h1 { -webkit-text-size-adjust: 100%; }
</style>
</head>
<body style="margin:0;padding:0;background:${INK.page};">

<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px;">${v.preheader}</div>
<!-- Pushes the client's own preview text off the end, so it does not append
     the first paragraph after ours. -->
<div style="display:none;max-height:0;overflow:hidden;">&#847;&zwnj;&nbsp;&#8199;&shy;&#847;&zwnj;&nbsp;&#8199;&shy;&#847;&zwnj;&nbsp;&#8199;&shy;&#847;&zwnj;&nbsp;&#8199;&shy;&#847;&zwnj;&nbsp;&#8199;&shy;&#847;&zwnj;&nbsp;&#8199;&shy;</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${INK.page};">
  <tr>
    <td align="center" class="ol-out" style="padding:32px 16px;">

      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:${INK.card};border:1px solid ${INK.hairline};border-radius:14px;">

        <!-- Logo, and the reference on the same line. The code is here rather
             than in the footer because it is the one thing worth quoting at us. -->
        <tr>
          <td class="ol-px" style="padding:26px 34px 22px;border-bottom:1px solid ${INK.hairline};">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="left" valign="middle">
                  <img src="${LOGO_URL}" class="ol-logo" width="148" height="25" alt="Orbital Leap" style="display:block;border:0;outline:none;text-decoration:none;height:25px;width:148px;line-height:25px;white-space:nowrap;overflow:hidden;font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${INK.soft};" />
                </td>
                <td align="right" valign="middle" class="ol-ref" style="font-family:${MONO};font-size:11px;letter-spacing:0.08em;color:${INK.ghost};">${escapeHtml(input.reference)}</td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Hero -->
        <tr>
          <td class="ol-px" style="padding:38px 34px 0;">
            <div style="font-family:${MONO};font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:${INK.soft};">${v.eyebrow}</div>

            <h1 class="ol-h1" style="margin:14px 0 0;font-family:${SANS};font-size:30px;line-height:1.16;font-weight:700;letter-spacing:-0.02em;color:${INK.white};">
              ${greeting}<br /><span style="color:${INK.soft};">Ya tenemos ${v.noun}.</span>
            </h1>

            <p class="ol-lead" style="margin:16px 0 0;font-family:${SANS};font-size:16px;line-height:1.6;color:${INK.soft};">
              ${v.lead}
            </p>
          </td>
        </tr>

        <!-- Three steps: when, and what. -->
        <tr>
          <td class="ol-px" style="padding:32px 34px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              ${step({ done: true, last: false, when: `Ahora · ${escapeHtml(input.receivedAt)}`, what: 'Recibido' })}
              ${step({ done: false, last: false, when: 'Hoy o mañana', what: 'Revisamos tu proyecto' })}
              ${step({ done: false, last: true, when: 'En menos de 24 h', what: escapeHtml(v.owed) })}
            </table>
          </td>
        </tr>

        <!-- What they sent, so they have a copy. -->
        <tr>
          <td class="ol-px" style="padding:30px 34px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${INK.hairline};border-radius:10px;">
              <tr>
                <td style="padding:18px 20px 16px;">
                  <div style="font-family:${MONO};font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${INK.ghost};padding-bottom:10px;">Tu mensaje</div>
                  <div style="font-family:${SANS};font-size:14px;line-height:1.7;color:${INK.soft};white-space:pre-wrap;">${escapeHtml(input.message)}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td class="ol-px" style="padding:24px 34px 32px;">
            <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.7;color:${INK.faint};">
              ¿Algo más que quieras contarnos? Responde a este correo.
            </p>
          </td>
        </tr>

        <tr>
          <td class="ol-px" style="padding:20px 34px 24px;border-top:1px solid ${INK.hairline};">
            <p style="margin:0 0 6px;font-family:${SANS};font-size:12px;line-height:1.6;color:${INK.ghost};">
              Recibes este correo porque nos escribiste desde studio.orbitaleap.com.
            </p>
            <p style="margin:0;font-family:${SANS};font-size:12px;color:${INK.ghost};">
              <a href="https://orbitaleap.com/privacidad/" style="color:${INK.faint};text-decoration:underline;">Privacidad</a>
              <span style="color:${INK.rail};">&nbsp;·&nbsp;</span>
              <a href="https://studio.orbitaleap.com/" style="color:${INK.faint};text-decoration:underline;">studio.orbitaleap.com</a>
            </p>
          </td>
        </tr>

      </table>

    </td>
  </tr>
</table>
</body>
</html>`;

    // Sent alongside the HTML. Some people read in plain text by choice, and
    // every spam filter treats an HTML-only email as a small strike against it.
    const text = [
        'ORBITAL LEAP STUDIO',
        `Referencia: ${input.reference}`,
        '',
        who ? `Gracias, ${who}. Ya tenemos ${v.noun}.` : `Gracias. Ya tenemos ${v.noun}.`,
        '',
        v.lead,
        '',
        `Ahora · ${input.receivedAt} — Recibido`,
        'Hoy o mañana — Revisamos tu proyecto',
        `En menos de 24 h — ${v.owed}`,
        '',
        'TU MENSAJE',
        input.message,
        '',
        '¿Algo más que quieras contarnos? Responde a este correo.',
        '',
        '—',
        'Recibes este correo porque nos escribiste desde studio.orbitaleap.com.',
        'Privacidad: https://orbitaleap.com/privacidad/',
    ].join('\n');

    return { subject, html, text };
}

/**
 * Short, human-quotable, and unique enough for the volume this sees.
 * Time-based rather than random so two codes can be ordered by eye.
 */
export function makeReference(now: number = Date.now()): string {
    return `OL-${now.toString(36).toUpperCase().slice(-4)}`;
}
