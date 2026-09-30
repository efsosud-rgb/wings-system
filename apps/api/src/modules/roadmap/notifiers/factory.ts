import type { Env } from '../../../env.js';
import { ZapiClient } from '../../../lib/zapi.js';

/**
 * The one channel the roadmap report sends over. Same shape as
 * `modules/ads/notifiers/factory.ts`, reusing the same Z-API env vars — this
 * module has no approvals or alerts of its own, only two daily WhatsApp
 * texts, so it needs no database-backed fallback notifier, just a logging one.
 */
export interface RoadmapNotifier {
  sendText(phone: string, message: string): Promise<void>;
}

class LoggingRoadmapNotifier implements RoadmapNotifier {
  constructor(private readonly log: (message: string) => void) {}
  async sendText(phone: string, message: string): Promise<void> {
    this.log(
      `[roadmap] Z-API not configured; would send ${message.length} chars to ${phone.slice(0, 4)}***`,
    );
  }
}

class ZapiRoadmapNotifier implements RoadmapNotifier {
  constructor(private readonly client: ZapiClient) {}
  async sendText(phone: string, message: string): Promise<void> {
    await this.client.sendText(phone, message);
  }
}

export function createRoadmapNotifier(
  env: Env,
  log: (message: string) => void = console.warn,
): RoadmapNotifier {
  if (!env.ZAPI_INSTANCE_ID || !env.ZAPI_INSTANCE_TOKEN || !env.ZAPI_CLIENT_TOKEN) {
    log('[roadmap] Z-API not configured; report sends will only be logged');
    return new LoggingRoadmapNotifier(log);
  }
  return new ZapiRoadmapNotifier(
    new ZapiClient({
      instanceId: env.ZAPI_INSTANCE_ID,
      instanceToken: env.ZAPI_INSTANCE_TOKEN,
      clientToken: env.ZAPI_CLIENT_TOKEN,
    }),
  );
}
