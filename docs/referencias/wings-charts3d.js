// WingsCharts3D: gráficos 3D de referência do Wings System (direção A, "Claro e leve").
//
// Regras visuais (as mesmas do resto do sistema):
// - barras finas, com folga entre elas, cantos arredondados e base reta no chão;
// - material acetinado com verniz (cerâmica), refletindo o mesmo estúdio do logo 3D;
// - sombra de contato suave embaixo de cada peça, grade fininha e recessiva ao fundo;
// - textos sempre em HTML por cima da cena, na cor de texto (nunca na cor da série);
// - uma série = uma cor (laranja da marca); "sem dono", "sem marca" e "outras" em neutro;
// - entrada curta (crescer do chão, com leve rebote), número contando junto,
//   uma faixa de luz passando no fim, deriva lenta da câmera e arraste para girar;
// - ao passar o mouse: a peça sobe um pouco, as outras recuam, e o tooltip mostra o valor;
// - prefers-reduced-motion: tudo parado, já no estado final.
//
// Uso:
//   const c = new Funnel3D(el, { stages: [{ label, value }], totalLabel: 'das abertas' });
//   const c = new Columns3D(el, { categories: [...], series: [{ name, values, color? }], neutralCategories: ['Sem dono'] });
//   const c = new RankedBars3D(el, { items: [{ label, value, neutral? }] });
//   const c = new Donut3D(el, { segments: [{ label, value, color?, neutral? }] });
//   c.dispose();

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { buildStudioEnvironment } from './studio-environment.js';

// Paleta categórica validada (fundo branco): laranja da marca primeiro, ordem fixa.
export const SERIES = ['#E95228', '#2A78D6', '#1BAF7A', '#4A3AA7', '#EDA100', '#E87BA4', '#008300'];
export const NEUTRAL = '#CBC4BA';
const DIM = new THREE.Color('#E4DED6');
const GRID = '#EAE5DE';
const BASELINE = '#D3CBC0';

const fmt = new Intl.NumberFormat('pt-BR');
const pct = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 0 });
const clamp01 = (t) => Math.min(1, Math.max(0, t));
const outCubic = (t) => 1 - Math.pow(1 - t, 3);
const outBack = (t) => {
  const s = 1.25;
  return 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);
};
const inOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;

function niceTicks(max, count = 4) {
  if (!(max > 0)) return { top: 1, step: 1 };
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  return { top: Math.ceil(max / step) * step, step };
}

let rectAreaReady = false;
let shadowTexture = null;

// Sombra de contato: um retângulo arredondado bem desfocado, reaproveitado por todas as peças.
function contactShadowTexture() {
  if (shadowTexture) return shadowTexture;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d');
  ctx.shadowColor = 'rgba(0,0,0,1)';
  ctx.shadowBlur = 38;
  ctx.shadowOffsetX = 1000;
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
  shadowTexture = new THREE.CanvasTexture(c);
  shadowTexture.colorSpace = THREE.SRGBColorSpace;
  return shadowTexture;
}

function satin(color, gradient = false) {
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

// Degradê sutil ao longo da peça: a base fica 16% mais escura que a ponta.
function shade(geo, axis = 'y', from = 0.84) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const pos = geo.attributes.position;
  const lo = bb.min[axis];
  const span = bb.max[axis] - lo || 1;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getComponent(i, axis === 'x' ? 0 : axis === 'y' ? 1 : 2) - lo) / span;
    const k = from + (1 - from) * Math.pow(t, 0.8);
    col[i * 3] = k;
    col[i * 3 + 1] = k;
    col[i * 3 + 2] = k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

let ringShadow = null;
function ringShadowTexture() {
  if (ringShadow) return ringShadow;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d');
  ctx.shadowColor = 'rgba(0,0,0,1)';
  ctx.shadowBlur = 22;
  ctx.shadowOffsetX = 1000;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 34;
  ctx.beginPath();
  ctx.arc(128 - 1000, 128, 82, 0, Math.PI * 2);
  ctx.stroke();
  ringShadow = new THREE.CanvasTexture(c);
  return ringShadow;
}

