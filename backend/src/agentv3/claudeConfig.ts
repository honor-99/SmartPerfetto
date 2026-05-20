// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';
import type { SceneType } from './sceneClassifier';
import { getRegisteredScenes } from './strategyLoader';
import { DEFAULT_OUTPUT_LANGUAGE, localize, outputLanguageDisplayName, parseOutputLanguage, type OutputLanguage } from './outputLanguage';
import { mergeIsolatedProviderEnv } from '../services/providerManager/envIsolation';
import type { ProviderScope } from '../services/providerManager';
import { collectEnvCredentialSources, hasConcreteEnvValue, isEnabledEnvFlag, redactUrlForDiagnostics } from '../agentRuntime/envCredentialSources';

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

export interface ClaudeAgentConfig {
  model: string;
  /** Lightweight model for auxiliary single-turn calls (verifier, classifier, summarizer).
   *  When using a third-party proxy that maps only one model, set CLAUDE_LIGHT_MODEL
   *  to the same value as CLAUDE_MODEL so all SDK calls route to the same endpoint. */
  lightModel: string;
  maxTurns: number;
  maxBudgetUsd?: number;
  cwd: string;
  effort: EffortLevel;
  /** Enable sub-agent delegation (frame-expert, system-expert, startup-expert). Default: false */
  enableSubAgents: boolean;
  /** Enable conclusion verification (heuristic + LLM). Default: false */
  enableVerification: boolean;
  /** Per sub-agent timeout in ms. Sub-agents exceeding this are stopped via stopTask(). Default: 120000 (2min) */
  subAgentTimeoutMs: number;
  /** Sub-agent model shorthand. Defaults to 'sonnet'.
   *  Accepted values: 'haiku' | 'sonnet' | 'opus' | 'inherit' (inherit orchestrator model). */
  subAgentModel?: 'inherit' | 'haiku' | 'sonnet' | 'opus';
  /** Per-turn timeout (ms) for the full analysis pipeline. Default: 60_000 (60s/turn).
   *  Raise via CLAUDE_FULL_PER_TURN_MS for slower LLMs (DeepSeek / Ollama / GLM). */
  fullPathPerTurnMs: number;
  /** Per-turn timeout (ms) for the quick analysis pipeline. Default: 40_000 (40s/turn).
   *  Override via CLAUDE_QUICK_PER_TURN_MS. */
  quickPathPerTurnMs: number;
  /** Timeout (ms) for the single-turn verifier LLM call. Default: 60_000.
   *  Override via CLAUDE_VERIFIER_TIMEOUT_MS (raise when CLAUDE_LIGHT_MODEL is not Haiku). */
  verifierTimeoutMs: number;
  /** Timeout (ms) for the single-turn query complexity classifier. Default: 30_000.
   *  Override via CLAUDE_CLASSIFIER_TIMEOUT_MS. */
  classifierTimeoutMs: number;
  /** User-facing output language. Default: zh-CN. Override via SMARTPERFETTO_OUTPUT_LANGUAGE=en. */
  outputLanguage: OutputLanguage;
}

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_LIGHT_MODEL = 'claude-haiku-4-5';
// Scrolling pipeline: 1 time-range + 1 scrolling_analysis + 2-3 deep-drill (blocking_chain/binder_root_cause)
// + 1-2 jank_frame_detail + hypothesis submit/resolve + conclusion = ~20-25 turns.
// Default keeps extra headroom for slower third-party models and larger traces.
const DEFAULT_MAX_TURNS = 60;
const DEFAULT_QUICK_MAX_TURNS = 10;
const DEFAULT_EFFORT: EffortLevel = 'high';

function parsePositiveIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadClaudeConfig(overrides?: Partial<ClaudeAgentConfig>): ClaudeAgentConfig {
  return {
    model: overrides?.model ?? process.env.CLAUDE_MODEL ?? DEFAULT_MODEL,
    lightModel: process.env.CLAUDE_LIGHT_MODEL ?? DEFAULT_LIGHT_MODEL,
    maxTurns: overrides?.maxTurns
      ?? (process.env.CLAUDE_MAX_TURNS ? parseInt(process.env.CLAUDE_MAX_TURNS, 10) : DEFAULT_MAX_TURNS),
    maxBudgetUsd: overrides?.maxBudgetUsd
      ?? (process.env.CLAUDE_MAX_BUDGET_USD ? parseFloat(process.env.CLAUDE_MAX_BUDGET_USD) : undefined),
    cwd: overrides?.cwd ?? process.env.CLAUDE_CWD ?? process.cwd(),
    effort: (overrides?.effort ?? process.env.CLAUDE_EFFORT ?? DEFAULT_EFFORT) as EffortLevel,
    enableSubAgents: overrides?.enableSubAgents ?? process.env.CLAUDE_ENABLE_SUB_AGENTS === 'true',
    enableVerification: overrides?.enableVerification ?? (process.env.CLAUDE_ENABLE_VERIFICATION !== 'false'),
    subAgentTimeoutMs: overrides?.subAgentTimeoutMs
      ?? (process.env.CLAUDE_SUB_AGENT_TIMEOUT_MS ? parseInt(process.env.CLAUDE_SUB_AGENT_TIMEOUT_MS, 10) : 120_000),
    subAgentModel: (process.env.CLAUDE_SUB_AGENT_MODEL as ClaudeAgentConfig['subAgentModel']) || undefined,
    fullPathPerTurnMs: overrides?.fullPathPerTurnMs
      ?? (process.env.CLAUDE_FULL_PER_TURN_MS ? parseInt(process.env.CLAUDE_FULL_PER_TURN_MS, 10) : 60_000),
    quickPathPerTurnMs: overrides?.quickPathPerTurnMs
      ?? (process.env.CLAUDE_QUICK_PER_TURN_MS ? parseInt(process.env.CLAUDE_QUICK_PER_TURN_MS, 10) : 40_000),
    verifierTimeoutMs: overrides?.verifierTimeoutMs
      ?? (process.env.CLAUDE_VERIFIER_TIMEOUT_MS ? parseInt(process.env.CLAUDE_VERIFIER_TIMEOUT_MS, 10) : 60_000),
    classifierTimeoutMs: overrides?.classifierTimeoutMs
      ?? (process.env.CLAUDE_CLASSIFIER_TIMEOUT_MS ? parseInt(process.env.CLAUDE_CLASSIFIER_TIMEOUT_MS, 10) : 30_000),
    outputLanguage: overrides?.outputLanguage
      ?? parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE),
  };
}

/**
 * Resolve effort level by scene type.
 * Deterministic pipelines (scrolling/startup/anr) use 'medium' since the workflow is prescriptive.
 * Open-ended queries ('general') use the configured default (typically 'high').
 */
export function resolveEffort(config: ClaudeAgentConfig, sceneType?: SceneType): EffortLevel {
  // Env override always wins (read directly, not via config which may have overrides)
  if (process.env.CLAUDE_EFFORT) return process.env.CLAUDE_EFFORT as EffortLevel;
  if (!sceneType) return config.effort;

  const scenes = getRegisteredScenes();
  const scene = scenes.find(s => s.scene === sceneType);
  if (scene?.effort) return scene.effort as EffortLevel;
  return config.effort;
}

export interface BedrockStatus {
  enabled: boolean;
  hasAuth: boolean;
  authMethod?: 'bearer_token' | 'iam_credentials' | 'profile_or_chain';
  region: string;
  baseUrl?: string;
  missing?: string[];
}

export interface VertexStatus {
  enabled: boolean;
  configured: boolean;
  projectId?: string;
  region?: string;
  missing?: string[];
}

/**
 * Detects whether AWS Bedrock is configured and whether its authentication
 * credentials are complete. Supports three auth paths:
 *   1. Bearer token: AWS_BEARER_TOKEN_BEDROCK
 *   2. IAM credentials: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ optional AWS_SESSION_TOKEN)
 *   3. AWS profile / default credential chain: AWS_PROFILE or implicit chain resolution
 */
