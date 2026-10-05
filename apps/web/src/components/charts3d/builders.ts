import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import {
  easeOutCubic,
  heatLevel,
  staggerOf,
  TONE_HEX,
  type BarsSpec,
  type ChartLabel,
  type ChartSpec,
  type DonutSpec,
  type FunnelSpec,
  type HeatSpec,
  type RibbonsSpec,
  type Tone,
} from './spec.js';

/**
 * One builder per kind of chart. Each lays its pieces out in scene units
 * (1 = one category slot), base on the floor at y = 0, centred on x and z,
 * and returns how to animate the entrance, lift a hovered piece, say what a
 * hit means and where each HTML label is pinned.
 */

export interface Hit {
  piece: number;
  sub?: number;
}

export interface Built {
  root: THREE.Group;
  /** The scene's final extent (entrance done), for framing the camera. */
  bounds: THREE.Box3;
  labels: ChartLabel[];
  /** Where each label is pinned, in `root` space, same order as `labels`. */
  anchors: THREE.Vector3[];
  pieceCount: number;
  /** Camera elevation and azimuth, radians. */
  elevation: number;
  azimuth: number;
  /** Advance the entrance to `ms` after it started; true while still moving. */
  animate(ms: number): boolean;
  /** Raise piece `index` by `amount` (0..1, eased by the engine). */
  lift(index: number, amount: number): void;
  hitOf(intersection: THREE.Intersection): Hit | null;
  tip(hit: Hit): string;
  /** Where the tooltip of a keyboard-chosen piece sits, in `root` space. */
  pieceAnchor(index: number): THREE.Vector3;
  dispose(): void;
}

export interface BuildContext {
  /** Width ÷ height of the chart's box, so a long series is not drawn as a sliver. */
  aspect: number;
  /** A narrow box: names go to a list under the chart, so the scene needs no room for them. */
  compact: boolean;
  shadowTexture: THREE.Texture;
}

const ELEVATION = THREE.MathUtils.degToRad(30);
const ENTRANCE_MS = 520;

class Resources {
  private items: { dispose(): void }[] = [];
  private materials = new Map<string, THREE.MeshPhysicalMaterial>();

  track<T extends { dispose(): void }>(item: T): T {
    this.items.push(item);
    return item;
  }

  /** Satin: little metal, a light varnish; the studio environment does the rest. */
  satin(hex: string): THREE.MeshPhysicalMaterial {
    const found = this.materials.get(hex);
    if (found) return found;
    const material = this.track(
      new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(hex),
        roughness: 0.42,
        metalness: 0.06,
        clearcoat: 0.35,
        clearcoatRoughness: 0.34,
        envMapIntensity: 0.62,
      }),
    );
    this.materials.set(hex, material);
    return material;
  }

  dispose() {
    for (const item of this.items) item.dispose();
    this.items = [];
    this.materials.clear();
  }
}

const toneHex = (tone: Tone | 'track') => TONE_HEX[tone];

/** A soft contact shadow under a footprint (width × depth), lying on the floor. */
function contactShadow(
  res: Resources,
  ctx: BuildContext,
  width: number,
  depth: number,
  opacity = 0.22,
): THREE.Mesh {
  const geometry = res.track(new THREE.PlaneGeometry(1, 1));
  const material = res.track(
    new THREE.MeshBasicMaterial({
      map: ctx.shadowTexture,
      color: 0x2b211a,
      transparent: true,
      opacity,
      depthWrite: false,
    }),
  );
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  // The texture's dark core is half its size; the rest is the blur.
  mesh.scale.set(width * 2 + 0.4, depth * 2 + 0.4, 1);
  mesh.position.y = 0.002;
  mesh.renderOrder = -1;
  return mesh;
}

/** A rounded box whose origin is the centre of its base, so scaling y grows it from the floor. */
function baseBox(res: Resources, width: number, height: number, depth: number, radius: number) {
  const r = Math.max(0.001, Math.min(radius, width / 2, height / 2, depth / 2) * 0.999);
  const geometry = res.track(new RoundedBoxGeometry(width, height, depth, 3, r));
  geometry.translate(0, height / 2, 0);
  return geometry;
}