class Chart3D {
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;
    this.reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.disposed = false;
    this.items = []; // { mesh, base: Color, label?, value, name, extra }
    this.labels = []; // { el, anchor: Vector3, obj?: Object3D, align: 'left'|'right'|'center', dy }
    this.hover = null;
    this.t = this.reduced ? 99 : 0;
    this.last = 0;
    this.visible = true;
    this.drag = null;
    this.orbit = { az: 0, el: 0, taz: 0, tel: 0 };
    this.pointer = { x: 0, y: 0, inside: false };

    container.classList.add('w3d');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'w3d-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.layer = document.createElement('div');
    this.layer.className = 'w3d-labels';
    this.layer.setAttribute('aria-hidden', 'true');
    this.tip = document.createElement('div');
    this.tip.className = 'w3d-tip';
    this.tip.hidden = true;
    container.append(this.canvas, this.layer, this.tip);

    const r = (this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.setClearColor(0x000000, 0);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NeutralToneMapping;
    if (!rectAreaReady) {
      RectAreaLightUniformsLib.init();
      rectAreaReady = true;
    }

    this.scene = new THREE.Scene();
    this.envTarget = buildStudioEnvironment(r, 'light');
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentRotation.y = 0.25;
    this.camera = new THREE.PerspectiveCamera(24, 1, 0.1, 400);

    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(-5, 10, 7);
    this.scene.add(key);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xe8e0d4, 0.55));
    const rim = new THREE.DirectionalLight(0xfff0e6, 0.8); // contraluz quente: realça as bordas arredondadas
    rim.position.set(7, 4, -7);
    this.scene.add(rim);
    this.sweepLight = new THREE.RectAreaLight(0xffffff, 0, 0.9, 14);
    this.scene.add(this.sweepLight);

    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.raycaster = new THREE.Raycaster();

    this.onResize = this.onResize.bind(this);
    this.onMove = this.onMove.bind(this);
    this.onLeave = this.onLeave.bind(this);
    this.onDown = this.onDown.bind(this);
    this.onUp = this.onUp.bind(this);
    this.onVisibility = this.onVisibility.bind(this);
    this.tick = this.tick.bind(this);

    this.ro = new ResizeObserver(this.onResize);
    this.ro.observe(container);
    this.io = new IntersectionObserver((es) => {
      this.visible = es.some((e) => e.isIntersecting);
      this.loop();
    });
    this.io.observe(container);
    document.addEventListener('visibilitychange', this.onVisibility);
    container.addEventListener('pointermove', this.onMove);
    container.addEventListener('pointerleave', this.onLeave);
    container.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointerup', this.onUp);
  }

  // ---- montagem comum ----
  addLabel(html, anchor, align = 'center', cls = '') {
    const el = document.createElement('div');
    el.className = `w3d-label w3d-${align} ${cls}`.trim();
    el.innerHTML = html;
    this.layer.append(el);
    const l = { el, anchor: anchor.clone(), align, obj: null };
    this.labels.push(l);
    return l;
  }

  addShadow(x, z, w, d, y = 0.002, strength = 0.2) {
    const m = new THREE.MeshBasicMaterial({ map: contactShadowTexture(), transparent: true, opacity: strength, depthWrite: false, color: 0x2a2018 });
    const p = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
    p.rotation.x = -Math.PI / 2;
    p.position.set(x, y, z);
    p.scale.set(w * 2, d * 2, 1);
    p.renderOrder = -1;
    this.root.add(p);
    return p;
  }

  addPiece(mesh, data) {
    const base = mesh.material.color.clone();
    this.root.add(mesh);
    const item = Object.assign({ mesh, base, lift: 0 }, data);
    this.items.push(item);
    return item;
  }

  line(points, color = GRID) {
    const g = new THREE.BufferGeometry().setFromPoints(points);
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1 }));
    this.root.add(l);
    return l;
  }

  // ---- câmera: enquadra a caixa da cena com folga, com azimute e elevação ----
  frame(box, az, el, margin = 1.12) {
    this.box = box;
    this.baseAz = az;
    this.baseEl = el;
    this.margin = margin;
    this.placeCamera();
  }

  placeCamera() {
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

  onResize() {
    if (this.disposed) return;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.size = { w, h };
    this.placeCamera();
    this.render();
  }

  // ---- interação ----
  onMove(e) {
    const rect = this.container.getBoundingClientRect();
    this.pointer.x = e.clientX - rect.left;
    this.pointer.y = e.clientY - rect.top;
    this.pointer.inside = true;
    if (this.drag) {
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      this.orbit.taz = THREE.MathUtils.clamp(this.drag.az - dx * 0.006, -0.45, 0.45);
      this.orbit.tel = THREE.MathUtils.clamp(this.drag.el + dy * 0.004, -0.12, 0.3);
    }
    this.loop();
  }

  onLeave() {
    this.pointer.inside = false;
    this.loop();
  }

  onDown(e) {
    if (this.reduced) return;
    this.drag = { x: e.clientX, y: e.clientY, az: this.orbit.taz, el: this.orbit.tel };
    this.container.classList.add('w3d-grabbing');
  }

  onUp() {
    if (!this.drag) return;
    this.drag = null;
    this.container.classList.remove('w3d-grabbing');
    this.orbit.taz = 0; // volta sozinha
    this.orbit.tel = 0;
    this.loop();
  }

  onVisibility() {
    this.loop();
  }

  pick() {
    if (!this.pointer.inside || !this.size || this.drag) return null;
    const ndc = new THREE.Vector2((this.pointer.x / this.size.w) * 2 - 1, -(this.pointer.y / this.size.h) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.items.map((i) => i.mesh), false);
    if (!hits.length) return null;
    return this.items.find((i) => i.mesh === hits[0].object) || null;
  }

  showTip(item) {
    if (!item || !item.tip) {
      this.tip.hidden = true;
      return;
    }
    this.tip.innerHTML = item.tip;
    this.tip.hidden = false;
    const w = this.tip.offsetWidth;
    const x = Math.min(this.size.w - w - 8, this.pointer.x + 14);
    const y = Math.max(8, this.pointer.y - 44);
    this.tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  // ---- laço de animação ----
  loop() {
    if (this.disposed) return;
    const run = this.visible && !document.hidden;
    if (run && !this.raf) {
      this.last = 0;
      this.raf = requestAnimationFrame(this.tick);
    } else if (!run && this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  tick(ts) {
    this.raf = 0;
    if (this.disposed) return;
    const dt = this.last ? Math.min((ts - this.last) / 1000, 0.05) : 0;
    this.last = ts;
    if (!this.reduced) this.t += dt;
    this.step(dt);
    this.render();
    this.raf = requestAnimationFrame(this.tick);
  }

  step(dt) {
    const k = 1 - Math.pow(0.0015, dt || 0.016);
    // deriva lenta da câmera + arraste com retorno suave
    const drift = this.reduced ? 0 : 0.035 * Math.sin(this.t * 0.25);
    this.orbit.az += (this.orbit.taz + drift - this.orbit.az) * k;
    this.orbit.el += (this.orbit.tel - this.orbit.el) * k;
    this.placeCamera();

    this.animate(this.t);

    // passar o mouse: a peça sobe, as outras recuam
    const hit = this.pick();
    if (hit !== this.hover) {
      this.hover = hit;
      this.container.style.cursor = hit ? 'pointer' : '';
    }
    for (const it of this.items) {
      const on = this.hover === it;
      const dim = this.hover && !on;
      it.lift += ((on ? 1 : 0) - it.lift) * k;
      it.dim = (it.dim || 0) + ((dim ? 1 : 0) - (it.dim || 0)) * k;
      it.mesh.material.color.copy(it.base).lerp(DIM, it.dim * 0.55);
      it.mesh.material.emissive.copy(it.base).multiplyScalar(0.16 * it.lift);
      this.applyLift(it);
    }
    this.showTip(this.hover);

    // faixa de luz depois da entrada
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

  sweepAt() {
    return 1.25;
  }

  applyLift() {}

  render() {
    if (this.disposed || !this.size) return;
    this.renderer.render(this.scene, this.camera);
    const v = new THREE.Vector3();
    for (const l of this.labels) {
      v.copy(l.anchor);
      if (l.obj) l.obj.localToWorld(v);
      v.project(this.camera);
      const x = (v.x * 0.5 + 0.5) * this.size.w;
      const y = (-v.y * 0.5 + 0.5) * this.size.h;
      l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }

  // Para testes e capturas: posiciona a animação num instante fixo.
  seek(t) {
    this.t = t;
    this.step(0.016);
    for (let i = 0; i < 40; i++) this.step(0.05);
    this.t = t;
    this.animate(t);
    this.render();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.io.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.container.removeEventListener('pointermove', this.onMove);
    this.container.removeEventListener('pointerleave', this.onLeave);
    this.container.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointerup', this.onUp);
    this.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this.envTarget.dispose();
    this.renderer.dispose();
    this.canvas.remove();
    this.layer.remove();
    this.tip.remove();
  }
}

// ---------------------------------------------------------------------------------
// Colunas agrupadas: categorias no eixo, uma coluna por série, grade recessiva ao fundo,
// valor no topo de cada coluna e nome da categoria embaixo, alinhado na tela.
export class Columns3D extends Chart3D {
  constructor(container, opts) {
    super(container, opts);
    const cats = opts.categories || [];
    const series = (opts.series || []).map((s, i) => Object.assign({ color: s.neutral ? NEUTRAL : SERIES[i % SERIES.length] }, s));
    const max = Math.max(0, ...series.flatMap((s) => s.values));
    const { top, step } = niceTicks(max, 4);
    const H = 3.4;
    const colW = 0.5;
    const colGap = 0.12;
    const d = 0.5;
    const groupW = Math.max(1.5, series.length * (colW + colGap) + 0.7);
    const span = cats.length * groupW;
    const x0 = -span / 2 + groupW / 2;
    const left = -span / 2 - 0.1;
    const right = span / 2 + 0.1;
    const wallZ = -d / 2 - 0.55;

    // grade (linhas finas no fundo) e eixo
    for (let v = 0; v <= top + 1e-9; v += step) {
      const y = (v / top) * H;
      this.line([new THREE.Vector3(left, y, wallZ), new THREE.Vector3(right, y, wallZ)], v === 0 ? BASELINE : GRID);
      this.addLabel(`<span class="w3d-tick">${fmt.format(v)}</span>`, new THREE.Vector3(left - 0.12, y, wallZ), 'right');
    }
    this.line([new THREE.Vector3(left, 0, d / 2 + 0.25), new THREE.Vector3(right, 0, d / 2 + 0.25)], BASELINE);

    this.cols = [];
    cats.forEach((c, ci) => {
      const gx = x0 + ci * groupW;
      series.forEach((s, si) => {
        const v = s.values[ci] || 0;
        const hgt = Math.max(0.035, (v / top) * H);
        const x = gx + (si - (series.length - 1) / 2) * (colW + colGap);
        const geo = new RoundedBoxGeometry(colW, hgt, d, 5, Math.min(0.1, colW / 2.6, hgt / 2.2));
        geo.translate(0, hgt / 2, 0);
        if (v > 0) shade(geo, 'y', 0.8);
        const neutralCat = (opts.neutralCategories || []).includes(c);
        const mesh = new THREE.Mesh(geo, satin(v === 0 || neutralCat ? NEUTRAL : s.color, v > 0));
        mesh.position.set(x, 0, 0);
        const it = this.addPiece(mesh, {
          name: c,
          value: v,
          hgt,
          order: ci * series.length + si,
          tip: `<b>${c}</b><span><i class="w3d-key" style="background:${s.color}"></i>${s.name}: ${fmt.format(v)}</span>`,
        });
        this.addShadow(x, 0.06, colW * 1.25, d * 1.25, 0.002, v === 0 ? 0.08 : 0.22);
        it.valueLabel = this.addLabel(`<b class="w3d-value${v === 0 ? ' w3d-zero' : ''}">${fmt.format(v)}</b>`, new THREE.Vector3(x, hgt + 0.2, 0), 'center');
        it.valueLabel.target = v;
        this.cols.push(it);
      });
      this.addLabel(`<span class="w3d-cat">${c}</span>`, new THREE.Vector3(gx, -0.42, d / 2 + 0.25), 'center');
    });
    const box = new THREE.Box3(new THREE.Vector3(left - 1.2, -0.7, wallZ), new THREE.Vector3(right + 0.2, H + 0.5, d / 2 + 0.3));
    this.frame(box, opts.azimuth ?? -0.17, opts.elevation ?? 0.16, 1.04);
    this.onResize();
  }

  animate(t) {
    for (const it of this.cols) {
      const p = this.reduced ? 1 : outBack(clamp01((t - 0.1 - it.order * 0.06) / 0.7));
      it.mesh.scale.y = Math.max(0.001, p);
      it.valueLabel.anchor.y = it.hgt * p + 0.22;
      const shown = this.reduced ? it.value : Math.round(it.value * clamp01(p));
      it.valueLabel.el.firstChild.textContent = fmt.format(shown);
    }
  }

  applyLift(it) {
    it.mesh.position.y = 0.06 * it.lift;
  }
}

// ---------------------------------------------------------------------------------
// Barras horizontais, todas saindo da mesma base. Ordenadas por valor (marcas, origens)
// ou na ordem das etapas (funil). Nome à esquerda; número e % na ponta de cada barra.
export class RankedBars3D extends Chart3D {
  constructor(container, opts) {
    super(container, opts);
    const sort = opts.sort !== false;
    let items = [...(opts.items || [])];
    if (sort) items.sort((a, b) => (b.value || 0) - (a.value || 0));
    const limit = opts.limit || (sort ? 6 : Infinity);
    if (items.length > limit) {
      const rest = items.slice(limit - 1);
      items = items.slice(0, limit - 1).concat([{ label: `Outras (${rest.length})`, value: rest.reduce((a, b) => a + (b.value || 0), 0), neutral: true }]);
    }
    const total = items.reduce((a, s) => a + (s.value || 0), 0);
    const max = Math.max(1, ...items.map((s) => s.value || 0));
    const L = 7;
    const t = opts.thickness || 0.36;
    const d = t;
    const gap = opts.gap || 0.24;
    const n = items.length;
    const totalH = n * t + (n - 1) * gap;
    const x0 = -L / 2;
    this.bars = [];
    // linha de base, de onde todas as barras saem
    this.line([new THREE.Vector3(x0 - 0.06, -totalH / 2 - 0.22, d / 2), new THREE.Vector3(x0 - 0.06, totalH / 2 + 0.22, d / 2)], BASELINE);
    items.forEach((s, i) => {
      const len = Math.max(0.16, (L * (s.value || 0)) / max);
      const geo = new RoundedBoxGeometry(len, t, d, 5, Math.min(0.11, t / 2.4, len / 2.2));
      geo.translate(len / 2, 0, 0);
      shade(geo, 'x', 0.8);
      const mesh = new THREE.Mesh(geo, satin(s.neutral ? NEUTRAL : s.color || SERIES[0], true));
      const y = totalH / 2 - t / 2 - i * (t + gap);
      mesh.position.set(x0, y, 0);
      // sombra suave na parede de trás: a barra parece flutuar um pouco acima do cartão
      const sh = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: contactShadowTexture(), transparent: true, opacity: 0.16, depthWrite: false, color: 0x2a2018 }),
      );
      sh.position.set(len / 2 + 0.06, -0.09, -d / 2 - 0.03);
      sh.scale.set(len * 2 + 0.4, t * 3.2, 1);
      mesh.add(sh);
      const share = total ? (s.value || 0) / total : 0;
      const it = this.addPiece(mesh, {
        name: s.label,
        value: s.value,
        len,
        x0,
        y,
        tip: `<b>${s.label}</b><span>${fmt.format(s.value || 0)} · ${pct.format(share)} ${opts.totalLabel || 'do total'}</span>`,
      });
      this.addLabel(`<span class="w3d-name">${s.label}</span>`, new THREE.Vector3(x0 - 0.32, y, d / 2), 'right');
      it.valueLabel = this.addLabel(`<b class="w3d-value">${fmt.format(s.value || 0)}</b><span class="w3d-share">${pct.format(share)}</span>`, new THREE.Vector3(x0 + len + 0.25, y, d / 2), 'left');
      this.bars.push(it);
    });
    const box = new THREE.Box3(new THREE.Vector3(x0 - 3.6, -totalH / 2 - 0.3, -d / 2), new THREE.Vector3(L / 2 + 2.3, totalH / 2 + 0.3, d / 2));
    this.frame(box, opts.azimuth ?? 0.16, opts.elevation ?? 0.12, 1.02);
    this.onResize();
  }

  animate(t) {
    this.bars.forEach((it, i) => {
      const p = this.reduced ? 1 : outBack(clamp01((t - 0.1 - i * 0.07) / 0.7));
      it.mesh.scale.x = Math.max(0.001, p);
      it.valueLabel.anchor.x = it.x0 + it.len * Math.max(0, p) + 0.25;
      it.valueLabel.el.style.opacity = this.reduced ? '1' : String(clamp01((t - 0.3 - i * 0.07) / 0.4));
      const shown = this.reduced ? it.value || 0 : Math.round((it.value || 0) * clamp01(p));
      it.valueLabel.el.firstChild.textContent = fmt.format(shown);
    });
  }

  applyLift(it) {
    it.mesh.position.z = 0.16 * it.lift;
  }
}

// Funil por etapa: as mesmas barras, na ordem das etapas (sem reordenar nem agrupar).
export class Funnel3D extends RankedBars3D {
  constructor(container, opts) {
    super(container, Object.assign({ totalLabel: 'das abertas' }, opts, { items: opts.stages || opts.items || [], sort: false, limit: Infinity }));
  }
}

// ---------------------------------------------------------------------------------
// Rosca: só para 3 a 6 fatias sem nenhuma acima de 80%; senão use RankedBars3D.
export class Donut3D extends Chart3D {
  constructor(container, opts) {
    super(container, opts);
    const segs = (opts.segments || []).filter((s) => s.value > 0);
    const total = segs.reduce((a, s) => a + s.value, 0) || 1;
    const R = 2.2;
    const r = 1.35;
    const hgt = 0.42;
    const gapA = 0.035;
    let a0 = Math.PI / 2;
    this.segs = [];
    segs.forEach((s, i) => {
      const span = (s.value / total) * Math.PI * 2;
      const a1 = a0 - span;
      const shape = new THREE.Shape();
      const sA = a0 - gapA / 2;
      const eA = a1 + gapA / 2;
      shape.absarc(0, 0, R, sA, eA, true);
      shape.absarc(0, 0, r, eA, sA, false);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: hgt, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelOffset: -0.05, bevelSegments: 4, curveSegments: 48 });
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, satin(s.neutral ? NEUTRAL : s.color || SERIES[i % SERIES.length]));
      const mid = (a0 + a1) / 2;
      const share = s.value / total;
      const it = this.addPiece(mesh, {
        name: s.label,
        value: s.value,
        mid,
        span,
        order: i,
        tip: `<b>${s.label}</b><span>${fmt.format(s.value)} · ${pct.format(share)}</span>`,
      });
      const lr = R + 0.55;
      it.valueLabel = this.addLabel(
        `<b class="w3d-value">${pct.format(share)}</b>`,
        new THREE.Vector3(Math.cos(mid) * lr, hgt / 2, -Math.sin(mid) * lr),
        Math.cos(mid) >= 0 ? 'left' : 'right',
      );
      this.segs.push(it);
      a0 = a1;
    });
    const sm = new THREE.MeshBasicMaterial({ map: ringShadowTexture(), transparent: true, opacity: 0.2, depthWrite: false, color: 0x2a2018 });
    const sp = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), sm);
    sp.rotation.x = -Math.PI / 2;
    sp.position.y = 0.001;
    sp.scale.set(R * 2 * 1.56, R * 2 * 1.56, 1);
    this.root.add(sp);
    this.centerLabel = this.addLabel(`<div class="w3d-stackin"><b class="w3d-hero">${fmt.format(total)}</b><span class="w3d-share">${opts.centerLabel || 'total'}</span></div>`, new THREE.Vector3(0, hgt, 0), 'stack');
    const box = new THREE.Box3(new THREE.Vector3(-R - 1.2, 0, -R - 0.6), new THREE.Vector3(R + 1.2, hgt, R + 0.6));
    this.frame(box, 0, 0.92, 1.0);
    this.onResize();
  }

  animate(t) {
    this.segs.forEach((it, i) => {
      const p = this.reduced ? 1 : outCubic(clamp01((t - 0.1 - i * 0.09) / 0.8));
      it.mesh.scale.set(1, Math.max(0.001, p), 1);
      it.mesh.rotation.y = (1 - p) * -0.5;
      it.valueLabel.el.style.opacity = this.reduced ? '1' : String(clamp01((t - 0.5 - i * 0.09) / 0.4));
    });
  }

  applyLift(it) {
    const out = 0.16 * it.lift;
    it.mesh.position.set(Math.cos(it.mid) * out, 0.05 * it.lift, -Math.sin(it.mid) * out);
  }

  sweepAt() {
    return 1.4;
  }
}