export function detectBedrock(env: Record<string, string | undefined> = process.env): BedrockStatus {
  const enabled = isEnabledEnvFlag(env.CLAUDE_CODE_USE_BEDROCK);
  if (!enabled) return { enabled: false, hasAuth: false, region: 'us-east-1' };

  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1';
  const baseUrl = env.ANTHROPIC_BEDROCK_BASE_URL || undefined;

  if (hasConcreteEnvValue(env.AWS_BEARER_TOKEN_BEDROCK)) {
    return { enabled: true, hasAuth: true, authMethod: 'bearer_token', region, baseUrl };
  }

  if (hasConcreteEnvValue(env.AWS_ACCESS_KEY_ID) && hasConcreteEnvValue(env.AWS_SECRET_ACCESS_KEY)) {
    return { enabled: true, hasAuth: true, authMethod: 'iam_credentials', region, baseUrl };
  }

  if (hasConcreteEnvValue(env.AWS_PROFILE)) {
    return { enabled: true, hasAuth: true, authMethod: 'profile_or_chain', region, baseUrl };
  }

  // CLAUDE_CODE_USE_BEDROCK is set but no explicit credentials found.
  // The SDK will still attempt the default AWS credential chain (EC2 metadata,
  // ECS task role, ~/.aws/credentials, etc.), so we treat this as potentially valid.
  const missing: string[] = [];
  if (!hasConcreteEnvValue(env.AWS_BEARER_TOKEN_BEDROCK)) missing.push('AWS_BEARER_TOKEN_BEDROCK');
  if (!hasConcreteEnvValue(env.AWS_ACCESS_KEY_ID)) missing.push('AWS_ACCESS_KEY_ID');
  if (!hasConcreteEnvValue(env.AWS_PROFILE)) missing.push('AWS_PROFILE');

  return {
    enabled: true,
    hasAuth: true,
    authMethod: 'profile_or_chain',
    region,
    baseUrl,
    missing,
  };
}

export function detectVertex(env: Record<string, string | undefined> = process.env): VertexStatus {
  const enabled = isEnabledEnvFlag(env.CLAUDE_CODE_USE_VERTEX);
  if (!enabled) return { enabled: false, configured: false };
  const projectId = hasConcreteEnvValue(env.ANTHROPIC_VERTEX_PROJECT_ID)
    ? env.ANTHROPIC_VERTEX_PROJECT_ID
    : undefined;
  const region = hasConcreteEnvValue(env.CLOUD_ML_REGION)
    ? env.CLOUD_ML_REGION
    : 'us-central1';
  return {
    enabled: true,
    configured: Boolean(projectId),
    projectId,
    region,
    missing: projectId ? undefined : ['ANTHROPIC_VERTEX_PROJECT_ID'],
  };
}

/**
 * Returns true when any supported Claude credential source is present:
 * direct API key, proxy base URL, or AWS Bedrock.
 */
export function hasClaudeCredentials(env: Record<string, string | undefined> = process.env): boolean {
  return !!(
    hasConcreteEnvValue(env.ANTHROPIC_API_KEY) ||
    hasConcreteEnvValue(env.ANTHROPIC_AUTH_TOKEN) ||
    hasConcreteEnvValue(env.ANTHROPIC_BASE_URL) ||
    detectBedrock(env).enabled ||
    detectVertex(env).configured
  );
}

