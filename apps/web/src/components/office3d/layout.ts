import {
  OFFICE_ZONES,
  SECTORS,
  officeZoneLabel,
  type OfficeAgentKey,
  type OfficeSnapshot,
  type OfficeZone,
} from '@wings/shared';

/**
 * The floor plan of the virtual office, in metres (1 unit = 1 m, Y up, the
 * origin on the floor). No three.js here: the plan is plain numbers, so it is
 * tested on its own and the engine only draws it.
 *
 * Measures (office-furniture standards, not measured at Wings: estimates):
 * | object        | width × depth × height | source                         |
 * | desk          | 1.40 × 0.70 × 0.74     | NBR 13966 workstation range    |
 * | chair seat    | 0.48 × 0.48 at 0.46    | NBR 13962 seat height range    |
 * | monitor       | 0.55 × 0.04 × 0.33     | a 24" screen                   |
 * | person        | 1.70 tall standing     | adult average (estimate)       |
 * | sofa          | 2.00 × 0.85 × 0.80     | three-seat sofa (estimate)     |
 * | meeting table | 2.40 × 1.10 × 0.74     | six-seat table (estimate)      |
 * | coffee bench  | 1.20 × 0.60 × 0.90     | kitchen counter (estimate)     |
 * | cat           | 0.45 long × 0.25 tall  | adult domestic cat (estimate)  |
 * Walls are drawn 1.1 m tall (a cut-away, so the desks can be seen), not 2.8 m.
 */

export const DESK = { w: 1.4, d: 0.7, h: 0.74 } as const;
/** One desk's footprint with its chair and the aisle behind it. */
const CELL = { w: 2.0, d: 2.3 } as const;
const MARGIN = 0.6;
const GAP = 0.8;
const MAX_ROW_WIDTH = 26;
const COLUMNS = 3;

export type DeskOccupant =
  { kind: 'person'; personId: string } | { kind: 'agent'; agentKey: OfficeAgentKey };

export interface DeskPlan {
  /** person id or `agent:<key>`; also the id the screen selects. */
  id: string;
  zone: OfficeZone;
  occupant: DeskOccupant;
  /** Centre of the desk top, on the floor plane. */
  x: number;
  z: number;
}

export interface RoomPlan {
  key: OfficeZone | 'lounge' | 'meeting';
  label: string;
  /** The name painted on the floor plan: short, so neighbours do not collide. */
  short: string;
  x: number;
  z: number;
  w: number;
  d: number;
}

export interface FloorPlan {
  rooms: RoomPlan[];
  desks: DeskPlan[];
  /** Furniture of the lounge and the meeting room, by name. */
  props: {
    name: 'sofa' | 'cat' | 'coffee' | 'meeting_table' | 'plant';
    x: number;
    z: number;
    rot: number;
  }[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

const roomSize = (desks: number) => {
  const cols = Math.min(COLUMNS, Math.max(2, desks));
  const rows = Math.max(1, Math.ceil(desks / cols));
  return { cols, w: cols * CELL.w + MARGIN * 2, d: rows * CELL.d + MARGIN * 2 };
};

export function floorPlan(snapshot: Pick<OfficeSnapshot, 'people' | 'agents'>): FloorPlan {
  const byZone = new Map<OfficeZone, DeskOccupant[]>();
  for (const zone of OFFICE_ZONES) byZone.set(zone, []);
  for (const person of snapshot.people) {
    byZone.get(person.zone)?.push({ kind: 'person', personId: person.id });
  }
  for (const agent of snapshot.agents) {
    byZone.get(agent.zone)?.push({ kind: 'agent', agentKey: agent.key });
  }

  type Box = {
    key: RoomPlan['key'];
    label: string;
    short: string;
    w: number;
    d: number;
    occupants: DeskOccupant[];
    cols: number;
  };
  const boxes: Box[] = OFFICE_ZONES.map((zone) => {
    const occupants = byZone.get(zone) ?? [];
    const size = roomSize(occupants.length);
    return {
      key: zone,
      label: officeZoneLabel(zone),
      short: SECTORS[zone].name,
      occupants,
      ...size,
    };
  });
  boxes.push({
    key: 'meeting',
    label: 'Sala de reunião',
    short: 'Reunião',
    w: 5.2,
    d: 4.2,
    occupants: [],
    cols: 0,
  });
  boxes.push({
    key: 'lounge',
    label: 'Café e descanso',
    short: 'Café',
    w: 6.2,
    d: 4.2,
    occupants: [],
    cols: 0,
  });

  // Shelf packing: rooms left to right, a new row when the floor gets too wide.
  const rooms: RoomPlan[] = [];
  const desks: DeskPlan[] = [];
  let x = 0;
  let z = 0;
  let rowDepth = 0;
  for (const box of boxes) {
    if (x > 0 && x + box.w > MAX_ROW_WIDTH) {
      x = 0;
      z += rowDepth + GAP;
      rowDepth = 0;
    }
    rooms.push({ key: box.key, label: box.label, short: box.short, x, z, w: box.w, d: box.d });
    box.occupants.forEach((occupant, i) => {
      const col = i % box.cols;
      const row = Math.floor(i / box.cols);
      desks.push({
        id: occupant.kind === 'person' ? occupant.personId : `agent:${occupant.agentKey}`,
        zone: box.key as OfficeZone,
        occupant,
        x: x + MARGIN + col * CELL.w + CELL.w / 2,
        z: z + MARGIN + row * CELL.d + 0.75,
      });
    });
    x += box.w + GAP;
    rowDepth = Math.max(rowDepth, box.d);
  }

  const props: FloorPlan['props'] = [];
  const lounge = rooms.find((r) => r.key === 'lounge')!;
  props.push({ name: 'sofa', x: lounge.x + 2.0, z: lounge.z + lounge.d - 1.0, rot: Math.PI });
  props.push({ name: 'cat', x: lounge.x + 1.6, z: lounge.z + lounge.d - 1.05, rot: Math.PI * 0.9 });
  props.push({ name: 'coffee', x: lounge.x + lounge.w - 1.2, z: lounge.z + 0.8, rot: 0 });
  props.push({ name: 'plant', x: lounge.x + lounge.w - 0.5, z: lounge.z + lounge.d - 0.5, rot: 0 });
  const meeting = rooms.find((r) => r.key === 'meeting')!;
  props.push({
    name: 'meeting_table',
    x: meeting.x + meeting.w / 2,
    z: meeting.z + meeting.d / 2,
    rot: 0,
  });
  // A plant in a corner of every work room (decoration, not data).
  for (const room of rooms) {
    if (room.key === 'lounge' || room.key === 'meeting') continue;
    props.push({ name: 'plant', x: room.x + room.w - 0.4, z: room.z + room.d - 0.4, rot: 0 });
  }

  const maxX = Math.max(...rooms.map((r) => r.x + r.w));
  const maxZ = Math.max(...rooms.map((r) => r.z + r.d));
  return { rooms, desks, props, bounds: { minX: 0, maxX, minZ: 0, maxZ } };
}
