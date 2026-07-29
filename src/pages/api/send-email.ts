export const prerender = false;

import type { APIRoute } from "astro";
import { Resend } from "resend";

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
        // Browser-side context: landing parameters, page, timings. Optional by
        // construction — a form that does not send it still works.
        const ctx = (body?.context ?? {}) as Record<string, any>;
        const attribution = (ctx.attribution ?? {}) as Record<string, string>;
        const consent = body?.consent === true || body?.consent === "true" || body?.consent === "on";

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

        // mail.orbitaleap.com, not the apex: that subdomain is the one verified in
    // Resend (DKIM at resend._domainkey.mail.orbitaleap.com), and Resend refuses
    // to send from a domain it has not verified.
        const emailFrom = readEnv(context, 'CONTACT_FROM_EMAIL') || "Orbital Leap <no-reply@mail.orbitaleap.com>";
        const emailTo = readEnv(context, 'CONTACT_TO_EMAIL') || "hello@orbitaleap.com";
        const consentedAt = new Date().toISOString();

        // Cloudflare fills these on the way in. Country and city cost nothing
        // and answer "is this lead even in a market we serve?" before you
        // read a word of the message. The IP itself is deliberately NOT
        // recorded: it would be a new category of personal data to declare,
        // and it answers no question the country does not.
        const country = request.headers.get('cf-ipcountry') || '';
        const cf = (request as any).cf ?? {};
        const city = (cf.city ?? '') as string;
        const region = (cf.region ?? '') as string;
        const place = [city, region, country].filter(Boolean).join(', ');

        const submittedAt = new Intl.DateTimeFormat('es-ES', {
            dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Madrid',
        }).format(new Date());

        const isPaid = ctx.paid === true;
        const clickId = attribution.gclid || attribution.gbraid || attribution.wbraid || '';

        // How the visit arrived, in one line, in plain words. This is the
        // question the old email could not answer at all: every lead looked
        // identical whether it cost 4 euros of ad spend or arrived free.
        const channel = isPaid
            ? 'Anuncio de Google Ads (pagado)'
            : attribution.utm_source
                ? `Campaña: ${escapeHtml(attribution.utm_source)}${attribution.utm_medium ? ` / ${escapeHtml(attribution.utm_medium)}` : ''}`
                : attribution.referrer
                    ? `Enlace desde ${escapeHtml(new URL(attribution.referrer).hostname)}`
                    : 'Directo u orgánico';

        const row = (label: string, value: string) => value
            ? `<tr><td style="padding:7px 14px 7px 0;color:#666;font-size:13px;white-space:nowrap;vertical-align:top;">${label}</td>
                   <td style="padding:7px 0;font-size:14px;color:#111;">${value}</td></tr>`
            : '';

        const detailRows = [
            row('Origen', escapeHtml(source)),
            row('Página', escapeHtml(ctx.page ?? '')),
            row('Canal', channel),
            row('Campaña', escapeHtml(attribution.utm_campaign ?? '')),
            row('Término', escapeHtml(attribution.utm_term ?? '')),
            row('Click ID', clickId ? `<code style="font-size:12px;">${escapeHtml(clickId)}</code>` : ''),
            row('Ubicación', escapeHtml(place)),
            row('Idioma', escapeHtml(ctx.language ?? '')),
            row('Enviado', escapeHtml(submittedAt)),
            row('Rellenado en', ctx.filledInSeconds ? `${escapeHtml(String(ctx.filledInSeconds))} s` : ''),
        ].join('');

        const { data, error } = await resend.emails.send({
            from: emailFrom,
            to: [emailTo],
            replyTo: email,
            // The channel leads the subject line. Scanning an inbox, the first
            // thing worth knowing is whether this lead cost money.
            subject: `${isPaid ? '💰 ' : ''}[${escapeHtml(source)}] ${escapeHtml(name)}${company ? ` — ${escapeHtml(company)}` : ""}`,
            html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px;color:#111;max-width:640px;margin:0 auto;">
          ${isPaid ? `<div style="background:#111;color:#fff;padding:8px 14px;border-radius:6px;font-size:12px;font-weight:600;display:inline-block;margin-bottom:16px;">LEAD DE PAGO · Google Ads</div>` : ''}

          <h2 style="font-size:21px;margin:0 0 4px;">${escapeHtml(name)}${company ? ` <span style="color:#666;font-weight:400;">· ${escapeHtml(company)}</span>` : ''}</h2>
          <p style="margin:0 0 20px;color:#666;font-size:14px;">${channel}</p>

          <!-- Contact actions first: replying is the point of this email, and
               it used to mean selecting an address out of a paragraph. -->
          <p style="margin:0 0 22px;">
            <a href="mailto:${escapeHtml(email)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:500;margin-right:8px;">Responder</a>
            <a href="tel:${escapeHtml(phone.replace(/[^+\d]/g, ''))}" style="display:inline-block;border:1px solid #ccc;color:#111;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:500;margin-right:8px;">Llamar</a>
            <a href="https://wa.me/${escapeHtml(phone.replace(/[^\d]/g, ''))}" style="display:inline-block;border:1px solid #ccc;color:#111;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:500;">WhatsApp</a>
          </p>

          <div style="padding:18px;background:#f7f7f7;border-radius:8px;margin-bottom:22px;">
            <p style="margin:0 0 8px;font-weight:600;font-size:13px;color:#666;">MENSAJE</p>
            <p style="white-space:pre-wrap;margin:0;color:#111;font-size:15px;line-height:1.55;">${escapeHtml(message)}</p>
          </div>

          <table style="width:100%;border-collapse:collapse;border-top:1px solid #eee;">
            ${row('Email', `<a href="mailto:${escapeHtml(email)}" style="color:#111;">${escapeHtml(email)}</a>`)}
            ${row('Teléfono', `<a href="tel:${escapeHtml(phone.replace(/[^+\d]/g, ''))}" style="color:#111;">${escapeHtml(phone)}</a>`)}
            ${row('Empresa', company ? escapeHtml(company) : '<span style="color:#999;">No especificada</span>')}
            ${detailRows}
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
