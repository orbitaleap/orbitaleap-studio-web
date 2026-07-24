/**
 * thinking-orb — a dotted thought-orb on a plain 2D canvas.
 *
 * A Fibonacci-sphere point set, rotated and orthographically projected, drawn
 * as depth-shaded arcs. No dependency, no WebGL, no filters — identical pixels
 * in every browser and cheap on low-end devices.
 *
 * Strictly monochrome: pass the ink colour in, it is drawn at varying alpha.
 */

export type OrbState = 'working' | 'resolving' | 'resolved';

export interface OrbOptions {
  /** CSS colour for the dots. Monochrome by design. */
  color?: string;
  /** Logical (CSS px) size of the square canvas. */
  size?: number;
  /** Multiplier on the baked animation speed. */
  speed?: number;
  /** Accessible label; the canvas is exposed as role="img". */
  label?: string;
}

export interface OrbHandle {
  /** Move the orb to a new state. `resolving` plays a one-shot settle. */
  setState(state: OrbState): void;
  /** Stop the RAF loop and detach listeners. */
  destroy(): void;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const SHELL_DOTS = 190;
const ORBIT_PARTICLES = 22;

type Vec3 = [number, number, number];

/**
 * Even point distribution over a unit sphere. Marching i along the golden angle
 * while z descends linearly gives near-uniform spacing without clustering at
 * the poles, which is what makes the shell read as a solid volume.
 */
function fibonacciSphere(count: number): Vec3[] {
  const points: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = GOLDEN_ANGLE * i;
    points.push([Math.cos(theta) * radius, y, Math.sin(theta) * radius]);
  }
  return points;
}

/** Rotate about Y (spin), then X (tilt). Orthographic — we just drop Z for x/y. */
function rotate(p: Vec3, spin: number, tilt: number): Vec3 {
  const [x, y, z] = p;
  const cs = Math.cos(spin);
  const ss = Math.sin(spin);
  const x1 = x * cs - z * ss;
  const z1 = x * ss + z * cs;
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  return [x1, y * ct - z1 * st, y * st + z1 * ct];
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

export function mountOrb(canvas: HTMLCanvasElement, options: OrbOptions = {}): OrbHandle {
  const {
    color = '#0B0B0C',
    size = 64,
    speed = 1,
    label = 'Procesando',
  } = options;

  const ctx = canvas.getContext('2d');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', label);

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Cap DPR at 2 — beyond that the extra pixels cost more than they show.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;

  const shell = fibonacciSphere(SHELL_DOTS);

  // Particles ride tilted great circles; the spread of inclinations is what
  // gives the orb its "many things happening at once" texture.
  const orbits = Array.from({ length: ORBIT_PARTICLES }, (_, i) => ({
    inclination: (i / ORBIT_PARTICLES) * Math.PI,
    phase: (i * GOLDEN_ANGLE) % (Math.PI * 2),
    rate: 0.85 + ((i * 37) % 100) / 220,
  }));

  let state: OrbState = 'working';
  let raf = 0;
  let start = 0;
  let resolveStart = 0;
  let destroyed = false;

  function draw(elapsed: number) {
    if (!ctx) return;
    const t = (elapsed / 1000) * speed;

    // 0 while working, ramps to 1 across the settle.
    let settle = 0;
    if (state === 'resolved') settle = 1;
    else if (state === 'resolving') {
      settle = Math.min(1, ((elapsed - resolveStart) / 1000) * speed / 0.9);
      settle = easeOutCubic(settle);
      if (settle >= 1) state = 'resolved';
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;
    const R = size * 0.34;
    const dotR = size * 0.0165;

    // Spin eases to a stop as the orb resolves rather than cutting.
    const spin = t * 0.75 * (1 - settle * 0.82);
    const tilt = -0.42 + Math.sin(t * 0.34) * 0.1 * (1 - settle);

    type Drawn = { x: number; y: number; depth: number; r: number; a: number };
    const drawn: Drawn[] = [];

    // Dotted shell. Breathes slightly while working, locks to a true sphere
    // once resolved.
    for (let i = 0; i < shell.length; i++) {
      const breathe = 1 + Math.sin(t * 1.5 + i * 0.35) * 0.035 * (1 - settle);
      const [x, y, z] = rotate(shell[i], spin, tilt);
      drawn.push({
        x: cx + x * R * breathe,
        y: cy + y * R * breathe,
        depth: z,
        r: dotR,
        a: 0.5,
      });
    }

    // Orbiting particles converge onto the shell as the orb settles.
    for (let i = 0; i < orbits.length; i++) {
      const o = orbits[i];
      const angle = o.phase + t * o.rate * 1.6 * (1 - settle * 0.7);
      const ring = 1.34 - 0.34 * settle;
      const px = Math.cos(angle) * ring;
      const py = Math.sin(angle) * Math.sin(o.inclination) * ring;
      const pz = Math.sin(angle) * Math.cos(o.inclination) * ring;
      const [x, y, z] = rotate([px, py, pz], spin, tilt);
      drawn.push({
        x: cx + x * R,
        y: cy + y * R,
        depth: z,
        r: dotR * (1.5 - 0.35 * settle),
        a: 1,
      });
    }

    // Painter's algorithm — far dots first so near ones read as in front.
    drawn.sort((a, b) => a.depth - b.depth);

    ctx.fillStyle = color;
    for (const d of drawn) {
      // Depth drives both alpha and radius; that alone sells the volume.
      const near = (d.depth + 1) / 2;
      ctx.globalAlpha = Math.min(1, d.a * (0.16 + 0.84 * near));
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r * (0.6 + 0.4 * near), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function frame(now: number) {
    if (destroyed) return;
    if (!start) start = now;
    draw(now - start);
    raf = requestAnimationFrame(frame);
  }

  if (reduceMotion) {
    // A single representative frame — no animation, still legible.
    draw(1400);
  } else {
    raf = requestAnimationFrame(frame);
  }

  // Don't burn frames on a hidden tab.
  const onVisibility = () => {
    if (reduceMotion || destroyed) return;
    if (document.hidden) {
      cancelAnimationFrame(raf);
    } else {
      raf = requestAnimationFrame(frame);
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    setState(next: OrbState) {
      if (next === state) return;
      if (next === 'resolving') resolveStart = performance.now() - start;
      state = next;
      if (reduceMotion) draw(1400);
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
