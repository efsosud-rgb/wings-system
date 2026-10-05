import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  HEAT_EMPTY,
  HEAT_RAMP,
  NEUTRAL,
  RANKED_LIMIT,
  SERIES,
  heatStep,
  seriesColor,
  type ChartSpec,
  type ColumnsSpec,
  type DonutSpec,
  type HeatSpec,
  type LineSpec,
  type RankedSpec,
  type ValueFormat,
} from './spec.js';

/**
 * The chart scenes, ported from the reference module on Eric's canvas
 * (`docs/referencias/wings-charts3d.js`, same numbers and motion), with two
 * differences: a scene never owns a WebGL context (the page's one renderer
 * draws it, see `engine.ts`), and labels are built with `textContent`,
 * never `innerHTML`, because stage, brand and seller names come from the CRM.
 */

const DIM = new THREE.Color('#E4DED6');
const GRID_DEFAULT = '#EAE5DE';
const BASELINE_DEFAULT = '#D3CBC0';

const intFmt = new Intl.NumberFormat('pt-BR');
const brlFmt = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 0,
});
const pctWhole = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 0 });
const pctSmall = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumSignificantDigits: 2 });
/** A share; under 1% keeps two significant digits, so a funnel's last steps never read "0%". */
const pct = {
  format: (share: number) => (share > 0 && share < 0.01 ? pctSmall : pctWhole).format(share),
};
/** Values arrive as counts or as cents; reais show whole. */
const formatOf = (format: ValueFormat) => (value: number) =>
  format === 'brl' ? brlFmt.format(Math.round(value / 100)) : intFmt.format(Math.round(value));
const tickOf = (format: ValueFormat) => (value: number) =>
  format === 'brl' ? intFmt.format(Math.round(value / 100)) : intFmt.format(value);

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const outCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const outBack = (t: number) => {
  const s = 1.25;
  return 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);
};
const inOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;

function niceTicks(max: number, count = 4) {
  if (!(max > 0)) return { top: 1, step: 1 };
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  return { top: Math.ceil(max / step) * step, step };
}

/** Textures shared by every scene of the page; the engine disposes them. */
export interface SharedTextures {
  contact: THREE.Texture;
  ring: THREE.Texture;
}

function blurred(draw: (ctx: CanvasRenderingContext2D) => void, blur: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.shadowColor = 'rgba(0,0,0,1)';
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = 1000;
  draw(ctx);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function makeSharedTextures(): SharedTextures {
  // Contact shadow: a very blurred rounded rectangle, reused by every piece.
  const contact = blurred((ctx) => {
    ctx.fillStyle = '#000';
    const r = 34;
    const x = 64 - 1000;
    const y = 64;
    const w = 128;
    const h = 128;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.fill();
  }, 38);
  const ring = blurred((ctx) => {
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 34;
    ctx.beginPath();
    ctx.arc(128 - 1000, 128, 82, 0, Math.PI * 2);
    ctx.stroke();
  }, 22);
  return { contact, ring };
}

function satin(color: string, gradient = false) {
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.4,
    metalness: 0,
    clearcoat: 0.65,
    clearcoatRoughness: 0.18,
    envMapIntensity: 0.95,
    vertexColors: gradient,
  });
}

/** A subtle gradient along the piece: the base 16–20% darker than the tip. */
function shade(geo: THREE.BufferGeometry, axis: 'x' | 'y' | 'z' = 'y', from = 0.84) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const pos = geo.attributes.position!;
  const lo = bb.min[axis];
  const span = bb.max[axis] - lo || 1;
  const index = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getComponent(i, index) - lo) / span;
    const k = from + (1 - from) * Math.pow(t, 0.8);
    col[i * 3] = k;
    col[i * 3 + 1] = k;
    col[i * 3 + 2] = k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

type Align = 'left' | 'right' | 'center' | 'stack';
interface Label {
  el: HTMLDivElement;
  anchor: THREE.Vector3;
}
interface Item {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  base: THREE.Color;
  lift: number;
  dim: number;
  tip: { title: string; line: string; key?: string };
  value: number;
  valueLabel?: Label;
  valueText?: HTMLElement;
  [extra: string]: unknown;
}

