import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Matrix4,
  NormalBlending,
  PerspectiveCamera,
  Plane,
  Points,
  Raycaster,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
} from 'three';
import { WING_POINTS_B64 } from '../../generated/wing-points.js';
import { decodeWingPoints } from '../../lib/wing-points.js';
import { frameBrake } from './brake.js';

/**
 * The 3D scene, one choreography: the logo's wing in particles that come apart
 * (problem), become a network (solution, services), a path (process) and the
 * wing again (final). Ported from the approved page (landing v3) with the white
 * background only: `uLight` stays 1 and the blending is NormalBlending. Loaded
 * after the first paint; when WebGL fails the page shows `.no-gl`.
 */

export interface PointerState {
  x: number;
  y: number;
  active: boolean;
  t: number;
}

export interface GyroState {
  x: number;
  y: number;
  on: boolean;
}

export interface SceneInput {
  canvas: HTMLCanvasElement;
  reduce: boolean;
  coarse: boolean;
  pointer: PointerState;
  gyro: GyroState;
  /** The process timeline's current step (-1 outside it). */
  step: () => number;
  /** The sections that drive the choreography (`data-form`, `data-l`, `data-p`, `data-n`, `data-glo`). */
  sections: HTMLElement[];
  /** Overrides the particle count (the OG image renders the full set without motion). */
  particles?: number;
  /** The frame-time brake; false only to measure the scene as it is (`?freio=0`, tests). */
  brake?: boolean;
}

export interface Scene3d {
  onScroll(): void;
  remeasure(): void;
}

type Vec4 = [number, number, number, number];
type Vec3 = [number, number, number];

declare global {
  interface Window {
    __wings3d?: () => Record<string, unknown>;
  }
  interface Navigator {
    deviceMemory?: number;
  }
}

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (t: number) => t * t * (3 - 2 * t);

/** Pixel ratio ceiling of a touch phone with motion that is not "weak" (3 = the screen's own size). */
const PHONE_MAX_PR = 2;

