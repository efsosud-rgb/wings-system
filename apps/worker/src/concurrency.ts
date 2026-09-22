import { cpus } from 'node:os';
import type { Env } from './env.js';

/**
 * How many jobs run at once, from the two env limits: never more cores than
 * `WORKER_CPU_LIMIT` (default half the host's, at least 1), and never more
 * than `WORKER_MEMORY_LIMIT_MB` divided into `WORKER_MEMORY_PER_JOB_MB`
 * shares. The smaller of the two wins.
 */
export function concurrencyOf(env: Env): number {
  const cpuLimit = env.WORKER_CPU_LIMIT ?? Math.max(1, Math.floor(cpus().length / 2));
  const memoryLimit = Math.max(1, Math.floor(env.WORKER_MEMORY_LIMIT_MB / env.WORKER_MEMORY_PER_JOB_MB));
  return Math.max(1, Math.min(cpuLimit, memoryLimit));
}

/** Threads handed to ffmpeg/ffprobe/whisper for one job, so N concurrent jobs
 * together stay inside `WORKER_CPU_LIMIT`. */
export function threadsPerJob(env: Env, concurrency: number): number {
  const cpuLimit = env.WORKER_CPU_LIMIT ?? Math.max(1, Math.floor(cpus().length / 2));
  return Math.max(1, Math.floor(cpuLimit / concurrency));
}