/** The DOM a scene draws into: its own 2D canvas, a label layer and a tooltip. */
export interface SceneHost {
  stage: HTMLElement;
  canvas: HTMLCanvasElement;
  layer: HTMLElement;
  tip: HTMLElement;
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export abstract class Scene3D {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(24, 1, 0.1, 400);
  readonly root = new THREE.Group();
  readonly reduced: boolean;
  /** A narrow box (under 520 px): names sit above the bars instead of in a column beside them. */
  compact = false;
  readonly ctx: CanvasRenderingContext2D;
  protected items: Item[] = [];
  protected labels: Label[] = [];
  protected fmt: (value: number) => string;
  protected tick: (value: number) => string;
  private hover: Item | null = null;
  private keyHover = -1;
  t: number;
  visible = false;
  size: { w: number; h: number } | null = null;
  private drag: { x: number; y: number; az: number; el: number } | null = null;
  private orbit = { az: 0, el: 0, taz: 0, tel: 0 };
  private pointer = { x: 0, y: 0, inside: false };
  private box: THREE.Box3 | null = null;
  private baseAz = 0;
  private baseEl = 0;
  private margin = 1.12;
  private sweepLight: THREE.RectAreaLight;
  private raycaster = new THREE.Raycaster();
  private disposers: (() => void)[] = [];
  /** Hairline colours: the page may redefine them for a dark surface (`--w3d-grid`, `--w3d-base`). */
  protected readonly grid: string;
  protected readonly base: string;

  constructor(
    protected host: SceneHost,
    protected shared: SharedTextures,
    environment: THREE.Texture,
    reduced: boolean,
    format: ValueFormat,
  ) {
    const ctx = host.canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas unavailable');
    this.ctx = ctx;
    const style = getComputedStyle(host.stage);
    this.grid = style.getPropertyValue('--w3d-grid').trim() || GRID_DEFAULT;
    this.base = style.getPropertyValue('--w3d-base').trim() || BASELINE_DEFAULT;
    this.reduced = reduced;
    this.t = reduced ? 99 : 0;
    this.fmt = formatOf(format);
    this.tick = tickOf(format);
    this.scene.environment = environment;
    this.scene.environmentRotation.y = 0.25;
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(-5, 10, 7);
    this.scene.add(key);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xe8e0d4, 0.55));
    // Warm back light: brings out the rounded edges.
    const rim = new THREE.DirectionalLight(0xfff0e6, 0.8);
    rim.position.set(7, 4, -7);
    this.scene.add(rim);
    this.sweepLight = new THREE.RectAreaLight(0xffffff, 0, 0.9, 14);
    this.scene.add(this.sweepLight);
    this.scene.add(this.root);

    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Window,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ) => {
      target.addEventListener(type, fn as EventListener);
      this.disposers.push(() => target.removeEventListener(type, fn as EventListener));
    };
    on(host.stage, 'pointermove', (e) => this.onMove(e));
    on(host.stage, 'pointerleave', () => {
      this.pointer.inside = false;
    });
    on(host.stage, 'pointerdown', (e) => this.onDown(e));
    on(window, 'pointerup', () => this.onUp());
  }

  // ---- building ----------------------------------------------------------------------

  protected addLabel(parts: HTMLElement[], anchor: THREE.Vector3, align: Align = 'center'): Label {
    const node = document.createElement('div');
    node.className = `w3d-label w3d-${align}`;
    node.append(...parts);
    // Hidden until the first frame places it, so labels never pile up at the corner.
    node.style.visibility = 'hidden';
    this.host.layer.append(node);
    const label = { el: node, anchor: anchor.clone() };
    this.labels.push(label);
    return label;
  }

  protected addShadow(x: number, z: number, w: number, d: number, y = 0.002, strength = 0.2) {
    const material = new THREE.MeshBasicMaterial({
      map: this.shared.contact,
      transparent: true,
      opacity: strength,
      depthWrite: false,
      color: 0x2a2018,
    });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(x, y, z);
    plane.scale.set(w * 2, d * 2, 1);
    plane.renderOrder = -1;
    this.root.add(plane);
    return plane;
  }

  protected addPiece(
    mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>,
    data: Omit<Item, 'mesh' | 'base' | 'lift' | 'dim'>,
  ): Item {
    this.root.add(mesh);
    const item = { mesh, base: mesh.material.color.clone(), lift: 0, dim: 0, ...data } as Item;
    this.items.push(item);
    return item;
  }

  protected line(points: THREE.Vector3[], color = this.grid) {
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color }));
    this.root.add(line);
    return line;
  }

  protected dashed(points: THREE.Vector3[], color = '#8A8076') {
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(
      geometry,
      new THREE.LineDashedMaterial({ color, dashSize: 0.16, gapSize: 0.1 }),
    );
    line.computeLineDistances();
    this.root.add(line);
    return line;
  }

  // ---- camera: frames the scene's box with room, at an azimuth and an elevation -------

  protected frame(box: THREE.Box3, az: number, el: number, margin = 1.12) {
    this.box = box;
    this.baseAz = az;
    this.baseEl = el;
    this.margin = margin;
    this.placeCamera();
  }

  private placeCamera() {
    if (!this.box) return;
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    this.box.getSize(size);
    this.box.getCenter(center);
    const az = this.baseAz + this.orbit.az;
    const el = this.baseEl + this.orbit.el;
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const fitH = (size.y * this.margin) / (2 * Math.tan(vFov / 2));
    const fitW = (size.x * this.margin) / (2 * Math.tan(vFov / 2) * this.camera.aspect);
    const dist = Math.max(fitH, fitW) + size.z;
    this.camera.position.set(
      center.x + Math.sin(az) * Math.cos(el) * dist,
      center.y + Math.sin(el) * dist,
      center.z + Math.cos(az) * Math.cos(el) * dist,
    );
    this.camera.lookAt(center);
    this.camera.updateProjectionMatrix();
  }

  resize(w: number, h: number) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.host.canvas.width = Math.max(1, Math.round(w * dpr));
    this.host.canvas.height = Math.max(1, Math.round(h * dpr));
    this.camera.aspect = w / Math.max(1, h);
    this.size = { w, h };
    this.placeCamera();
  }

  // ---- interaction --------------------------------------------------------------------

  private onMove(e: PointerEvent) {
    const rect = this.host.stage.getBoundingClientRect();
    this.pointer.x = e.clientX - rect.left;
    this.pointer.y = e.clientY - rect.top;
    this.pointer.inside = true;
    this.keyHover = -1;
    if (this.drag) {
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      this.orbit.taz = THREE.MathUtils.clamp(this.drag.az - dx * 0.006, -0.45, 0.45);
      this.orbit.tel = THREE.MathUtils.clamp(this.drag.el + dy * 0.004, -0.12, 0.3);
    }
  }

  private onDown(e: PointerEvent) {
    if (this.reduced || e.pointerType === 'touch') return;
    this.drag = { x: e.clientX, y: e.clientY, az: this.orbit.taz, el: this.orbit.tel };
    this.host.stage.classList.add('w3d-grabbing');
  }

  private onUp() {
    if (!this.drag) return;
    this.drag = null;
    this.host.stage.classList.remove('w3d-grabbing');
    // Comes back on its own.
    this.orbit.taz = 0;
    this.orbit.tel = 0;
  }

  /** Arrow keys walk the pieces; -1 lets go. */
  focusPiece(step: number) {
    if (step === 0 || this.items.length === 0) {
      this.keyHover = -1;
      return;
    }
    this.keyHover = (Math.max(-1, this.keyHover) + step + this.items.length) % this.items.length;
    this.pointer.inside = false;
  }

  private pick(): Item | null {
    if (this.keyHover >= 0) return this.items[this.keyHover] ?? null;
    if (!this.pointer.inside || !this.size || this.drag) return null;
    const ndc = new THREE.Vector2(
      (this.pointer.x / this.size.w) * 2 - 1,
      -(this.pointer.y / this.size.h) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(
      this.items.map((item) => item.mesh),
      false,
    );
    if (!hits.length) return null;
    return this.items.find((item) => item.mesh === hits[0]!.object) ?? null;
  }

  private shown: Item | null = null;
  private showTip(item: Item | null) {
    const tip = this.host.tip;
    if (!item || !this.size) {
      tip.hidden = true;
      this.shown = null;
      return;
    }
    if (this.shown !== item) {
      this.shown = item;
      const line = el('span', '');
      if (item.tip.key) {
        const swatch = el('i', 'w3d-key');
        swatch.style.background = item.tip.key;
        line.append(swatch);
      }
      line.append(document.createTextNode(item.tip.line));
      tip.replaceChildren(el('b', '', item.tip.title), line);
    }
    tip.hidden = false;
    let x = this.pointer.x;
    let y = this.pointer.y;
    if (this.keyHover >= 0) {
      const at = item.mesh.getWorldPosition(new THREE.Vector3()).project(this.camera);
      x = (at.x * 0.5 + 0.5) * this.size.w;
      y = (-at.y * 0.5 + 0.5) * this.size.h;
    }
    const w = tip.offsetWidth;
    const left = Math.max(8, Math.min(this.size.w - w - 8, x + 14));
    const top = Math.max(8, y - 44);
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  // ---- animation ----------------------------------------------------------------------

  abstract animate(t: number): void;
  protected applyLift(_item: Item): void {}
  protected sweepAt() {
    return 1.25;
  }

  step(dt: number) {
    if (!this.reduced) this.t += dt;
    const k = 1 - Math.pow(0.0015, dt || 0.016);
    // Slow camera drift, and a drag that eases back.
    const drift = this.reduced ? 0 : 0.035 * Math.sin(this.t * 0.25);
    this.orbit.az += (this.orbit.taz + drift - this.orbit.az) * k;
    this.orbit.el += (this.orbit.tel - this.orbit.el) * k;
    this.placeCamera();

    this.animate(this.t);

    // Hover: the piece rises, the others step back.
    const hit = this.pick();
    if (hit !== this.hover) {
      this.hover = hit;
      this.host.stage.style.cursor = hit ? 'pointer' : '';
    }
    for (const item of this.items) {
      const on = this.hover === item;
      const dim = this.hover !== null && !on;
      const kk = this.reduced ? 1 : k;
      item.lift += ((on ? 1 : 0) - item.lift) * kk;
      item.dim += ((dim ? 1 : 0) - item.dim) * kk;
      item.mesh.material.color.copy(item.base).lerp(DIM, item.dim * 0.55);
      item.mesh.material.emissive.copy(item.base).multiplyScalar(0.16 * item.lift);
      this.applyLift(item);
    }
    this.showTip(this.hover);

    // A band of light once the entrance is done.
    const s = clamp01((this.t - this.sweepAt()) / 1.3);
    if (!this.reduced && s > 0 && s < 1 && this.box) {
      const size = new THREE.Vector3();
      const c = new THREE.Vector3();
      this.box.getSize(size);
      this.box.getCenter(c);
      const x = c.x - size.x * 0.75 + size.x * 1.5 * inOutSine(s);
      this.sweepLight.position.set(x, c.y + size.y * 0.2, c.z + size.z * 0.5 + 2.2);
      this.sweepLight.lookAt(x, c.y, c.z);
      this.sweepLight.intensity = 9 * Math.sin(Math.PI * s);
    } else {
      this.sweepLight.intensity = 0;
    }
  }

  /** Draws through the page's renderer, then copies the pixels to this chart's canvas. */
  draw(renderer: THREE.WebGLRenderer) {
    if (!this.size) return;
    const canvas = this.host.canvas;
    const buffer = renderer.domElement;
    const dpr = renderer.getPixelRatio();
    renderer.setScissorTest(true);
    renderer.setViewport(0, 0, canvas.width / dpr, canvas.height / dpr);
    renderer.setScissor(0, 0, canvas.width / dpr, canvas.height / dpr);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    this.ctx.clearRect(0, 0, canvas.width, canvas.height);
    // WebGL's origin is the bottom left, so this chart's pixels are the buffer's last rows.
    this.ctx.drawImage(
      buffer,
      0,
      buffer.height - canvas.height,
      canvas.width,
      canvas.height,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    const v = new THREE.Vector3();
    for (const label of this.labels) {
      v.copy(label.anchor);
      this.root.localToWorld(v);
      v.project(this.camera);
      const x = (v.x * 0.5 + 0.5) * this.size.w;
      const y = (-v.y * 0.5 + 0.5) * this.size.h;
      label.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      if (label.el.style.visibility) label.el.style.visibility = '';
    }
  }

  dispose() {
    for (const off of this.disposers) off();
    this.root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
    });
    this.host.layer.replaceChildren();
    this.host.tip.hidden = true;
  }
}

