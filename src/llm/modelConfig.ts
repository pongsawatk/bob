import { env } from '../env.js';

export type Effort = 'low' | 'medium' | 'high';
export type ModelRole = 'HR' | 'IT' | 'PRODUCT' | 'GENERAL' | 'ROUTER' | 'PEOPLE' | 'PEOPLE_INTENT';
export const MODEL_CONFIG_VERSION = '2026-10-08.1';
export const ARMS = {
  'sonnet5-medium': { model: 'anthropic/claude-sonnet-5', effort: 'medium' },
  'sonnet55-medium': { model: 'anthropic/claude-sonnet-5.5', effort: 'medium' },
  'gemini38-low': { model: 'google/gemini-3.8-flash', effort: 'low' },
  'haiku55-low': { model: 'anthropic/claude-haiku-5.5', effort: 'low' },
} as const;
export type ExperimentArm = keyof typeof ARMS;
export const isExperimentArm = (v: unknown): v is ExperimentArm => typeof v === 'string' && Object.hasOwn(ARMS, v);

export interface ModelSettings { model: string; effort?: Effort; maxTokens: number; temperature?: number }
export function modelSettings(role: ModelRole, arm?: ExperimentArm): ModelSettings {
  const defaults = { HR: 4096, IT: 4096, PRODUCT: 2500, GENERAL: 1000, ROUTER: 256, PEOPLE: 800, PEOPLE_INTENT: 1000 };
  const models: Record<ModelRole, string> = {
    HR: env.MODEL_HR, IT: env.MODEL_IT, PRODUCT: env.MODEL_PRODUCT, GENERAL: env.MODEL_GENERAL,
    ROUTER: env.MODEL_ROUTER, PEOPLE: env.MODEL_PEOPLE, PEOPLE_INTENT: env.MODEL_PEOPLE_INTENT,
  };
  const model = arm ? ARMS[arm].model : models[role];
  const explicit = process.env[`EFFORT_${role}`];
  const effort = arm ? ARMS[arm].effort : ['low', 'medium', 'high'].includes(explicit ?? '') ? explicit as Effort
    : /claude-(?:sonnet-5|haiku-5\.5)/.test(model) ? (role === 'PEOPLE' || role === 'PEOPLE_INTENT' || role === 'ROUTER' ? 'low' : 'medium') : undefined;
  return { model, effort, maxTokens: defaults[role], temperature: role === 'ROUTER' || role === 'PEOPLE_INTENT' ? 0 : 0.3 };
}

/** These families reject custom sampling or use thinking-level controls instead. */
export function acceptsTemperature(model: string): boolean {
  return !/^(?:anthropic\/claude-(?:sonnet-5|haiku-5\.5)|google\/gemini-3\.8)/.test(model);
}