const tipOf = (name: string, text: string) => (name ? `${name}: ${text}` : text);

// --- bars -------------------------------------------------------------------------------

function buildBars(spec: BarsSpec, ctx: BuildContext): Built {
  const res = new Resources();
  const root = new THREE.Group();
  const n = spec.categories.length;
  const m = Math.max(1, spec.series.length);
  const max = Math.max(0, ...spec.series.flatMap((series) => series.values));
  const vertical = spec.orientation === 'vertical';
  const labels: ChartLabel[] = [];
  const anchors: THREE.Vector3[] = [];
  const pieces: {
    mesh: THREE.Mesh;
    shadow: THREE.Mesh | null;
    base: THREE.Vector3;
    cat: number;
    ser: number;
    top: THREE.Vector3;
  }[] = [];

  if (vertical) {
    // Height follows the box: a long series in a wide box gets a lower ceiling.
    const height = THREE.MathUtils.clamp((n / ctx.aspect) * 0.95, 1.6, 6);
    const width = Math.min(0.42, 0.74 / m);
    const depth = Math.max(width, 0.36);
    for (let c = 0; c < n; c += 1) {
      const slot = c - (n - 1) / 2;
      for (let s = 0; s < m; s += 1) {
        const series = spec.series[s]!;
        const value = series.values[c] ?? 0;
        const h = max > 0 ? Math.max(0.02, (value / max) * height) : 0.02;
        const x = slot + (s - (m - 1) / 2) * width * 1.08;
        const mesh = new THREE.Mesh(
          baseBox(res, width, h, depth, 0.06),
          res.satin(toneHex(series.tone)),
        );
        mesh.position.set(x, 0, 0);
        mesh.userData.piece = pieces.length;
        const shadow = contactShadow(res, ctx, width, depth);
        shadow.position.x = x;
        root.add(shadow, mesh);
        pieces.push({
          mesh,
          shadow,
          base: mesh.position.clone(),
          cat: c,
          ser: s,
          top: new THREE.Vector3(x, h, 0),
        });
        if (spec.showValues) {
          labels.push({
            key: `v${c}:${s}`,
            text: (series.short ?? series.texts)[c] ?? '',
            kind: 'value',
            align: 'above',
          });
          anchors.push(new THREE.Vector3(x, h + 0.08, 0));
        }
      }
      const category = spec.categories[c]!;
      if (category.axis !== false) {
        labels.push({ key: `a${c}`, text: category.label, kind: 'axis', align: 'center' });
        anchors.push(new THREE.Vector3(slot, 0, depth / 2 + 0.25));
      }
    }
    const bounds = new THREE.Box3(
      new THREE.Vector3(-n / 2, 0, -depth),
      new THREE.Vector3(n / 2, height, depth),
    );
    return finishBars(res, root, bounds, labels, anchors, pieces, spec, true);
  }

  // Horizontal: one row per category, the first on top, bars running right from x = 0.
  const length = THREE.MathUtils.clamp(n * ctx.aspect * 0.55, 4, 12);
  const thickness = Math.min(0.5, 0.78 / m);
  const depth = 0.5;
  for (let c = 0; c < n; c += 1) {
    const rowY = (n - 1 - c) * 1;
    for (let s = 0; s < m; s += 1) {
      const series = spec.series[s]!;
      const value = series.values[c] ?? 0;
      const w = max > 0 ? Math.max(0.03, (value / max) * length) : 0.03;
      const y = rowY + (s - (m - 1) / 2) * thickness * 1.1;
      const geometry = res.track(
        new RoundedBoxGeometry(w, thickness, depth, 3, Math.min(0.06, w / 2 - 0.001)),
      );
      geometry.translate(w / 2, 0, 0);
      const mesh = new THREE.Mesh(geometry, res.satin(toneHex(series.tone)));
      mesh.position.set(0, y + 0.5, 0);
      mesh.userData.piece = pieces.length;
      root.add(mesh);
      pieces.push({
        mesh,
        shadow: null,
        base: mesh.position.clone(),
        cat: c,
        ser: s,
        top: new THREE.Vector3(w, y + 0.5, 0),
      });
      if (spec.showValues) {
        labels.push({
          key: `v${c}:${s}`,
          text: (series.short ?? series.texts)[c] ?? '',
          kind: 'value',
          align: 'right',
        });
        anchors.push(new THREE.Vector3(w + 0.12, y + 0.5, 0));
      }
    }
    labels.push({ key: `n${c}`, text: spec.categories[c]!.label, kind: 'name', align: 'left' });
    anchors.push(new THREE.Vector3(-0.15, rowY + 0.5, 0));
  }
  const floor = contactShadow(res, ctx, length * 0.6, depth, 0.16);
  floor.position.x = length * 0.3;
  root.add(floor);
  // Centre the whole thing on x so the camera frames it.
  root.children.forEach((child) => (child.position.x -= length / 2));
  pieces.forEach((piece) => {
    piece.base.x -= length / 2;
    piece.top.x -= length / 2;
  });
  anchors.forEach((anchor) => (anchor.x -= length / 2));
  const bounds = new THREE.Box3(
    new THREE.Vector3(-length / 2 - 0.8, 0, -depth),
    new THREE.Vector3(length / 2 + 0.8, n, depth),
  );
  return finishBars(res, root, bounds, labels, anchors, pieces, spec, false);
}