export function getClaudeRuntimeDiagnostics(
  providerId?: string | null,
  providerScope?: ProviderScope,
) {
  const env = createSdkEnv(providerId, providerScope);
  const bedrock = detectBedrock(env);
  const vertex = detectVertex(env);
  const credentialSources: string[] = [];
  if (hasConcreteEnvValue(env.ANTHROPIC_API_KEY)) credentialSources.push('anthropic_api_key');
  if (hasConcreteEnvValue(env.ANTHROPIC_AUTH_TOKEN)) credentialSources.push('anthropic_auth_token');
  if (hasConcreteEnvValue(env.ANTHROPIC_BASE_URL)) credentialSources.push('anthropic_compatible_proxy');
  if (bedrock.enabled) credentialSources.push(`bedrock:${bedrock.authMethod}`);
  if (vertex.enabled) credentialSources.push('google_vertex');

  const providerMode = hasConcreteEnvValue(env.ANTHROPIC_BASE_URL)
    ? 'anthropic_compatible_proxy'
    : bedrock.enabled
      ? 'aws_bedrock'
      : vertex.enabled
        ? 'google_vertex'
        : (hasConcreteEnvValue(env.ANTHROPIC_API_KEY) || hasConcreteEnvValue(env.ANTHROPIC_AUTH_TOKEN))
          ? 'anthropic_direct'
          : 'unconfigured';

  return {
    runtime: 'claude-agent-sdk',
    providerMode,
    model: env.CLAUDE_MODEL || DEFAULT_MODEL,
    lightModel: env.CLAUDE_LIGHT_MODEL || DEFAULT_LIGHT_MODEL,
    baseUrl: redactUrlForDiagnostics(env.ANTHROPIC_BASE_URL),
    outputLanguage: {
      value: parseOutputLanguage(env.SMARTPERFETTO_OUTPUT_LANGUAGE),
      displayName: outputLanguageDisplayName(parseOutputLanguage(env.SMARTPERFETTO_OUTPUT_LANGUAGE)),
      env: 'SMARTPERFETTO_OUTPUT_LANGUAGE',
      default: DEFAULT_OUTPUT_LANGUAGE,
    },
    configured: hasClaudeCredentials(env),
    credentialSources,
    baseUrlConfigured: hasConcreteEnvValue(env.ANTHROPIC_BASE_URL),
    bedrock: {
      enabled: bedrock.enabled,
      authMethod: bedrock.authMethod,
      region: bedrock.region,
      baseUrlConfigured: !!bedrock.baseUrl,
    },
    vertex,
    configHint: hasConcreteEnvValue(env.ANTHROPIC_BASE_URL)
      ? 'Using Anthropic-compatible proxy. Ensure the mapped model supports streaming and tool/function calling.'
      : 'Set ANTHROPIC_API_KEY for Anthropic direct access, or ANTHROPIC_BASE_URL plus ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN for a third-party Anthropic-compatible provider.',
    sdkBinary: getClaudeSdkBinaryDiagnostics(env),
  };
}

/** Match before quotaOrAuth — binary-missing can surface as process-exit-1. */
function isNativeBinaryMissing(messageLower: string): boolean {
  if (messageLower.includes('claude code native binary not found')) return true;
  return messageLower.includes('claude-agent-sdk-') && messageLower.includes('/claude');
}

const NATIVE_BINARY_HINT_EXAMPLE = '/app/backend/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude';
const NATIVE_BINARY_HINT_INSPECT = 'docker exec -it <container> ls /app/backend/node_modules/@anthropic-ai/';

const NATIVE_BINARY_HINT_TEXT: Record<OutputLanguage, {
  intro: string;
  cause: string;
  fix: string;
  inspectLabel: string;
}> = {
  'zh-CN': {
    intro: '该错误与 AI provider（DeepSeek / Kimi / Anthropic 等）配置无关，是 Claude Agent SDK 的原生二进制平台探测失败。',
    cause: '常见原因：容器/Node 版本下 glibc 探测异常导致 SDK 误选 musl 变体；或 npm install 跳过了 optional dependencies。',
    fix: '解决：在 .env 中设置 CLAUDE_BINARY_PATH 指向实际安装的二进制，例如：',
    inspectLabel: '排查命令（Docker）：',
  },
  en: {
    intro: 'This is unrelated to your AI provider (DeepSeek / Kimi / Anthropic / etc.) configuration. The Claude Agent SDK\'s native-binary platform detection failed.',
    cause: 'Common causes: glibc detection misfires inside the container so the SDK selects the musl variant; or npm install skipped optional dependencies.',
    fix: 'Fix: set CLAUDE_BINARY_PATH in .env to the actually-installed binary, e.g.:',
    inspectLabel: 'Inspect inside Docker:',
  },
};

