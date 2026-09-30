import type { RunLimits } from './types.ts';

export const DEFAULT_LIMITS: RunLimits = {
  budgetUsd: 3,
  maxTokens: 3_000_000,
  maxTasks: 6,
  maxStepsPerTask: 14,
  maxConsultsPerTask: 3,
  maxQuestionsPerTask: 2,
  maxReplans: 1,
  concurrency: 3,
  requirePlanApproval: true,
};