function finishBars(
  res: Resources,
  root: THREE.Group,
  bounds: THREE.Box3,
  labels: ChartLabel[],
  anchors: THREE.Vector3[],
  pieces: {
    mesh: THREE.Mesh;
    shadow: THREE.Mesh | null;
    base: THREE.Vector3;
    cat: number;
    ser: number;
    top: THREE.Vector3;
  }[],
  spec: BarsSpec,
  vertical: boolean,
): Built {
  const step = staggerOf(spec.categories.length);
  const lifts = new Array<number>(pieces.length).fill(0);
  const grow = (piece: (typeof pieces)[number], t: number) => {
    const k = Math.max(0.0001, t);
    if (vertical) piece.mesh.scale.y = k;
    else piece.mesh.scale.x = k;
    if (piece.shadow)
      (piece.shadow.material as THREE.MeshBasicMaterial).opacity = 0.22 * Math.min(1, t * 1.4);
  };
  return {
    root,
    bounds,
    labels,
    anchors,
    pieceCount: pieces.length,
    elevation: vertical ? ELEVATION : THREE.MathUtils.degToRad(18),
    azimuth: vertical ? THREE.MathUtils.degToRad(-14) : THREE.MathUtils.degToRad(-10),
    animate(ms) {
      let moving = false;
      for (const piece of pieces) {
        const t = easeOutCubic((ms - piece.cat * step) / ENTRANCE_MS);
        grow(piece, t);
        if (t < 1) moving = true;
      }
      return moving;
    },
    lift(index, amount) {
      const piece = pieces[index];
      if (!piece) return;
      lifts[index] = amount;
      if (vertical) piece.mesh.position.y = piece.base.y + amount * 0.14;
      else piece.mesh.position.z = piece.base.z + amount * 0.18;
    },
    hitOf(intersection) {
      const piece = intersection.object.userData.piece as number | undefined;
      return piece === undefined ? null : { piece };
    },
    tip(hit) {
      const piece = pieces[hit.piece];
      if (!piece) return '';
      const series = spec.series[piece.ser]!;
      const name = spec.categories[piece.cat]!.label;
      return spec.series.length > 1
        ? `${name} · ${series.label}: ${series.texts[piece.cat] ?? ''}`
        : tipOf(name, series.texts[piece.cat] ?? '');
    },
    pieceAnchor(index) {
      const piece = pieces[index]!;
      return piece.top.clone().add(new THREE.Vector3(0, (lifts[index] ?? 0) * 0.14, 0));
    },
    dispose: () => res.dispose(),
  };
}

