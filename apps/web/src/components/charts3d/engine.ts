import * as THREE from 'three';
import { buildStudioEnvironment } from '../../brand/studio-environment.js';
import { buildChart, type Built, type Hit } from './builders.js';
import { COMPACT_WIDTH, type ChartLabel, type ChartSpec } from './spec.js';

/**
 * One WebGL context for every 3D chart on the screen.
 *
 * The renderer draws off screen; each chart owns a plain 2D canvas and gets
 * its scene copied there after every frame it changes. So the page holds a
 * single context (the menu's logo holds the other), charts scroll and stack
 * like any element, and nothing floats over a menu or a dialog. Frames are
 * drawn only while something moves: the entrance, a hovered piece rising,
 * the camera turning back after a drag. A hidden tab or a chart scrolled
 * away draws nothing; the last chart to leave releases the context.
 */

export interface ViewCallbacks {
  /** The labels to lay over the canvas, once per build. */
  onLabels(labels: ChartLabel[]): void;
  /** Each label's position in CSS pixels, after every drawn frame; null when behind the camera. */
  onFrame(positions: ({ x: number; y: number } | null)[]): void;
  /** The hovered or keyboard-chosen piece: its tooltip text and where to show it. */
  onHover(hover: { text: string; x: number; y: number } | null): void;
}

const MAX_DPR = 2;
const compactWidth = (width: number) => width > 0 && width < COMPACT_WIDTH;

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

class View {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(20, 1, 0.1, 400);
  readonly ctx: CanvasRenderingContext2D;
  built: Built | null = null;
  spec: ChartSpec;
  width = 0;
  height = 0;
  visible = false;
  startedAt: number | null = null;
  entering = true;
  hover: Hit | null = null;
  pointer: { x: number; y: number } | null = null;
  lifts: number[] = [];
  yaw = 0;
  yawTarget = 0;
  drag: { x: number; yaw: number } | null = null;
  dirty = true;
  builtAspect = 0;
  builtCompact = false;

  constructor(
    readonly engine: ChartEngine,
    readonly canvas: HTMLCanvasElement,
    spec: ChartSpec,
    readonly callbacks: ViewCallbacks,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas unavailable');
    this.ctx = ctx;
    this.spec = spec;
    this.scene.environment = engine.environment;
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(-3, 6, 5);
    this.scene.add(key, new THREE.HemisphereLight(0xffffff, 0xd9d2c9, 0.55));
  }

  rebuild() {
    if (this.built) {
      this.scene.remove(this.built.root);
      this.built.dispose();
    }
    const aspect = this.width > 0 && this.height > 0 ? this.width / this.height : 2;
    this.builtAspect = aspect;
    this.builtCompact = compactWidth(this.width);
    this.built = buildChart(this.spec, {
      aspect,
      compact: this.builtCompact,
      shadowTexture: this.engine.shadowTexture,
    });
    this.scene.add(this.built.root);
    this.lifts = new Array<number>(this.built.pieceCount).fill(0);
    this.hover = null;
    this.callbacks.onLabels(this.built.labels);
    this.built.animate(this.engine.reduced || !this.entering ? Number.POSITIVE_INFINITY : 0);
    this.frame();
    this.dirty = true;
  }

  /** Point the camera at the scene from the chart's angle, as close as the whole of it allows. */
  frame() {
    const built = this.built;
    if (!built || this.width === 0) return;
    this.camera.aspect = this.width / this.height;
    const center = built.bounds.getCenter(new THREE.Vector3());
    const dir = new THREE.Vector3(
      Math.sin(built.azimuth) * Math.cos(built.elevation),
      Math.sin(built.elevation),
      Math.cos(built.azimuth) * Math.cos(built.elevation),
    );
    const corners: THREE.Vector3[] = [];
    for (const x of [built.bounds.min.x, built.bounds.max.x])
      for (const y of [built.bounds.min.y, built.bounds.max.y])
        for (const z of [built.bounds.min.z, built.bounds.max.z])
          corners.push(new THREE.Vector3(x, y, z));
    const fits = (distance: number) => {
      this.camera.position.copy(center).addScaledVector(dir, distance);
      this.camera.lookAt(center);
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld();
      return corners.every((corner) => {
        const p = corner.clone().project(this.camera);
        return p.z < 1 && Math.abs(p.x) <= 0.9 && Math.abs(p.y) <= 0.86;
      });
    };
    let low = 0.5;
    let high = 400;
    for (let i = 0; i < 24; i += 1) {
      const mid = (low + high) / 2;
      if (fits(mid)) high = mid;
      else low = mid;
    }
    fits(high);
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    const aspect = width / Math.max(1, height);
    // A box that changed shape a lot gets its layout again (heights follow the aspect).
    if (!this.built || Math.abs(aspect - this.builtAspect) / this.builtAspect > 0.25)
      this.rebuild();
    else this.frame();
    this.dirty = true;
    this.engine.wake();
  }

