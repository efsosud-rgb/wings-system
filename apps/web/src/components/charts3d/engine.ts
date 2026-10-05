import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { buildStudioEnvironment } from '../../brand/studio-environment.js';
import {
  COMPACT_WIDTH,
  makeScene,
  makeSharedTextures,
  type Scene3D,
  type SceneHost,
  type SharedTextures,
} from './scenes.js';
import type { ChartSpec } from './spec.js';

/**
 * One WebGL context for every 3D chart on the screen.
 *
 * The renderer draws off screen; each chart owns a plain 2D canvas and gets
 * its scene copied there every frame. So the page holds a single context
 * (the menu's logo holds the other), charts scroll and stack like any element,
 * and nothing floats over a menu or a dialog. Only charts in view are drawn;
 * a hidden tab draws nothing; the last chart to leave frees the context.
 */

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class ChartEngine {
  readonly renderer: THREE.WebGLRenderer;
  readonly reduced = reducedMotion();
  private envTarget: THREE.WebGLRenderTarget;
  private shared: SharedTextures;
  private scenes = new Map<Element, Scene3D>();
  private observer: IntersectionObserver | null = null;
  private raf = 0;
  private last = 0;

  constructor() {
    const canvas = document.createElement('canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.autoClear = false;
    RectAreaLightUniformsLib.init();
    this.envTarget = buildStudioEnvironment(this.renderer, 'light');
    this.shared = makeSharedTextures();
    document.addEventListener('visibilitychange', this.onVisibility);
    if (typeof IntersectionObserver !== 'undefined') {
      this.observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const scene = this.scenes.get(entry.target);
          if (scene) scene.visible = entry.isIntersecting;
        }
        this.loop();
      });
    }
  }

  private onVisibility = () => this.loop();

  /** A chart's scene, drawn by this engine until `remove`. */
  add(host: SceneHost, spec: ChartSpec): Scene3D {
    const scene = makeScene(spec, host, this.shared, this.envTarget.texture, this.reduced);
    this.scenes.set(host.stage, scene);
    this.specs.set(host.stage, { host, spec });
    if (this.observer) this.observer.observe(host.stage);
    else scene.visible = true;
    this.resize(host.stage);
    return scene;
  }

  private specs = new Map<Element, { host: SceneHost; spec: ChartSpec }>();

  private rebuild(stage: Element, old: Scene3D): Scene3D {
    const entry = this.specs.get(stage)!;
    old.dispose();
    const scene = makeScene(
      entry.spec,
      entry.host,
      this.shared,
      this.envTarget.texture,
      this.reduced,
    );
    scene.visible = old.visible;
    scene.t = old.t;
    this.scenes.set(stage, scene);
    return scene;
  }

  /** Swap a chart's scene for new data (another funnel, another period); the entrance plays again. */
  replace(host: SceneHost, spec: ChartSpec): Scene3D {
    const old = this.scenes.get(host.stage);
    const visible = old?.visible ?? false;
    old?.dispose();
    const scene = makeScene(spec, host, this.shared, this.envTarget.texture, this.reduced);
    scene.visible = visible;
    this.scenes.set(host.stage, scene);
    this.specs.set(host.stage, { host, spec });
    this.resize(host.stage);
    return scene;
  }

  resize(stage: Element) {
    let scene = this.scenes.get(stage);
    if (!scene) return;
    // Crossing the narrow width lays the chart out again.
    if (scene.compact !== (stage.clientWidth > 0 && stage.clientWidth < COMPACT_WIDTH)) {
      scene = this.rebuild(stage, scene);
    }
    scene.resize(stage.clientWidth, stage.clientHeight);
    const canvas = this.renderer.domElement;
    const w = (stage as HTMLElement).querySelector('canvas')?.width ?? 0;
    const h = (stage as HTMLElement).querySelector('canvas')?.height ?? 0;
    // The off-screen buffer grows to the largest chart; each draw uses its corner.
    if (canvas.width < w || canvas.height < h) {
      const dpr = this.renderer.getPixelRatio();
      this.renderer.setSize(
        Math.max(w, canvas.width) / dpr,
        Math.max(h, canvas.height) / dpr,
        false,
      );
    }
    this.loop();
  }

  remove(stage: Element) {
    const scene = this.scenes.get(stage);
    this.observer?.unobserve(stage);
    scene?.dispose();
    this.scenes.delete(stage);
    this.specs.delete(stage);
  }

  get size() {
    return this.scenes.size;
  }

  private running() {
    if (document.hidden) return false;
    for (const scene of this.scenes.values()) if (scene.visible) return true;
    return false;
  }

  loop() {
    const run = this.running();
    if (run && !this.raf) {
      this.last = 0;
      this.raf = requestAnimationFrame(this.tick);
    } else if (!run && this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private tick = (ts: number) => {
    this.raf = 0;
    const dt = this.last ? Math.min((ts - this.last) / 1000, 0.05) : 0;
    this.last = ts;
    for (const scene of this.scenes.values()) {
      if (!scene.visible) continue;
      scene.step(dt);
      scene.draw(this.renderer);
    }
    if (this.running()) this.raf = requestAnimationFrame(this.tick);
  };

  dispose() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.observer?.disconnect();
    for (const scene of this.scenes.values()) scene.dispose();
    this.scenes.clear();
    this.shared.contact.dispose();
    this.shared.ring.dispose();
    this.envTarget.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

// --- the one engine of the page ------------------------------------------------------------

let engine: ChartEngine | null = null;
let failed = false;
let release: ReturnType<typeof setTimeout> | null = null;

/** The page's engine, made on first use; null when WebGL is not there (the chart shows its table). */
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
