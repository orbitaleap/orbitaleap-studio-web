export const prerender = false;

import type { APIRoute } from "astro";
import { Resend } from "resend";
import { buildConfirmationEmail } from '../../lib/confirmation-email';
import { recordLead } from '../../lib/leads-store';

// The Workers binding namespace. Imported at module scope because
// `cloudflare:workers` is a virtual module resolved only when bundling for
// the Workers runtime; the try/catch keeps `astro dev` and Node builds, where
// it does not exist, from failing to load this route at all.
try {
    const mod = await import(/* @vite-ignore */ 'cloudflare:workers');
    (globalThis as any).__cfEnv = (mod as any).env;
} catch {
    // Not on Workers — readEnv falls through to process.env / import.meta.env.
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// Cloudflare Worker secrets do not arrive in process.env.
//
// This endpoint read `process.env.X || import.meta.env.X`, and on Workers
// neither is populated from a binding: import.meta.env is inlined at BUILD
// time, and process.env is a Node concept. The secrets are set correctly in
// the dashboard — RESEND_API_KEY among them — and the endpoint still answered
// 500 "falta RESEND_API_KEY" for every submission from every form on the site.
//
// On Cloudflare the bindings arrive on the request context, at
// locals.runtime.env. Read that first and keep the other two as fallbacks so
// `astro dev` and any Node deployment keep working unchanged.
function readEnv(context: any, key: string): string | undefined {
    // cloudflare:workers first. Astro 7 (this project) removed
    // locals.runtime.env — reading it now throws the removal notice itself,
    // which is what this endpoint was returning to every submitter:
    //   "Astro.locals.runtime.env has been removed in Astro v6.
    //    Use 'import { env } from \"cloudflare:workers\"' instead."
    //
    // The import is dynamic and wrapped because the module only exists inside
    // the Workers runtime: a static import would break `astro dev` and any
    // Node build, and this file has to keep working in both.
    let workerEnv: Record<string, string> | undefined;
    try {
        workerEnv = (globalThis as any).__cfEnv;
    } catch {
        workerEnv = undefined;
    }

    return (
        workerEnv?.[key] ||
        (typeof process !== 'undefined' ? process.env?.[key] : undefined) ||
        (import.meta.env as any)?.[key]
    );
}

// Rate limit: how many submissions one address may send, and over what window.
const RATE_LIMIT_MAX = 2;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;

/**
 * Counts submissions per email address using the Workers Cache API.
 *
 * Cache rather than KV because it needs no binding, no namespace and no
 * dashboard setup — this has to work on a deploy that has never been
 * configured for it.
 *
 * The trade is real and worth stating: the cache is per data centre, so
 * someone routed through a different Cloudflare colo starts from zero. This
 * is a speed bump against the ordinary case — the same person submitting the
 * same form repeatedly, by accident or frustration — not a defence against a
 * determined attacker, who is what Turnstile and the honeypot are for. If it
 * ever needs to be airtight, the same logic moves to KV unchanged.
 *
 * The address is hashed before it becomes a cache key: a raw email in a key
 * is personal data sitting somewhere it does not need to be.
 */
async function underRateLimit(email: string): Promise<boolean> {
    try {
        const cache = (caches as any).default;
        if (!cache) return true;

        const digest = await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(email.toLowerCase())
        );
        const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
        const key = new Request(`https://ratelimit.orbitaleap.internal/lead/${hash}`);

        const hit = await cache.match(key);
        const count = hit ? Number(await hit.text()) || 0 : 0;
        if (count >= RATE_LIMIT_MAX) return false;

        await cache.put(
            key,
            new Response(String(count + 1), {
                headers: { 'Cache-Control': `max-age=${RATE_LIMIT_WINDOW_SECONDS}` },
            })
        );
        return true;
    } catch {
        // Never let the limiter itself block a genuine lead.
        return true;
    }
}