// ---------------------------------------------------------------------------------------
// Grouped columns: categories on the axis, one column per series, a recessive grid behind,
// each column's value on top and the category's name under it, level on the screen.
class Columns3D extends Scene3D {
  private cols: (Item & { hgt: number; order: number })[] = [];

  build(spec: ColumnsSpec) {
    const cats = spec.categories;
    const series = spec.series.map((s, i) => ({
      ...s,
      color: seriesColor(s, i),
    }));
    const max = Math.max(0, spec.reference?.value ?? 0, ...series.flatMap((s) => s.values));
    const { top, step } = niceTicks(max, 4);
    // Many categories (a month of days): slimmer columns, values in the tooltip and the
    // table, and only some names on the axis.
    const dense = cats.length > 12;
    const H = 3.4;
    const colW = dense ? 0.42 : 0.5;
    const colGap = 0.12;
    const d = dense ? 0.42 : 0.5;
    const groupW = dense
      ? series.length * (colW + colGap) + 0.12
      : Math.max(1.5, series.length * (colW + colGap) + 0.7);
    const every = dense ? Math.ceil(cats.length / (this.compact ? 5 : 10)) : 1;
    const span = cats.length * groupW;
    const x0 = -span / 2 + groupW / 2;
    const left = -span / 2 - 0.1;
    const right = span / 2 + 0.1;
    const wallZ = -d / 2 - 0.55;

    // The grid (hairlines at the back) and the axis.
    for (let v = 0; v <= top + 1e-9; v += step) {
      const y = (v / top) * H;
      this.line(
        [new THREE.Vector3(left, y, wallZ), new THREE.Vector3(right, y, wallZ)],
        v === 0 ? this.base : this.grid,
      );
      this.addLabel(
        [el('span', 'w3d-tick', this.tick(v))],
        new THREE.Vector3(left - 0.12, y, wallZ),
        'right',
      );
    }
    this.line(
      [new THREE.Vector3(left, 0, d / 2 + 0.25), new THREE.Vector3(right, 0, d / 2 + 0.25)],
      this.base,
    );

    cats.forEach((c, ci) => {
      const gx = x0 + ci * groupW;
      series.forEach((s, si) => {
        const v = s.values[ci] || 0;
        const hgt = Math.max(0.035, (v / top) * H);
        const x = gx + (si - (series.length - 1) / 2) * (colW + colGap);
        const geo = new RoundedBoxGeometry(colW, hgt, d, 5, Math.min(0.1, colW / 2.6, hgt / 2.2));
        geo.translate(0, hgt / 2, 0);
        if (v > 0) shade(geo, 'y', 0.8);
        const neutralCat = (spec.neutralCategories ?? []).includes(c);
        const color = v === 0 || neutralCat ? NEUTRAL : s.color;
        const mesh = new THREE.Mesh(geo, satin(color, v > 0));
        mesh.position.set(x, 0, 0);
        const item = this.addPiece(mesh, {
          value: v,
          tip: { title: c, line: `${s.name}: ${this.fmt(v)}`, key: neutralCat ? NEUTRAL : s.color },
        }) as Item & { hgt: number; order: number };
        item.hgt = hgt;
        item.order = ci * series.length + si;
        this.addShadow(x, 0.06, colW * 1.25, d * 1.25, 0.002, v === 0 ? 0.08 : 0.22);
        if (!dense) {
          const text = el('b', `w3d-value${v === 0 ? ' w3d-zero' : ''}`, this.fmt(v));
          item.valueText = text;
          item.valueLabel = this.addLabel([text], new THREE.Vector3(x, hgt + 0.2, 0), 'center');
        }
        this.cols.push(item);
      });
      if (ci % every === 0)
        this.addLabel(
          [el('span', 'w3d-cat', c)],
          new THREE.Vector3(gx, -0.42, d / 2 + 0.25),
          'center',
        );
    });
    if (spec.reference && spec.reference.value > 0) {
      const y = (spec.reference.value / top) * H;
      this.dashed([
        new THREE.Vector3(left, y, d / 2 + 0.05),
        new THREE.Vector3(right, y, d / 2 + 0.05),
      ]);
      this.addLabel(
        [el('span', 'w3d-ref', `${spec.reference.label} ${this.fmt(spec.reference.value)}`)],
        new THREE.Vector3(right, y + 0.22, d / 2 + 0.05),
        'right',
      );
    }
    const box = new THREE.Box3(
      new THREE.Vector3(left - (this.compact ? 1.9 : 1.2), -1.1, wallZ),
      new THREE.Vector3(right + 0.2, H + 0.5, d / 2 + 0.3),
    );
    this.frame(box, -0.17, 0.16, 1.04);
  }