// --- funnel ----------------------------------------------------------------------------

function buildFunnel(spec: FunnelSpec, ctx: BuildContext): Built {
  const res = new Resources();
  const root = new THREE.Group();
  const n = spec.steps.length;
  const log = spec.scale === 'log';
  const measure = (value: number) =>
    log ? Math.log10(1 + Math.max(0, value)) : Math.max(0, value);
  const max = Math.max(0, ...spec.steps.map((step) => measure(step.value)));
  const radiusOf = (value: number) => 0.22 + (max > 0 ? (measure(value) / max) * 1.55 : 0);
  const slab = 0.5;
  const gap = 0.07;
  const labels: ChartLabel[] = [];
  const anchors: THREE.Vector3[] = [];
  const pieces: { mesh: THREE.Mesh; y: number; r: number }[] = [];
  // The first step on top; the funnel assembles from the bottom up.
  for (let i = 0; i < n; i += 1) {
    const step = spec.steps[i]!;
    const r = radiusOf(step.value);
    const next = i + 1 < n ? radiusOf(spec.steps[i + 1]!.value) : r * 0.86;
    const bottom = Math.min(r, Math.max(next, r * 0.72));
    const geometry = res.track(new THREE.CylinderGeometry(r, bottom, slab, 72, 1));
    geometry.translate(0, slab / 2, 0);
    // Alternate two warmths of the brand orange so neighbouring steps part; the names say which is which.
    const hex = i % 2 === 0 ? TONE_HEX.brand : TONE_HEX.brandSoft;
    const mesh = new THREE.Mesh(geometry, res.satin(hex));
    const y = (n - 1 - i) * (slab + gap);
    mesh.position.y = y;
    mesh.userData.piece = i;
    root.add(mesh);
    pieces.push({ mesh, y, r });
    labels.push({
      key: `s${i}`,
      text: `${step.label} · ${step.text}`,
      kind: 'name',
      align: 'right',
    });
    anchors.push(new THREE.Vector3(Math.max(r, 1.0) + 0.3, y + slab / 2, 0));
  }
  const widest = Math.max(0.5, ...pieces.map((piece) => piece.r));
  const lowest = pieces[n - 1];
  root.add(contactShadow(res, ctx, (lowest?.r ?? 0.5) * 1.6, (lowest?.r ?? 0.5) * 1.6, 0.26));
  const height = n * (slab + gap);
  const bounds = new THREE.Box3(
    new THREE.Vector3(-widest, 0, -widest),
    new THREE.Vector3(widest + (ctx.compact ? 0.2 : 2.6), height, widest),
  );
  const lifts = new Array<number>(n).fill(0);
  return {
    root,
    bounds,
    labels,
    anchors,
    pieceCount: n,
    elevation: THREE.MathUtils.degToRad(17),
    azimuth: 0,
    animate(ms) {
      let moving = false;
      // Bottom slab first.
      for (let i = 0; i < n; i += 1) {
        const order = n - 1 - i;
        const t = easeOutCubic((ms - order * 70) / ENTRANCE_MS);
        const piece = pieces[i]!;
        piece.mesh.scale.setScalar(Math.max(0.0001, 0.6 + 0.4 * t));
        piece.mesh.position.y = piece.y + (1 - t) * 0.6 + lifts[i]! * 0.12;
        piece.mesh.visible = t > 0;
        if (t < 1) moving = true;
      }
      return moving;
    },
    lift(index, amount) {
      const piece = pieces[index];
      if (!piece) return;
      lifts[index] = amount;
      piece.mesh.position.y = piece.y + amount * 0.12;
    },
    hitOf(intersection) {
      const piece = intersection.object.userData.piece as number | undefined;
      return piece === undefined ? null : { piece };
    },
    tip(hit) {
      const step = spec.steps[hit.piece];
      return step ? tipOf(step.label, step.text) : '';
    },
    pieceAnchor(index) {
      const piece = pieces[index]!;
      return new THREE.Vector3(0, piece.y + slab + 0.05, 0);
    },
    dispose: () => res.dispose(),
  };
}

