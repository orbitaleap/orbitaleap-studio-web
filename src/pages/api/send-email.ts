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
        const phone = (body?.phone ?? "").toString().trim();
        const message = (body?.message ?? "").toString().trim();
        const turnstileToken = (body?.turnstileToken ?? "").toString().trim();
        const website_url = (body?.website_url ?? "").toString().trim();
        const consent = body?.consent === true || body?.consent === "true" || body?.consent === "on";

        // Honeypot bot protection
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

        const { data, error } = await resend.emails.send({
            from: emailFrom,
            to: [emailTo],
            replyTo: email,
            subject: `Nuevo mensaje de contacto: ${escapeHtml(name)}`,
            html: `
        <div style="font-family: sans-serif; padding: 24px; color: #111; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 8px;">
          <h2 style="border-bottom: 2px solid #111; padding-bottom: 12px; font-size: 20px;">Nuevo mensaje desde la web de Orbital Leap</h2>
          <p style="margin: 12px 0;"><strong>Nombre:</strong> ${escapeHtml(name)}</p>
          <p style="margin: 12px 0;"><strong>Email:</strong> ${escapeHtml(email)}</p>
          <p style="margin: 12px 0;"><strong>Empresa / Organización:</strong> ${company ? escapeHtml(company) : "No especificada"}</p>
          <p style="margin: 12px 0;"><strong>Teléfono:</strong> ${escapeHtml(phone)}</p>
          <div style="margin-top: 24px; padding: 16px; background: #f9f9f9; border-radius: 8px;">
            <p style="margin: 0 0 8px 0; font-weight: bold;">Mensaje:</p>
            <p style="white-space: pre-wrap; margin: 0; color: #333;">${escapeHtml(message)}</p>
          </div>
          <p style="margin: 16px 0 0; font-size: 11px; color: #999;">Consentimiento RGPD aceptado el ${consentedAt}.</p>
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