  animate(t: number) {
    for (const it of this.cols) {
      const p = this.reduced ? 1 : outBack(clamp01((t - 0.1 - it.order * 0.06) / 0.7));
      it.mesh.scale.y = Math.max(0.001, p);
      if (!it.valueLabel) continue;
      it.valueLabel.anchor.y = it.hgt * p + 0.22;
      const shown = this.reduced ? it.value : it.value * clamp01(p);
      it.valueText!.textContent = this.fmt(shown);
    }
  }

  protected override applyLift(it: Item) {
    it.mesh.position.y = 0.06 * it.lift;
  }
}

// ---------------------------------------------------------------------------------------
// Horizontal bars, all from the same base. Ranked by value (brands, sources) or in the
// stages' order (funnel). Name on the left; number and share at each bar's tip.
class RankedBars3D extends Scene3D {
  private bars: (Item & { len: number; x0: number })[] = [];
  /** The names' column, left and right edge in scene units, at the bars' depth. */
  private names: { from: number; to: number; z: number } | null = null;

  /** Names stop at their column's edge, measured on the screen at this size. */
  override resize(w: number, h: number) {
    super.resize(w, h);
    if (this.compact || !this.names) return;
    this.camera.updateMatrixWorld();
    const a = new THREE.Vector3(this.names.from, 0, this.names.z).project(this.camera);
    const b = new THREE.Vector3(this.names.to, 0, this.names.z).project(this.camera);
    const px = Math.floor(Math.abs(b.x - a.x) * 0.5 * w) - 4;
    this.host.layer.style.setProperty('--w3d-name-max', `${Math.max(60, px)}px`);
  }

