export type RoomId =
  | 'bridge'
  | 'radio'
  | 'chart'
  | 'sonar'
  | 'cabin'
  | 'lab'
  | 'engine'
  | 'archive'
  | 'galley'
  | 'workshop';

export type SpriteId =
  | 'navigator'
  | 'sonar'
  | 'writer'
  | 'engineer'
  | 'inspector'
  | 'deckhand'
  | 'quartermaster';

export type Effort = 'low' | 'medium' | 'high';

export interface Agent {
  id: string;
  name: string;
  /** Short job title shown in the world, e.g. "Researcher". */
  title: string;
  /** What this agent is responsible for. Used for planning and in every prompt. */
  role: string;
  /** Free-form behaviour instructions appended to the system prompt. */
  persona: string;
  sprite: SpriteId;
  station: RoomId;
  color: string;
  /** null means the agent has no model assigned and cannot work until one is chosen. */
  providerId: string | null;
  model: string;
  effort: Effort;
  maxSteps: number;
  tools: string[];
  /** Tools this agent may run without asking. Only read-only external tools are eligible. */
  autoApprove: string[];
  isLead: boolean;
  enabled: boolean;
  /** $/million tokens overrides; null = use the built-in price table. */
  priceIn: number | null;
  priceOut: number | null;
  sort: number;
}

export type ProviderKind = 'anthropic' | 'openai' | 'openai_compat' | 'demo';

export interface ProviderPublic {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string | null;
  /** Where the key came from. Keys themselves never leave the server. */
  keySource: 'env' | 'stored' | 'none';
  keyHint: string | null;
  envVar: string | null;
  defaultModel: string;
  createdAt: number;
}

export type RunStatus =
  | 'planning'
  | 'review'
  | 'running'
  | 'paused'
  | 'synthesizing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface RunLimits {
  budgetUsd: number;
  maxTokens: number;
  maxTasks: number;
  maxStepsPerTask: number;
  maxConsultsPerTask: number;
  maxQuestionsPerTask: number;
  maxReplans: number;
  concurrency: number;
  requirePlanApproval: boolean;
}

export interface Run {
  id: string;
  goal: string;
  status: RunStatus;
  limits: RunLimits;
  spentUsd: number;
  tokensIn: number;
  tokensOut: number;
  /** True if any model call in this run was served by the demo (simulated) provider. */
  demo: boolean;
  planRationale: string | null;
  summary: string | null;
  finalArtifactId: string | null;
  pauseReason: string | null;
  /** The status to return to when a paused run resumes. */
  pausedFrom: RunStatus | null;
  error: string | null;
  replans: number;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'waiting_user'
  | 'waiting_approval'
  | 'done'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export interface Task {
  id: string;
  runId: string;
  key: string;
  title: string;
  description: string;
  acceptance: string;
  assigneeId: string;
  dependsOn: string[];
  status: TaskStatus;
  resultSummary: string | null;
  notesForTeam: string | null;
  artifactIds: string[];
  steps: number;
  consults: number;
  questions: number;
  attempts: number;
  error: string | null;
  spentUsd: number;
  order: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export type ArtifactKind = 'markdown' | 'code' | 'json' | 'csv' | 'html' | 'text';

export interface Artifact {
  id: string;
  runId: string | null;
  taskId: string | null;
  agentId: string | null;
  name: string;
  kind: ArtifactKind;
  language: string | null;
  description: string;
  version: number;
  size: number;
  /** Path relative to the workspace folder, so it can be opened outside the app. */
  path: string;
  demo: boolean;
  isFinal: boolean;
  createdAt: number;
}

export interface Memory {
  id: string;
  scope: 'shared' | 'agent';
  agentId: string | null;
  runId: string | null;
  content: string;
  tags: string;
  source: string;
  pinned: boolean;
  demo: boolean;
  createdAt: number;
}

export type RequestKind = 'question' | 'approval' | 'plan' | 'budget' | 'blocked';

export interface DecisionRequest {
  id: string;
  runId: string | null;
  taskId: string | null;
  agentId: string | null;
  kind: RequestKind;
  title: string;
  body: string;
  options: string[];
  /** For approvals: the exact tool call that will run if approved. */
  tool: string | null;
  args: Record<string, unknown> | null;
  risk: string | null;
  status: 'open' | 'resolved' | 'expired';
  response: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export type EventLevel = 'debug' | 'info' | 'important' | 'warn' | 'error';

export interface LogEvent {
  id: number;
  runId: string | null;
  taskId: string | null;
  agentId: string | null;
  type: string;
  level: EventLevel;
  summary: string;
  data: Record<string, unknown> | null;
  ts: number;
}

export interface ChatMessage {
  id: string;
  agentId: string;
  role: 'user' | 'agent' | 'system';
  mode: 'ask' | 'redirect';
  content: string;
  runId: string | null;
  demo: boolean;
  error: boolean;
  ts: number;
}

export type Activity =
  | 'idle'
  | 'planning'
  | 'working'
  | 'waiting_dep'
  | 'waiting_user'
  | 'waiting_approval'
  | 'consulting'
  | 'consulted'
  | 'chatting'
  | 'filing'
  | 'blocked'
  | 'failed'
  | 'paused'
  | 'off_duty';

/** Live, in-memory state of an agent, derived from the engine. Drives the world. */
export interface AgentLive {
  agentId: string;
  activity: Activity;
  runId: string | null;
  taskId: string | null;
  detail: string | null;
  withAgentId: string | null;
  blockedBy: string[];
  step: number;
  maxSteps: number;
  requestId: string | null;
  since: number;
}

export interface Snapshot {
  agents: Agent[];
  live: AgentLive[];
  providers: ProviderPublic[];
  run: Run | null;
  runs: Run[];
  tasks: Task[];
  artifacts: Artifact[];
  requests: DecisionRequest[];
  events: LogEvent[];
  memories: Memory[];
  charter: string;
  defaults: RunLimits;
  toolCatalog: ToolInfo[];
}

export interface ToolInfo {
  name: string;
  label: string;
  description: string;
  /** internal: touches only this app's state. external: reaches outside the machine. */
  reach: 'internal' | 'external' | 'human';
  /** Consequential tools always need approval and can't be auto-approved. */
  consequential: boolean;
}

export type ServerMessage =
  | { kind: 'upsert'; entity: 'agent'; data: Agent }
  | { kind: 'upsert'; entity: 'live'; data: AgentLive }
  | { kind: 'upsert'; entity: 'run'; data: Run }
  | { kind: 'upsert'; entity: 'task'; data: Task }
  | { kind: 'upsert'; entity: 'artifact'; data: Artifact }
  | { kind: 'upsert'; entity: 'request'; data: DecisionRequest }
  | { kind: 'upsert'; entity: 'memory'; data: Memory }
  | { kind: 'upsert'; entity: 'chat'; data: ChatMessage }
  | { kind: 'upsert'; entity: 'provider'; data: ProviderPublic }
  | { kind: 'remove'; entity: 'agent' | 'task' | 'memory' | 'provider'; id: string }
  | { kind: 'event'; data: LogEvent }
  | { kind: 'stream'; agentId: string; taskId: string | null; channel: 'text' | 'thinking'; delta: string; reset?: boolean }
  | { kind: 'charter'; data: string }
  | { kind: 'hello'; serverStart: number };