export const POST: APIRoute = async (context) => {
    const { request } = context;
    const contentType = request.headers.get("Content-Type") ?? "";
    
    if (!contentType.toLowerCase().startsWith("application/json")) {
        return new Response(JSON.stringify({ error: "Content-Type debe ser application/json" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }

    try {
        const resendApiKey = readEnv(context, 'RESEND_API_KEY');
        if (!resendApiKey) {
            return new Response(JSON.stringify({ error: "Configuración del servidor incompleta: falta RESEND_API_KEY" }), {
                status: 500,
                headers: { "Content-Type": "application/json" },
            });
        }

        const resend = new Resend(resendApiKey);
        const body = await request.json();

        const name = (body?.name ?? "").toString().trim();
        const email = (body?.email ?? "").toString().trim();
        const company = (body?.company ?? "").toString().trim();
        // Where the lead came from, sent explicitly by each form. It used to
        // be smuggled into `company` ("Consulta desde Landing"), which
        // collides with the company a visitor actually types.
        const source = (body?.source ?? "studio.orbitaleap.com").toString().trim();
        const phone = (body?.phone ?? "").toString().trim();
        const message = (body?.message ?? "").toString().trim();
        const turnstileToken = (body?.turnstileToken ?? "").toString().trim();
        const website_url = (body?.website_url ?? "").toString().trim();
        const consent = body?.consent === true || body?.consent === "true" || body?.consent === "on";

        // Where the visit started, sent by the shared submitter. Trimmed to a
        // sane length because it is client-supplied and lands in an email: a
        // referrer or a campaign name is short, and anything longer is either
        // a mistake or someone probing.
        const clip = (v: unknown, max: number) => (v ?? "").toString().trim().slice(0, max);
        const attribution = {
            channel: clip(body?.attribution?.channel, 40),
            detail: clip(body?.attribution?.detail, 200),
            landing: clip(body?.attribution?.landing, 200),
        };

        // Honeypot bot protection
        // Same 2.5s floor orbitaleap.com uses. A person cannot read the
        // fields, type and submit inside it; a script posting straight at the
        // endpoint has no reason to wait. Forms that do not send `elapsed` are
        // let through rather than blocked, so adding this cannot break a form
        // that has not been updated yet.
        const elapsed = Number(body?.elapsed);
        if (Number.isFinite(elapsed) && elapsed < 2500) {
            return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }

        if (website_url) {
            return new Response(JSON.stringify({ error: "Comprobación de seguridad fallida." }), {
                status: 403,
                headers: { "Content-Type": "application/json" },
            });
        }

        if (!name || !email || !phone || !message) {
            return new Response(JSON.stringify({ error: "Por favor, completa todos los campos obligatorios." }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
            });
        }

        // GDPR (RGPD art. 7): the privacy-policy checkbox is the legal basis for
        // processing this submission — every form on the site marks it required,
        // so a request that reaches here without it is spoofed and must be refused
        // rather than silently processed.
        // Server-side minimum, mirroring the client's minlength. Client
        // validation is a courtesy to whoever is typing; a direct post never
        // sees it, and a one-character message is the shape junk arrives in.
        const MIN_MESSAGE = 20;
        if (name.trim().length < 2 || message.trim().length < MIN_MESSAGE) {
            return new Response(JSON.stringify({ error: "Añade un poco más de detalle: una o dos frases bastan." }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
            });
        }

        // Shape checks, not emptiness checks — the fields above already cover
        // empty. Until now a lead could arrive with a sentence in the phone
        // field and prose in the email, and it was accepted: the only email
        // rule was the browser's type="email", which a direct post never sees
        // and which accepts "ana@localhost" anyway, and type="tel" validates
        // nothing at all in any browser.
        //
        // A malformed address means the reply bounces and the lead is dead, so
        // this is worth refusing at the door rather than discovering later.
        const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
        if (!EMAIL_RE.test(email)) {
            return new Response(JSON.stringify({ error: "Revisa el email: no parece una dirección válida." }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
            });
        }

        // Counted on digits alone, so +34, spaces, dashes and brackets are all
        // fine while "llámame por la tarde" is not. 9 is a Spanish national
        // number; 15 is the E.164 maximum.
        const phoneDigits = phone.replace(/\D/g, '');
        if (phoneDigits.length < 9 || phoneDigits.length > 15 || /[a-zA-Z]/.test(phone)) {
            return new Response(JSON.stringify({ error: "Revisa el teléfono: introduce solo números, con prefijo si quieres." }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
            });
        }

        if (!consent) {
            return new Response(JSON.stringify({ error: "Debes aceptar la Política de Privacidad para enviar el formulario." }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
            });
        }

        // Verify Turnstile Token if present
        // Fails closed, on both halves.
        //
        // This was `if (turnstileToken && secret)`, which skipped verification
        // whenever EITHER was missing. The secret half is a misconfiguration;
        // the token half is an open bypass — omit the field when posting
        // directly and Turnstile never runs at all. A form that can be
        // defeated by leaving out a parameter is not protecting anything.
        const secret = readEnv(context, 'TURNSTILE_SECRET_KEY');
        if (!secret) {
            console.error('send-email: TURNSTILE_SECRET_KEY is not bound');
            return new Response(JSON.stringify({ error: "Configuración del servidor incompleta." }), {
                status: 503,
                headers: { "Content-Type": "application/json" },
            });
        }
        if (!turnstileToken) {
            return new Response(JSON.stringify({ error: "Completa la verificación de seguridad e inténtalo de nuevo." }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
            });
        }
        {
            const verifyUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
            const verifyResponse = await fetch(verifyUrl, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    secret,
                    response: turnstileToken,
                }).toString(),
            });
            const verifyData = await verifyResponse.json();
            if (!verifyData.success) {
                return new Response(JSON.stringify({ error: "Verificación de seguridad Turnstile no válida." }), {
                    status: 403,
                    headers: { "Content-Type": "application/json" },
                });
            }
        }

        // After Turnstile, deliberately: a bot that fails the challenge should
        // not be able to burn a real person's allowance by submitting their
        // address, and only a submission that would otherwise have been sent
        // should count against the limit.
        if (!(await underRateLimit(email))) {
            return new Response(JSON.stringify({
                error: "Ya hemos recibido tu mensaje. Te responderemos en breve; si es urgente, escríbenos directamente a contact@orbitaleap.com.",
            }), {
                status: 429,
                headers: { "Content-Type": "application/json" },
            });
        }

        // mail.orbitaleap.com, not the apex: that subdomain is the one verified in
    // Resend (DKIM at resend._domainkey.mail.orbitaleap.com), and Resend refuses
    // to send from a domain it has not verified.
        const emailFrom = readEnv(context, 'CONTACT_FROM_EMAIL') || "Orbital Leap <no-reply@mail.orbitaleap.com>";
        const emailTo = readEnv(context, "CONTACT_TO_EMAIL") || "contact@orbitaleap.com";
        const consentedAt = new Date().toISOString();

        // Everything below comes from the request itself — Cloudflare's own
        // headers and the clock. Nothing is captured in the browser and
        // nothing is stored there, so this adds no cookie, no localStorage
        // and nothing to declare in the cookie policy.
        const country = request.headers.get('cf-ipcountry') || '';
        const cf = (request as any).cf ?? {};
        const place = [cf.city ?? '', cf.region ?? '', country].filter(Boolean).join(', ');

        // The IP itself is deliberately not recorded: it would be a new
        // category of personal data to declare, and answers no question the
        // country does not.
        const submittedAt = new Intl.DateTimeFormat('es-ES', {
            dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Madrid',
        }).format(new Date());

        // Digits only, for the tel: and wa.me links. A number typed as
        // "+34 600 123 456" is not dialable as written.
        const telHref = phone.replace(/[^+\d]/g, '');
        const waHref = phone.replace(/[^\d]/g, '');

        const row = (label: string, value: string) => value
            ? `<tr><td style="padding:7px 14px 7px 0;color:#666;font-size:13px;white-space:nowrap;vertical-align:top;">${label}</td>
                   <td style="padding:7px 0;font-size:14px;color:#111;">${value}</td></tr>`
            : '';

        const { data, error } = await resend.emails.send({
            from: emailFrom,
            to: [emailTo],
            replyTo: email,
            subject: `[${escapeHtml(source)}] ${escapeHtml(name)}${company ? ` — ${escapeHtml(company)}` : ""}`,
            html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;padding:24px;color:#111;max-width:640px;margin:0 auto;">

          <!-- WHICH FORM, first and largest. It was a row in a table below
               the message, which made three different forms look identical
               at a glance. -->
          <div style="margin-bottom:18px;">
            <span style="background:#111;color:#fff;padding:9px 16px;border-radius:6px;font-size:14px;font-weight:700;display:inline-block;">
              ${escapeHtml(source)}
            </span>
          </div>

          <h2 style="font-size:21px;margin:0 0 18px;">${escapeHtml(name)}${company ? ` <span style="color:#666;font-weight:400;">· ${escapeHtml(company)}</span>` : ''}</h2>

          <!-- Contact actions first: replying is the entire point of this
               email, and it used to mean selecting an address out of a
               paragraph. -->
          <p style="margin:0 0 22px;">
            <a href="mailto:${escapeHtml(email)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:500;margin-right:6px;">Responder</a>
            <a href="tel:${escapeHtml(telHref)}" style="display:inline-block;border:1px solid #ccc;color:#111;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:500;margin-right:6px;">Llamar</a>
            <a href="https://wa.me/${escapeHtml(waHref)}" style="display:inline-block;border:1px solid #ccc;color:#111;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:500;">WhatsApp</a>
          </p>

          <div style="padding:18px;background:#f7f7f7;border-radius:8px;margin-bottom:22px;">
            <p style="margin:0 0 8px;font-weight:600;font-size:13px;color:#666;">MENSAJE</p>
            <p style="white-space:pre-wrap;margin:0;color:#111;font-size:15px;line-height:1.55;">${escapeHtml(message)}</p>
          </div>

          <table style="width:100%;border-collapse:collapse;border-top:1px solid #eee;">
            ${row('Email', `<a href="mailto:${escapeHtml(email)}" style="color:#111;">${escapeHtml(email)}</a>`)}
            ${row('Teléfono', `<a href="tel:${escapeHtml(telHref)}" style="color:#111;">${escapeHtml(phone)}</a>`)}
            ${row('Empresa', company ? escapeHtml(company) : '<span style="color:#999;">No especificada</span>')}
            ${row('Formulario', escapeHtml(source))}
            ${row('Origen', attribution.channel
                ? `<strong>${escapeHtml(attribution.channel)}</strong>${attribution.detail ? ` <span style="color:#666;">${escapeHtml(attribution.detail)}</span>` : ''}`
                : '')}
            ${row('Entró por', attribution.landing ? escapeHtml(attribution.landing) : '')}
            ${row('Ubicación', escapeHtml(place))}
            ${row('Enviado', escapeHtml(submittedAt))}
          </table>

          <p style="margin:22px 0 0;font-size:11px;color:#999;border-top:1px solid #eee;padding-top:12px;">
            Consentimiento RGPD aceptado el ${consentedAt}. No se registra la dirección IP.
          </p>
        </div>
      `,
        });

        if (error) {
            console.error("Error al enviar email mediante Resend:", error);
            return new Response(JSON.stringify({ error: error.message }), {
                status: 500,
                headers: { "Content-Type": "application/json" },
            });
        }

        // Our own record of the lead, for the /metrics dashboard.
        //
        // Same rule as the confirmation below, and for the same reason: it
        // runs AFTER the notification and cannot fail the request. The email
        // is what the business runs on; this table is for counting. A lead
        // that is delivered but not counted is a gap in a chart, while a lead
        // that is counted but not delivered is a lost customer.
        try {
            await recordLead(readEnv(context, 'DATABASE_URL'), {
                form: source,
                channel: attribution.channel,
                detail: attribution.detail,
                landing: attribution.landing,
                country,
                region: (cf.region ?? '') as string,
                city: (cf.city ?? '') as string,
                name, email, phone, company, message,
                consentAt: consentedAt,
            });
        } catch (e: any) {
            console.error('[leads] no se pudo registrar el lead:', e?.message ?? e);
        }

        // The confirmation to the person who wrote in.
        //
        // Deliberately AFTER the internal notification and deliberately unable
        // to fail the request: the lead is safe the moment the message above
        // lands, and a courtesy email that bounces must never turn a captured
        // lead into an error the visitor sees. If it fails it is logged and
        // that is all.
        //
        // replyTo is the team address, not the no-reply it is sent from, so
        // "just hit reply" is true rather than a figure of speech.
        try {
            const confirmation = buildConfirmationEmail({
                name,
                message,
                source,
                // Compact on purpose. dateStyle:'long' produced "30 de julio
                // de 2026, 1:29", which wrapped to two lines at 320px and
                // stretched that one row out of step with the rail. The year is
                // redundant under a label that already says "Ahora".
                receivedAt: new Intl.DateTimeFormat('es-ES', {
                    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                    timeZone: 'Europe/Madrid',
                }).format(new Date()),
            });

            const { error: confirmError } = await resend.emails.send({
                from: emailFrom,
                to: [email],
                replyTo: emailTo,
                subject: confirmation.subject,
                html: confirmation.html,
                text: confirmation.text,
            });

            if (confirmError) {
                console.error("Confirmación al cliente no enviada:", confirmError);
            }
        } catch (confirmException) {
            console.error("Confirmación al cliente no enviada:", confirmException);
        }

        return new Response(JSON.stringify({ message: "Mensaje enviado con éxito", id: data?.id }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });

    } catch (e: any) {
        console.error("Error interno del servidor:", e);
        return new Response(JSON.stringify({ error: e.message || "Error interno del servidor" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        });
    }
};