  build(spec: RankedSpec) {
    const sort = spec.sort !== false;
    let items = [...spec.items];
    if (sort) items.sort((a, b) => (b.value || 0) - (a.value || 0));
    const limit = spec.limit ?? (sort ? RANKED_LIMIT : Infinity);
    if (items.length > limit) {
      const rest = items.slice(limit - 1);
      items = items.slice(0, limit - 1).concat([
        {
          label: `Outras (${rest.length})`,
          value: rest.reduce((a, b) => a + (b.value || 0), 0),
          neutral: true,
        },
      ]);
    }
    const total = spec.shareBase ?? items.reduce((a, s) => a + (s.value || 0), 0);
    const max = Math.max(1, ...items.map((s) => s.value || 0));
    const L = 7;
    const t = 0.36;
    const d = t;
    const gap = this.compact ? 0.95 : 0.24;
    const n = items.length;
    const totalH = n * t + (n - 1) * gap;
    const x0 = -L / 2;
    this.names = { from: x0 - 3.6, to: x0 - 0.32, z: d / 2 };
    // The base line every bar starts from.
    this.line(
      [
        new THREE.Vector3(x0 - 0.06, -totalH / 2 - 0.22, d / 2),
        new THREE.Vector3(x0 - 0.06, totalH / 2 + 0.22, d / 2),
      ],
      this.base,
    );
    items.forEach((s, i) => {
      const len = Math.max(
        0.16,
        spec.log
          ? (L * Math.log10((s.value || 0) + 1)) / Math.log10(max + 1)
          : (L * (s.value || 0)) / max,
      );
      const geo = new RoundedBoxGeometry(len, t, d, 5, Math.min(0.11, t / 2.4, len / 2.2));
      geo.translate(len / 2, 0, 0);
      shade(geo, 'x', 0.8);
      const color = s.neutral ? NEUTRAL : SERIES[(spec.slot ?? 0) % SERIES.length]!;
      const mesh = new THREE.Mesh(geo, satin(color, true));
      const y = totalH / 2 - t / 2 - i * (t + gap);
      mesh.position.set(x0, y, 0);
      // A soft shadow on the wall behind: the bar seems to float just above the card.
      const shadow = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: this.shared.contact,
          transparent: true,
          opacity: 0.16,
          depthWrite: false,
          color: 0x2a2018,
        }),
      );
      shadow.position.set(len / 2 + 0.06, -0.09, -d / 2 - 0.03);
      shadow.scale.set(len * 2 + 0.4, t * 3.2, 1);
      mesh.add(shadow);
      const share = total ? (s.value || 0) / total : 0;
      const item = this.addPiece(mesh, {
        value: s.value || 0,
        tip: {
          title: s.label,
          line: `${this.fmt(s.value || 0)} · ${pct.format(share)} ${spec.totalLabel ?? 'do total'}`,
        },
      }) as Item & { len: number; x0: number };
      item.len = len;
      item.x0 = x0;
      if (this.compact)
        this.addLabel(
          [el('span', 'w3d-name', s.label)],
          new THREE.Vector3(x0, y + t / 2 + 0.2, d / 2),
          'left',
        );
      else
        this.addLabel(
          [el('span', 'w3d-name', s.label)],
          new THREE.Vector3(x0 - 0.32, y, d / 2),
          'right',
        );
      const value = el('b', 'w3d-value', this.fmt(s.value || 0));
      item.valueText = value;
      item.valueLabel = this.addLabel(
        [value, el('span', 'w3d-share', pct.format(share))],
        new THREE.Vector3(x0 + len + 0.25, y, d / 2),
        'left',
      );
      this.bars.push(item);
    });
    const box = new THREE.Box3(
      new THREE.Vector3(x0 - (this.compact ? 0.3 : 3.6), -totalH / 2 - 0.3, -d / 2),
      // Room at the right for the longest bar's value and share.
      new THREE.Vector3(
        L / 2 + (this.compact ? 4.6 : 3.2),
        totalH / 2 + (this.compact ? 0.6 : 0.3),
        d / 2,
      ),
    );
    this.frame(box, 0.16, 0.12, 1.02);
  }

  animate(t: number) {
    this.bars.forEach((it, i) => {
      const p = this.reduced ? 1 : outBack(clamp01((t - 0.1 - i * 0.07) / 0.7));
      it.mesh.scale.x = Math.max(0.001, p);
      it.valueLabel!.anchor.x = it.x0 + it.len * Math.max(0, p) + 0.25;
      it.valueLabel!.el.style.opacity = this.reduced
        ? '1'
        : String(clamp01((t - 0.3 - i * 0.07) / 0.4));
      const shown = this.reduced ? it.value : it.value * clamp01(p);
      it.valueText!.textContent = this.fmt(shown);
    });
  }

  protected override applyLift(it: Item) {
    it.mesh.position.z = 0.16 * it.lift;
  }
}

// ---------------------------------------------------------------------------------------
// Donut: only for 3 to 6 slices with none above 80% (`shareSpec` decides).
class Donut3D extends Scene3D {
  private segs: (Item & { mid: number })[] = [];

