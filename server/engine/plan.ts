import type { Agent } from '../../shared/types.ts';
import { agents } from '../db.ts';

export interface PlanTask {
  key: string;
  title: string;
  description: string;
  assignee: string;
  depends_on: string[];
  acceptance: string;
}

export function findAgentByName(name: string): Agent | undefined {
  const n = name.trim().toLowerCase();
  const crew = agents.all().filter((a) => a.enabled);
  return crew.find((a) => a.name.toLowerCase() === n || a.id === name) ?? crew.find((a) => n.startsWith(a.name.toLowerCase()));
}

/** Returns a description of the first problem, or null if the plan is usable. */
export function validatePlan(plan: { tasks: PlanTask[] }, maxTasks: number): string | null {
  if (!plan.tasks.length) return 'The plan has no tasks.';
  if (plan.tasks.length > maxTasks) return `Too many tasks (${plan.tasks.length}); the limit is ${maxTasks}. Merge some.`;
  const keys = new Set<string>();
  for (const t of plan.tasks) {
    if (keys.has(t.key)) return `Duplicate task key "${t.key}".`;
    keys.add(t.key);
    if (!findAgentByName(t.assignee)) {
      return `Task "${t.key}": no crew member called "${t.assignee}". Available crew: ${agents
        .all()
        .filter((a) => a.enabled)
        .map((a) => a.name)
        .join(', ')}.`;
    }
  }
  for (const t of plan.tasks) {
    for (const d of t.depends_on) {
      if (!keys.has(d)) return `Task "${t.key}" depends on unknown key "${d}".`;
      if (d === t.key) return `Task "${t.key}" depends on itself.`;
    }
  }
  const state = new Map<string, number>();
  const depsOf = new Map(plan.tasks.map((t) => [t.key, t.depends_on]));
  const visit = (k: string): boolean => {
    if (state.get(k) === 1) return false;
    if (state.get(k) === 2) return true;
    state.set(k, 1);
    for (const d of depsOf.get(k) ?? []) if (!visit(d)) return false;
    state.set(k, 2);
    return true;
  };
  for (const k of keys) if (!visit(k)) return `The dependencies contain a cycle involving "${k}".`;
  return null;
}
