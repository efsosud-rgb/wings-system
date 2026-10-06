import {
  officeLightAt,
  type OfficeEvent,
  type OfficeLight,
  type OfficeSnapshot,
} from '@wings/shared';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DESK, floorPlan, type DeskPlan, type FloorPlan } from './layout.js';

/**
 * The virtual office in three.js: one WebGLRenderer on the page's canvas
 * (the menu logo holds the only other context), every repeated object an
 * InstancedMesh, geometry made here in code (no third-party assets).
 *
 * People move only when the API reports something they did (`react`): a hop
 * for a move or a finished task, standing up with confetti for a won sale.
 * The cat breathes and the coffee stays warm: decoration, never data.
 * With prefers-reduced-motion the scene stands still and draws on demand.
 */

export interface OfficeHost {
  stage: HTMLElement;
  canvas: HTMLCanvasElement;
  /** HTML layer for the name tags and room names (textContent only). */
  labels: HTMLElement;
}

export interface OfficeCallbacks {
  onSelect: (deskId: string | null) => void;
}

export interface OfficeStats {
  calls: number;
  triangles: number;
  fps: number | null;
  geometries: number;
  textures: number;
}

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Below this width the name tags shrink to first names and room names hide. */
export const COMPACT_WIDTH = 520;
const COMPACT_START_ZOOM = 1.7;

/** Agents' tags on the floor; the side panel and the list use the full names. */
const AGENT_TAG: Record<string, string> = {
  'agent:sofia': 'Sofia · IA',
  'agent:trafego': 'Tráfego · IA',
  'agent:edicao': 'Edição · IA',
};

const ZONE_TINT: Record<string, number> = {
  diretoria: 0xe9e2f2,
  comercial: 0xf6e2d8,
  marketing: 0xf3ecd2,
  'formatacao-juridico': 0xdfe8f1,
  'formatacao-financeiro': 0xdcefe6,
  'formatacao-processos-projetos': 0xe3e9dc,
  'formatacao-contabil-tributario': 0xe6e4f1,
  'formatacao-logistica': 0xf0e6dc,
  'formatacao-ti': 0xdfe6ea,
  lounge: 0xf1e8de,
  meeting: 0xe8e6e2,
};

/** Shirt colour by room: the colour says the sector, nothing else. */
const ZONE_SHIRT: Record<string, number> = {
  diretoria: 0x5b4a8b,
  comercial: 0xe95228,
  marketing: 0xc98a12,
  'formatacao-juridico': 0x3f6e9e,
  'formatacao-financeiro': 0x2f8a63,
  'formatacao-processos-projetos': 0x667a3c,
  'formatacao-contabil-tributario': 0x6c63a8,
  'formatacao-logistica': 0x9a6a3a,
  'formatacao-ti': 0x3d7c8c,
};

const SCREEN = {
  task: new THREE.Color(0xff7a45),
  overdue: new THREE.Color(0xd8342a),
  deal: new THREE.Color(0x4f8df5),
  agent: new THREE.Color(0x2bc4b4),
  idle: new THREE.Color(0x2a2d33),
};

interface LightSetting {
  sky: number;
  ground: number;
  hemi: number;
  sun: number;
  sunIntensity: number;
  sunPos: [number, number, number];
  lamp: number;
}

const LIGHTS: Record<OfficeLight, LightSetting> = {
  manha: {
    sky: 0xffe9c7,
    ground: 0xb9a58a,
    hemi: 1.5,
    sun: 0xffd29a,
    sunIntensity: 1.8,
    sunPos: [-10, 9, 8],
    lamp: 0,
  },
  dia: {
    sky: 0xffffff,
    ground: 0xbdb6ab,
    hemi: 1.6,
    sun: 0xfff6e8,
    sunIntensity: 2.0,
    sunPos: [6, 16, 9],
    lamp: 0,
  },
  por_do_sol: {
    sky: 0xffc29a,
    ground: 0x8f6f62,
    hemi: 1.15,
    sun: 0xff8a4c,
    sunIntensity: 1.9,
    sunPos: [16, 5, -3],
    lamp: 0.6,
  },
  noite: {
    sky: 0x56648a,
    ground: 0x1c2030,
    hemi: 0.75,
    sun: 0xa9bcff,
    sunIntensity: 0.45,
    sunPos: [-6, 12, -6],
    lamp: 1.4,
  },
};

const AZIMUTH = Math.PI / 4;
const ELEVATION = THREE.MathUtils.degToRad(35);
const VIEW_DIR = new THREE.Vector3(
  Math.cos(ELEVATION) * Math.sin(AZIMUTH),
  Math.sin(ELEVATION),
  Math.cos(ELEVATION) * Math.cos(AZIMUTH),
);

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