export const WINGS_CHARTS_CSS = `
.w3d{position:relative;overflow:hidden;touch-action:pan-y;cursor:grab;-webkit-user-select:none;user-select:none}
.w3d.w3d-grabbing{cursor:grabbing}
.w3d-canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.w3d-labels{position:absolute;inset:0;pointer-events:none;font-family:'Plus Jakarta Sans',system-ui,sans-serif}
.w3d-label{position:absolute;left:0;top:0;white-space:nowrap;line-height:1.2;will-change:transform}
.w3d-label>*{display:inline-block}
.w3d-right>*:first-child{transform:translate(-100%,-50%)}
.w3d-left>*:first-child{transform:translate(0,-50%)}
.w3d-center>*:first-child{transform:translate(-50%,-100%)}
.w3d-left{display:flex}
.w3d-left>*{transform:translate(0,-50%)}
.w3d-stack>.w3d-stackin{display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-50%)}
.w3d-name{font-size:12.5px;font-weight:600;color:#3A3733}
.w3d-cat{font-size:12.5px;font-weight:600;color:#3A3733;transform:translate(-50%,0)!important;padding-top:6px}
.w3d-value{font-size:13px;font-weight:800;color:#1D1B19}
.w3d-zero{color:#857F78;font-weight:600}
.w3d-share{font-size:12px;font-weight:600;color:#857F78;margin-left:6px}
.w3d-stackin .w3d-share{margin:2px 0 0}
.w3d-hero{font-size:28px;font-weight:800;color:#1D1B19;letter-spacing:-.01em}
.w3d-tick{font-size:11px;font-weight:600;color:#857F78;font-variant-numeric:tabular-nums}
.w3d-tip[hidden]{display:none!important}
.w3d-tip{position:absolute;left:0;top:0;z-index:2;display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:8px;background:#1D1B19;color:#fff;font:600 12px/1.35 'Plus Jakarta Sans',system-ui,sans-serif;box-shadow:0 6px 18px rgba(29,27,25,.22);pointer-events:none;white-space:nowrap}
.w3d-tip b{font-weight:800;font-size:12.5px}
.w3d-tip span{color:#D9D3CA;display:flex;align-items:center;gap:6px}
.w3d-key{width:8px;height:8px;border-radius:2px;display:inline-block}
`;