// --- donut and ring meter ----------------------------------------------------------------

function ringSector(
  inner: number,
  outer: number,
  start: number,
  length: number,
  height: number,
): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const segments = Math.max(2, Math.ceil((length / (Math.PI * 2)) * 96));
  shape.absarc(0, 0, outer, start, start + length, false);
  shape.absarc(0, 0, inner, start + length, start, true);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: true,
    bevelThickness: Math.min(0.03, height / 4),
    bevelSize: 0.025,
    bevelSegments: 3,
    curveSegments: segments,
  });
  // Lie flat: the shape's plane becomes the floor, the extrusion goes up.
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function buildDonut(spec: DonutSpec, ctx: BuildContext): Built {
  const res = new Resources();
  const root = new THREE.Group();
  const outer = 1.5;
  const inner = spec.gauge ? 1.16 : 0.84;
  const height = spec.gauge ? 0.2 : 0.34;
  const total = spec.slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);
  const gapAngle = spec.slices.length > 1 && !spec.gauge ? 0.025 : 0;
  const parts: { mesh: THREE.Mesh; start: number; length: number; mid: number }[] = [];
  let cursor = Math.PI / 2;
  for (let i = 0; i < spec.slices.length; i += 1) {
    const slice = spec.slices[i]!;
    const length = total > 0 ? (Math.max(0, slice.value) / total) * Math.PI * 2 : 0;
    // Counter-clockwise in the shape's plane reads clockwise from above once laid flat.
    const start = cursor;
    cursor += length;
    const mesh = new THREE.Mesh(undefined, res.satin(toneHex(slice.tone)));
    mesh.userData.piece = i;
    root.add(mesh);
    parts.push({ mesh, start, length, mid: start + length / 2 });
  }
  root.add(contactShadow(res, ctx, outer * 1.4, outer * 1.4, 0.2));
  const labels: ChartLabel[] = [];
  const anchors: THREE.Vector3[] = [];
  const at = (angle: number, radius: number, y: number) =>
    // The shape's (x, y) becomes (x, -z) after rotateX(-90°).
    new THREE.Vector3(Math.cos(angle) * radius, y, -Math.sin(angle) * radius);
  if (!spec.gauge) {
    spec.slices.forEach((slice, i) => {
      const part = parts[i]!;
      if (part.length < 0.12) return; // A sliver keeps its numbers in the legend and the table.
      const side = Math.cos(part.mid) >= 0 ? 'right' : 'left';
      labels.push({
        key: `s${i}`,
        text: `${slice.label} · ${slice.text}`,
        kind: 'name',
        align: side,
      });
      anchors.push(at(part.mid, outer + 0.18, height / 2));
    });
  }
  let drawnTo = -1;
  const draw = (fraction: number) => {
    if (Math.abs(fraction - drawnTo) < 1e-4) return;
    drawnTo = fraction;
    for (const part of parts) {
      const visible = Math.max(
        0,
        Math.min(part.length, Math.PI * 2 * fraction - (part.start - Math.PI / 2)),
      );
      const length = Math.max(0, visible - gapAngle);
      part.mesh.visible = length > 0.002;
      if (!part.mesh.visible) continue;
      const old = part.mesh.geometry;
      part.mesh.geometry = ringSector(inner, outer, part.start + gapAngle / 2, length, height);
      old.dispose();
    }
  };
  const lifts = new Array<number>(parts.length).fill(0);
  const bounds = new THREE.Box3(
    new THREE.Vector3(-outer - (spec.gauge || ctx.compact ? 0.1 : 2.8), 0, -outer),
    new THREE.Vector3(outer + (spec.gauge || ctx.compact ? 0.1 : 2.8), height + 0.2, outer),
  );
  return {
    root,
    bounds,
    labels,
    anchors,
    pieceCount: parts.length,
    elevation: THREE.MathUtils.degToRad(spec.gauge ? 38 : 34),
    azimuth: 0,
    animate(ms) {
      // The ring opens as an arc.
      const t = easeOutCubic(ms / 760);
      draw(t);
      return t < 1;
    },
    lift(index, amount) {
      const part = parts[index];
      if (!part) return;
      lifts[index] = amount;
      const out = at(part.mid, amount * 0.1, amount * 0.08);
      part.mesh.position.copy(out);
    },
    hitOf(intersection) {
      const piece = intersection.object.userData.piece as number | undefined;
      return piece === undefined ? null : { piece };
    },
    tip(hit) {
      const slice = spec.slices[hit.piece];
      return slice ? tipOf(slice.label, slice.text) : '';
    },
    pieceAnchor(index) {
      const part = parts[index]!;
      return at(part.mid, (inner + outer) / 2, height + 0.1);
    },
    dispose() {
      for (const part of parts) part.mesh.geometry?.dispose();
      res.dispose();
    },
  };
}