function box(w: number, h: number, d: number, x = 0, y = 0, z = 0) {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z).toNonIndexed();
}
function cylinder(rt: number, rb: number, h: number, seg: number, x = 0, y = 0, z = 0) {
  return new THREE.CylinderGeometry(rt, rb, h, seg).translate(x, y, z).toNonIndexed();
}
function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const geometry = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
  for (const part of parts) part.dispose();
  if (!geometry) throw new Error('office3d: could not merge geometry');
  return geometry;
}

interface Hop {
  index: number;
  start: number;
  duration: number;
  stand: boolean;
}

export class OfficeEngine {
  readonly reduced = reducedMotion();
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  private hemi = new THREE.HemisphereLight();
  private sun = new THREE.DirectionalLight();
  private lamp = new THREE.PointLight(0xffd7a0, 0, 30, 1.6);
  private geometries: THREE.BufferGeometry[] = [];
  private materials: THREE.Material[] = [];
  private world = new THREE.Group();

  private plan: FloorPlan | null = null;
  private snapshot: OfficeSnapshot | null = null;
  private deskMesh: THREE.InstancedMesh | null = null;
  private screenMesh: THREE.InstancedMesh | null = null;
  private torsoMesh: THREE.InstancedMesh | null = null;
  private headMesh: THREE.InstancedMesh | null = null;
  private confetti: THREE.InstancedMesh | null = null;
  private catBody: THREE.Mesh | null = null;
  private catTail: THREE.Mesh | null = null;
  private ring: THREE.Mesh | null = null;
  /** Seated figure index per desk id (absent people have none). */
  private figureOf = new Map<string, number>();
  private figureBase: THREE.Matrix4[] = [];
  private tags = new Map<string, HTMLElement>();
  private roomTags: { el: HTMLElement; at: THREE.Vector3 }[] = [];

  private target = new THREE.Vector3();
  private zoom = 1;
  private fit = { target: new THREE.Vector3(), half: 10 };
  private flight: {
    from: THREE.Vector3;
    to: THREE.Vector3;
    z0: number;
    z1: number;
    t: number;
  } | null = null;
  private hops: Hop[] = [];
  private bursts: { origin: THREE.Vector3; start: number; seeds: Float32Array }[] = [];
  private selected: string | null = null;
  private width = 1;
  private height = 1;
  private clock = 0;
  private raf = 0;
  private last = 0;
  private visible = true;
  private observer: IntersectionObserver | null = null;
  private frames: number[] = [];
  private placedOnce = false;
  private dragging: { x: number; y: number; moved: boolean; target: THREE.Vector3 } | null = null;
  private raycaster = new THREE.Raycaster();
  private tmp = new THREE.Matrix4();
  private v = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private one = new THREE.Vector3(1, 1, 1);
  private floorKey = '';
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private host: OfficeHost,
    private callbacks: OfficeCallbacks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas: host.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.scene.add(this.hemi, this.sun, this.lamp, this.world);
    this.camera.up.set(0, 1, 0);