  build(spec: DonutSpec) {
    const segs = spec.segments.filter((s) => s.value > 0);
    const total = segs.reduce((a, s) => a + s.value, 0) || 1;
    const R = 2.2;
    const r = 1.35;
    const hgt = 0.42;
    const gapA = 0.035;
    let a0 = Math.PI / 2;
    let colour = 0;
    segs.forEach((s) => {
      const span = (s.value / total) * Math.PI * 2;
      const a1 = a0 - span;
      const shape = new THREE.Shape();
      const sA = a0 - gapA / 2;
      const eA = a1 + gapA / 2;
      shape.absarc(0, 0, R, sA, eA, true);
      shape.absarc(0, 0, r, eA, sA, false);
      const geo = new THREE.ExtrudeGeometry(shape, {
        depth: hgt,
        bevelEnabled: true,
        bevelThickness: 0.05,
        bevelSize: 0.05,
        bevelOffset: -0.05,
        bevelSegments: 4,
        curveSegments: 48,
      });
      geo.rotateX(-Math.PI / 2);
      // Neutral slices take no colour from the palette, so the real ones keep its order.
      const color = s.neutral ? NEUTRAL : SERIES[colour++ % SERIES.length]!;
      const mesh = new THREE.Mesh(geo, satin(color));
      const mid = (a0 + a1) / 2;
      const share = s.value / total;
      const item = this.addPiece(mesh, {
        value: s.value,
        tip: { title: s.label, line: `${this.fmt(s.value)} · ${pct.format(share)}`, key: color },
      }) as Item & { mid: number };
      item.mid = mid;
      const lr = R + 0.55;
      item.valueLabel = this.addLabel(
        [el('b', 'w3d-value', pct.format(share))],
        new THREE.Vector3(Math.cos(mid) * lr, hgt / 2, -Math.sin(mid) * lr),
        Math.cos(mid) >= 0 ? 'left' : 'right',
      );
      this.segs.push(item);
      a0 = a1;
    });
    const ring = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: this.shared.ring,
        transparent: true,
        opacity: 0.2,
        depthWrite: false,
        color: 0x2a2018,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.001;
    ring.scale.set(R * 2 * 1.56, R * 2 * 1.56, 1);
    this.root.add(ring);
    const stack = el('div', 'w3d-stackin');
    stack.append(
      el('b', 'w3d-hero', this.fmt(total)),
      el('span', 'w3d-share', spec.centerLabel ?? 'total'),
    );
    this.addLabel([stack], new THREE.Vector3(0, hgt, 0), 'stack');
    const box = new THREE.Box3(
      new THREE.Vector3(-R - 1.2, 0, -R - 0.6),
      new THREE.Vector3(R + 1.2, hgt, R + 0.6),
    );
    this.frame(box, 0, 0.92, 1.0);
  }

  animate(t: number) {
    this.segs.forEach((it, i) => {
      const p = this.reduced ? 1 : outCubic(clamp01((t - 0.1 - i * 0.09) / 0.8));
      it.mesh.scale.set(1, Math.max(0.001, p), 1);
      it.mesh.rotation.y = (1 - p) * -0.5;
      it.valueLabel!.el.style.opacity = this.reduced
        ? '1'
        : String(clamp01((t - 0.5 - i * 0.09) / 0.4));
    });
  }

  protected override applyLift(it: Item) {
    const mid = (it as Item & { mid: number }).mid;
    const out = 0.16 * it.lift;
    it.mesh.position.set(Math.cos(mid) * out, 0.05 * it.lift, -Math.sin(mid) * out);
  }

  protected override sweepAt() {
    return 1.4;
  }
}

/** A tube in dashes along straight segments, as one geometry whose index runs along the path. */
function dashedTube(pts: THREE.Vector3[], radius: number, dash = 0.16, gap = 0.1) {
  const pieces: THREE.BufferGeometry[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  let phase = 0;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1]!;
    const b = pts[k]!;
    const len = a.distanceTo(b);
    const dir = b.clone().sub(a).normalize();
    let at = 0;
    while (at < len) {
      const inDash = phase < dash;
      const room = inDash ? dash - phase : dash + gap - phase;
      const stepLen = Math.min(room, len - at);
      if (inDash && stepLen > 0.01) {
        const piece = new THREE.CylinderGeometry(radius, radius, stepLen, 8, 1, false);
        piece.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir));
        const mid = a.clone().addScaledVector(dir, at + stepLen / 2);
        piece.translate(mid.x, mid.y, mid.z);
        pieces.push(piece);
      }
      at += stepLen;
      phase = (phase + stepLen) % (dash + gap);
    }
  }
  const merged = pieces.length ? mergeGeometries(pieces) : new THREE.BufferGeometry();
  for (const piece of pieces) piece.dispose();
  return merged ?? new THREE.BufferGeometry();
}

// ---------------------------------------------------------------------------------------
// Lines over an ordered axis: a tube per series along straight segments (no smoothing that
// would invent a value between two days), a wash under the series marked `area`, a bead on
// each point to hover, the last value at each line's end. A null breaks the line.
class Lines3D extends Scene3D {
  private tubes: { mesh: THREE.Mesh; count: number }[] = [];
  private areas: THREE.Mesh[] = [];
  private beads: (Item & { at: number })[] = [];
  private ends: Label[] = [];
  private n = 0;