  /** Advance animations; true while anything still moves. */
  step(now: number): boolean {
    const built = this.built;
    if (!built) return false;
    let moving = false;
    if (this.entering && this.visible) {
      if (this.startedAt === null) this.startedAt = now;
      const still = built.animate(
        this.engine.reduced ? Number.POSITIVE_INFINITY : now - this.startedAt,
      );
      if (!still) this.entering = false;
      moving ||= still;
      this.dirty = true;
    }
    const reduced = this.engine.reduced;
    for (let i = 0; i < this.lifts.length; i += 1) {
      const target = this.hover?.piece === i ? 1 : 0;
      const current = this.lifts[i]!;
      if (current === target) continue;
      const next =
        reduced || Math.abs(target - current) < 0.01 ? target : current + (target - current) * 0.22;
      this.lifts[i] = next;
      built.lift(i, next);
      this.dirty = true;
      if (next !== target) moving = true;
    }
    if (this.yaw !== this.yawTarget) {
      // Slow: a drag turns the scene gently, and letting go brings it back on its own.
      const next =
        Math.abs(this.yawTarget - this.yaw) < 0.002
          ? this.yawTarget
          : this.yaw + (this.yawTarget - this.yaw) * 0.08;
      this.yaw = next;
      built.root.rotation.y = next;
      this.dirty = true;
      if (next !== this.yawTarget) moving = true;
    }
    return moving;
  }

  draw(renderer: THREE.WebGLRenderer) {
    if (!this.built || !this.dirty || !this.visible || this.width === 0) return;
    this.dirty = false;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.engine.ensureSize(w, h, dpr);
    const bufferHeight = renderer.domElement.height;
    renderer.setScissorTest(true);
    renderer.setViewport(0, 0, w / dpr, h / dpr);
    renderer.setScissor(0, 0, w / dpr, h / dpr);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    this.ctx.clearRect(0, 0, w, h);
    // WebGL's origin is the bottom left, so this chart's pixels are the buffer's last rows.
    this.ctx.drawImage(renderer.domElement, 0, bufferHeight - h, w, h, 0, 0, w, h);
    this.emitLabels();
  }

  private toScreen(point: THREE.Vector3): { x: number; y: number } | null {
    const world = this.built!.root.localToWorld(point.clone());
    const p = world.project(this.camera);
    if (p.z > 1) return null;
    return { x: ((p.x + 1) / 2) * this.width, y: ((1 - p.y) / 2) * this.height };
  }

  private emitLabels() {
    const built = this.built!;
    this.callbacks.onFrame(built.anchors.map((anchor) => this.toScreen(anchor)));
    if (this.hover) {
      const text = built.tip(this.hover);
      const at = this.pointer ?? this.toScreen(built.pieceAnchor(this.hover.piece));
      this.callbacks.onHover(at ? { text, x: at.x, y: at.y } : null);
    }
  }

  pick(x: number, y: number): Hit | null {
    if (!this.built) return null;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(
      new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1),
      this.camera,
    );
    for (const hit of raycaster.intersectObject(this.built.root, true)) {
      const found = this.built.hitOf(hit);
      if (found) return found;
    }
    return null;
  }

  setHover(hit: Hit | null, pointer: { x: number; y: number } | null) {
    const same = hit?.piece === this.hover?.piece && hit?.sub === this.hover?.sub;
    this.hover = hit;
    this.pointer = pointer;
    if (!hit) this.callbacks.onHover(null);
    else if (same && pointer) this.callbacks.onHover({ text: this.built!.tip(hit), ...pointer });
    this.dirty = true;
    this.engine.wake();
  }

  dispose() {
    if (this.built) {
      this.scene.remove(this.built.root);
      this.built.dispose();
      this.built = null;
    }
  }
}

