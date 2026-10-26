import { z } from 'zod';
import { SALES_PERIODS, type SalesRange } from './sales-panel.js';

/**
 * Câmeras (docs/cameras.md): people flow per area of a client's store or of
 * Wings' own office, as aggregated numbers only. The video never leaves the
 * site; the server receives counts, occupancy and alerts, never an image, a
 * face or a person's identity (Eric, 24/10/2026; LGPD art. 11). Devices send
 * 15-minute batches with their own token; the dashboard reads the `dw` model.
 */

export const CAMERA_UNIT_KINDS = ['escritorio', 'loja'] as const;
export type CameraUnitKind = (typeof CAMERA_UNIT_KINDS)[number];
export const CAMERA_UNIT_KIND_LABELS: Record<CameraUnitKind, string> = {
  escritorio: 'Escritório',
  loja: 'Loja',
};

export const CAMERA_AREA_KINDS = [
  'porta',
  'recepcao',
  'sala_reuniao',
  'salao',
  'caixa',
  'outra',
] as const;
export type CameraAreaKind = (typeof CAMERA_AREA_KINDS)[number];
export const CAMERA_AREA_KIND_LABELS: Record<CameraAreaKind, string> = {
  porta: 'Porta',
  recepcao: 'Recepção',
  sala_reuniao: 'Sala de reunião',
  salao: 'Salão',
  caixa: 'Caixa',
  outra: 'Outra área',
};

export const CAMERA_DEVICE_KINDS = ['camera', 'caixa'] as const;
export type CameraDeviceKind = (typeof CAMERA_DEVICE_KINDS)[number];
export const CAMERA_DEVICE_KIND_LABELS: Record<CameraDeviceKind, string> = {
  camera: 'Câmera que conta sozinha',
  caixa: 'Caixa de análise (computador local)',
};

export const CAMERA_ALERT_KINDS = [
  'sala_ocupada_sem_reserva',
  'sala_reservada_vazia',
  'lotacao',
  'permanencia_longa',
  'dispositivo_offline',
] as const;
export type CameraAlertKind = (typeof CAMERA_ALERT_KINDS)[number];
export const CAMERA_ALERT_KIND_LABELS: Record<CameraAlertKind, string> = {
  sala_ocupada_sem_reserva: 'Sala ocupada sem reserva',
  sala_reservada_vazia: 'Sala reservada que ficou vazia',
  lotacao: 'Lotação acima da capacidade',
  permanencia_longa: 'Permanência longa',
  dispositivo_offline: 'Dispositivo fora do ar',
};

// --- registration (Admin Master only) -------------------------------------------------

const slug = z
  .string()
  .trim()
  .regex(/^[a-z0-9-]{1,40}$/, 'Use letras minúsculas, números e hífen');
const name = z.string().trim().min(2).max(80);

/** One device, in its unit and area; the unit may be an existing one by id. Strict: nothing else enters. */
export const cameraDeviceCreateSchema = z
  .object({
    unitId: z.uuid().optional(),
    unitName: name.optional(),
    unitKind: z.enum(CAMERA_UNIT_KINDS).optional(),
    city: z.string().trim().max(80).optional(),
    uf: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    areaCode: slug,
    areaName: name,
    areaKind: z.enum(CAMERA_AREA_KINDS),
    capacity: z.number().int().min(1).max(500).optional(),
    name,
    kind: z.enum(CAMERA_DEVICE_KINDS),
    manufacturer: z.string().trim().max(80).optional(),
    model: z.string().trim().max(80).optional(),
    /** A test device: its batches are kept apart (`fonte = teste`) and never reach the panel. */
    test: z.boolean().default(false),
  })
  .strict()
  .refine((value) => value.unitId !== undefined || (value.unitName && value.unitKind), {
    message: 'Informe a unidade: uma existente (unitId) ou o nome e o tipo de uma nova.',
    path: ['unitName'],
  });
export type CameraDeviceCreateInput = z.infer<typeof cameraDeviceCreateSchema>;

export interface CameraUnit {
  id: string;
  name: string;
  kind: CameraUnitKind;
}