function nativeBinaryHint(message: string, lang: OutputLanguage): string {
  const t = NATIVE_BINARY_HINT_TEXT[lang];
  return `${message}\n\n${t.intro}\n${t.cause}\n${t.fix}\n  CLAUDE_BINARY_PATH=${NATIVE_BINARY_HINT_EXAMPLE}\n${t.inspectLabel} ${NATIVE_BINARY_HINT_INSPECT}`;
}

export function isClaudeQuotaError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("you've hit your limit") ||
    lower.includes('hit your limit') ||
    lower.includes('rate limit') ||
    lower.includes('quota') ||
    lower.includes('extra usage') ||
    lower.includes('overage') ||
    lower.includes('too many requests') ||
    /\b429\b/.test(lower);
}

export interface CredentialSourceHint {
  source: 'provider-manager' | 'env-or-default';
  providerName?: string;
  providerType?: string;
  providerRuntime?: string;
  envCredentialSources: string[];
  providerOverridesEnv: boolean;
}

export function getCredentialSourceHint(
  providerId?: string | null,
  providerScope?: ProviderScope,
): CredentialSourceHint {
  const envCredentialSources = collectEnvCredentialSources(process.env, 'env');
  const { getProviderService } = require('../services/providerManager');
  const svc = getProviderService();
  const provider = typeof providerId === 'string'
    ? svc.getRawProvider(providerId, providerScope)
    : providerId === null
      ? undefined
      : svc.getRawEffectiveProvider(providerScope);

  if (provider) {
    return {
      source: 'provider-manager',
      providerName: provider.name,
      providerType: provider.type,
      providerRuntime: svc.resolveAgentRuntime(provider),
      envCredentialSources,
      providerOverridesEnv: envCredentialSources.length > 0,
    };
  }

  return {
    source: 'env-or-default',
    envCredentialSources,
    providerOverridesEnv: false,
  };
}

function credentialSourceHintText(hint: CredentialSourceHint | undefined, lang: OutputLanguage): string {
  if (!hint) return '';
  if (hint.source === 'provider-manager') {
    const providerLabel = `${hint.providerName || 'unnamed'}${hint.providerType ? ` (${hint.providerType})` : ''}`;
    const overrideText = hint.providerOverridesEnv
      ? localize(
        lang,
        '检测到 env 凭证，但当前 active Provider Manager profile 优先级更高；如果想用 .env，请在 AI Assistant 设置里停用 active provider。',
        'Env credentials are also present, but the active Provider Manager profile has priority. To use .env, deactivate the active provider in AI Assistant settings.',
      )
      : '';
    return '\n\n' + localize(
      lang,
      `当前凭证来源: Provider Manager active provider "${providerLabel}"${hint.providerRuntime ? `, runtime=${hint.providerRuntime}` : ''}。${overrideText}`,
      `Current credential source: Provider Manager active provider "${providerLabel}"${hint.providerRuntime ? `, runtime=${hint.providerRuntime}` : ''}. ${overrideText}`,
    );
  }

  const envText = hint.envCredentialSources.length > 0
    ? hint.envCredentialSources.join(', ')
    : localize(lang, '未检测到显式 env 凭证', 'no explicit env credentials detected');
  return '\n\n' + localize(
    lang,
    `当前凭证来源: .env 或环境变量 fallback (${envText})。Docker Hub compose 读取仓库根目录 .env；本地源码运行才默认使用 backend/.env。`,
    `Current credential source: .env or environment fallback (${envText}). Docker Hub compose reads the repository-root .env; local source runs use backend/.env by default.`,
  );
}