  build(spec: LineSpec) {
    const cats = spec.categories;
    const n = Math.max(1, cats.length);
    this.n = n;
    const values = spec.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
    const max = Math.max(0, spec.reference?.value ?? 0, ...values);
    const { top, step } = niceTicks(max, 4);
    const H = 3.2;
    const L = 8.4;
    const xAt = (i: number) => (n === 1 ? 0 : -L / 2 + (i * L) / (n - 1));
    const yAt = (v: number) => (v / top) * H;
    const left = -L / 2 - 0.15;
    const right = L / 2 + 0.15;
    const wallZ = -0.6;
    const depth = spec.series.length;
    const zOf = (si: number) => (depth - 1 - si) * 0.16;

    for (let v = 0; v <= top + 1e-9; v += step) {
      const y = yAt(v);
      this.line(
        [new THREE.Vector3(left, y, wallZ), new THREE.Vector3(right, y, wallZ)],
        v === 0 ? this.base : this.grid,
      );
      this.addLabel(
        [el('span', 'w3d-tick', this.tick(v))],
        new THREE.Vector3(left - 0.12, y, wallZ),
        'right',
      );
    }
    this.line(
      [new THREE.Vector3(left, 0, zOf(0) + 0.3), new THREE.Vector3(right, 0, zOf(0) + 0.3)],
      this.base,
    );
    const every = Math.max(1, Math.ceil(n / (this.compact ? 4 : 8)));
    cats.forEach((c, i) => {
      if (i % every !== 0 && i !== n - 1) return;
      if (i !== n - 1 && n - 1 - i < every * 0.75) return;
      this.addLabel(
        [el('span', 'w3d-cat', c)],
        new THREE.Vector3(xAt(i), -0.42, zOf(0) + 0.3),
        'center',
      );
    });

    let palette = 0;
    spec.series.forEach((s, si) => {
      const color = s.neutral ? NEUTRAL : seriesColor({ slot: s.slot ?? palette }, si);
      if (!s.neutral && s.slot === undefined) palette++;
      const z = zOf(si);
      // Runs of consecutive values: a null ends one.
      const runs: number[][] = [];
      let run: number[] = [];
      s.values.forEach((v, i) => {
        if (v === null) {
          if (run.length) runs.push(run);
          run = [];
        } else run.push(i);
      });
      if (run.length) runs.push(run);
      for (const r of runs) {
        const pts = r.map((i) => new THREE.Vector3(xAt(i), yAt(s.values[i]!), z));
        if (pts.length > 1) {
          const path = new THREE.CurvePath<THREE.Vector3>();
          for (let k = 1; k < pts.length; k++) path.add(new THREE.LineCurve3(pts[k - 1]!, pts[k]!));
          const geo = s.dashed
            ? dashedTube(pts, 0.032)
            : new THREE.TubeGeometry(path, Math.max(8, (pts.length - 1) * 6), 0.05, 10, false);
          const material = satin(color);
          if (s.dashed) {
            material.transparent = true;
            material.opacity = 0.75;
          }
          const tube = new THREE.Mesh(geo, material);
          this.root.add(tube);
          this.tubes.push({ mesh: tube, count: geo.index?.count ?? 0 });
          if (s.area) {
            const shape = new THREE.Shape();
            shape.moveTo(pts[0]!.x, 0);
            for (const p of pts) shape.lineTo(p.x, p.y);
            shape.lineTo(pts.at(-1)!.x, 0);
            shape.closePath();
            const areaGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.12, bevelEnabled: false });
            areaGeo.translate(0, 0, z - 0.06);
            const wash = new THREE.MeshPhysicalMaterial({
              color,
              roughness: 0.6,
              transparent: true,
              opacity: 0.22,
              depthWrite: false,
            });
            const area = new THREE.Mesh(areaGeo, wash);
            this.root.add(area);
            this.areas.push(area);
          }
        }
        for (const i of r) {
          const v = s.values[i]!;
          const bead = new THREE.Mesh(
            new THREE.SphereGeometry(s.dashed ? 0.07 : 0.09, 16, 12),
            satin(color),
          );
          bead.position.set(xAt(i), yAt(v), z);
          const item = this.addPiece(bead, {
            value: v,
            tip: { title: cats[i] ?? '', line: `${s.name}: ${this.fmt(v)}`, key: color },
          }) as Item & { at: number };
          item.at = i;
          this.beads.push(item);
        }
      }
      // The latest value at the end of the line.
      const last = s.values.reduce<number>((at, v, i) => (v === null ? at : i), -1);
      // Narrow: the legend, the tooltip and the table carry the last value instead.
      if (last >= 0 && !this.compact) {
        const tag = el('span', 'w3d-end');
        const sw = el('i', 'w3d-key');
        sw.style.background = color;
        tag.append(sw, el('b', 'w3d-value', this.fmt(s.values[last]!)));
        this.ends.push(
          this.addLabel([tag], new THREE.Vector3(xAt(last) + 0.2, yAt(s.values[last]!), z), 'left'),
        );
      }
    });

    if (spec.reference && spec.reference.value > 0) {
      const y = yAt(spec.reference.value);
      this.dashed([new THREE.Vector3(left, y, zOf(0)), new THREE.Vector3(right, y, zOf(0))]);
      this.addLabel(
        [el('span', 'w3d-ref', `${spec.reference.label} ${this.fmt(spec.reference.value)}`)],
        new THREE.Vector3(right, y + 0.22, zOf(0)),
        'right',
      );
    }

    const box = new THREE.Box3(
      new THREE.Vector3(left - 1.1, -1.1, wallZ),
      new THREE.Vector3(right + (this.compact ? 0.3 : 1.6), H + 0.4, zOf(0) + 0.3),
    );
    this.frame(box, -0.14, 0.12, 1.04);
  }

  animate(t: number) {
    const p = this.reduced ? 1 : outCubic(clamp01((t - 0.1) / 1.1));
    for (const tube of this.tubes) {
      // Index triangles run along the path, so a draw range reveals it left to right.
      const count = Math.floor((tube.count * p) / 3) * 3;
      tube.mesh.geometry.setDrawRange(0, p >= 1 ? Infinity : count);
    }
    for (const area of this.areas) area.scale.y = Math.max(0.001, p);
    for (const bead of this.beads) {
      const at = this.n <= 1 ? 0 : bead.at / (this.n - 1);
      const k = this.reduced ? 1 : outBack(clamp01((p - at) * 6));
      bead.mesh.scale.setScalar(Math.max(0.001, k));
    }
    for (const end of this.ends)
      end.el.style.opacity = this.reduced ? '1' : String(clamp01((t - 1.1) / 0.4));
  }

  protected override applyLift(it: Item) {
    it.mesh.scale.multiplyScalar(1 + 0.5 * it.lift);
  }
}