// --- ribbons (one per platform, in depth lanes) ----------------------------------------

function buildRibbons(spec: RibbonsSpec, ctx: BuildContext): Built {
  const res = new Resources();
  const root = new THREE.Group();
  const n = spec.days.length;
  const lanes = spec.series.length;
  const width = Math.max(4, n * 0.42);
  const height = THREE.MathUtils.clamp((width / ctx.aspect) * 0.9, 1.4, 4);
  const max = Math.max(0, ...spec.series.flatMap((series) => series.values.map((v) => v ?? 0)));
  const xOf = (i: number) => (n <= 1 ? 0 : (i / (n - 1) - 0.5) * width);
  const yOf = (v: number | null) => (max > 0 ? ((v ?? 0) / max) * height : 0);
  const band = Math.max(0.08, height * 0.06);
  const laneGap = 0.9;
  const pieces: { mesh: THREE.Mesh; z: number }[] = [];
  const labels: ChartLabel[] = [];
  const anchors: THREE.Vector3[] = [];
  spec.series.forEach((series, s) => {
    const shape = new THREE.Shape();
    shape.moveTo(xOf(0), yOf(series.values[0] ?? null) + band / 2);
    for (let i = 1; i < n; i += 1) shape.lineTo(xOf(i), yOf(series.values[i] ?? null) + band / 2);
    for (let i = n - 1; i >= 0; i -= 1)
      shape.lineTo(xOf(i), Math.max(0, yOf(series.values[i] ?? null) - band / 2));
    shape.closePath();
    const geometry = res.track(
      new THREE.ExtrudeGeometry(shape, {
        depth: 0.32,
        bevelEnabled: true,
        bevelSize: 0.02,
        bevelThickness: 0.02,
        bevelSegments: 2,
      }),
    );
    const mesh = new THREE.Mesh(geometry, res.satin(toneHex(series.tone)));
    // The first series in front; the others step back into depth.
    const z = -(s * laneGap) - 0.16;
    mesh.position.z = z;
    mesh.userData.piece = s;
    // A faint wall under the tape keeps it reading as a series over time, not a floating line.
    const wallShape = new THREE.Shape();
    wallShape.moveTo(xOf(0), 0);
    for (let i = 0; i < n; i += 1)
      wallShape.lineTo(xOf(i), Math.max(0, yOf(series.values[i] ?? null) - band / 2));
    wallShape.lineTo(xOf(n - 1), 0);
    wallShape.closePath();
    const wallMaterial = res.track(
      new THREE.MeshBasicMaterial({
        color: toneHex(series.tone),
        transparent: true,
        opacity: 0.1,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    const wall = new THREE.Mesh(res.track(new THREE.ShapeGeometry(wallShape)), wallMaterial);
    wall.position.z = 0.16;
    mesh.add(wall);
    root.add(mesh);
    const shadow = contactShadow(res, ctx, width / 2, 0.2, 0.12);
    shadow.position.z = z + 0.16;
    root.add(shadow);
    pieces.push({ mesh, z });
    labels.push({ key: `l${s}`, text: series.label, kind: 'name', align: 'right' });
    const last = series.values[n - 1] ?? null;
    anchors.push(new THREE.Vector3(xOf(n - 1) + 0.2, yOf(last), z + 0.16));
  });
  spec.days.forEach((day, i) => {
    if (day.axis === false) return;
    labels.push({ key: `a${i}`, text: day.label, kind: 'axis', align: 'center' });
    anchors.push(new THREE.Vector3(xOf(i), 0, 0.45));
  });
  const depth = lanes * laneGap;
  const bounds = new THREE.Box3(
    new THREE.Vector3(-width / 2 - 0.2, 0, -depth),
    new THREE.Vector3(width / 2 + 1.6, height + band, 0.6),
  );
  const lifts = new Array<number>(lanes).fill(0);
  return {
    root,
    bounds,
    labels,
    anchors,
    pieceCount: lanes,
    elevation: THREE.MathUtils.degToRad(26),
    azimuth: THREE.MathUtils.degToRad(-12),
    animate(ms) {
      let moving = false;
      pieces.forEach((piece, s) => {
        const t = easeOutCubic((ms - s * 40) / ENTRANCE_MS);
        piece.mesh.scale.y = Math.max(0.0001, t);
        if (t < 1) moving = true;
      });
      return moving;
    },
    lift(index, amount) {
      const piece = pieces[index];
      if (!piece) return;
      lifts[index] = amount;
      piece.mesh.position.y = amount * 0.12;
    },
    hitOf(intersection) {
      const piece =
        intersection.object.userData.piece ?? intersection.object.parent?.userData.piece;
      if (piece === undefined) return null;
      // The day under the pointer, from the hit's x in the chart's own space.
      const local = root.worldToLocal(intersection.point.clone());
      const day = n <= 1 ? 0 : Math.round((local.x / width + 0.5) * (n - 1));
      return { piece: piece as number, sub: THREE.MathUtils.clamp(day, 0, n - 1) };
    },
    tip(hit) {
      const series = spec.series[hit.piece];
      if (!series) return '';
      const day = hit.sub ?? n - 1;
      return `${series.label} · ${spec.days[day]?.label ?? ''}: ${series.texts[day] ?? ''}`;
    },
    pieceAnchor(index) {
      const series = spec.series[index]!;
      const piece = pieces[index]!;
      return new THREE.Vector3(
        xOf(n - 1),
        yOf(series.values[n - 1] ?? null) + band,
        piece.z + 0.16,
      );
    },
    dispose: () => res.dispose(),
  };
}

// --- heat blocks ---------------------------------------------------------------------------

function buildHeat(spec: HeatSpec, ctx: BuildContext): Built {
  const res = new Resources();
  const root = new THREE.Group();
  const rows = spec.rows.length;
  const cols = spec.cols.length;
  const cell = 0.92;
  const max = Math.max(0, ...spec.cells.map((item) => item.value));
  const height = 1.8;
  const xOf = (col: number) => col - (cols - 1) / 2;
  const zOf = (row: number) => row - (rows - 1) / 2;
  const geometry = baseBox(res, cell, 1, cell, 0.08);
  const material = res.track(
    new THREE.MeshPhysicalMaterial({
      roughness: 0.42,
      metalness: 0.06,
      clearcoat: 0.4,
      clearcoatRoughness: 0.32,
      envMapIntensity: 0.62,
    }),
  );
  const mesh = new THREE.InstancedMesh(geometry, material, spec.cells.length);
  const surface = new THREE.Color('#FFFFFF');
  const ink = new THREE.Color(toneHex(spec.tone));
  const heights: number[] = [];
  const matrix = new THREE.Matrix4();
  spec.cells.forEach((item, i) => {
    // The flat grid's five steps of ink, now as a mix towards white and as height.
    const color = surface.clone().lerp(ink, heatLevel(item.value, max));
    mesh.setColorAt(i, color);
    heights.push(max > 0 ? Math.max(0.04, (item.value / max) * height) : 0.04);
    matrix.makeTranslation(xOf(item.col), 0, zOf(item.row));
    mesh.setMatrixAt(i, matrix);
  });
  mesh.userData.instanced = true;
  root.add(mesh);
  // Floor tiles for every slot, so an empty hour still has its place.
  const tiles = new THREE.Mesh(
    res.track(new THREE.PlaneGeometry(cols, rows)),
    res.track(
      new THREE.MeshBasicMaterial({
        color: '#F1EEEA',
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      }),
    ),
  );
  tiles.rotation.x = -Math.PI / 2;
  tiles.position.y = 0.001;
  root.add(tiles, contactShadow(res, ctx, cols * 0.5, rows * 0.5, 0.12));
  const labels: ChartLabel[] = [];
  const anchors: THREE.Vector3[] = [];
  spec.rows.forEach((row, r) => {
    labels.push({ key: `r${r}`, text: row.label, kind: 'axis', align: 'left' });
    anchors.push(new THREE.Vector3(xOf(0) - 0.7, 0, zOf(r)));
  });
  spec.cols.forEach((col, c) => {
    if (col.axis === false) return;
    labels.push({ key: `c${c}`, text: col.label, kind: 'axis', align: 'center' });
    anchors.push(new THREE.Vector3(xOf(c), 0, zOf(rows - 1) + 0.9));
  });
  const lifts = new Array<number>(spec.cells.length).fill(0);
  const progress = new Array<number>(spec.cells.length).fill(0);
  const place = (i: number) => {
    const item = spec.cells[i]!;
    matrix.compose(
      new THREE.Vector3(xOf(item.col), lifts[i]! * 0.25, zOf(item.row)),
      new THREE.Quaternion(),
      new THREE.Vector3(1, Math.max(0.0001, heights[i]! * progress[i]!), 1),
    );
    mesh.setMatrixAt(i, matrix);
  };
  const bounds = new THREE.Box3(
    new THREE.Vector3(-cols / 2 - 1.4, 0, -rows / 2),
    new THREE.Vector3(cols / 2, height, rows / 2 + 1),
  );
  return {
    root,
    bounds,
    labels,
    anchors,
    pieceCount: spec.cells.length,
    elevation: THREE.MathUtils.degToRad(38),
    azimuth: THREE.MathUtils.degToRad(-10),
    animate(ms) {
      let moving = false;
      spec.cells.forEach((item, i) => {
        const t = easeOutCubic((ms - (item.col + item.row) * 18) / ENTRANCE_MS);
        progress[i] = t;
        place(i);
        if (t < 1) moving = true;
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      return moving;
    },
    lift(index, amount) {
      if (index < 0 || index >= spec.cells.length) return;
      lifts[index] = amount;
      place(index);
      mesh.instanceMatrix.needsUpdate = true;
    },
    hitOf(intersection) {
      return intersection.object === mesh && intersection.instanceId !== undefined
        ? { piece: intersection.instanceId }
        : null;
    },
    tip(hit) {
      const item = spec.cells[hit.piece];
      if (!item) return '';
      return `${spec.rows[item.row]?.label ?? ''} ${spec.cols[item.col]?.label ?? ''}h: ${item.text}`;
    },
    pieceAnchor(index) {
      const item = spec.cells[index]!;
      return new THREE.Vector3(xOf(item.col), heights[index]! + 0.1, zOf(item.row));
    },
    dispose: () => res.dispose(),
  };
}

export function buildChart(spec: ChartSpec, ctx: BuildContext): Built {
  switch (spec.kind) {
    case 'bars':
      return buildBars(spec, ctx);
    case 'funnel':
      return buildFunnel(spec, ctx);
    case 'donut':
      return buildDonut(spec, ctx);
    case 'ribbons':
      return buildRibbons(spec, ctx);
    case 'heat':
      return buildHeat(spec, ctx);
  }
}