export function explainClaudeRuntimeError(
  message: string,
  outputLanguage: OutputLanguage = parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE),
  credentialSourceHint?: CredentialSourceHint,
): string {
  const lower = message.toLowerCase();

  if (isNativeBinaryMissing(lower)) {
    return nativeBinaryHint(message, outputLanguage);
  }

  const quotaOrAuth =
    lower.includes('out of') ||
    isClaudeQuotaError(message) ||
    lower.includes('not logged in') ||
    lower.includes('unauthorized') ||
    lower.includes('401') ||
    lower.includes('process exited with code 1');

  if (!quotaOrAuth) return message;

  return `${message}\n\n` +
    'SmartPerfetto is currently using the Claude Agent SDK runtime. ' +
    'If your Claude subscription/API quota is unavailable, configure an Anthropic-compatible proxy instead: ' +
    'set ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN, CLAUDE_MODEL, and CLAUDE_LIGHT_MODEL in the env file for your run mode, then restart the backend. ' +
    'Docker uses the repository-root .env; local source runs use backend/.env by default. ' +
    'Provider Manager active profiles take priority over env fallback. ' +
    'Provider switchers such as CC Switch manage Claude Code/Codex/Gemini CLI configs, but SmartPerfetto does not automatically read Codex CLI or Gemini CLI credentials.' +
    credentialSourceHintText(credentialSourceHint, outputLanguage);
}

/**
 * Check if ClaudeRuntime (agentv3) is the active orchestrator.
 * Defaults to true unless the explicit runtime is OpenAI Agents SDK.
 */
export function isClaudeCodeEnabled(): boolean {
  const runtime = process.env.SMARTPERFETTO_AGENT_RUNTIME;
  return !runtime || runtime === 'claude-agent-sdk';
}

/**
 * Create a lightweight config for quick (factual) queries.
 * Reduces maxTurns, effort, and disables verification/sub-agents
 * to optimize for fast response on simple questions.
 */
export function createQuickConfig(baseConfig: ClaudeAgentConfig): ClaudeAgentConfig {
  return {
    ...baseConfig,
    maxTurns: parsePositiveIntEnv('CLAUDE_QUICK_MAX_TURNS', DEFAULT_QUICK_MAX_TURNS),
    effort: 'low',
    enableVerification: false,
    enableSubAgents: false,
  };
}

/** Diagnostics describing how the Claude Agent SDK native binary was resolved. */
export interface ClaudeSdkBinaryDiagnostics {
  detectedPlatformKey: string | null;
  chosenPath: string | null;
  fallbackUsed: boolean;
  source: 'env-override' | 'sdk-default' | 'fallback' | 'none';
  error?: string;
}

interface AutoBinaryResolution {
  path: string | null;
  diagnostics: ClaudeSdkBinaryDiagnostics;
}

let autoBinaryCache: AutoBinaryResolution | null = null;

/** Test-only: reset the auto-detection memo. */
export function resetSdkBinaryOptionCache(): void {
  autoBinaryCache = null;
}

/** Mirror of the SDK's internal platform detection. Falsy glibc → musl. */
function detectPlatformKey(): string {
  try {
    if (process.platform === 'linux') {
      const report = typeof process.report?.getReport === 'function'
        ? (process.report.getReport() as { header?: { glibcVersionRuntime?: string } })
        : undefined;
      const glibc = report?.header?.glibcVersionRuntime;
      return `linux-${process.arch}${glibc ? '' : '-musl'}`;
    }
    return `${process.platform}-${process.arch}`;
  } catch {
    return `${process.platform}-${process.arch}`;
  }
}

