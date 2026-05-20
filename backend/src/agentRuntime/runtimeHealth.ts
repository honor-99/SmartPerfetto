// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { serverConfig } from '../config';
import { getOpenAIRuntimeDiagnostics } from '../agentOpenAI';
import { getClaudeRuntimeDiagnostics } from '../agentv3/claudeConfig';
import { collectEnvCredentialSources } from './envCredentialSources';
import { resolveAgentRuntimeSelection } from './runtimeSelection';
import { getProviderService } from '../services/providerManager';
import { getSmartPerfettoVersion } from '../version';

export function buildRuntimeHealthPayload(now: Date = new Date()) {
  const runtimeSelection = resolveAgentRuntimeSelection();
  const providerSvc = getProviderService();
  const activeProvider = providerSvc.list().find(p => p.isActive);
  const selectedProviderId = runtimeSelection.source === 'provider'
    ? runtimeSelection.providerId
    : null;
  const claudeDiagnostics = getClaudeRuntimeDiagnostics(
    runtimeSelection.kind === 'claude-agent-sdk' ? selectedProviderId : null,
  );
  const openAIDiagnostics = getOpenAIRuntimeDiagnostics(
    runtimeSelection.kind === 'openai-agents-sdk' ? selectedProviderId : null,
  );
  const selectedDiagnostics = runtimeSelection.kind === 'openai-agents-sdk'
    ? openAIDiagnostics
    : claudeDiagnostics;
  const envSources = collectEnvCredentialSources(process.env, 'health');
  const providerOverridesEnv = runtimeSelection.source === 'provider' && envSources.length > 0;

  return {
    status: 'OK',
    timestamp: now.toISOString(),
    environment: serverConfig.nodeEnv,
    version: getSmartPerfettoVersion(),
    aiEngine: {
      runtime: runtimeSelection.kind,
      model: selectedDiagnostics.model,
      providerMode: selectedDiagnostics.providerMode,
      configured: selectedDiagnostics.configured,
      source: runtimeSelection.source,
      credentialSource: runtimeSelection.source === 'provider'
        ? 'provider-manager'
        : 'env-or-default',
      envCredentialSources: envSources,
      providerOverridesEnv,
      ...(activeProvider ? {
        activeProvider: {
          id: activeProvider.id,
          name: activeProvider.name,
          type: activeProvider.type,
        },
      } : {}),
      authRequired: !!process.env.SMARTPERFETTO_API_KEY
        || process.env.SMARTPERFETTO_ENTERPRISE === 'true'
        || !!process.env.SMARTPERFETTO_OIDC_ISSUER_URL,
      diagnostics: selectedDiagnostics,
    },
  };
}
