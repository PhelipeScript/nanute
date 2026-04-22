'use strict';
/**
 * Nanute — Canvas Animation Engine
 *
 * Pure mathematical animation system using Canvas 2D API.
 * No external dependencies. Zero memory leaks.
 *
 * States:
 *   idle        → breathing orbit, slow particles, soft glow
 *   listening   → expanding Gaussian rings, energised particles
 *   processing  → dual counter-rotating arcs, fast particles
 *   speaking    → radial waveform with prime-frequency bars
 *   notification→ bloom burst, accent flash
 *   paused      → dim, barely alive
 *   expanded    → minimal (panel takes over)
 *
 * Performance:
 *   - Adaptive frame rate: 5–60 fps depending on state
 *   - RAF cancelled when engine is stopped
 *   - Color and intensity smooth-lerped every frame
 */
const CanvasEngine = (() => {

  // ── Constants ────────────────────────────────────────────────────────────
  const CSS_W  = 80;
  const CSS_H  = 80;
  const CX     = CSS_W / 2;   // 40
  const CY     = CSS_H / 2;   // 40
  const CORE_R = 26;           // base circle radius (px)

  /** RGB palette per state */
  const PALETTE = {
    idle:         [120, 200, 255],
    listening:    [ 60, 220, 178],
    processing:   [ 85, 158, 255],
    speaking:     [175, 142, 255],
    notification: [255,  72, 118],
    paused:       [ 88, 108, 130],
    expanded:     [120, 200, 255],
  };

  /** Particle energy per state (0 – 1.5) */
  const ENERGY = {
    idle:         0.42,
    listening:    0.96,
    processing:   1.22,
    speaking:     0.88,
    notification: 1.10,
    paused:       0.06,
    expanded:     0.28,
  };

  /** Target ms between renders per state (adaptive fps) */
  const FRAME_MS = {
    idle:         33,   // ~30 fps
    listening:    16,   // ~60 fps
    processing:   16,
    speaking:     20,   // ~50 fps
    notification: 16,
    paused:      200,   //  ~5 fps — near-zero CPU
    expanded:     50,   // ~20 fps — minimal orb for panel header
  };

  // ── State ────────────────────────────────────────────────────────────────
  let canvas, ctx, dpr;
  let t             = 0;          // time accumulator (seconds)
  let lastFrameTime = 0;
  let rafId         = null;
  let running       = false;
  let state         = 'idle';

  // Current interpolated color (components kept as floats for smooth lerp)
  let [cr, cg, cb]  = PALETTE.idle;
  let [tr, tg, tb]  = PALETTE.idle;
  let energy        = 0.42;
  let targetEnergy  = 0.42;

  // ── Particle class ───────────────────────────────────────────────────────
  class Particle {
    /**
     * @param {number} radius  orbit radius in px
     * @param {number} speed   angular speed (rad / frame@60fps)
     * @param {number} phase   angular phase offset
     * @param {number} size    dot radius in px
     */
    constructor(radius, speed, phase, size) {
      this.radius = radius;
      this.speed  = speed;
      this.phase  = phase;
      this.size   = size;
      this.angle  = Math.random() * Math.PI * 2;
      this.alpha  = 0.18 + Math.random() * 0.36;
      // Slight elliptical squash on Y axis for depth illusion
      this.yf     = 0.83 + Math.random() * 0.17;
    }

    /** Advance angle by dt seconds */
    step(dt) {
      // Speed is defined as rad/s at energy=1.0; scale by current energy
      this.angle += this.speed * (0.55 + energy * 1.10) * dt;
    }

    /** Return current [x, y] position */
    pos() {
      // Lissajous-like: y-frequency slightly offset → organic spiral drift
      const r = this.radius + 2.4 * Math.sin(t * 0.36 + this.phase);
      return [
        CX + Math.cos(this.angle) * r,
        CY + Math.sin(this.angle * 1.065) * r * this.yf,
      ];
    }

    /** Draw dot onto ctx */
    draw() {
      const [x, y] = this.pos();
      // Sinusoidal alpha pulse — each particle breathes independently
      const pulse = 0.5 + 0.5 * Math.sin(t * 4.1 + this.phase);
      const a     = this.alpha * (0.22 + energy * 0.78) * (0.68 + pulse * 0.32);
      const sz    = this.size  * (0.70 + pulse * 0.42);
      ctx.beginPath();
      ctx.arc(x, y, sz, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${cr | 0},${cg | 0},${cb | 0},${a.toFixed(3)})`;
      ctx.fill();
    }
  }

  // ── Build particle field ─────────────────────────────────────────────────
  let particles = [];

  function buildParticles() {
    particles = [];
    // Three concentric orbital rings (inner → outer)
    const rings = [
      [8,  0.82, 10],   // [radius, speed rad/s, count]
      [15, 0.54, 13],
      [22, 0.36, 15],
    ];
    for (let o = 0; o < rings.length; o++) {
      const [r, spd, n] = rings[o];
      for (let i = 0; i < n; i++) {
        const phase = (i / n) * Math.PI * 2;
        particles.push(new Particle(r, spd, phase, 0.80 + o * 0.26));
      }
    }
    // Inner core nebula — tiny, fast, tight cluster
    for (let i = 0; i < 9; i++) {
      particles.push(
        new Particle(
          3 + Math.random() * 4.5,
          1.25 + Math.random() * 0.55,
          Math.random() * Math.PI * 2,
          0.52 + Math.random() * 0.32,
        ),
      );
    }
  }

  // ── Draw helpers ─────────────────────────────────────────────────────────

  /** Neural-network style connections between nearby particles */
  function drawConnections() {
    // Cache positions — only one pos() call per particle per frame
    const poses = particles.map(p => p.pos());
    ctx.lineWidth = 0.55;
    for (let i = 0; i < poses.length; i++) {
      for (let j = i + 1; j < poses.length; j += 4) { // sample every 4th for perf
        const [ax, ay] = poses[i];
        const [bx, by] = poses[j];
        const d = Math.hypot(ax - bx, ay - by);
        if (d < 13 && d > 2) {
          const a = ((1 - d / 13) * 0.068 * energy).toFixed(4);
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.strokeStyle = `rgba(${cr | 0},${cg | 0},${cb | 0},${a})`;
          ctx.stroke();
        }
      }
    }
  }

  /** Dark glass circle — base layer */
  function drawCoreDisk() {
    ctx.beginPath();
    ctx.arc(CX, CY, CORE_R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(5, 6, 14, 0.84)';
    ctx.fill();
  }

  /** Breathing ring border */
  function drawCoreRing() {
    const breathe = Math.sin(t * Math.PI * 2 / 3.2);   // period = 3.2s
    const r = CORE_R + breathe * 1.6;
    const a = (0.26 + 0.20 * breathe).toFixed(3);
    ctx.beginPath();
    ctx.arc(CX, CY, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${cr | 0},${cg | 0},${cb | 0},${a})`;
    ctx.lineWidth = 0.75;
    ctx.stroke();
  }

  /** Ambient radial glow behind circle */
  function drawAmbientGlow() {
    const gR = CORE_R * 1.7;
    const g  = ctx.createRadialGradient(CX, CY, 0, CX, CY, gR);
    g.addColorStop(0, `rgba(${cr | 0},${cg | 0},${cb | 0},${(0.19 * energy).toFixed(3)})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CSS_W, CSS_H);
  }

  /** Center emitter dot + soft glow halo */
  function drawEmitter() {
    const pulse = Math.abs(Math.sin(t * 2.9));
    const sz  = 2.1 + 1.3 * pulse;
    const hR  = sz * 5.5;
    // Halo gradient
    const g = ctx.createRadialGradient(CX, CY, 0, CX, CY, hR);
    g.addColorStop(0, `rgba(${cr | 0},${cg | 0},${cb | 0},${(0.42 * energy).toFixed(3)})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(CX, CY, hR, 0, Math.PI * 2);
    ctx.fill();
    // Core dot — slightly brighter/whiter
    ctx.beginPath();
    ctx.arc(CX, CY, sz, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(
      ${Math.min(255, (cr + 85)) | 0},
      ${Math.min(255, (cg + 40)) | 0},
      255, 0.96)`;
    ctx.fill();
  }

  // ── State-specific visual layers ─────────────────────────────────────────

  /** Idle: subtle outer ring that breathes in sync with CORE_R */
  function layerIdle() {
    const breathe = Math.sin(t * Math.PI * 2 / 3.2);
    const r = CORE_R + 6 + breathe * 3;
    const a = (0.09 + 0.07 * breathe).toFixed(3);
    ctx.beginPath();
    ctx.arc(CX, CY, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${cr | 0},${cg | 0},${cb | 0},${a})`;
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }

  /**
   * Listening: Gaussian-decay expanding rings.
   * Three rings offset by 120° in time → continuous ripple.
   */
  function layerListening() {
    const maxExpand = 36;   // max px past CORE_R before reset
    const speed     = 52;   // px per second
    for (let w = 0; w < 3; w++) {
      const expand = ((t * speed + w * (maxExpand / 3)) % maxExpand);
      // Gaussian decay: opacity strongest near CORE_R, fades outward
      const norm  = expand / maxExpand;
      const alpha = Math.exp(-5 * norm * norm) * 0.62;
      if (alpha < 0.01) continue;
      ctx.beginPath();
      ctx.arc(CX, CY, CORE_R + expand, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${cr | 0},${cg | 0},${cb | 0},${alpha.toFixed(3)})`;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  /**
   * Processing: two counter-rotating arcs — outer (fast) and inner (slow).
   * Arc length modulates slightly for organic feel.
   */
  function layerProcessing() {
    const TAU = Math.PI * 2;
    ctx.lineCap = 'round';

    // Outer arc — rotates CW
    const a1  = t * (TAU / 1.55); // full rotation in 1.55s
    const len1 = TAU * (0.30 + 0.06 * Math.sin(t * 1.8));
    ctx.beginPath();
    ctx.arc(CX, CY, CORE_R, a1, a1 + len1);
    ctx.strokeStyle = `rgba(${cr | 0},${cg | 0},${cb | 0},0.90)`;
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // Inner arc — rotates CCW, shorter
    const a2  = -(t * (TAU / 2.4));
    const len2 = TAU * (0.18 + 0.04 * Math.sin(t * 2.3));
    ctx.beginPath();
    ctx.arc(CX, CY, 17, a2, a2 + len2);
    ctx.strokeStyle = `rgba(${cr | 0},${cg | 0},${cb | 0},0.52)`;
    ctx.lineWidth = 1.1;
    ctx.stroke();

    ctx.lineCap = 'butt';
  }

  /**
   * Speaking: 7 radial bars with prime-based frequencies.
   * Creates natural, non-repeating waveform variation.
   */
  function layerSpeaking() {
    // Frequencies chosen as ratios of small primes → no perfect harmonic repeats
    const FREQS  = [0.83, 1.31, 0.97, 1.53, 0.71, 1.19, 1.07];
    const HALF_PI = Math.PI / 2;
    ctx.lineCap  = 'round';
    ctx.lineWidth = 2.0;

    for (let i = 0; i < 7; i++) {
      const angle  = (i / 7) * Math.PI * 2 - HALF_PI;
      const amp    = 5 + 9 * Math.abs(Math.sin(Math.PI * 2 * FREQS[i] * t));
      const innerR = 13;
      const outerR = innerR + amp;
      const ca     = Math.cos(angle);
      const sa     = Math.sin(angle);
      ctx.beginPath();
      ctx.moveTo(CX + ca * innerR, CY + sa * innerR);
      ctx.lineTo(CX + ca * outerR, CY + sa * outerR);
      ctx.strokeStyle = `rgba(${cr | 0},${cg | 0},${cb | 0},0.78)`;
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  /** Notification: intense bloom flash */
  function layerNotification() {
    const flicker = 0.5 + 0.5 * Math.sin(t * 18);
    const bR = 32 + flicker * 6;
    const g  = ctx.createRadialGradient(CX, CY, 0, CX, CY, bR);
    g.addColorStop(0,   `rgba(${cr | 0},${cg | 0},${cb | 0},${(0.55 + flicker * 0.25).toFixed(2)})`);
    g.addColorStop(0.45, `rgba(${cr | 0},${cg | 0},${cb | 0},${(0.18 + flicker * 0.10).toFixed(2)})`);
    g.addColorStop(1,   'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CSS_W, CSS_H);
  }

  // ── Main render loop ─────────────────────────────────────────────────────

  function render(timestamp) {
    if (!running) return;

    const elapsed = timestamp - lastFrameTime;
    const target  = FRAME_MS[state] ?? 33;

    if (elapsed >= target) {
      const dt      = Math.min(elapsed / 1000, 0.1); // cap at 100ms (tab restore)
      lastFrameTime = timestamp;
      t += dt;

      // ── Smooth lerp: color and energy ──────────────────────────────────
      // Frame-rate independent exponential decay lerp
      const lk = 1 - Math.pow(0.86, dt * 60);
      cr  += (tr - cr) * lk;
      cg  += (tg - cg) * lk;
      cb  += (tb - cb) * lk;
      energy += (targetEnergy - energy) * lk;

      // ── Advance particles ───────────────────────────────────────────────
      for (const p of particles) p.step(dt);

      // ── Clear ───────────────────────────────────────────────────────────
      ctx.clearRect(0, 0, CSS_W, CSS_H);

      // ── Render layers (back → front) ────────────────────────────────────
      drawAmbientGlow();    // 1. soft glow behind circle
      drawCoreDisk();       // 2. dark glass base
      drawConnections();    // 3. neural lines
      for (const p of particles) p.draw(); // 4. orbiting dots
      drawCoreRing();       // 5. breathing border

      // 6. State-specific overlay
      switch (state) {
        case 'idle':         layerIdle();         break;
        case 'listening':    layerListening();     break;
        case 'processing':   layerProcessing();    break;
        case 'speaking':     layerSpeaking();      break;
        case 'notification': layerNotification();  break;
        // paused / expanded: no extra layer — dim naturally via energy
      }

      drawEmitter();        // 7. center emitter dot (always on top)
    }

    rafId = requestAnimationFrame(render);
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Initialise the engine on a canvas element.
   * Must be called once before setState().
   * @param {HTMLCanvasElement} el
   */
  function init(el) {
    canvas = el;
    dpr    = Math.ceil(window.devicePixelRatio || 1); // always integer for crisp pixel grid

    // Physical pixel resolution
    canvas.width        = CSS_W * dpr;
    canvas.height       = CSS_H * dpr;
    canvas.style.width  = CSS_W + 'px';
    canvas.style.height = CSS_H + 'px';

    ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    buildParticles();

    running       = true;
    lastFrameTime = 0;
    rafId         = requestAnimationFrame(render);
  }

  /**
   * Transition to a new visual state.
   * Color and energy lerp smoothly over ~300ms.
   * @param {string} newState
   */
  function setState(newState) {
    if (!PALETTE[newState]) return;
    state = newState;
    [tr, tg, tb]  = PALETTE[newState];
    targetEnergy  = ENERGY[newState] ?? 0.42;
  }

  /** Pause the RAF loop (near-zero CPU). */
  function stop() {
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  /** Resume the RAF loop. */
  function start() {
    if (running) return;
    running       = true;
    lastFrameTime = 0;
    rafId         = requestAnimationFrame(render);
  }

  return { init, setState, stop, start };
})();