export interface CameraDevice {
  id: string;
  name: string;
  kind: CameraDeviceKind;
  unit: CameraUnit;
  area: { code: string; name: string; kind: CameraAreaKind };
  test: boolean;
  active: boolean;
  createdAt: string;
  /** When the last batch arrived; null = never (not installed yet). */
  lastBatchAt: string | null;
}

/** The answer of the registration: the token is shown once and never stored or sent again. */
export interface CameraDeviceCreated {
  device: CameraDevice;
  token: string;
}

// --- the batch a device sends ----------------------------------------------------------

const count = z.number().int().min(0).max(100_000).nullable();

/** One 15-minute interval, as the device counted it; a null count = the device did not count it. */
export const cameraIntervalSchema = z
  .object({
    /** Start of the interval, ISO 8601 with offset, on a quarter hour (:00, :15, :30, :45). */
    startsAt: z.iso.datetime({ offset: true }),
    entries: count,
    exits: count,
    maxOccupancy: z.number().int().min(0).max(10_000).nullable(),
    dwellSeconds: z
      .number()
      .int()
      .min(0)
      .max(86_400 * 1000)
      .nullable(),
    dwellCount: count,
    alerts: z
      .array(
        z
          .object({
            kind: z.enum(CAMERA_ALERT_KINDS),
            startedAt: z.iso.datetime({ offset: true }),
            endedAt: z.iso.datetime({ offset: true }).nullable().default(null),
            people: z.number().int().min(0).max(10_000).nullable().default(null),
          })
          .strict(),
      )
      .max(50)
      .default([]),
  })
  .strict();

/** The whole batch: strict objects, so an image field (or any other field) is refused as a whole. */
export const cameraBatchSchema = z
  .object({ intervals: z.array(cameraIntervalSchema).min(1).max(200) })
  .strict();
export type CameraBatchInput = z.infer<typeof cameraBatchSchema>;

// --- the dashboard -----------------------------------------------------------------------

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const optional = <T extends z.ZodType>(schema: T) =>
  schema.optional().or(z.literal('').transform(() => undefined));

/** The panel's filters: a unit (all of them when absent) and the sales panel's periods, 30 days by default. */
export const camerasQuerySchema = z
  .object({
    unit: optional(z.uuid()),
    period: z.enum(SALES_PERIODS).default('30d'),
    from: optional(day),
    to: optional(day),
  })
  .refine(
    (value) =>
      value.period !== 'custom' ||
      (value.from !== undefined && value.to !== undefined && value.from <= value.to),
    { message: 'Informe o início e o fim do período.', path: ['from'] },
  );
export type CamerasQuery = z.infer<typeof camerasQuerySchema>;

export interface CamerasDashboard {
  unit: CameraUnit | null;
  units: CameraUnit[];
  range: SalesRange;
  /** Entries at the doors, summed per hour of the day (0–23); null = no door device counted. */
  byHour: { hour: number; entries: number | null }[];
  /** Entries at the doors per ISO weekday (1 = Monday … 7 = Sunday). */
  byWeekday: { weekday: number; entries: number | null }[];
  /** The three hours with the most entries, in order. */
  peaks: { hour: number; entries: number }[];
  rooms: {
    code: string;
    name: string;
    capacity: number | null;
    /** 15-minute slots the device reported, and how many had someone inside. */
    slotsObserved: number;
    slotsOccupied: number;
    maxOccupancy: number | null;
    avgDwellMinutes: number | null;
  }[];
  alerts: { kind: CameraAlertKind; count: number }[];
  /** Reserved rooms that stayed empty: null with the reason until the Agenda knows the rooms. */
  reservedEmpty: { count: number | null; reason: string | null };
  devices: {
    id: string;
    name: string;
    area: string;
    kind: CameraDeviceKind;
    lastBatchAt: string | null;
    /** Why this device gives no number yet. */
    reason: string | null;
  }[];
  /** Why the whole panel shows "—" (no device, no batch yet). */
  reason: string | null;
  canManage: boolean;
  loadedAt: string | null;
}
