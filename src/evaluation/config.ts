import { getRedis } from '../store/redis.js';
import { isExperimentArm, type ExperimentArm } from '../llm/modelConfig.js';
import { sha256 } from '../llm/experimentContext.js';

export interface EvaluationConfig {
  mode: 'off' | 'shadow' | 'pilot';
  arm: ExperimentArm;
  pilotUsers: string[];
  dailyMaxCalls: number;
  totalMaxCalls: number;
  dailyMaxUsd: number;
  totalMaxUsd: number;
  sampleRate: number;
  jevEnabled: boolean;
}
export const DEFAULT_EVALUATION_CONFIG: EvaluationConfig = {
  mode: 'off', arm: 'sonnet55-medium', pilotUsers: [], dailyMaxCalls: 12,
  totalMaxCalls: 100, dailyMaxUsd: 2, totalMaxUsd: 10, sampleRate: 1, jevEnabled: false,
};
export function validateConfig(value: unknown): value is EvaluationConfig {
  if (!value || typeof value !== 'object') return false;
  const v = value as EvaluationConfig;
  return ['off', 'shadow', 'pilot'].includes(v.mode) && isExperimentArm(v.arm) &&
    Array.isArray(v.pilotUsers) && v.pilotUsers.length <= 30 && v.pilotUsers.every(u => typeof u === 'string' && u.length > 0 && u.length <= 200) &&
    Number.isInteger(v.dailyMaxCalls) && v.dailyMaxCalls >= 0 && v.dailyMaxCalls <= 50 &&
    Number.isInteger(v.totalMaxCalls) && v.totalMaxCalls >= 0 && v.totalMaxCalls <= 500 &&
    Number.isFinite(v.dailyMaxUsd) && v.dailyMaxUsd >= 0 && v.dailyMaxUsd <= 10 &&
    Number.isFinite(v.totalMaxUsd) && v.totalMaxUsd >= 0 && v.totalMaxUsd <= 50 &&
    Number.isFinite(v.sampleRate) && v.sampleRate >= 0 && v.sampleRate <= 1 && typeof v.jevEnabled === 'boolean';
}
export async function getEvaluationConfig(): Promise<EvaluationConfig> {
  const v = await getRedis()?.get<EvaluationConfig>('bob:eval:v1:config');
  return validateConfig(v) ? v : { ...DEFAULT_EVALUATION_CONFIG };
}
export async function setEvaluationConfig(v: EvaluationConfig): Promise<void> {
  if (!validateConfig(v)) throw new Error('Invalid evaluation configuration');
  const redis = getRedis();
  if (!redis) throw new Error('Evaluation requires Redis');
  await redis.set('bob:eval:v1:config', { ...v, pilotUsers: v.pilotUsers.map(u => u.trim().toLowerCase()) });
}
export function pilotArm(config: EvaluationConfig, userId: string): ExperimentArm | undefined {
  return config.mode === 'pilot' && config.pilotUsers.includes(userId.trim().toLowerCase()) ? config.arm : undefined;
}
export function sampled(config: EvaluationConfig, traceId: string): boolean {
  return config.mode !== 'off' && parseInt(sha256(traceId).slice(0, 8), 16) / 0x100000000 < config.sampleRate;
}