// ---------------------------------------------------------------------------------------
// Heat map: a tile per row × column, in the orange ramp's five steps of the largest value;
// a step is also a little height, so two neighbours read apart; nothing there is grey.
class Heat3D extends Scene3D {
  private tiles: (Item & { order: number; hgt: number })[] = [];

  build(spec: HeatSpec) {
    const rows = spec.rows;
    const cols = spec.columns;
    const max = Math.max(0, ...spec.values.flat());
    const cell = 0.34;
    const gap = 0.07;
    const pitch = cell + gap;
    // Narrow: the columns split in two blocks, one under the other, so a day's name has room.
    const blocks = this.compact && cols.length > 12 ? 2 : 1;
    const per = Math.ceil(cols.length / blocks);
    const blockGap = 0.75;
    const W = per * pitch - gap;
    const blockD = rows.length * pitch - gap;
    const D = blocks * blockD + (blocks - 1) * blockGap;
    const x0 = -W / 2 + cell / 2;
    const every = spec.columnEvery ?? 3;
    for (let b = 0; b < blocks; b++) {
      const zb = -D / 2 + cell / 2 + b * (blockD + blockGap);
      rows.forEach((row, ri) => {
        const z = zb + ri * pitch;
        this.addLabel(
          [el('span', 'w3d-name', row)],
          new THREE.Vector3(-W / 2 - 0.18, 0, z),
          'right',
        );
        for (let k = 0; k < per; k++) {
          const ci = b * per + k;
          const col = cols[ci];
          if (col === undefined) break;
          const v = spec.values[ri]?.[ci] ?? 0;
          const stepN = heatStep(v, max);
          const hgt = 0.05 + stepN * 0.07;
          const color = stepN ? HEAT_RAMP[stepN - 1]! : HEAT_EMPTY;
          const geo = new RoundedBoxGeometry(cell, hgt, cell, 3, Math.min(0.05, hgt / 2.2));
          geo.translate(0, hgt / 2, 0);
          const mesh = new THREE.Mesh(geo, satin(color));
          mesh.position.set(x0 + k * pitch, 0, z);
          const item = this.addPiece(mesh, {
            value: v,
            tip: { title: `${row} ${col}`, line: v > 0 ? this.fmt(v) : 'sem dado', key: color },
          }) as Item & { order: number; hgt: number };
          item.order = k + ri * 0.5 + b * 4;
          item.hgt = hgt;
          this.tiles.push(item);
        }
      });
      for (let k = 0; k < per; k++) {
        const ci = b * per + k;
        const col = cols[ci];
        if (col === undefined || ci % every !== 0) continue;
        this.addLabel(
          [el('span', 'w3d-cat', col)],
          new THREE.Vector3(x0 + k * pitch, 0, zb + blockD - cell / 2 + 0.3),
          'center',
        );
      }
    }
    this.addShadow(0, 0, W * 0.6, D * 0.6, 0.001, 0.12);
    const box = new THREE.Box3(
      new THREE.Vector3(-W / 2 - (this.compact ? 0.8 : 1.1), 0, -D / 2 - 0.1),
      new THREE.Vector3(W / 2 + 0.1, 0.45, D / 2 + 0.55),
    );
    this.frame(box, 0, 0.98, 1.0);
  }

  animate(t: number) {
    for (const it of this.tiles) {
      const p = this.reduced ? 1 : outBack(clamp01((t - 0.1 - it.order * 0.03) / 0.6));
      it.mesh.scale.y = Math.max(0.001, p);
    }
  }

  protected override applyLift(it: Item) {
    it.mesh.position.y = 0.12 * it.lift;
  }

  protected override sweepAt() {
    return 1.6;
  }
}

/** Below this width the ranked bars put names above the bars. */
export const COMPACT_WIDTH = 520;

/** The scene for a spec; the funnel is ranked bars in the stages' order. */
export function makeScene(
  spec: ChartSpec,
  host: SceneHost,
  shared: SharedTextures,
  environment: THREE.Texture,
  reduced: boolean,
): Scene3D {
  const compact = host.stage.clientWidth > 0 && host.stage.clientWidth < COMPACT_WIDTH;
  const narrow = <T extends Scene3D>(scene: T) => {
    scene.compact = compact;
    return scene;
  };
  switch (spec.kind) {
    case 'columns': {
      const scene = narrow(new Columns3D(host, shared, environment, reduced, spec.format));
      scene.build(spec);
      return scene;
    }
    case 'ranked': {
      const scene = narrow(new RankedBars3D(host, shared, environment, reduced, spec.format));
      scene.build(spec);
      return scene;
    }
    case 'funnel': {
      const scene = narrow(new RankedBars3D(host, shared, environment, reduced, spec.format));
      scene.build({
        kind: 'ranked',
        items: spec.stages,
        format: spec.format,
        totalLabel: spec.totalLabel ?? 'das abertas',
        shareBase: spec.shareBase,
        slot: spec.slot,
        log: spec.log,
        sort: false,
        limit: Infinity,
      });
      return scene;
    }
    case 'donut': {
      const scene = narrow(new Donut3D(host, shared, environment, reduced, spec.format));
      scene.build(spec);
      return scene;
    }
    case 'line': {
      const scene = narrow(new Lines3D(host, shared, environment, reduced, spec.format));
      scene.build(spec);
      return scene;
    }
    case 'heat': {
      const scene = narrow(new Heat3D(host, shared, environment, reduced, spec.format));
      scene.build(spec);
      return scene;
    }
  }
}
