// WingsLogo3D: o logo oficial da Wings em relevo 3D (extrudado com chanfro), com
// material metálico, balanço lento, faixa de luz que passa pela superfície e
// inclinação que segue o mouse.
//
// Uso:
//   const logo = new WingsLogo3D(canvasEl, { variant: 'dark' });   // fundo escuro (login)
//   const logo = new WingsLogo3D(canvasEl, { variant: 'light', motion: 'subtle' }); // menu lateral
//   logo.dispose();                                                 // ao desmontar
//
// variant 'light' = assinatura principal (WINGS em preto, S alado em laranja), para fundo claro.
// variant 'dark'  = versão negativa (WINGS em prata, S alado em laranja), para fundo escuro.
// As cores da marca vêm do manual: laranja orgânico #E95228, preto nobre #000000.
//
// Feito e conferido com three r186. Funciona a partir da r162 (environmentRotation e
// NeutralToneMapping); em versões mais antigas os reflexos ficam parados.

import * as THREE from 'three';
import { buildStudioEnvironment } from './studio-environment.js';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { LOGO } from './wings-logo-paths.js';

const BRAND_ORANGE = '#E95228';

const MATERIALS = {
  dark: {
    wordFace: { color: '#dadde4', metalness: 1, roughness: 0.11, clearcoat: 0.6, clearcoatRoughness: 0.08, envMapIntensity: 1.2 },
    wordSide: { color: '#f2f3f6', metalness: 1, roughness: 0.09, envMapIntensity: 1.55 },
    sFace: { color: BRAND_ORANGE, metalness: 0.3, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 0.95 },
    sSide: { color: BRAND_ORANGE, metalness: 0.85, roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.3 },
  },
  light: {
    wordFace: { color: '#0a0a0b', metalness: 0, roughness: 0.45, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 0.2 },
    wordSide: { color: '#3a3a42', metalness: 0.9, roughness: 0.16, envMapIntensity: 1.1 },
    sFace: { color: BRAND_ORANGE, metalness: 0.25, roughness: 0.34, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 0.85 },
    sSide: { color: BRAND_ORANGE, metalness: 0.8, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.2 },
  },
};

// Profundidade do relevo em unidades do SVG (o logo tem 272 de largura e 90 de altura).
const RELIEF = {
  WINGS: { depth: 8, bevelThickness: 1.6, bevelSize: 0.4 },
  S: { depth: 8, bevelThickness: 1.6, bevelSize: 0.4 },
  COMPANY: { depth: 3, bevelThickness: 0.7, bevelSize: 0.24 },
};

const LOGO_WIDTH = 10; // largura do logo no mundo 3D

export function supportsWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGL2RenderingContext && c.getContext('webgl2')) || !!c.getContext('webgl');
  } catch (e) {
    return false;
  }
}

function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
const clamp01 = (t) => Math.min(1, Math.max(0, t));

let rectAreaReady = false;

