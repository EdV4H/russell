export { createAgent, FROZEN_NOTICE } from "./create-agent.js";
export type { AgentConfig, AgentHandle } from "./create-agent.js";
export {
  DO_NOT_WRITE_PROMPT,
  UNDETECTABLE_CATEGORIES,
  inspectSensitive,
} from "./sensitive-guard.js";
export type {
  GuardResult,
  SensitiveCategory,
  SensitiveFinding,
  SensitiveGuardConfig,
} from "./sensitive-guard.js";