    document.addEventListener('visibilitychange', this.onVisibility);
    if (typeof IntersectionObserver !== 'undefined') {
      this.observer = new IntersectionObserver((entries) => {
        this.visible = entries.some((entry) => entry.isIntersecting);
        this.loop();
      });
      this.observer.observe(host.stage);
    }
    const canvas = host.canvas;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('keydown', this.onKey);
  }

  // --- building -----------------------------------------------------------------------------

  private own<T extends THREE.BufferGeometry | THREE.Material>(item: T): T {
    if (item instanceof THREE.BufferGeometry) this.geometries.push(item);
    else this.materials.push(item);
    return item;
  }

  private standard(color: number, extra: THREE.MeshStandardMaterialParameters = {}) {
    return this.own(
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.85,
        metalness: 0,
        flatShading: true,
        ...extra,
      }),
    );
  }

  private instanced(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    count: number,
    name: string,
  ) {
    const mesh = new THREE.InstancedMesh(this.own(geometry), material, Math.max(count, 1));
    mesh.count = count;
    mesh.name = name;
    this.world.add(mesh);
    return mesh;
  }

  /** First data, or new data: the floor is rebuilt only when its desks change. */
  setSnapshot(snapshot: OfficeSnapshot) {
    const plan = floorPlan(snapshot);
    // Desks and who is seated decide the geometry; anything else only repaints.
    const key = [
      ...plan.desks.map((d) => d.id),
      ...snapshot.people.filter((p) => p.present).map((p) => `+${p.id}`),
    ].join('|');
    this.snapshot = snapshot;
    if (key !== this.floorKey) {
      const first = !this.plan;
      this.floorKey = key;
      this.clearWorld();
      this.plan = plan;
      this.build(plan);
      this.fitView();
      if (first || !this.selected) {
        this.target.copy(this.fit.target);
        // A phone starts closer (the whole floor is a strip there); "Visão geral" shows it all.
        this.zoom = this.width < COMPACT_WIDTH ? COMPACT_START_ZOOM : 1;
      }
      if (this.selected) this.select(this.selected, false);
    }
    this.applyLight(officeLightAt(snapshot.hour, snapshot.minute));
    this.paintDesks();
    this.updateTags();
    this.requestFrame();
  }

  private clearWorld() {
    for (const child of [...this.world.children]) this.world.remove(child);
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries = [];
    this.materials = [];
    this.figureOf.clear();
    this.figureBase = [];
    this.host.labels.replaceChildren();
    this.tags.clear();
    this.roomTags = [];
    this.confetti = null;
  }

  private build(plan: FloorPlan) {
    const snapshot = this.snapshot!;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const color = new THREE.Color();

    // Floor slab under everything.
    const { minX, maxX, minZ, maxZ } = plan.bounds;
    const slab = new THREE.Mesh(
      this.own(
        box(maxX - minX + 2, 0.12, maxZ - minZ + 2, (minX + maxX) / 2, -0.06, (minZ + maxZ) / 2),
      ),
      this.standard(0xd9d3ca),
    );
    slab.name = 'floor';
    this.world.add(slab);

    // Room floors and the two back walls of each room (a cut-away: front walls are left out).
    const roomFloors = this.instanced(
      box(1, 0.02, 1, 0, 0.01, 0),
      this.standard(0xffffff),
      plan.rooms.length,
      'room-floors',
    );
    const walls = this.instanced(
      box(1, 1, 1, 0, 0.5, 0),
      this.standard(0xf2efea),
      plan.rooms.length * 2,
      'walls',
    );
    plan.rooms.forEach((room, i) => {
      roomFloors.setMatrixAt(
        i,
        m.compose(
          p.set(room.x + room.w / 2, 0, room.z + room.d / 2),
          q.identity(),
          s.set(room.w, 1, room.d),
        ),
      );
      roomFloors.setColorAt(i, color.setHex(ZONE_TINT[room.key] ?? 0xeeeeee));
      walls.setMatrixAt(
        i * 2,
        m.compose(
          p.set(room.x + room.w / 2, 0, room.z + 0.04),
          q.identity(),
          s.set(room.w, 1.1, 0.08),
        ),
      );
      walls.setMatrixAt(
        i * 2 + 1,
        m.compose(
          p.set(room.x + 0.04, 0, room.z + room.d / 2),
          q.identity(),
          s.set(0.08, 1.1, room.d),
        ),
      );
      const tag = document.createElement('span');
      tag.className = 'o3d-room';
      tag.textContent = room.short;
      tag.title = room.label;
      this.host.labels.append(tag);
      this.roomTags.push({ el: tag, at: new THREE.Vector3(room.x + 0.3, 1.25, room.z + 0.3) });
    });

    // Desks, monitors, chairs.
    const deskGeo = merged([
      box(DESK.w, 0.04, DESK.d, 0, DESK.h - 0.02, 0),
      box(0.04, DESK.h - 0.04, DESK.d - 0.06, -DESK.w / 2 + 0.04, (DESK.h - 0.04) / 2, 0),
      box(0.04, DESK.h - 0.04, DESK.d - 0.06, DESK.w / 2 - 0.04, (DESK.h - 0.04) / 2, 0),
      box(DESK.w - 0.1, 0.3, 0.02, 0, 0.45, -DESK.d / 2 + 0.05),
    ]);
    const monitorGeo = merged([
      box(0.55, 0.33, 0.03, 0, DESK.h + 0.15 + 0.165, -0.15),
      box(0.04, 0.15, 0.04, 0, DESK.h + 0.075, -0.17),
      box(0.2, 0.02, 0.14, 0, DESK.h + 0.01, -0.17),
      box(0.42, 0.015, 0.14, 0, DESK.h + 0.008, 0.08),
    ]);
    const screenGeo = new THREE.PlaneGeometry(0.5, 0.28).translate(
      0,
      DESK.h + 0.15 + 0.165,
      -0.133,
    );
    const chairGeo = merged([
      box(0.48, 0.06, 0.48, 0, 0.46, 0),
      box(0.46, 0.5, 0.06, 0, 0.78, 0.22),
      cylinder(0.03, 0.03, 0.4, 6, 0, 0.23, 0),
      cylinder(0.25, 0.25, 0.04, 8, 0, 0.02, 0),
    ]);

    const desks = plan.desks;
    const meetingChairs = 6;
    this.deskMesh = this.instanced(deskGeo, this.standard(0xc9a77c), desks.length, 'desks');
    const monitors = this.instanced(monitorGeo, this.standard(0x2b2e34), desks.length, 'monitors');
    this.screenMesh = this.instanced(
      screenGeo,
      this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })),
      desks.length,
      'screens',
    );
    const chairs = this.instanced(
      chairGeo,
      this.standard(0x3b3f47),
      desks.length + meetingChairs,
      'chairs',
    );

    desks.forEach((desk, i) => {
      m.compose(p.set(desk.x, 0, desk.z), q.identity(), s.set(1, 1, 1));
      this.deskMesh!.setMatrixAt(i, m);
      monitors.setMatrixAt(i, m);
      this.screenMesh!.setMatrixAt(i, m);
      chairs.setMatrixAt(
        i,
        m.compose(p.set(desk.x, 0, desk.z + 0.62), q.identity(), s.set(1, 1, 1)),
      );
    });

    // Seated figures: people with a live session, and the agents (software is always at its desk).
    const torsoGeo = cylinder(0.16, 0.2, 0.55, 6, 0, 0.78, 0.62);
    const headGeo = new THREE.IcosahedronGeometry(0.115, 0).translate(0, 1.2, 0.6);
    const seated = desks.filter((desk) =>
      desk.occupant.kind === 'agent'
        ? true
        : snapshot.people.find((person) => person.id === desk.id)?.present === true,
    );
    this.torsoMesh = this.instanced(torsoGeo, this.standard(0xffffff), seated.length, 'torsos');
    this.headMesh = this.instanced(headGeo, this.standard(0xffffff), seated.length, 'heads');
    seated.forEach((desk, i) => {
      const base = new THREE.Matrix4().compose(
        new THREE.Vector3(desk.x, 0, desk.z),
        new THREE.Quaternion(),
        new THREE.Vector3(1, 1, 1),
      );
      this.figureOf.set(desk.id, i);
      this.figureBase.push(base);
      this.torsoMesh!.setMatrixAt(i, base);
      this.headMesh!.setMatrixAt(i, base);
      const agent = desk.occupant.kind === 'agent';
      this.torsoMesh!.setColorAt(
        i,
        color.setHex(agent ? 0x2bc4b4 : (ZONE_SHIRT[desk.zone] ?? 0x777777)),
      );
      // Heads are one neutral tone: these are figures, not portraits.
      this.headMesh!.setColorAt(i, color.setHex(agent ? 0xd8f5f1 : 0xe7ddd0));
    });

    // Meeting room: table and six chairs around it.
    const meetingProp = plan.props.find((prop) => prop.name === 'meeting_table');
    if (meetingProp) {
      const table = new THREE.Mesh(
        this.own(
          merged([
            box(2.4, 0.05, 1.1, 0, 0.715, 0),
            cylinder(0.08, 0.12, 0.69, 6, -0.7, 0.345, 0),
            cylinder(0.08, 0.12, 0.69, 6, 0.7, 0.345, 0),
          ]),
        ),
        this.standard(0xb38d63),
      );
      table.name = 'meeting-table';
      table.position.set(meetingProp.x, 0, meetingProp.z);
      this.world.add(table);
      const seats: [number, number, number][] = [
        [-0.75, -0.85, 0],
        [0, -0.85, 0],
        [0.75, -0.85, 0],
        [-0.75, 0.85, Math.PI],
        [0, 0.85, Math.PI],
        [0.75, 0.85, Math.PI],
      ];
      seats.forEach(([dx, dz, rot], k) => {
        q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rot);
        chairs.setMatrixAt(
          desks.length + k,
          m.compose(p.set(meetingProp.x + dx, 0, meetingProp.z + dz), q, s.set(1, 1, 1)),
        );
      });
    }
    chairs.count = desks.length + (meetingProp ? meetingChairs : 0);

    // Lounge: sofa, the cat, coffee bench.
    for (const prop of plan.props) {
      if (prop.name === 'sofa') {
        const sofa = new THREE.Mesh(
          this.own(
            merged([
              box(2.0, 0.42, 0.85, 0, 0.21, 0),
              box(2.0, 0.42, 0.2, 0, 0.63, -0.33),
              box(0.2, 0.25, 0.85, -0.9, 0.55, 0),
              box(0.2, 0.25, 0.85, 0.9, 0.55, 0),
            ]),
          ),
          this.standard(0x5d7a8c),
        );
        sofa.name = 'sofa';
        sofa.position.set(prop.x, 0, prop.z);
        sofa.rotation.y = prop.rot;
        this.world.add(sofa);
      } else if (prop.name === 'cat') {
        const fur = this.standard(0x3a3433);
        const body = new THREE.Mesh(
          this.own(
            merged([
              box(0.34, 0.16, 0.2, 0, 0.08, 0),
              new THREE.IcosahedronGeometry(0.085, 0).translate(0.2, 0.17, 0),
              new THREE.ConeGeometry(0.035, 0.07, 4).translate(0.2, 0.27, 0.045).toNonIndexed(),
              new THREE.ConeGeometry(0.035, 0.07, 4).translate(0.2, 0.27, -0.045).toNonIndexed(),
            ]),
          ),
          fur,
        );
        body.name = 'cat';
        body.position.set(prop.x, 0.42, prop.z);
        body.rotation.y = prop.rot;
        const tail = new THREE.Mesh(this.own(box(0.26, 0.04, 0.04, -0.13, 0, 0)), fur);
        tail.name = 'cat-tail';
        tail.position.set(-0.16, 0.1, 0);
        body.add(tail);
        this.world.add(body);
        this.catBody = body;
        this.catTail = tail;
      } else if (prop.name === 'coffee') {
        const bench = new THREE.Mesh(
          this.own(
            merged([
              box(1.2, 0.9, 0.6, 0, 0.45, 0),
              box(0.28, 0.36, 0.26, 0.25, 1.08, -0.05),
              box(0.1, 0.1, 0.1, -0.25, 0.95, 0.05),
            ]),
          ),
          this.standard(0x8a6b55),
        );
        bench.name = 'coffee';
        bench.position.set(prop.x, 0, prop.z);
        this.world.add(bench);
      }
    }

    // Plants: one in a corner of every room.
    const plants = plan.props.filter((prop) => prop.name === 'plant');
    const pots = this.instanced(
      cylinder(0.17, 0.13, 0.36, 7, 0, 0.18, 0),
      this.standard(0xb8735a),
      plants.length,
      'pots',
    );
    const leaves = this.instanced(
      new THREE.IcosahedronGeometry(0.34, 0).scale(1, 1.4, 1).translate(0, 0.78, 0),
      this.standard(0x4f8a4b),
      plants.length,
      'leaves',
    );
    plants.forEach((plant, i) => {
      m.compose(
        p.set(plant.x, 0, plant.z),
        q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, i * 1.7),
        s.set(1, 1, 1),
      );
      pots.setMatrixAt(i, m);
      leaves.setMatrixAt(i, m);
    });

    // Selection ring, under the chosen desk.
    const ring = new THREE.Mesh(
      this.own(
        new THREE.RingGeometry(0.95, 1.1, 32).rotateX(-Math.PI / 2).translate(0, 0.03, 0.25),
      ),
      this.own(new THREE.MeshBasicMaterial({ color: 0xff5a1f, transparent: true, opacity: 0.85 })),
    );
    ring.name = 'selection';
    ring.visible = false;
    this.world.add(ring);
    this.ring = ring;

    // Confetti for a won sale: 160 small cards, hidden until a win.
    this.confetti = this.instanced(
      new THREE.PlaneGeometry(0.16, 0.24),
      this.own(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false })),
      160,
      'confetti',
    );
    this.confetti.count = 0;
    const palette = [0xff5a1f, 0xffc23d, 0x2bc4b4, 0x4f8df5, 0xffffff];
    for (let i = 0; i < 160; i++)
      this.confetti.setColorAt(i, color.setHex(palette[i % palette.length]!));

    // Name tags (HTML, textContent).
    for (const desk of desks) {
      const tag = document.createElement('button');
      tag.type = 'button';
      tag.className = 'o3d-tag';
      tag.dataset.desk = desk.id;
      tag.tabIndex = -1;
      tag.addEventListener('click', () => this.select(desk.id));
      this.host.labels.append(tag);
      this.tags.set(desk.id, tag);
    }

    for (const mesh of [
      roomFloors,
      walls,
      this.deskMesh,
      monitors,
      this.screenMesh,
      chairs,
      this.torsoMesh,
      this.headMesh,
      pots,
      leaves,
    ]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  /** Screen colours and name tags from the current snapshot. */
  private paintDesks() {
    if (!this.plan || !this.snapshot || !this.screenMesh) return;
    const people = new Map(this.snapshot.people.map((person) => [person.id, person]));
    const agents = new Map(this.snapshot.agents.map((agent) => [`agent:${agent.key}`, agent]));
    this.plan.desks.forEach((desk, i) => {
      let tone = SCREEN.idle;
      const person = people.get(desk.id);
      const agent = agents.get(desk.id);
      if (person) {
        const monitor = person.monitor;
        if (monitor.kind === 'task') tone = monitor.overdue ? SCREEN.overdue : SCREEN.task;
        else if (monitor.kind === 'deal') tone = SCREEN.deal;
      } else if (agent?.lastActivityAt) {
        tone = SCREEN.agent;
      }
      this.screenMesh!.setColorAt(i, tone);
    });
    if (this.screenMesh.instanceColor) this.screenMesh.instanceColor.needsUpdate = true;
  }

  private updateTags() {
    if (!this.snapshot) return;
    const people = new Map(this.snapshot.people.map((person) => [person.id, person]));
    const agents = new Map(this.snapshot.agents.map((agent) => [`agent:${agent.key}`, agent]));
    for (const [id, tag] of this.tags) {
      const person = people.get(id);
      const agent = agents.get(id);
      const name = person?.displayName ?? agent?.name ?? '—';
      const away = person ? !person.present : false;
      tag.textContent = person?.displayName ?? AGENT_TAG[id] ?? name;
      // The monitor's colour, repeated as a dot on the tag (readable at any zoom).
      tag.dataset.state = person
        ? person.monitor.kind === 'task'
          ? person.monitor.overdue
            ? 'overdue'
            : 'task'
          : person.monitor.kind
        : agent?.lastActivityAt
          ? 'agent'
          : 'none';
      tag.classList.toggle('is-away', away);
      tag.classList.toggle('is-agent', Boolean(agent));
      tag.classList.toggle('is-selected', id === this.selected);
      tag.setAttribute('aria-label', `${name}${away ? ', fora do sistema' : ''}`);
    }
  }

  private applyLight(phase: OfficeLight) {
    const light = LIGHTS[phase];
    this.hemi.color.setHex(light.sky);
    this.hemi.groundColor.setHex(light.ground);
    this.hemi.intensity = light.hemi;
    this.sun.color.setHex(light.sun);
    this.sun.intensity = light.sunIntensity;
    const centre = this.fit.target;
    this.sun.position.set(centre.x + light.sunPos[0], light.sunPos[1], centre.z + light.sunPos[2]);
    this.sun.target.position.copy(centre);
    this.sun.target.updateMatrixWorld();
    this.lamp.intensity = light.lamp * 12;
    this.lamp.position.set(centre.x, 3.2, centre.z);
    this.host.stage.dataset.light = phase;
  }

  // --- camera --------------------------------------------------------------------------------

  private fitView() {
    if (!this.plan) return;
    const { minX, maxX, minZ, maxZ } = this.plan.bounds;
    const centre = new THREE.Vector3((minX + maxX) / 2, 0.4, (minZ + maxZ) / 2);
    this.fit.target.copy(centre);
    this.placeCamera(centre);
    this.camera.updateMatrixWorld();
    // Half-sizes the corners need on screen, from the camera's right and up axes.
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    let halfW = 0;
    let halfH = 0;
    for (const x of [minX, maxX]) {
      for (const z of [minZ, maxZ]) {
        for (const y of [0, 1.3]) {
          this.v.set(x, y, z).sub(centre);
          halfW = Math.max(halfW, Math.abs(this.v.dot(right)));
          halfH = Math.max(halfH, Math.abs(this.v.dot(up)));
        }
      }
    }
    const aspect = this.width / Math.max(this.height, 1);
    this.fit.half = Math.max(halfH, halfW / aspect) * 1.06;
  }

  private placeCamera(target: THREE.Vector3) {
    this.camera.position.copy(target).addScaledVector(VIEW_DIR, 60);
    this.camera.lookAt(target);
  }

  private applyCamera() {
    const half = this.fit.half / this.zoom;
    const aspect = this.width / Math.max(this.height, 1);
    this.camera.left = -half * aspect;
    this.camera.right = half * aspect;
    this.camera.top = half;
    this.camera.bottom = -half;
    this.camera.updateProjectionMatrix();
    this.placeCamera(this.target);
    this.camera.updateMatrixWorld();
  }

  private flyTo(to: THREE.Vector3, zoom: number) {
    if (this.reduced) {
      this.target.copy(to);
      this.zoom = zoom;
      this.requestFrame();
      return;
    }
    this.flight = { from: this.target.clone(), to: to.clone(), z0: this.zoom, z1: zoom, t: 0 };
    this.loop();
  }

  /** Selects a desk (camera flies to it) or, with null, goes back to the whole floor. */
  select(deskId: string | null, notify = true) {
    this.selected = deskId;
    const desk = deskId ? this.plan?.desks.find((d) => d.id === deskId) : null;
    if (desk && this.ring) {
      this.ring.position.set(desk.x, 0, desk.z);
      this.ring.visible = true;
      this.flyTo(
        new THREE.Vector3(desk.x, 0.6, desk.z + 0.3),
        this.width < COMPACT_WIDTH ? 3.2 : 2.6,
      );
    } else {
      if (this.ring) this.ring.visible = false;
      this.flyTo(this.fit.target, 1);
    }
    this.updateTags();
    if (notify) this.callbacks.onSelect(desk ? desk.id : null);
  }

  zoomBy(factor: number) {
    this.zoom = THREE.MathUtils.clamp(this.zoom * factor, 0.8, 5);
    this.requestFrame();
  }

  // --- events from the API --------------------------------------------------------------------

  /** Real events the screen has not shown yet: hops for work done, confetti for a sale. */
  react(events: OfficeEvent[]) {
    if (!this.plan) return;
    for (const event of events) {
      if (!event.employeeId) continue;
      const index = this.figureOf.get(event.employeeId);
      const desk = this.plan.desks.find((d) => d.id === event.employeeId);
      if (!desk) continue;
      const won = event.kind === 'deal_won';
      if (won) this.badge(desk.id);
      if (index !== undefined && !this.reduced) {
        this.hops.push({ index, start: this.clock, duration: won ? 3.2 : 1.1, stand: won });
      }
      if (won && !this.reduced) {
        const seeds = new Float32Array(160 * 4);
        for (let i = 0; i < seeds.length; i++) seeds[i] = ((i * 2654435761) % 1000) / 1000;
        this.bursts.push({
          origin: new THREE.Vector3(desk.x, 1.6, desk.z + 0.3),
          start: this.clock,
          seeds,
        });
      }
    }
    this.loop();
  }

  /** "Venda ganha!" on the seller's tag for a few seconds (also with reduced motion). */
  private badge(deskId: string) {
    const tag = this.tags.get(deskId);
    if (!tag) return;
    tag.classList.add('is-celebrating');
    const timer = setTimeout(() => {
      tag.classList.remove('is-celebrating');
      this.timers.delete(timer);
    }, 7000);
    this.timers.add(timer);
  }

  // --- frame ---------------------------------------------------------------------------------

  resize() {
    const w = this.host.stage.clientWidth;
    const h = this.host.stage.clientHeight;
    if (!w || !h) return;
    const wasCompact = this.width < COMPACT_WIDTH;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.fitView();
    if (!this.selected) this.target.copy(this.fit.target);
    this.host.stage.classList.toggle('is-compact', w < COMPACT_WIDTH);
    if (wasCompact !== w < COMPACT_WIDTH && this.selected) this.select(this.selected, false);
    this.requestFrame();
  }

  private animating() {
    return Boolean(
      this.flight || this.hops.length || this.bursts.length || (!this.reduced && this.catBody),
    );
  }

  private running() {
    return !document.hidden && this.visible && this.animating();
  }

  private onVisibility = () => this.loop();

  /** One frame now (used by the still scene). */
  requestFrame() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(this.tick);
  }

  private loop() {
    if (this.running()) this.requestFrame();
  }

  private tick = (ts: number) => {
    this.raf = 0;
    const dt = this.last ? Math.min((ts - this.last) / 1000, 0.05) : 0;
    this.last = ts;
    this.clock += dt;
    if (dt > 0) {
      this.frames.push(dt);
      if (this.frames.length > 90) this.frames.shift();
    }
    this.step(dt);
    this.applyCamera();
    this.renderer.render(this.scene, this.camera);
    this.placeTags();
    if (this.running()) this.raf = requestAnimationFrame(this.tick);
    else this.last = 0;
  };

  private step(dt: number) {
    if (this.flight) {
      this.flight.t = Math.min(1, this.flight.t + dt / 0.7);
      const k = easeOut(this.flight.t);
      this.target.lerpVectors(this.flight.from, this.flight.to, k);
      this.zoom = THREE.MathUtils.lerp(this.flight.z0, this.flight.z1, k);
      if (this.flight.t >= 1) this.flight = null;
    }
    if (this.catBody && this.catTail && !this.reduced) {
      this.catBody.scale.y = 1 + Math.sin(this.clock * 1.6) * 0.03;
      this.catTail.rotation.y = Math.sin(this.clock * 0.9) * 0.35;
    }
    if (this.hops.length && this.torsoMesh && this.headMesh) {
      const touched = new Set<number>();
      this.hops = this.hops.filter((hop) => {
        const t = (this.clock - hop.start) / hop.duration;
        const base = this.figureBase[hop.index]!;
        let lift = 0;
        if (t < 1)
          lift = hop.stand
            ? Math.sin(Math.PI * t) * 0.32 + Math.abs(Math.sin(t * Math.PI * 6)) * 0.08
            : Math.abs(Math.sin(t * Math.PI * 2)) * 0.12;
        this.v.setFromMatrixPosition(base);
        this.v.y += lift;
        this.tmp.copy(base).setPosition(this.v);
        this.torsoMesh!.setMatrixAt(hop.index, this.tmp);
        this.headMesh!.setMatrixAt(hop.index, this.tmp);
        touched.add(hop.index);
        return t < 1;
      });
      if (touched.size) {
        this.torsoMesh.instanceMatrix.needsUpdate = true;
        this.headMesh.instanceMatrix.needsUpdate = true;
      }
    }
    if (this.confetti) {
      const live = this.bursts.filter((burst) => this.clock - burst.start < 3);
      this.bursts = live;
      let n = 0;
      for (const burst of live) {
        const t = this.clock - burst.start;
        for (let i = 0; i < 160 / Math.max(live.length, 1) && n < 160; i++, n++) {
          const a = burst.seeds[i * 4]! * Math.PI * 2;
          const r = 0.5 + burst.seeds[i * 4 + 1]! * 1.6;
          const up = 2.4 + burst.seeds[i * 4 + 2]! * 1.6;
          this.v.set(
            burst.origin.x + Math.cos(a) * r * t,
            burst.origin.y + up * t - 2.2 * t * t,
            burst.origin.z + Math.sin(a) * r * t,
          );
          this.e.set(t * 6 + i, t * 4 + i * 0.5, 0);
          this.confetti.setMatrixAt(
            n,
            this.tmp.compose(this.v, this.q.setFromEuler(this.e), this.one),
          );
        }
      }
      this.confetti.count = n;
      this.confetti.instanceMatrix.needsUpdate = true;
    }
  }

  private placeTags() {
    if (!this.plan) return;
    const w = this.width;
    const h = this.height;
    for (const desk of this.plan.desks) {
      const tag = this.tags.get(desk.id);
      if (!tag) continue;
      this.v.set(desk.x, 1.62, desk.z + 0.3).project(this.camera);
      tag.style.transform = `translate(-50%, -100%) translate(${((this.v.x + 1) / 2) * w}px, ${((1 - this.v.y) / 2) * h}px)`;
    }
    for (const room of this.roomTags) {
      this.v.copy(room.at).project(this.camera);
      room.el.style.transform = `translate(${((this.v.x + 1) / 2) * w}px, ${((1 - this.v.y) / 2) * h}px)`;
    }
    if (!this.placedOnce) {
      this.placedOnce = true;
      this.host.labels.classList.add('is-placed');
    }
  }

  // --- input -----------------------------------------------------------------------------------

  private deskAt(clientX: number, clientY: number): DeskPlan | null {
    if (!this.plan || !this.deskMesh) return null;
    const rect = this.host.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = [this.deskMesh, this.screenMesh, this.torsoMesh, this.headMesh].filter(
      Boolean,
    ) as THREE.InstancedMesh[];
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (!hit || hit.instanceId === undefined) return null;
    if (hit.object === this.torsoMesh || hit.object === this.headMesh) {
      const id = [...this.figureOf.entries()].find(([, index]) => index === hit.instanceId)?.[0];
      return this.plan.desks.find((d) => d.id === id) ?? null;
    }
    return this.plan.desks[hit.instanceId] ?? null;
  }

  private onPointerDown = (event: PointerEvent) => {
    this.dragging = {
      x: event.clientX,
      y: event.clientY,
      moved: false,
      target: this.target.clone(),
    };
  };

  private onPointerMove = (event: PointerEvent) => {
    if (this.dragging && (event.buttons & 1) === 1) {
      const dx = event.clientX - this.dragging.x;
      const dy = event.clientY - this.dragging.y;
      if (Math.hypot(dx, dy) > 4) this.dragging.moved = true;
      if (this.dragging.moved) {
        const scale = (2 * this.fit.half) / this.zoom / this.height;
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
        const forward = new THREE.Vector3(-VIEW_DIR.x, 0, -VIEW_DIR.z).normalize();
        this.target
          .copy(this.dragging.target)
          .addScaledVector(right, -dx * scale)
          .addScaledVector(forward, (dy * scale) / Math.sin(ELEVATION));
        this.flight = null;
        this.requestFrame();
      }
      return;
    }
    this.host.canvas.style.cursor = this.deskAt(event.clientX, event.clientY) ? 'pointer' : 'grab';
  };

  private onPointerUp = (event: PointerEvent) => {
    const drag = this.dragging;
    this.dragging = null;
    if (drag?.moved) return;
    const desk = this.deskAt(event.clientX, event.clientY);
    this.select(desk ? desk.id : null);
  };

  private onPointerLeave = () => {
    this.dragging = null;
  };

  private onKey = (event: KeyboardEvent) => {
    if (!this.plan || !this.plan.desks.length) return;
    const desks = this.plan.desks;
    const index = desks.findIndex((d) => d.id === this.selected);
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      this.select(desks[(index + 1) % desks.length]!.id);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.select(desks[(index - 1 + desks.length) % desks.length]!.id);
    } else if (event.key === 'Escape') {
      this.select(null);
    }
  };

  stats(): OfficeStats {
    const total = this.frames.reduce((sum, dt) => sum + dt, 0);
    return {
      calls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      fps: this.frames.length > 10 && total > 0 ? Math.round(this.frames.length / total) : null,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
    };
  }

  dispose() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.observer?.disconnect();
    const canvas = this.host.canvas;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointerleave', this.onPointerLeave);
    canvas.removeEventListener('keydown', this.onKey);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.clearWorld();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

export function createOfficeEngine(
  host: OfficeHost,
  callbacks: OfficeCallbacks,
): OfficeEngine | null {
  try {
    return new OfficeEngine(host, callbacks);
  } catch {
    return null;
  }
}
