/**
 * The gate, and the sign-in screen, shared by every page under /metrics.
 *
 * Extracted when the dashboard split into two pages. Copying it would have
 * meant two gates to keep in step, and the failure mode of that is a page
 * everyone can open — the kind of divergence nobody notices until it is a
 * problem.
 *
 * Returns EITHER an identity or a Response to send back. The caller has no
 * third option, which is the point: a page cannot accidentally render because
 * it forgot to check a boolean.
 */

import { verifyToken, readToken } from './neon-auth';
import { hasAccess, sendPasswordReset } from './metrics-access';
import { workerEnv } from './worker-env';

/**
 * Reset requests are rate limited HERE rather than in the browser, which is
 * why they no longer go straight from the page to the auth server. A button
 * that fires an email to any address on one click, with the request leaving
 * from the visitor's own machine, is an email cannon aimed at whoever they
 * type — and nothing client-side can stop that, because the attacker owns the
 * client.
 *
 * Same Cache API the contact endpoint uses: no binding, no namespace, and the
 * same documented caveat that it is per data centre. Against someone
 * distributed it is a speed bump; against the ordinary case — a bored person
 * clicking, or a script from one host — it holds.
 */
const RESET_MAX = 3;
const RESET_WINDOW_SECONDS = 15 * 60;

async function underResetLimit(request: Request): Promise<boolean> {
  try {
    const cache = (caches as any).default;
    if (!cache) return true;
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const key = new Request(`https://metrics-reset.orbitaleap.internal/${hash}`);
    const hit = await cache.match(key);
    const count = hit ? Number(await hit.text()) || 0 : 0;
    if (count >= RESET_MAX) return false;
    await cache.put(key, new Response(String(count + 1), {
      headers: { 'Cache-Control': `max-age=${RESET_WINDOW_SECONDS}` },
    }));
    return true;
  } catch {
    return true;
  }
}

export interface Guarded {
  identity: { email: string; name: string | null; sub: string } | null;
  response: Response | null;
  env: Record<string, any>;
}

export async function guardMetrics(request: Request, url: URL): Promise<Guarded> {
  const env = await workerEnv();
  const authUrl = env.NEON_AUTH_URL as string | undefined;

  // A reset asked for from the sign-in screen. Handled before the gate,
  // because the person asking is by definition not through it.
  let sentNotice: string | null = null;
  if (request.method === 'POST') {
    const form = await request.clone().formData().catch(() => null);
    const forgot = form?.get('forgot');
    if (typeof forgot === 'string' && forgot) {
      sentNotice = !(await underResetLimit(request))
        ? 'Demasiadas solicitudes. Espera unos minutos.'
        // Deliberately the same words whether or not the address exists: the
        // auth server does not distinguish, and neither should this.
        : (await sendPasswordReset(forgot, authUrl)).ok
          ? 'Si esa cuenta existe, te hemos enviado un correo.'
          : 'No se pudo enviar el correo. Inténtalo de nuevo.';
    }
  }

  const verified = await verifyToken(readToken(request), authUrl);
  // One source of truth: an account in neon_auth."user" that is not banned.
  const allowed = verified ? await hasAccess(verified.email, env.DATABASE_URL) : false;
  if (verified && allowed) return { identity: verified, response: null, env };

  const rejected = Boolean(verified) && !allowed;
  const resetToken = url.searchParams.get('token');

  return { identity: null, env, response: signInScreen({ authUrl, rejected, resetToken, sentNotice }) };
}