export class ChartEngine {
  readonly renderer: THREE.WebGLRenderer;
  readonly environment: THREE.Texture;
  readonly shadowTexture: THREE.CanvasTexture;
  readonly reduced = reducedMotion();
  private envTarget: THREE.WebGLRenderTarget;
  private views = new Set<View>();
  private raf = 0;
  private observer: IntersectionObserver | null = null;
  private byElement = new Map<Element, View>();

  constructor() {
    const canvas = document.createElement('canvas');
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'low-power',
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    // A touch under 1 so the brand orange stays itself under the studio's bright sky.
    this.renderer.toneMappingExposure = 0.86;
    this.renderer.autoClear = false;
    this.envTarget = buildStudioEnvironment(this.renderer, 'light');
    this.environment = this.envTarget.texture;
    this.shadowTexture = softShadowTexture();
    document.addEventListener('visibilitychange', this.onVisibility);
    if (typeof IntersectionObserver !== 'undefined') {
      this.observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const view = this.byElement.get(entry.target);
          if (!view) continue;
          view.visible = entry.isIntersecting;
          view.dirty = true;
        }
        this.wake();
      });
    }
  }

  private onVisibility = () => {
    if (document.hidden) this.stop();
    else this.wake();
  };

  ensureSize(w: number, h: number, dpr: number) {
    const canvas = this.renderer.domElement;
    if (canvas.width >= w && canvas.height >= h && this.renderer.getPixelRatio() === dpr) return;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(Math.max(w, canvas.width) / dpr, Math.max(h, canvas.height) / dpr, false);
  }

  add(
    canvas: HTMLCanvasElement,
    observed: Element,
    spec: ChartSpec,
    callbacks: ViewCallbacks,
  ): View {
    const view = new View(this, canvas, spec, callbacks);
    this.views.add(view);
    this.byElement.set(observed, view);
    if (this.observer) this.observer.observe(observed);
    else view.visible = true;
    return view;
  }

  remove(view: View, observed: Element) {
    this.observer?.unobserve(observed);
    this.byElement.delete(observed);
    view.dispose();
    this.views.delete(view);
  }

  get size() {
    return this.views.size;
  }

  wake() {
    if (this.raf || document.hidden) return;
    this.raf = requestAnimationFrame(this.tick);
  }

  private stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private tick = (now: number) => {
    this.raf = 0;
    let moving = false;
    for (const view of this.views) {
      if (!view.visible) continue;
      moving = view.step(now) || moving;
      view.draw(this.renderer);
    }
    if (moving) this.wake();
  };

  dispose() {
    this.stop();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.observer?.disconnect();
    for (const view of this.views) view.dispose();
    this.views.clear();
    this.shadowTexture.dispose();
    this.envTarget.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

export type ChartView = View;

/** A blurred dark square on transparency: the contact shadow under every piece. */
function softShadowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.shadowColor = 'rgba(0,0,0,1)';
  ctx.shadowBlur = 22;
  // Draw the square off canvas and cast only its shadow onto it.
  ctx.shadowOffsetX = size * 4;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.roundRect(size / 4 - size * 4, size / 4, size / 2, size / 2, 10);
  ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// --- the one engine of the page ------------------------------------------------------------

let engine: ChartEngine | null = null;
let failed = false;
let release: ReturnType<typeof setTimeout> | null = null;

/** The page's engine, made on first use; null when WebGL is not there (the chart then draws flat). */
export function acquireEngine(): ChartEngine | null {
  if (release) {
    clearTimeout(release);
    release = null;
  }
  if (engine) return engine;
  if (failed) return null;
  try {
    engine = new ChartEngine();
    return engine;
  } catch {
    failed = true;
    return null;
  }
}

/** Called when a chart leaves; the last one out frees the context (a beat later, so a tab switch reuses it). */
export function releaseEngine() {
  if (!engine || engine.size > 0 || release) return;
  release = setTimeout(() => {
    release = null;
    if (engine && engine.size === 0) {
      engine.dispose();
      engine = null;
    }
  }, 400);
}

export { THREE };
