/**
 * The Workers binding namespace, read the one way that still works.
 *
 * `Astro.locals.runtime.env` is the obvious place and it is a trap: Astro
 * removed it in v6, and reading it now THROWS the removal notice rather than
 * returning undefined. This project is on Astro 7, so a route that reaches
 * for it answers 500 to every request — which is how /metrics first behaved,
 * and how /api/send-email behaved before it was moved off it.
 *
 * `cloudflare:workers` is a virtual module that exists only when bundling for
 * the Workers runtime, so the import has to be dynamic and guarded: a static
 * one breaks `astro dev` and any Node build. The result is cached on
 * globalThis because the namespace is per-isolate, not per-request.
 *
 * An empty object is a legitimate answer — off-Workers, or before a binding
 * has been created. Callers are expected to cope rather than throw.
 */
export async function workerEnv(): Promise<Record<string, any>> {
  const g = globalThis as any;
  if (g.__cfEnv) return g.__cfEnv;
  try {
    const mod = await import(/* @vite-ignore */ 'cloudflare:workers');
    g.__cfEnv = (mod as any).env ?? {};
  } catch {
    g.__cfEnv = {};
  }
  return g.__cfEnv;
}
