/**
 * The email the person who filled the form receives.
 *
 * Until now they got nothing: a line of status text in the page and silence in
 * their inbox. That silence is the worst moment in the whole funnel — someone
 * has just decided to trust us with their project and the first thing they
 * experience is not knowing whether it arrived.
 *
 * So this is not an "acuse de recibo". It sets an explicit promise (24 h
 * laborables), shows them exactly what we received so they have a record, and
 * reads as if a person sent it. Replies land on a real inbox, because reply_to
 * is set to the same address that will answer them.
 *
 * ── Why the markup looks like 2004 ────────────────────────────────────────────
 * Email clients are not browsers. Outlook on Windows renders with Word, which
 * has no flexbox, no grid, no float worth trusting, and drops border-radius.
 * Gmail strips <style> blocks in some contexts and all data: URIs in <img>.
 * So: tables for layout, every style inline, no images at all, and anything
 * decorative built out of coloured divs that degrade to squares rather than
 * disappear. The design has to survive that, not fight it.
 *
 * There are no images on purpose — not even a logo. An image-less email cannot
 * break behind "load remote content", cannot be blocked into a broken layout,
 * and cannot be used to track an open. The wordmark is set in type.
 */

export type LeadSource = string;

export interface ConfirmationInput {
    name: string;
    message: string;
    /** The form it came from — 'Contacto web' | 'Landing /launch' | 'Test autodiagnóstico'. */
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

const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

// Just the first name. "Gracias, María del Carmen Fernández de la Vega" is a
// database talking; "Gracias, María" is a person.
const firstName = (full: string): string => {
    const first = full.trim().split(/\s+/)[0] ?? '';
    if (!first) return '';
    return first.charAt(0).toLocaleUpperCase('es-ES') + first.slice(1);
};

const INK = {
    page: '#060606',
    card: '#0B0B0B',
    hairline: '#1E1E1E',
    rail: '#282828',
    white: '#FFFFFF',
    soft: '#A6A6A6',
    faint: '#6A6A6A',
    ghost: '#4A4A4A',
};

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

/**
 * What changes between the three forms. Everything else is shared, so the
 * three confirmations are recognisably the same email — which is the point of
 * the parity work — while still answering the question the person actually
 * asked.
 */
function variant(source: LeadSource) {
    const s = source.toLowerCase();

    if (s.includes('launch')) {
        return {
            lead: 'Hemos recibido tu solicitud y la vamos a leer entera. En menos de 24 horas laborables tendrás una respuesta con un presupuesto concreto y un plazo, no un “te llamamos para hablarlo”.',
            third: 'Respuesta con presupuesto',
            thirdDesc: 'Alcance, precio y fecha de entrega. En un correo que puedes reenviar a quien decida.',
        };
    }

    if (s.includes('autodiagn') || s.includes('test')) {
        return {
            lead: 'Ya tenemos tus respuestas del autodiagnóstico. Las revisamos una a una y en menos de 24 horas laborables te escribimos con la lectura completa: qué te está frenando y por dónde empezaríamos.',
            third: 'Tu lectura del autodiagnóstico',
            thirdDesc: 'Qué dicen tus respuestas, sin adornos, y las dos o tres cosas que cambiaríamos primero.',
        };
    }

    return {
        lead: 'Hemos recibido tu mensaje y lo vamos a leer entero. En menos de 24 horas laborables tendrás una respuesta escrita por una persona, con algo concreto sobre lo que nos has contado.',
        third: 'Nuestra respuesta',
        thirdDesc: 'Escrita por una persona, sobre tu proyecto en particular. Menos de 24 horas laborables.',
    };
}

/** One stage of the timeline. `done` fills the dot; the last one drops the rail. */
function stage(opts: { done: boolean; last: boolean; label: string; title: string; desc: string }): string {
    const dot = opts.done
        ? `<div style="width:9px;height:9px;border-radius:50%;background:${INK.white};font-size:0;line-height:0;">&nbsp;</div>`
        : `<div style="width:7px;height:7px;border-radius:50%;border:1px solid ${INK.rail};font-size:0;line-height:0;">&nbsp;</div>`;

    // Fixed-height connector rather than a full-height border: Word has no
    // reliable way to draw a line down a cell, but it will happily paint a
    // 1px-wide div. Slightly short if the text wraps hard, which reads as a
    // dashed rail rather than as a bug.
    const rail = opts.last
        ? ''
        : `<div style="width:1px;height:58px;background:${INK.rail};margin:7px auto 0;font-size:0;line-height:0;">&nbsp;</div>`;

    return `
      <tr>
        <td width="26" align="center" valign="top" style="padding:0;width:26px;">
          ${dot}${rail}
        </td>
        <td valign="top" style="padding:0 0 ${opts.last ? '0' : '26px'} 14px;">
          <div style="font-family:${MONO};font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${opts.done ? INK.white : INK.ghost};padding-bottom:5px;">${opts.label}</div>
          <div style="font-family:${SANS};font-size:15px;font-weight:600;color:${opts.done ? INK.white : INK.soft};line-height:1.35;padding-bottom:4px;">${opts.title}</div>
          <div style="font-family:${SANS};font-size:13px;color:${INK.faint};line-height:1.6;">${opts.desc}</div>
        </td>
      </tr>`;
}

export function buildConfirmationEmail(input: ConfirmationInput): BuiltEmail {
    const who = firstName(input.name);
    const v = variant(input.source);
    const greeting = who ? `Gracias, ${escapeHtml(who)}.` : 'Gracias.';

    const subject = who
        ? `Recibido, ${who} — te respondemos en menos de 24 h`
        : 'Recibido — te respondemos en menos de 24 h';

    // The line the inbox shows next to the subject. Left to itself it picks up
    // whatever text comes first, which here would be the wordmark.
    const preheader = 'Tu mensaje ya está con nosotros. Lo lee una persona, no un filtro.';

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
</head>
<body style="margin:0;padding:0;background:${INK.page};">

<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px;">${preheader}</div>
<!-- Pushes the client's own preview text off the end, so it does not append
     the first paragraph after ours. -->
<div style="display:none;max-height:0;overflow:hidden;">&#847;&zwnj;&nbsp;&#8199;&shy;&#847;&zwnj;&nbsp;&#8199;&shy;&#847;&zwnj;&nbsp;&#8199;&shy;&#847;&zwnj;&nbsp;&#8199;&shy;&#847;&zwnj;&nbsp;&#8199;&shy;&#847;&zwnj;&nbsp;&#8199;&shy;</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${INK.page};">
  <tr>
    <td align="center" style="padding:32px 16px;">

      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:${INK.card};border:1px solid ${INK.hairline};border-radius:14px;">

        <!-- Wordmark, and the reference on the same line. The code is here
             rather than buried in the footer because it is the one thing worth
             quoting back at us. -->
        <tr>
          <td style="padding:26px 34px 22px;border-bottom:1px solid ${INK.hairline};">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="left" style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;color:${INK.soft};">Orbital&nbsp;Leap&nbsp;Studio</td>
                <td align="right" style="font-family:${MONO};font-size:11px;letter-spacing:0.08em;color:${INK.ghost};">${escapeHtml(input.reference)}</td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Hero -->
        <tr>
          <td style="padding:38px 34px 4px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="middle" style="padding:0 8px 0 0;"><div style="width:6px;height:6px;border-radius:50%;background:${INK.white};font-size:0;line-height:0;">&nbsp;</div></td>
                <td valign="middle" style="font-family:${MONO};font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:${INK.soft};">Señal recibida</td>
              </tr>
            </table>

            <h1 style="margin:16px 0 0;font-family:${SANS};font-size:30px;line-height:1.16;font-weight:700;letter-spacing:-0.02em;color:${INK.white};">
              ${greeting}<br /><span style="color:${INK.soft};">Ya estamos en ello.</span>
            </h1>

            <p style="margin:18px 0 0;font-family:${SANS};font-size:15px;line-height:1.68;color:${INK.soft};">
              ${v.lead}
            </p>
          </td>
        </tr>

        <!-- The timeline. The one piece of ornament in the email, and it is
             load-bearing: it answers "what happens next" without a paragraph. -->
        <tr>
          <td style="padding:34px 34px 6px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              ${stage({
                  done: true,
                  last: false,
                  label: `Ahora · ${escapeHtml(input.receivedAt)}`,
                  title: 'Recibido',
                  desc: 'Tu mensaje ya está en nuestra bandeja. No hace falta que hagas nada más.',
              })}
              ${stage({
                  done: false,
                  last: false,
                  label: 'Hoy o mañana',
                  title: 'Lo leemos entero',
                  desc: 'Una persona, no una plantilla ni un filtro automático.',
              })}
              ${stage({
                  done: false,
                  last: true,
                  label: 'En menos de 24 h laborables',
                  title: escapeHtml(v.third),
                  desc: escapeHtml(v.thirdDesc),
              })}
            </table>
          </td>
        </tr>

        <!-- What they sent, echoed back. Partly so they have a copy, partly so
             the email is obviously about them and not a broadcast. -->
        <tr>
          <td style="padding:30px 34px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${INK.hairline};border-radius:10px;">
              <tr>
                <td style="padding:18px 20px 16px;">
                  <div style="font-family:${MONO};font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${INK.ghost};padding-bottom:10px;">Lo que nos has enviado</div>
                  <div style="font-family:${SANS};font-size:14px;line-height:1.7;color:${INK.soft};white-space:pre-wrap;">${escapeHtml(input.message)}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- The only call to action, and it is "reply", which costs them one
             tap and puts them straight in front of the person answering. -->
        <tr>
          <td style="padding:26px 34px 34px;">
            <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.7;color:${INK.faint};">
              ¿Se te ha quedado algo en el tintero? Responde a este correo —
              llega a la misma persona que va a contestarte.
            </p>
          </td>
        </tr>

        <tr>
          <td style="padding:22px 34px 26px;border-top:1px solid ${INK.hairline};">
            <p style="margin:0 0 6px;font-family:${SANS};font-size:12px;line-height:1.6;color:${INK.ghost};">
              Recibes este correo porque enviaste el formulario en studio.orbitaleap.com.
              Es un mensaje puntual sobre tu consulta, no una suscripción.
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

    // Sent alongside the HTML, not as an afterthought. Some people read in
    // plain text by choice, and every spam filter in existence treats an
    // HTML-only email as a small strike against it.
    const text = [
        'ORBITAL LEAP STUDIO',
        `Referencia: ${input.reference}`,
        '',
        who ? `Gracias, ${who}. Ya estamos en ello.` : 'Gracias. Ya estamos en ello.',
        '',
        v.lead,
        '',
        `[x] Recibido — ${input.receivedAt}`,
        '    Tu mensaje ya está en nuestra bandeja. No hace falta que hagas nada más.',
        '[ ] Lo leemos entero — hoy o mañana',
        '    Una persona, no una plantilla ni un filtro automático.',
        `[ ] ${v.third} — en menos de 24 h laborables`,
        `    ${v.thirdDesc}`,
        '',
        'LO QUE NOS HAS ENVIADO',
        input.message,
        '',
        '¿Se te ha quedado algo en el tintero? Responde a este correo — llega a la misma persona que va a contestarte.',
        '',
        '—',
        'Recibes este correo porque enviaste el formulario en studio.orbitaleap.com.',
        'Privacidad: https://orbitaleap.com/privacidad/',
    ].join('\n');

    return { subject, html, text };
}

/**
 * Short, human-quotable, and unique enough for the volume this sees.
 * Time-based rather than random so two codes can be ordered by eye.
 */
export function makeReference(now: number = Date.now()): string {
    const block = now.toString(36).toUpperCase().slice(-4);
    return `OL-${block}`;
}