export class WingsLogo3D {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.opts = Object.assign(
      { variant: 'light', company: true, motion: 'full', intro: true, interactive: true, fit: 0.8, onFallback: null },
      options,
    );
    this.reduced = prefersReducedMotion();
    this.disposed = false;
    this.visible = true;
    this.running = false;
    this.pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    this.sweepStart = -1;
    this.nextSweep = 1.9;
    this.lastTs = 0;
    this.elapsed = 0;

    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
    } catch (e) {
      this.failed = true;
      if (typeof this.opts.onFallback === 'function') this.opts.onFallback(e);
      return;
    }

    const r = this.renderer;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.setClearColor(0x000000, 0);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NeutralToneMapping !== undefined ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = this.opts.variant === 'dark' ? 1.05 : 1.0;

    if (!rectAreaReady) {
      RectAreaLightUniformsLib.init();
      rectAreaReady = true;
    }

    this.scene = new THREE.Scene();
    this.envTarget = buildStudioEnvironment(this.renderer, this.opts.variant);
    this.scene.environment = this.envTarget.texture;

    this.camera = new THREE.PerspectiveCamera(26, 1, 0.1, 200);

    this.root = new THREE.Group();
    this.relief = new THREE.Group();
    this.root.add(this.relief);
    this.scene.add(this.root);
    this.buildLogo();

    // Faixa de luz que atravessa o logo.
    this.sweepLight = new THREE.RectAreaLight(0xffffff, 0, 0.7, 10);
    this.sweepLight.position.set(-30, 0, 4.5);
    this.scene.add(this.sweepLight);

    // Luz de recorte suave vinda de cima, para separar os planos do relevo.
    const key = new THREE.DirectionalLight(0xffffff, this.opts.variant === 'dark' ? 0.9 : 1.2);
    key.position.set(-3, 6, 8);
    this.scene.add(key);

    this.onResize = this.onResize.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerLeave = this.onPointerLeave.bind(this);
    this.onPointerEnter = this.onPointerEnter.bind(this);
    this.onVisibility = this.onVisibility.bind(this);
    this.tick = this.tick.bind(this);

    this.resizeObserver = new ResizeObserver(this.onResize);
    this.resizeObserver.observe(canvas);
    this.intersection = new IntersectionObserver((entries) => {
      this.visible = entries.some((e) => e.isIntersecting);
      this.updateRunning();
    });
    this.intersection.observe(canvas);
    document.addEventListener('visibilitychange', this.onVisibility);

    if (this.opts.interactive && !this.reduced) {
      canvas.addEventListener('pointermove', this.onPointerMove);
      canvas.addEventListener('pointerleave', this.onPointerLeave);
      canvas.addEventListener('pointerenter', this.onPointerEnter);
    }

    this.onResize();
    if (this.reduced || !this.opts.intro) this.elapsed = 2;
    this.renderStill();
    this.updateRunning();
  }

  buildLogo() {
    const set = MATERIALS[this.opts.variant] || MATERIALS.light;
    const mk = (p) => new THREE.MeshPhysicalMaterial(p);
    this.materials = { wordFace: mk(set.wordFace), wordSide: mk(set.wordSide), sFace: mk(set.sFace), sSide: mk(set.sSide) };
    const loader = new SVGLoader();
    const parts = this.opts.company ? LOGO.paths : LOGO.paths.filter((p) => p.part !== 'COMPANY');

    // Sem "COMPANY", o enquadramento usa só a altura de WINGS + S.
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of parts) {
      const nums = p.d.match(/-?\d+(\.\d+)?/g).map(Number);
      for (let i = 1; i < nums.length; i += 2) {
        if (nums[i] < minY) minY = nums[i];
        if (nums[i] > maxY) maxY = nums[i];
      }
    }
    this.logoAspect = LOGO.w / (maxY - minY);

    for (const p of parts) {
      const data = loader.parse(`<svg xmlns="http://www.w3.org/2000/svg"><path d="${p.d}"/></svg>`);
      const shapes = [];
      for (const sp of data.paths) shapes.push(...(Number(THREE.REVISION) >= 185 ? sp.toShapes() : SVGLoader.createShapes(sp)));
      const cfg = RELIEF[p.part];
      const geo = new THREE.ExtrudeGeometry(shapes, {
        depth: cfg.depth,
        bevelEnabled: true,
        bevelThickness: cfg.bevelThickness,
        bevelSize: cfg.bevelSize,
        bevelOffset: -cfg.bevelSize,
        bevelSegments: 6,
        curveSegments: 14,
      });
      geo.translate(-LOGO.w / 2, -(minY + maxY) / 2, -3);
      const isS = p.part === 'S';
      const mesh = new THREE.Mesh(geo, isS ? [this.materials.sFace, this.materials.sSide] : [this.materials.wordFace, this.materials.wordSide]);
      this.relief.add(mesh);
    }
    const k = LOGO_WIDTH / LOGO.w;
    this.relief.scale.set(k, -k, k);
    this.baseScaleZ = k;
  }

  onResize() {
    if (this.disposed) return;
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const logoH = LOGO_WIDTH / this.logoAspect;
    const fit = this.opts.fit;
    const distW = LOGO_WIDTH / fit / (2 * Math.tan(vFov / 2) * this.camera.aspect);
    const distH = logoH / fit / (2 * Math.tan(vFov / 2));
    this.camera.position.set(0, 0, Math.max(distW, distH) + 1.2);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    if (!this.running) this.renderStill();
  }

  onPointerMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.tx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.ty = ((e.clientY - rect.top) / rect.height) * 2 - 1;
  }

  onPointerLeave() {
    this.pointer.tx = 0;
    this.pointer.ty = 0;
  }

  onPointerEnter() {
    this.sweep();
  }

  onVisibility() {
    this.updateRunning();
  }

  sweep() {
    if (this.reduced || this.disposed) return;
    if (this.sweepStart < 0 || this.elapsed - this.sweepStart > 1.5) this.sweepStart = this.elapsed;
    this.updateRunning();
  }

  updateRunning() {
    if (this.disposed || this.failed) return;
    const shouldRun = !this.reduced && this.visible && !document.hidden;
    if (shouldRun && !this.running) {
      this.running = true;
      this.lastTs = 0;
      this.raf = requestAnimationFrame(this.tick);
    } else if (!shouldRun && this.running) {
      this.running = false;
      cancelAnimationFrame(this.raf);
    }
  }

  pose(t) {
    const subtle = this.opts.motion === 'subtle';
    // Entrada: o relevo "nasce" da superfície (profundidade de 2% a 100%) enquanto o logo se ergue.
    const intro = this.opts.intro && !this.reduced ? easeOutCubic(clamp01(t / 1.5)) : 1;
    this.relief.scale.z = this.baseScaleZ * (0.02 + 0.98 * intro);
    const settle = 1 - intro;

    let ry;
    let rx;
    let y = 0;
    if (this.reduced) {
      ry = -0.16;
      rx = 0.05;
    } else {
      const ampY = subtle ? 0.13 : 0.24;
      const ampX = subtle ? 0.035 : 0.07;
      ry = ampY * Math.sin(t * 0.55) - settle * 0.35;
      rx = ampX * Math.sin(t * 0.38 + 1.1) + settle * 0.55;
      y = (subtle ? 0.03 : 0.08) * Math.sin(t * 0.9);
      // Inclinação que segue o mouse, suavizada.
      this.pointer.x += (this.pointer.tx - this.pointer.x) * 0.08;
      this.pointer.y += (this.pointer.ty - this.pointer.y) * 0.08;
      ry += this.pointer.x * 0.32;
      rx += this.pointer.y * 0.18;
    }
    this.root.rotation.set(rx, ry, 0);
    this.root.position.y = y;

    // Reflexos que andam devagar pelo cromado.
    let envY = this.reduced ? 0.25 : 0.25 + 0.3 * Math.sin(t * 0.21);

    // Faixa de luz: uma passada no fim da entrada, depois a cada ~6 s (e ao passar o mouse).
    if (!this.reduced && t >= this.nextSweep && (this.sweepStart < 0 || t - this.sweepStart > 1.5)) {
      this.sweepStart = t;
      this.nextSweep = t + 6.2;
    }
    const s = this.sweepStart >= 0 ? clamp01((t - this.sweepStart) / 1.35) : 1;
    if (s < 1) {
      const x = -8 + 16 * easeInOutSine(s);
      this.sweepLight.position.set(x, 0.4, 3.2);
      this.sweepLight.lookAt(x * 0.5, 0, 0);
      this.sweepLight.intensity = (this.opts.variant === 'dark' ? 22 : 14) * Math.sin(Math.PI * s);
      envY += 0.55 * Math.sin(Math.PI * s); // as tiras de luz do estúdio deslizam pelas letras
    } else {
      this.sweepLight.intensity = 0;
    }
    if (this.scene.environmentRotation) this.scene.environmentRotation.y = envY; // three r162+
  }

  renderStill() {
    if (this.disposed || this.failed) return;
    this.pose(this.elapsed);
    this.renderer.render(this.scene, this.camera);
  }

  tick(ts) {
    if (!this.running || this.disposed) return;
    const dt = this.lastTs ? (ts - this.lastTs) / 1000 : 0;
    this.lastTs = ts;
    this.elapsed += Math.min(Math.max(dt, 0), 0.05);
    this.pose(this.elapsed);
    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.tick);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.raf);
    if (this.failed) return;
    this.resizeObserver.disconnect();
    this.intersection.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('pointerenter', this.onPointerEnter);
    this.relief.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    Object.values(this.materials).forEach((m) => m.dispose());
    this.envTarget.dispose();
    this.renderer.dispose();
  }
}