/** The scene, or null when WebGL cannot start. */
export function createScene(input: SceneInput): Scene3d | null {
  const { canvas, reduce, coarse, pointer: ptr, gyro } = input;
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: true,
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
    });
  } catch {
    return null;
  }
  const weak = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 3;
  const N = input.particles ?? (reduce ? 3200 : weak ? 2800 : coarse ? 5200 : 8400);
  const PR = Math.min(devicePixelRatio || 1, weak ? 1 : coarse ? (reduce ? 1.5 : PHONE_MAX_PR) : 2);
  renderer.setPixelRatio(PR);
  // the brake: on a touch phone with motion, a slow scene steps down this ladder (never back up)
  const ladder = [PR, 2, 1.5, 1.25, 1].filter((s, i) => !i || s < PR);
  const brake =
    (input.brake ?? true) && coarse && !reduce && ladder.length > 1 ? frameBrake() : null;
  let rung = 0,
    curPR = PR;
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  const camera = new PerspectiveCamera(38, 1, 0.1, 80);
  camera.position.set(0, 0, 10);

  const rng = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = rng(20251015);
  const gauss = () => {
    let u = 0,
      v = 0;
    while (!u) u = r();
    while (!v) v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  // the wing's points, sampled from the official logo (brandbook, page 1)
  const wing = decodeWingPoints(WING_POINTS_B64);
  const nW = wing.length / 2;
  const at = (array: Float32Array, i: number) => array[i] ?? 0;

  const aW = new Float32Array(N * 3),
    aC = new Float32Array(N * 3),
    aN = new Float32Array(N * 3),
    aP = new Float32Array(N * 3);
  const aCol = new Float32Array(N * 3),
    aColL = new Float32Array(N * 3),
    aSize = new Float32Array(N),
    aRand = new Float32Array(N),
    aEdge = new Float32Array(N * 2),
    aStep = new Float32Array(N);

  const WS = 3.05;
  for (let i = 0; i < N; i++) {
    const j = i % nW,
      x = at(wing, 2 * j) * WS + (r() - 0.5) * 0.03,
      y = at(wing, 2 * j + 1) * WS + (r() - 0.5) * 0.03;
    const thick = i >= nW ? (r() - 0.5) * 0.7 : (r() - 0.5) * 0.16;
    aW.set([x, y, 0.55 * Math.sin(x * 0.62) - 0.16 * y + thick], i * 3);
  }
  for (let i = 0; i < N; i++) {
    const u = r() * 2 - 1,
      th = r() * Math.PI * 2,
      rad = 1.6 + Math.pow(r(), 0.55) * 4.6,
      s = Math.sqrt(1 - u * u);
    aC.set(
      [
        rad * s * Math.cos(th) * 1.3 + gauss() * 0.15,
        rad * u * 0.78 + gauss() * 0.15,
        rad * s * Math.sin(th) * 0.9 - 0.8,
      ],
      i * 3,
    );
  }
  const nodes: Vec3[] = [[0, 0, 0]];
  let guard = 0;
  while (nodes.length < 26 && guard++ < 4000) {
    const x = (r() * 2 - 1) * 4.5,
      y = (r() * 2 - 1) * 2.7;
    if ((x * x) / 20.25 + (y * y) / 7.29 > 1) continue;
    if (nodes.some((n) => (n[0] - x) ** 2 + (n[1] - y) ** 2 < 0.85)) continue;
    nodes.push([x, y, 0.35 * Math.sin(x * 0.8) + (r() - 0.5) * 0.9]);
  }
  const edges: [number, number][] = [],
    seen = new Set<string>();
  nodes.forEach((n, i) => {
    const near = nodes
      .map((m, j): [number, number] => [
        j,
        (m[0] - n[0]) ** 2 + (m[1] - n[1]) ** 2 + (m[2] - n[2]) ** 2,
      ])
      .filter((a) => a[0] !== i)
      .sort((a, b) => a[1] - b[1])
      .slice(0, i === 0 ? 5 : 2);
    near.forEach(([j]) => {
      const k = i < j ? i + '-' + j : j + '-' + i;
      if (!seen.has(k)) {
        seen.add(k);
        edges.push([i, j]);
      }
    });
  });
  const node = (k: number): Vec3 => nodes[k] ?? [0, 0, 0];
  for (let i = 0; i < N; i++) {
    aEdge[i * 2] = -1;
    aEdge[i * 2 + 1] = 0;
    if (r() < 0.3) {
      const k = r() < 0.12 ? 0 : 1 + Math.floor(r() * (nodes.length - 1)),
        n = node(k),
        sp = k === 0 ? 0.2 : 0.09;
      aN.set([n[0] + gauss() * sp, n[1] + gauss() * sp, n[2] + gauss() * sp], i * 3);
    } else {
      const e = Math.floor(r() * edges.length),
        edge = edges[e] ?? [0, 0],
        a = node(edge[0]),
        b = node(edge[1]),
        t = r();
      aN.set(
        [
          a[0] + (b[0] - a[0]) * t + gauss() * 0.025,
          a[1] + (b[1] - a[1]) * t + gauss() * 0.025,
          a[2] + (b[2] - a[2]) * t + gauss() * 0.025,
        ],
        i * 3,
      );
      aEdge[i * 2] = t;
      aEdge[i * 2 + 1] = (e * 0.137) % 1;
    }
  }
  const P: Vec3[] = [
    [-0.9, 2.35, 0],
    [0.95, 0.8, 0.5],
    [-0.85, -0.8, -0.45],
    [0.9, -2.35, 0.2],
  ];
  const pathPoint = (k: number): Vec3 => P[k] ?? [0, 0, 0];
  const cr = (p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 => {
    const t2 = t * t,
      t3 = t2 * t;
    const axis = (k: 0 | 1 | 2) =>
      0.5 *
      (2 * p1[k] +
        (-p0[k] + p2[k]) * t +
        (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 +
        (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
    return [axis(0), axis(1), axis(2)];
  };
  const onPath = (s: number) => {
    const seg = Math.min(2, Math.floor(s * 3)),
      t = s * 3 - seg;
    return cr(
      pathPoint(Math.max(0, seg - 1)),
      pathPoint(seg),
      pathPoint(seg + 1),
      pathPoint(Math.min(3, seg + 2)),
      t,
    );
  };
  for (let i = 0; i < N; i++) {
    aStep[i] = -1;
    if (r() < 0.24) {
      const k = Math.floor(r() * 4),
        a = r() * Math.PI * 2,
        rad = 0.2 + Math.abs(gauss()) * 0.07,
        p = pathPoint(k);
      aP.set(
        [p[0] + Math.cos(a) * rad, p[1] + Math.sin(a) * rad * 0.9, p[2] + gauss() * 0.06],
        i * 3,
      );
      aStep[i] = k;
    } else {
      const p = onPath(r()),
        a = r() * Math.PI * 2,
        rad = 0.04 + r() * 0.12;
      aP.set([p[0] + Math.cos(a) * rad, p[1] + gauss() * 0.03, p[2] + Math.sin(a) * rad], i * 3);
    }
  }
  // brandbook colours. PAL (light that adds up) is the dark background's and
  // stays only because the shader still reads it; on white the points are
  // PALL: organic orange, dark orange and noble black, solid.
  const PAL: Vec3[] = [
    [0.914, 0.322, 0.157],
    [1.0, 0.45, 0.27],
    [1.0, 0.82, 0.72],
    [1, 1, 1],
  ];
  const PALL: Vec3[] = [
    [0.914, 0.322, 0.157],
    [0.722, 0.227, 0.082],
    [0.98, 0.55, 0.38],
    [0.0, 0.0, 0.0],
  ];
  const PW = [0.58, 0.22, 0.12, 0.08];
  for (let i = 0; i < N; i++) {
    let x = r(),
      k = 0;
    while (k < PW.length - 1 && x > (PW[k] ?? 0)) {
      x -= PW[k] ?? 0;
      k++;
    }
    aCol.set(PAL[k] ?? [1, 1, 1], i * 3);
    aColL.set(PALL[k] ?? [0, 0, 0], i * 3);
    aSize[i] = r() < 0.04 ? 1.6 + r() * 0.7 : 0.5 + r() * 0.75;
    aRand[i] = r();
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(aW, 3));
  (
    [
      ['aW', aW, 3],
      ['aC', aC, 3],
      ['aN', aN, 3],
      ['aP', aP, 3],
      ['aCol', aCol, 3],
      ['aColL', aColL, 3],
      ['aSize', aSize, 1],
      ['aRand', aRand, 1],
      ['aEdge', aEdge, 2],
      ['aStep', aStep, 1],
    ] as const
  ).forEach(([n, a, s]) => geo.setAttribute(n, new BufferAttribute(a, s)));

  const uni = {
    uTime: { value: 0 },
    uMix: { value: new Vector4(reduce ? 1 : 0, reduce ? 0 : 1, 0, 0) },
    uMouse: { value: new Vector3(99, 99, 0) },
    uMouseK: { value: 0 },
    uSize: { value: (coarse ? 36 : 44) * Math.min(1.6, Math.max(1, Math.sqrt(8400 / N))) },
    uPR: { value: PR },
    uStep: { value: -1 },
    uDrift: { value: reduce ? 0 : 1 },
    uAlpha: { value: 1 },
    uLight: { value: 1 },
  };
  const mat = new ShaderMaterial({
    uniforms: uni,
    transparent: true,
    depthWrite: false,
    blending: NormalBlending,
    vertexShader: `
        uniform float uTime; uniform vec4 uMix; uniform vec3 uMouse; uniform float uMouseK; uniform float uSize; uniform float uPR; uniform float uStep; uniform float uDrift; uniform float uAlpha; uniform float uLight;
        attribute vec3 aW; attribute vec3 aC; attribute vec3 aN; attribute vec3 aP; attribute vec3 aCol; attribute vec3 aColL; attribute float aSize; attribute float aRand; attribute vec2 aEdge; attribute float aStep;
        varying vec3 vCol; varying float vA;
        void main(){
          vec3 p = aW*uMix.x + aC*uMix.y + aN*uMix.z + aP*uMix.w;
          float t = uTime*(0.22 + aRand*0.3) + aRand*40.0;
          p += vec3(sin(t + p.y*0.7), cos(t*0.9 + p.x*0.6), sin(t*0.7 + p.z))*(0.025 + uMix.y*0.2)*uDrift;
          vec2 d = p.xy - uMouse.xy; float f = uMouseK*(1.0 - smoothstep(0.0, 1.15, length(d)));
          p.xy += normalize(d + 1e-4)*f*0.55; p.z += f*0.8;
          vec4 mv = modelViewMatrix*vec4(p, 1.0);
          gl_Position = projectionMatrix*mv;
          float glow = 0.0;
          if (aEdge.x >= 0.0) { float ph = fract(uTime*0.16 + aEdge.y); glow += (1.0 - smoothstep(0.0, 0.07, abs(aEdge.x - ph)))*uMix.z*1.3; }
          if (aStep >= 0.0) { glow += (1.0 - step(0.5, abs(aStep - uStep)))*uMix.w*1.25; }
          float sizeK = mix(1.0, 0.82, uLight);
          gl_PointSize = uSize*sizeK*aSize*(1.0 + glow*0.7)*uPR/max(0.5, -mv.z);
          vec3 dark = mix(aCol, vec3(1.0, 0.9, 0.82), clamp(glow, 0.0, 1.0)*0.55);
          vec3 light = mix(aColL, vec3(0.914, 0.322, 0.157), clamp(glow, 0.0, 1.0)*0.85);
          vCol = mix(dark, light, uLight);
          float a = (0.5 + 0.5*aRand)*(1.0 + glow)*uAlpha*(1.0 - smoothstep(14.0, 22.0, -mv.z));
          vA = mix(a, min(1.0, a*0.85 + 0.12*glow), uLight);
        }`,
    fragmentShader: `
        uniform float uLight; varying vec3 vCol; varying float vA;
        void main(){
          vec2 c = gl_PointCoord - 0.5; float r2 = dot(c, c);
          float soft = exp(-r2*13.0);
          float solid = 1.0 - smoothstep(0.12, 0.25, r2);
          float a = mix(soft, solid, uLight);
          if (a < 0.03) discard;
          gl_FragColor = vec4(vCol, a*vA);
        }`,
  });
  const points = new Points(geo, mat);
  points.frustumCulled = false;
  const group = new Group();
  group.add(points);
  scene.add(group);

  const FORM: Record<string, Vec4> = {
    wing: [1, 0, 0, 0],
    chaos: [0, 1, 0, 0],
    net: [0, 0, 1, 0],
    path: [0, 0, 0, 1],
  };
  const numbers = (value: string | undefined) => (value ?? '0,0,1').split(',').map(Number);
  const secs = input.sections.map((el) => ({
    el,
    form: FORM[el.dataset.form ?? 'wing'] ?? FORM.wing!,
    L: numbers(el.dataset.l),
    Pt: numbers(el.dataset.p),
    // phones (<= 640 px): x (times the screen aspect, so it keeps its place), y, scale, alpha
    N: numbers(el.dataset.n),
    glo: parseFloat(el.dataset.glo || '1'),
  }));
  type Section = (typeof secs)[number];
  let meta: { s: Section; a: number; b: number }[] = [],
    portrait = false;
  function measure() {
    const vh = innerHeight;
    portrait = innerWidth / vh < 0.9 || innerWidth <= 980;
    meta = secs.map((s) => {
      const rc = s.el.getBoundingClientRect(),
        top = rc.top + scrollY,
        h = s.el.offsetHeight,
        pad = Math.min(vh * 0.32, h * 0.45);
      return { s, a: top + pad, b: top + h - pad };
    });
  }
  const target = { mix: new Vector4(1, 0, 0, 0), x: 0, y: 0, sc: 1, glo: 1 };
  function aim() {
    if (!meta.length) return;
    const vc = scrollY + innerHeight / 2;
    // j: the section the screen centre is in or heading to; i: the one it leaves while between two
    let j = meta.findIndex((m) => vc <= m.b);
    if (j < 0) j = meta.length - 1;
    const i = j && vc < meta[j]!.a ? j - 1 : j,
      t = smooth(clamp((vc - meta[i]!.b) / Math.max(1, meta[j]!.a - meta[i]!.b)));
    // a section's pose: form mix, x, y, scale, alpha; portrait phones (<= 640 px) use N
    const pose = (s: Section) =>
      innerWidth <= 640 && camera.aspect < 0.9
        ? [...s.form, s.N[0]! * camera.aspect, s.N[1]!, s.N[2]!, s.N[3]!]
        : [...s.form, ...(portrait ? s.Pt : s.L), s.glo];
    const a = pose(meta[i]!.s),
      b = pose(meta[j]!.s),
      v = a.map((x, n) => x + (b[n]! - x) * t);
    target.mix.fromArray(v);
    target.x = v[4]!;
    target.y = v[5]!;
    target.sc = v[6]!;
    target.glo = v[7]!;
  }
  function resize() {
    const w = canvas.clientWidth || innerWidth,
      h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = camera.aspect < 0.9 ? 54 : 38;
    camera.updateProjectionMatrix();
    measure();
    aim();
  }

  const curMix = uni.uMix.value,
    rot = { x: 0, y: 0 },
    mouseLocal = new Vector3(99, 99, 0);
  const ray = new Raycaster(),
    ndc = new Vector2(),
    inv = new Matrix4(),
    plane = new Plane(new Vector3(0, 0, 1), 0),
    hit = new Vector3();
  let raf = 0,
    last = performance.now();
  const introStart = performance.now() + 250,
    introUntil = introStart + 1900,
    chaosMix = new Vector4(0, 1, 0, 0);
  function update(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const k = reduce ? 1 : 1 - Math.pow(1 - 0.06, dt * 60);
    if (!reduce && now < introUntil) {
      const q = clamp((now - introStart) / (introUntil - introStart));
      curMix.copy(chaosMix).lerp(target.mix, 1 - Math.pow(1 - q, 3));
    } else curMix.lerp(target.mix, reduce ? 1 : 1 - Math.pow(1 - 0.07, dt * 60));
    group.position.x += (target.x - group.position.x) * k;
    group.position.y += (target.y - group.position.y) * k;
    const sc = group.scale.x + (target.sc - group.scale.x) * k;
    group.scale.setScalar(sc);
    uni.uAlpha.value += (target.glo - uni.uAlpha.value) * k;
    const ix = gyro.on ? gyro.x : ptr.x,
      iy = gyro.on ? gyro.y : ptr.y;
    const sway = reduce ? 0 : Math.sin(now * 0.00015) * 0.07;
    rot.y += ((reduce ? 0 : ix * 0.3) + sway - rot.y) * k;
    rot.x += ((reduce ? 0 : -iy * 0.2) - rot.x) * k;
    group.rotation.set(rot.x, rot.y, 0);
    const live = !reduce && ptr.active && now - ptr.t < 1600;
    uni.uMouseK.value += ((live ? 1 : 0) - uni.uMouseK.value) * (1 - Math.pow(1 - 0.08, dt * 60));
    if (live) {
      group.updateMatrixWorld();
      ndc.set(ptr.x, ptr.y);
      ray.setFromCamera(ndc, camera);
      inv.copy(group.matrixWorld).invert();
      ray.ray.applyMatrix4(inv);
      if (ray.ray.intersectPlane(plane, hit)) mouseLocal.copy(hit);
      uni.uMouse.value.lerp(mouseLocal, 0.35);
    }
    uni.uTime.value = now / 1000;
    uni.uStep.value = input.step();
  }
  function frame(now: number) {
    raf = 0;
    if (brake && rung < ladder.length - 1 && brake(now)) {
      curPR = ladder[++rung]!;
      renderer.setPixelRatio(curPR); // also resizes the canvas, and resize() keeps this ratio
      uni.uPR.value = curPR;
    }
    update(now);
    renderer.render(scene, camera);
    if (!reduce && !document.hidden) raf = requestAnimationFrame(frame);
  }
  function kick() {
    if (!raf) raf = requestAnimationFrame(frame);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      last = performance.now();
      kick();
    }
  });
  addEventListener('resize', () => {
    resize();
    kick();
  });
  resize();
  group.position.set(target.x, target.y, 0);
  group.scale.setScalar(target.sc);
  kick();
  window.__wings3d = () => ({
    particulas: N,
    pixelRatio: curPR,
    degrau: rung,
    degraus: ladder,
    freio: brake !== null,
    drawCalls: renderer.info.render.calls,
    pontos: renderer.info.render.points,
    memoria: renderer.info.memory,
  });
  return {
    onScroll() {
      aim();
      kick();
    },
    remeasure() {
      measure();
      aim();
      kick();
    },
  };
}