function signInScreen(o: {
  authUrl: string | undefined;
  rejected: boolean;
  resetToken: string | null;
  sentNotice?: string | null;
}): Response {
  const cfg = !o.authUrl
    ? '<p class="err">Falta NEON_AUTH_URL.</p>'
    : o.rejected
      ? '<p class="err">Esta cuenta no tiene acceso al panel.</p>'
      : '';

  return new Response(
    `<!doctype html><html lang="es"><head><meta charset="utf-8">
     <meta name="viewport" content="width=device-width,initial-scale=1">
     <meta name="robots" content="noindex, nofollow">
     <link rel="icon" type="image/svg+xml" href="/favicon.svg">
     <title>Métricas</title>
     <style>
       *{box-sizing:border-box}
       body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0d0d;color:#fff;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}
       .card{border:1px solid rgba(255,255,255,.1);background:#141414;border-radius:14px;
             padding:34px;width:min(380px,92vw)}
       h1{font-size:1.15rem;margin:0 0 4px;font-weight:600;letter-spacing:-.01em}
       p.sub{margin:0 0 22px;color:rgba(255,255,255,.45);font-size:.85rem}
       label{display:block;font-size:.75rem;color:rgba(255,255,255,.5);margin:0 0 6px}
       input{width:100%;padding:11px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.15);
             background:rgba(255,255,255,.04);color:#fff;font-size:.95rem;margin-bottom:14px}
       input:focus{outline:1px solid rgba(255,255,255,.45);outline-offset:1px}
       button{width:100%;padding:11px;border:0;border-radius:8px;background:#fff;color:#000;
              font-weight:600;font-size:.9rem;cursor:pointer}
       button[disabled]{opacity:.55;cursor:default}
       button.linky{background:none;border:0;color:rgba(255,255,255,.45);font-size:.78rem;
                    font-weight:400;margin-top:12px;padding:4px;text-decoration:underline;
                    text-underline-offset:3px;cursor:pointer}
       button.linky:hover{color:rgba(255,255,255,.8)}
       .err{color:#ff8080;font-size:.82rem;margin:0 0 14px}
       dialog{border:1px solid rgba(255,255,255,.1);background:#141414;color:#fff;border-radius:14px;
              padding:26px;width:min(400px,92vw)}
       dialog::backdrop{background:rgba(0,0,0,.6)}
       dialog h2{font-size:1rem;margin:0 0 6px;font-weight:600}
       dialog strong{color:#fff;word-break:break-all}
       .dialog-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:20px}
       .dialog-actions button{width:auto;padding:9px 16px;font-size:.83rem}
       .dialog-actions button.ghost{background:none;border:1px solid rgba(255,255,255,.18);color:#fff}
       #msg{margin-top:14px;font-size:.8rem;color:rgba(255,255,255,.45);min-height:1.1em;text-align:center}
     </style></head><body>
     <div class="card">
       <h1>Métricas</h1>
       <p class="sub">Panel interno de Orbital Leap Studio.</p>
       ${cfg}
       <form id="f" autocomplete="on" style="${o.resetToken ? 'display:none' : ''}">
         <label for="email">Correo</label>
         <input id="email" type="email" required autocomplete="username" autofocus>
         <label for="password">Contraseña</label>
         <input id="password" type="password" required autocomplete="current-password">
         <button id="in" type="submit">Entrar</button>
         <button id="forgot" type="button" class="linky">He olvidado mi contraseña</button>
       </form>

       <form id="rf" autocomplete="on" style="${o.resetToken ? '' : 'display:none'}">
         <p class="sub" style="margin-bottom:16px">Elige una contraseña nueva.</p>
         <label for="np">Contraseña nueva</label>
         <input id="np" type="password" minlength="12" required autocomplete="new-password" autofocus>
         <label for="np2">Repítela</label>
         <input id="np2" type="password" minlength="12" required autocomplete="new-password">
         <button id="rb" type="submit">Guardar contraseña</button>
       </form>
       <div id="msg">${o.sentNotice ? o.sentNotice.replace(/</g, '&lt;') : ''}</div>
     </div>

     <dialog id="confirm">
       <h2>Enviar correo de contraseña</h2>
       <p class="sub">Se enviará un enlace a <strong id="confirm-email"></strong> para elegir una contraseña nueva.</p>
       <form method="POST" id="confirm-form">
         <input type="hidden" name="forgot" id="confirm-input">
         <div class="dialog-actions">
           <button type="button" class="ghost" id="confirm-no">Cancelar</button>
           <button type="submit">Enviar</button>
         </div>
       </form>
     </dialog>
     <script>
      const AUTH = ${JSON.stringify(o.authUrl ?? '')};
      const REJECTED = ${o.rejected ? 'true' : 'false'};
      const RESET_TOKEN = ${JSON.stringify(o.resetToken ?? '')};
      const msg = document.getElementById('msg');
      const say = (t) => { msg.textContent = t; };

      async function grabToken() {
        const r = await fetch(AUTH + '/token', { credentials: 'include' });
        if (!r.ok) return false;
        const d = await r.json().catch(() => ({}));
        const t = d.token || d.jwt || (d.data && d.data.token);
        if (!t) return false;
        document.cookie = 'ol_metrics_jwt=' + t +
          '; Path=/metrics; Max-Age=3600; Secure; SameSite=Strict';
        return true;
      }

      (async () => {
        if (!AUTH || REJECTED || RESET_TOKEN) return;
        try { if (await grabToken()) { location.reload(); return; } } catch {}
      })();

      // Opens a confirmation instead of sending. A single click used to put a
      // real email in somebody's inbox — too easy to do by accident, and too
      // easy to do on purpose to an address that is not yours. The send itself
      // now goes through our own endpoint, which rate limits it; the dialog is
      // only the part that stops the accident.
      const dlg = document.getElementById('confirm');
      document.getElementById('forgot').addEventListener('click', () => {
        const email = document.getElementById('email').value.trim();
        if (!email) { say('Escribe tu correo primero.'); document.getElementById('email').focus(); return; }
        document.getElementById('confirm-email').textContent = email;
        document.getElementById('confirm-input').value = email;
        dlg.showModal();
      });
      document.getElementById('confirm-no').addEventListener('click', () => dlg.close());

      document.getElementById('rf').addEventListener('submit', async (e) => {
        e.preventDefault();
        const a = document.getElementById('np').value;
        if (a !== document.getElementById('np2').value) { say('Las dos contraseñas no coinciden.'); return; }
        const btn = document.getElementById('rb');
        btn.disabled = true; say('Guardando…');
        try {
          const r = await fetch(AUTH + '/reset-password', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newPassword: a, token: RESET_TOKEN }),
          });
          if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            say(d.message || 'El enlace ya no es válido. Pide otro.');
            btn.disabled = false; return;
          }
          say('Contraseña guardada. Entra con tu correo.');
          setTimeout(() => { location.href = '/metrics'; }, 900);
        } catch { say('No se pudo contactar con el servidor de acceso.'); btn.disabled = false; }
      });

      document.getElementById('f').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('in');
        btn.disabled = true; say('Entrando…');
        try {
          const r = await fetch(AUTH + '/sign-in/email', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: document.getElementById('email').value,
              password: document.getElementById('password').value,
            }),
          });
          if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            say(d.code === 'INVALID_EMAIL_OR_PASSWORD'
              ? 'Correo o contraseña incorrectos.' : (d.message || 'No se pudo iniciar sesión.'));
            btn.disabled = false; return;
          }
          if (await grabToken()) { location.reload(); return; }
          say('Sesión iniciada, pero no se pudo obtener el token.');
        } catch { say('No se pudo conectar con el servidor de acceso.'); }
        btn.disabled = false;
      });
     </script></body></html>`,
    {
      status: 401,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Robots-Tag': 'noindex, nofollow',
        'Cache-Control': 'no-store',
      },
    },
  );
}