function isExecutableBinary(p: string): boolean {
  try {
    fs.accessSync(p, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * SDK runtime glibc/musl detection can disagree with npm-install's selection
 * inside containers, leaving the SDK's auto-selected variant absent. Falls
 * back to any installed same-platform/arch sibling.
 */
function autoResolveSdkBinary(): AutoBinaryResolution {
  if (autoBinaryCache) return autoBinaryCache;

  const diagnostics: ClaudeSdkBinaryDiagnostics = {
    detectedPlatformKey: null,
    chosenPath: null,
    fallbackUsed: false,
    source: 'none',
  };

  try {
    const platformKey = detectPlatformKey();
    diagnostics.detectedPlatformKey = platformKey;

    const sdkMain = require.resolve('@anthropic-ai/claude-agent-sdk');
    const anthropicDir = path.resolve(path.dirname(sdkMain), '..');
    const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude';

    const preferredPath = path.join(anthropicDir, `claude-agent-sdk-${platformKey}`, binaryName);
    if (isExecutableBinary(preferredPath)) {
      diagnostics.chosenPath = preferredPath;
      diagnostics.source = 'sdk-default';
      autoBinaryCache = { path: preferredPath, diagnostics };
      return autoBinaryCache;
    }

    const platformPrefix = `claude-agent-sdk-${process.platform}-${process.arch}`;
    const entries = fs.readdirSync(anthropicDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith(platformPrefix)) continue;
      const candidatePath = path.join(anthropicDir, entry.name, binaryName);
      if (isExecutableBinary(candidatePath)) {
        diagnostics.chosenPath = candidatePath;
        diagnostics.fallbackUsed = true;
        diagnostics.source = 'fallback';
        autoBinaryCache = { path: candidatePath, diagnostics };
        return autoBinaryCache;
      }
    }

    autoBinaryCache = { path: null, diagnostics };
    return autoBinaryCache;
  } catch (err) {
    diagnostics.error = (err as Error).message;
    autoBinaryCache = { path: null, diagnostics };
    return autoBinaryCache;
  }
}

/**
 * Resolve `pathToClaudeCodeExecutable`. Explicit CLAUDE_BINARY_PATH is read
 * per-call so Provider Manager env overlays take effect; auto-detection is
 * memoized.
 */
export function getSdkBinaryOption(env: Record<string, string | undefined> = process.env): { pathToClaudeCodeExecutable?: string } {
  const explicitPath = env.CLAUDE_BINARY_PATH?.trim();
  if (explicitPath) return { pathToClaudeCodeExecutable: explicitPath };

  const auto = autoResolveSdkBinary();
  return auto.path ? { pathToClaudeCodeExecutable: auto.path } : {};
}

export function getClaudeSdkBinaryDiagnostics(env: Record<string, string | undefined> = process.env): ClaudeSdkBinaryDiagnostics {
  const explicitPath = env.CLAUDE_BINARY_PATH?.trim();
  if (explicitPath) {
    return {
      detectedPlatformKey: null,
      chosenPath: explicitPath,
      fallbackUsed: false,
      source: 'env-override',
    };
  }
  return autoResolveSdkBinary().diagnostics;
}

/**
 * Create a sanitized copy of process.env for SDK subprocess spawning.
 * When a providerId is given, overlays that provider's env vars.
 * When no providerId is given, overlays the active provider only when it is
 * configured for the Claude Agent SDK runtime.
 * Falls back to raw process.env when no provider is configured.
 */
export function createSdkEnv(
  sessionOverrideProviderId?: string | null,
  providerScope?: ProviderScope,
): Record<string, string | undefined> {
  // Lazy import to avoid circular dependency at module load time
  const { getProviderService } = require('../services/providerManager');
  const svc = getProviderService();

  const provider = typeof sessionOverrideProviderId === 'string'
    ? svc.getRawProvider(sessionOverrideProviderId, providerScope)
    : sessionOverrideProviderId === null
      ? undefined
    : svc.getRawEffectiveProvider(providerScope);

  if (typeof sessionOverrideProviderId === 'string' && !provider) {
    throw new Error(`Provider not found: ${sessionOverrideProviderId}`);
  }

  const providerRuntime = provider ? svc.resolveAgentRuntime(provider) : undefined;
  if (typeof sessionOverrideProviderId === 'string' && providerRuntime !== 'claude-agent-sdk') {
    throw new Error(`Provider ${sessionOverrideProviderId} is configured for ${providerRuntime}, not claude-agent-sdk`);
  }

  const providerEnv = providerRuntime === 'claude-agent-sdk' && provider
    ? svc.getEnvForProvider(provider.id, providerScope)
    : null;
  const env = mergeIsolatedProviderEnv(process.env, providerEnv);

  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SESSION_ACCESS_TOKEN;
  return env;
}

/**
 * Resolve the effective ClaudeAgentConfig based on the active provider or session override.
 * Unlike loadClaudeConfig() which only reads process.env at construction time,
 * this reads providerManager env vars at call time when the provider matches
 * the Claude Agent SDK runtime.
 */
export function resolveRuntimeConfig(
  baseConfig: ClaudeAgentConfig,
  providerId?: string | null,
  providerScope?: ProviderScope,
): ClaudeAgentConfig {
  // Lazy import to avoid circular dependency
  const { getProviderService } = require('../services/providerManager');
  const svc = getProviderService();

  const provider = typeof providerId === 'string'
    ? svc.getRawProvider(providerId, providerScope)
    : providerId === null
      ? undefined
    : svc.getRawEffectiveProvider(providerScope);

  if (typeof providerId === 'string' && !provider) {
    throw new Error(`Provider not found: ${providerId}`);
  }

  const providerRuntime = provider ? svc.resolveAgentRuntime(provider) : undefined;
  if (typeof providerId === 'string' && providerRuntime !== 'claude-agent-sdk') {
    throw new Error(`Provider ${providerId} is configured for ${providerRuntime}, not claude-agent-sdk`);
  }

  const providerEnv = providerRuntime === 'claude-agent-sdk' && provider
    ? svc.getEnvForProvider(provider.id, providerScope)
    : null;

  if (!providerEnv) return baseConfig;

  return {
    ...baseConfig,
    model: providerEnv.CLAUDE_MODEL || baseConfig.model,
    lightModel: providerEnv.CLAUDE_LIGHT_MODEL || baseConfig.lightModel,
    maxTurns: providerEnv.CLAUDE_MAX_TURNS
      ? parseInt(providerEnv.CLAUDE_MAX_TURNS, 10) : baseConfig.maxTurns,
    maxBudgetUsd: providerEnv.CLAUDE_MAX_BUDGET_USD
      ? parseFloat(providerEnv.CLAUDE_MAX_BUDGET_USD) : baseConfig.maxBudgetUsd,
    effort: (providerEnv.CLAUDE_EFFORT || baseConfig.effort) as EffortLevel,
    enableSubAgents: providerEnv.CLAUDE_ENABLE_SUB_AGENTS
      ? providerEnv.CLAUDE_ENABLE_SUB_AGENTS === 'true' : baseConfig.enableSubAgents,
    enableVerification: providerEnv.CLAUDE_ENABLE_VERIFICATION !== undefined
      ? providerEnv.CLAUDE_ENABLE_VERIFICATION !== 'false' : baseConfig.enableVerification,
    fullPathPerTurnMs: providerEnv.CLAUDE_FULL_PER_TURN_MS
      ? parseInt(providerEnv.CLAUDE_FULL_PER_TURN_MS, 10) : baseConfig.fullPathPerTurnMs,
    quickPathPerTurnMs: providerEnv.CLAUDE_QUICK_PER_TURN_MS
      ? parseInt(providerEnv.CLAUDE_QUICK_PER_TURN_MS, 10) : baseConfig.quickPathPerTurnMs,
    verifierTimeoutMs: providerEnv.CLAUDE_VERIFIER_TIMEOUT_MS
      ? parseInt(providerEnv.CLAUDE_VERIFIER_TIMEOUT_MS, 10) : baseConfig.verifierTimeoutMs,
    classifierTimeoutMs: providerEnv.CLAUDE_CLASSIFIER_TIMEOUT_MS
      ? parseInt(providerEnv.CLAUDE_CLASSIFIER_TIMEOUT_MS, 10) : baseConfig.classifierTimeoutMs,
    subAgentModel: (providerEnv.CLAUDE_SUB_AGENT_MODEL as ClaudeAgentConfig['subAgentModel'])
      || baseConfig.subAgentModel,
  };
}
