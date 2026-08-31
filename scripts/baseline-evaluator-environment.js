import { RESOURCE_LOCK_ENV } from './resource-lock.js';

const RESOURCE_LOCK_ENVIRONMENT_NAMES = Object.freeze(Object.values(RESOURCE_LOCK_ENV));
const SENSITIVE_BASELINE_ENVIRONMENT_NAMES = Object.freeze([
  /^MCBOT_/i,
  /^(?:DEEPSEEK|OPENAI|ANTHROPIC|GEMINI|COHERE|GROQ|MISTRAL|OLLAMA|OPENROUTER|PERPLEXITY|TOGETHER|RCON)_/i,
  /^(?:AZURE_OPENAI|AWS_BEDROCK|GOOGLE_GENERATIVE_AI|VERTEX_AI)_/i,
  /(?:^|_)(?:API(?:_KEY|_TOKEN|_URL|_BASE|_BASE_URL|_ENDPOINT)?|RCON(?:_HOST|_PORT|_PASSWORD)?|PROVIDER(?:_URL|_ENDPOINT)?|ACCESS_TOKEN|AUTH_TOKEN|TOKEN|PASSWORD|SECRET|PRIVATE_KEY|CLIENT_SECRET|CONNECTION_STRING)$/i,
  /^(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AZURE_CLIENT_SECRET|GOOGLE_APPLICATION_CREDENTIALS)$/i,
]);

export function sanitizeBaselineEvaluatorEnvironment(sourceEnvironment) {
  if (!sourceEnvironment || typeof sourceEnvironment !== 'object') {
    throw new TypeError('baseline evaluator source environment must be an object');
  }

  // The parent acquired and authenticated this exact join state before it
  // launched the evaluator. Snapshot it before the broad MCBOT scrub so every
  // nested Node process joins that lease instead of trying to acquire another.
  const inheritedResourceLock = RESOURCE_LOCK_ENVIRONMENT_NAMES.map((name) => [
    name,
    sourceEnvironment[name],
  ]);
  const suppliedLockEntries = inheritedResourceLock.filter(([, value]) => value !== undefined);
  if (suppliedLockEntries.length !== 0 && (
    suppliedLockEntries.length !== RESOURCE_LOCK_ENVIRONMENT_NAMES.length
    || suppliedLockEntries.some(([, value]) => typeof value !== 'string' || value.trim() === '')
  )) {
    throw new Error('inherited MCBot resource-lock environment is incomplete');
  }

  const environment = { ...sourceEnvironment };
  for (const name of Object.keys(environment)) {
    if (SENSITIVE_BASELINE_ENVIRONMENT_NAMES.some((pattern) => pattern.test(name))) {
      delete environment[name];
    }
  }
  for (const [name, value] of suppliedLockEntries) environment[name] = value;
  return environment;
}
