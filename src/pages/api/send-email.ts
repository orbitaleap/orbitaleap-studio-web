export const prerender = false;

import type { APIRoute } from "astro";
import { Resend } from "resend";

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
        const resendApiKey = process.env.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
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

        // Verify Turnstile Token if present
        const secret = process.env.TURNSTILE_SECRET_KEY || import.meta.env.TURNSTILE_SECRET_KEY;
        if (turnstileToken && secret) {
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

        const emailFrom = process.env.CONTACT_FROM_EMAIL || import.meta.env.CONTACT_FROM_EMAIL || "Orbital Leap <no-reply@orbitaleap.com>";
        const emailTo = process.env.CONTACT_TO_EMAIL || import.meta.env.CONTACT_TO_EMAIL || "contact@orbitaleap.com";

        const { data, error } = await resend.emails.send({
            from: emailFrom,
            to: [emailTo],
            replyTo: email,
            subject: `Nuevo mensaje de contacto: ${name}`,
            html: `
        <div style="font-family: sans-serif; padding: 24px; color: #111; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 8px;">
          <h2 style="border-bottom: 2px solid #111; padding-bottom: 12px; font-size: 20px;">Nuevo mensaje desde la web de Orbital Leap</h2>
          <p style="margin: 12px 0;"><strong>Nombre:</strong> ${name}</p>
          <p style="margin: 12px 0;"><strong>Email:</strong> ${email}</p>
          <p style="margin: 12px 0;"><strong>Empresa / Organización:</strong> ${company || "No especificada"}</p>
          <p style="margin: 12px 0;"><strong>Teléfono:</strong> ${phone || "No especificado"}</p>
          <div style="margin-top: 24px; padding: 16px; background: #f9f9f9; border-radius: 8px;">
            <p style="margin: 0 0 8px 0; font-weight: bold;">Mensaje:</p>
            <p style="white-space: pre-wrap; margin: 0; color: #333;">${message}</p>
          </div>
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
