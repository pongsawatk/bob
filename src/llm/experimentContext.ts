import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { callLLM, type LLMCallOptions, type LLMResult } from './openrouter.js';
import { ARMS, MODEL_CONFIG_VERSION, type ExperimentArm } from './modelConfig.js';
import type { SelectResult } from '../kb/select.js';
import { requestBudget } from '../http/budget.js';

export interface EvaluationSnapshot {
  schema: 1;
  category: 'HR' | 'IT';
  promptVersion: string;
  promptHash: string;
  kbHash: string;
  configVersion: string;
  createdAt: string;
  options: LLMCallOptions;
  selection: SelectResult;
  result: LLMResult;
  servedAnswer?: string;
}
export interface ModelExperimentContext { arm?: ExperimentArm; allowFallback?: boolean; snapshot?: EvaluationSnapshot }
const context = new AsyncLocalStorage<ModelExperimentContext>();
export const withModelExperiment = <T>(scope: ModelExperimentContext, fn: () => Promise<T>) => context.run(scope, fn);
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Captures exactly the assembled prompt, evidence and source clock. */
export async function callDomainLLM(category: 'HR' | 'IT', options: LLMCallOptions, promptVersion: string, selection: SelectResult): Promise<LLMResult> {
  const scope = context.getStore();
  const resolved = scope?.arm ? { ...options, ...ARMS[scope.arm], strictProvider: true, cacheSystem: scope.allowFallback ? options.cacheSystem : false } : options;
  if (scope?.arm && !scope.allowFallback) {
    if (Buffer.byteLength(JSON.stringify(resolved)) > 160000 || (resolved.maxTokens ?? 1000) > 4096) throw new Error('Evaluation exceeds cost bound');
    Object.assign(resolved, { retries: 0, maxPrice: { prompt: 4, completion: 10 } });
  }
  let result: LLMResult;
  try {
    result = await callLLM(scope?.allowFallback && scope.arm ? { ...resolved, retries: 0, timeoutMs: 20000 } : resolved);
  } catch (error) {
    if (!scope?.allowFallback || !scope.arm || (requestBudget()?.deadline ?? 0) - Date.now() < 8000) throw error;
    result = await callLLM({ ...options, retries: 0 });
    result = { ...result, fallbackFrom: resolved.model, costUsd: null };
  }
  result.promptHash = sha256(options.systemPrompt);
  result.kbHash = sha256(selection.bundle);
  if (scope) scope.snapshot = {
    schema: 1, category, options: resolved, promptVersion, selection, result,
    promptHash: sha256(options.systemPrompt), kbHash: sha256(selection.bundle),
    configVersion: MODEL_CONFIG_VERSION, createdAt: new Date().toISOString(),
  };
  return result;
}
