// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * claudeMcpServer unit tests
 *
 * Tests MCP tool registration and key validation logic:
 * - Plan enforcement (P0-G10): execute_sql/invoke_skill require prior submit_plan
 * - submit_plan scene template validation
 * - Hypothesis lifecycle (submit → resolve)
 * - Analysis notes (write_analysis_note)
 * - write_analysis_note cap (20)
 * - flag_uncertainty (non-blocking)
 * - revise_plan (preserves completed phases)
 * - Tool count and allowedTools auto-derivation (P2-G1)
 *
 * The MCP server is tested by directly invoking tool handlers returned from
 * the SDK mock's `tool()` function.
 */

import { jest, describe, it, expect } from '@jest/globals';
import type { AnalysisPlanV3, AnalysisNote, Hypothesis, UncertaintyFlag } from '../types';

// ── Mock dependencies ────────────────────────────────────────────────────

// Mock modules that claudeMcpServer imports
jest.mock('../../services/skillEngine/skillAnalysisAdapter', () => ({
  getSkillAnalysisAdapter: jest.fn(() => ({
    adaptSkillResult: jest.fn((r: any) => r),
    listSkills: jest.fn(async () => [
      { id: 'scrolling_analysis', displayName: 'Scrolling Analysis', description: 'Analyze scrolling jank', type: 'composite', keywords: ['scroll', 'jank'] },
      { id: 'cpu_analysis', displayName: 'CPU Analysis', description: 'Analyze CPU usage', type: 'atomic', keywords: ['cpu'] },
    ]),
  })),
}));

jest.mock('../../agent/detectors/architectureDetector', () => ({
  createArchitectureDetector: jest.fn(() => ({
    detect: jest.fn(async () => ({ type: 'Standard', confidence: 0.9 })),
  })),
}));

jest.mock('../../services/skillEngine/skillLoader', () => ({
  skillRegistry: {
    getSkill: jest.fn(() => ({ type: 'atomic', name: 'test_skill' })),
    getAllSkills: jest.fn(() => [
      { name: 'scrolling_analysis', type: 'composite', description: 'Scrolling analysis' },
      { name: 'cpu_analysis', type: 'atomic', description: 'CPU analysis' },
    ]),
  },
}));

jest.mock('../artifactStore', () => ({
  ArtifactStore: jest.fn().mockImplementation(() => ({
    _artifacts: new Map<string, any>(),
    _counter: 0,
    store: jest.fn(function(this: any, entry: any) {
      const id = `art-${++this._counter}`;
      this._artifacts.set(id, { id, ...entry });
      return id;
    }),
    generateCompactSummary: jest.fn(function(this: any, id: string) {
      const artifact = this._artifacts.get(id) || {};
      return {
        id,
        stepId: artifact.stepId || 'result',
        title: artifact.title || 'Result',
        rowCount: artifact.data?.rows?.length ?? 0,
        ...(artifact.planPhaseId ? { planPhaseId: artifact.planPhaseId } : {}),
        ...(artifact.planPhaseTitle ? { planPhaseTitle: artifact.planPhaseTitle } : {}),
      };
    }),
    fetch: jest.fn(function(this: any, id: string, detail: string, offset?: number, limit?: number) {
      const artifact = this._artifacts.get(id);
      const rows = artifact?.data?.rows || [[1], [2]];
      const columns = artifact?.data?.columns || ['value'];
      const effectiveOffset = offset ?? 0;
      const effectiveLimit = limit ?? 50;
      return {
        id,
        skillId: artifact?.skillId,
        stepId: artifact?.stepId,
        title: artifact?.title,
        columns,
        rows: rows.slice(effectiveOffset, effectiveOffset + effectiveLimit),
        totalRows: rows.length,
        offset: effectiveOffset,
        limit: effectiveLimit,
        hasMore: effectiveOffset + effectiveLimit < rows.length,
        detail,
        diagnostics: artifact?.diagnostics,
        planPhaseId: artifact?.planPhaseId,
        planPhaseTitle: artifact?.planPhaseTitle,
        planPhaseGoal: artifact?.planPhaseGoal,
        sourceToolCallId: artifact?.sourceToolCallId,
        paramsHash: artifact?.paramsHash,
        identityResolution: artifact?.identityResolution,
      };
    }),
    get: jest.fn(function(this: any, id: string) {
      return this._artifacts.get(id) || null;
    }),
    list: jest.fn(function(this: any) {
      return [...this._artifacts.values()];
    }),
    serialize: jest.fn(function(this: any) {
      return [...this._artifacts.values()];
    }),
  })),
}));

jest.mock('../sqlSummarizer', () => ({
  summarizeSqlResult: jest.fn(() => ({
    totalRows: 10,
    columns: ['col1'],
    columnStats: {},
    sampleRows: [[1]],
  })),
}));

jest.mock('../analysisPatternMemory', () => ({
  matchPatterns: jest.fn(() => []),
  matchNegativePatterns: jest.fn(() => []),
  extractTraceFeatures: jest.fn(() => ['arch:Standard']),
}));

// Mock the schema index loading (it reads a JSON file at import time)
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: jest.fn((...args: unknown[]) => {
      const p = args[0] as string;
      if (typeof p === 'string' && p.includes('perfettoSqlIndex')) return false;
      if (typeof p === 'string' && p.includes('sql_learning')) return false;
      return (actual as any).existsSync(p);
    }),
    readFileSync: jest.fn((...args: unknown[]) => {
      const p = args[0] as string;
      if (typeof p === 'string' && p.includes('perfettoSqlIndex')) return '{"version":"1","generatedAt":"","templates":[]}';
      if (typeof p === 'string' && p.includes('sql_learning')) return '[]';
      return (actual as any).readFileSync(p, args[1]);
    }),
  };
});

import {
  createClaudeMcpServer,
  MCP_NAME_PREFIX,
  loadLearnedSqlFixPairs,
  normalizeOptionalToolString,
} from '../claudeMcpServer';
import { ArtifactStore } from '../artifactStore';

// ── Helpers ──────────────────────────────────────────────────────────────

type ToolDef = { name: string; schema?: Record<string, any>; handler: (...args: any[]) => any };

function createTestServer(options: { referenceTraceId?: string; sceneType?: any; lightweight?: boolean } = {}) {
  const analysisNotes: AnalysisNote[] = [];
  const hypotheses: Hypothesis[] = [];
  const uncertaintyFlags: UncertaintyFlag[] = [];
  const analysisPlan: { current: AnalysisPlanV3 | null } = { current: null };
  const watchdogWarning: { current: string | null } = { current: null };
  const emittedUpdates: any[] = [];

  const mockTpService = {
    query: jest.fn(async (_traceId: string, _sql: string) => ({ columns: ['id'], rows: [[1]], rowCount: 1, durationMs: 5 })),
  };
  const mockSkillExecutor = {
    execute: jest.fn(async (
      skillId: string,
      _traceId: string,
      _params?: Record<string, any>,
      _overrides?: Record<string, any>,
    ) => ({
      skillId,
      success: true,
      displayResults: [{
        stepId: 'result',
        title: 'Result',
        layer: 'list',
        format: 'table',
        data: { rows: [[1]], columns: ['a'] },
      }],
      diagnostics: [],
      executionTimeMs: 5,
    })),
    executeCompositeSkill: jest.fn(async () => ({
      success: true,
      displayResults: [{ stepId: 'result', title: 'Result', layer: 'list', format: 'table', data: { rows: [[1]], columns: ['a'] } }],
      layers: {},
    })),
    registerSkill: jest.fn(),
  };

  const { server, allowedTools } = createClaudeMcpServer({
    traceId: 'test-trace-123',
    traceProcessorService: mockTpService as any,
    skillExecutor: mockSkillExecutor as any,
    analysisNotes,
    hypotheses,
    uncertaintyFlags,
    watchdogWarning,
    artifactStore: new ArtifactStore() as any,
    emitUpdate: (u: any) => emittedUpdates.push(u),
    sceneType: options.sceneType,
    ...(options.lightweight ? { lightweight: true } : { analysisPlan }),
    ...(options.referenceTraceId ? {
      referenceTraceId: options.referenceTraceId,
      comparisonContext: {
        referenceTraceId: options.referenceTraceId,
        commonCapabilities: ['slice'],
      },
    } : {}),
  });

  // Extract tool handlers from the mock SDK server
  const tools: Map<string, ToolDef> = new Map();
  const mockServerInstance = server?.instance as any;
  if (mockServerInstance?.tools) {
    for (const t of mockServerInstance.tools) {
      tools.set(t.name.replace(MCP_NAME_PREFIX, ''), t);
    }
  }

  return {
    tools,
    allowedTools,
    analysisNotes,
    hypotheses,
    uncertaintyFlags,
    analysisPlan,
    watchdogWarning,
    emittedUpdates,
    mockTpService,
    mockSkillExecutor,
  };
}

async function callTool(tools: Map<string, ToolDef>, name: string, params: Record<string, any> = {}): Promise<any> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`Tool ${name} not found. Available: ${[...tools.keys()].join(', ')}`);
  const rawResult = await tool.handler(params);
  // MCP tool handlers return { content: [{ type: 'text', text: JSON.stringify(...) }] }
  if (rawResult && typeof rawResult === 'object' && Array.isArray(rawResult.content)) {
    const textEntry = rawResult.content.find((c: any) => c.type === 'text');
    if (textEntry?.text) {
      try { return JSON.parse(textEntry.text); } catch {
        const parsed = parseLeadingJsonObject(textEntry.text);
        return parsed ?? textEntry.text;
      }
    }
  }
  if (typeof rawResult === 'string') {
    try { return JSON.parse(rawResult); } catch {
      const parsed = parseLeadingJsonObject(rawResult);
      return parsed ?? rawResult;
    }
  }
  return rawResult;
}

function parseLeadingJsonObject(text: string): unknown | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(0, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('createClaudeMcpServer', () => {
  describe('tool input normalization', () => {
    it('normalizes LLM string nulls for optional tool fields', () => {
      expect(normalizeOptionalToolString('null')).toBeUndefined();
      expect(normalizeOptionalToolString(' undefined ')).toBeUndefined();
      expect(normalizeOptionalToolString('none')).toBeUndefined();
      expect(normalizeOptionalToolString('')).toBeUndefined();
      expect(normalizeOptionalToolString(' app/src/MainActivity.kt ')).toBe('app/src/MainActivity.kt');
    });
  });

  describe('tool registration', () => {
    it('should register the full MCP toolset (range guard, not exact count)', () => {
      // Asserting an exact count breaks every time we add or retire a tool;
      // assert a sane range plus the must-have anchors so a regression that
      // *removes* a critical tool still fails loudly.
      const { tools } = createTestServer();
      expect(tools.size).toBeGreaterThanOrEqual(15);
      expect(tools.size).toBeLessThanOrEqual(25);
      for (const required of ['execute_sql', 'invoke_skill', 'lookup_sql_schema', 'submit_plan']) {
        expect(tools.has(required)).toBe(true);
      }
    });

    it('should auto-derive allowedTools matching registered tools (P2-G1)', () => {
      const { tools, allowedTools } = createTestServer();
      // Every tool should have a matching allowedTools entry (with prefix)
      for (const name of tools.keys()) {
        const prefixed = MCP_NAME_PREFIX + name;
        expect(allowedTools).toContain(prefixed);
      }
      expect(allowedTools.length).toBe(tools.size);
    });

    it('should register all expected tools', () => {
      const { tools } = createTestServer();
      const expected = [
        'execute_sql', 'invoke_skill', 'list_skills', 'detect_architecture',
        'lookup_sql_schema', 'submit_plan', 'update_plan_phase', 'revise_plan',
        'submit_hypothesis', 'resolve_hypothesis', 'write_analysis_note',
        'fetch_artifact', 'query_perfetto_source', 'flag_uncertainty', 'recall_patterns',
      ];
      for (const name of expected) {
        expect(tools.has(name)).toBe(true);
      }
    });

    it('keeps fetch_artifact available in lightweight mode for skill artifacts', () => {
      const { tools, allowedTools } = createTestServer({ lightweight: true });

      expect([...tools.keys()].sort()).toEqual([
        'execute_sql',
        'fetch_artifact',
        'invoke_skill',
        'lookup_sql_schema',
      ]);
      expect(allowedTools).toContain(MCP_NAME_PREFIX + 'fetch_artifact');
      expect(tools.has('submit_plan')).toBe(false);
    });
  });

  describe('fetch_artifact', () => {
    it('coerces string pagination arguments before fetching rows', async () => {
      const { tools } = createTestServer();

      const result = await callTool(tools, 'fetch_artifact', {
        artifactId: 'art-1',
        detail: 'rows',
        offset: '0',
        limit: '50',
        purpose: 'Verify pagination argument normalization',
      });

      expect(result.success).toBe(true);
      expect(result.offset).toBe(0);
      expect(result.limit).toBe(50);
      expect(result.detail).toBe('rows');
    });

    it('rejects invalid pagination strings with a tool-level error', async () => {
      const { tools } = createTestServer();

      const result = await callTool(tools, 'fetch_artifact', {
        artifactId: 'art-1',
        detail: 'rows',
        offset: 'bad',
        limit: '50',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('offset must be an integer');
    });

    it('inherits the source phase from the artifact instead of the currently active phase', async () => {
      const { tools, analysisPlan } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: '概览数据表', goal: '调用 scrolling_analysis 生成概览表', expectedTools: ['invoke_skill'] },
          { id: 'p2', name: '根因深钻', goal: '读取前序表后选择代表帧深钻', expectedTools: ['fetch_artifact'] },
        ],
        successCriteria: 'Fetched artifact data keeps its origin phase',
      });
      await callTool(tools, 'update_plan_phase', { phaseId: 'p1', status: 'in_progress' });
      const skillResult = await callTool(tools, 'invoke_skill', {
        skillId: 'scrolling_analysis',
        params: { process_name: 'com.example' },
      });
      await callTool(tools, 'update_plan_phase', { phaseId: 'p2', status: 'in_progress' });

      const result = await callTool(tools, 'fetch_artifact', {
        artifactId: skillResult.artifacts[0].id,
        detail: 'rows',
        purpose: '读取概览阶段生成的表格，选择后续深钻对象',
      });

      expect(result.success).toBe(true);
      expect(result.planPhaseId).toBe('p1');
      expect(result.planPhaseTitle).toBe('概览数据表');
      expect(result.planPhaseAttribution).toBe('inferred');
      expect(analysisPlan.current?.phases.find(p => p.id === 'p2')?.status).toBe('in_progress');
    });

    it('preserves identity sidecars when fetching skill artifacts', async () => {
      const { tools, mockSkillExecutor } = createTestServer({ lightweight: true });
      mockSkillExecutor.execute.mockResolvedValueOnce({
        skillId: 'process_identity_skill',
        success: true,
        displayResults: [{
          stepId: 'root',
          title: 'Identity Result',
          layer: 'overview',
          format: 'table',
          data: { rows: [[1]], columns: ['process_name'] },
        }],
        identityResolution: {
          version: 'identity_contract@1',
          identityRefId: 'identity:test',
          target: { traceId: 'test-trace-123', source: 'skill_param' },
          status: 'verified',
          processes: [],
          threads: [],
          warnings: [],
        },
        diagnostics: [{ severity: 'warning', message: 'identity warning' }],
        synthesizeData: [{
          stepId: 'synth',
          stepName: 'Synthesize Rows',
          success: true,
          data: [{ frame_id: 1, blocked_ms: 120 }],
        }],
        executionTimeMs: 5,
      } as any);

      const skillResult = await callTool(tools, 'invoke_skill', {
        skillId: 'process_identity_skill',
        params: { process_name: 'com.example' },
      });
      const fetched = await callTool(tools, 'fetch_artifact', {
        artifactId: skillResult.artifacts[0].id,
        detail: 'rows',
      });
      const fetchedDiagnostics = await callTool(tools, 'fetch_artifact', {
        artifactId: skillResult.diagnosticsArtifactId,
        detail: 'rows',
      });
      const fetchedSynthesize = await callTool(tools, 'fetch_artifact', {
        artifactId: skillResult.synthesizeArtifacts[0].artifactId,
        detail: 'rows',
      });

      expect(fetched.identityResolution).toEqual(expect.objectContaining({
        identityRefId: 'identity:test',
        status: 'verified',
      }));
      expect(fetchedDiagnostics.identityResolution).toEqual(expect.objectContaining({
        identityRefId: 'identity:test',
        status: 'verified',
      }));
      expect(fetchedSynthesize.identityResolution).toEqual(expect.objectContaining({
        identityRefId: 'identity:test',
        status: 'verified',
      }));
    });

    it('creates fetchable diagnostics artifacts without display results', async () => {
      const { tools, mockSkillExecutor } = createTestServer({ lightweight: true });
      mockSkillExecutor.execute.mockResolvedValueOnce({
        skillId: 'diagnostics_identity_skill',
        success: true,
        displayResults: [],
        identityResolution: {
          version: 'identity_contract@1',
          identityRefId: 'identity:diagnostics',
          target: { traceId: 'test-trace-123', source: 'skill_param' },
          status: 'verified',
          processes: [],
          threads: [],
          warnings: [],
        },
        diagnostics: [{ severity: 'warning', message: 'identity warning' }],
        executionTimeMs: 5,
      } as any);

      const skillResult = await callTool(tools, 'invoke_skill', {
        skillId: 'diagnostics_identity_skill',
        params: { process_name: 'com.example' },
      });
      const fetchedDiagnostics = await callTool(tools, 'fetch_artifact', {
        artifactId: skillResult.diagnosticsArtifactId,
        detail: 'rows',
      });

      expect(skillResult.diagnosticsArtifactId).toBeTruthy();
      expect(fetchedDiagnostics.identityResolution).toEqual(expect.objectContaining({
        identityRefId: 'identity:diagnostics',
        status: 'verified',
      }));
    });

    it('creates fetchable synthesize artifacts without display results', async () => {
      const { tools, mockSkillExecutor } = createTestServer({ lightweight: true });
      mockSkillExecutor.execute.mockResolvedValueOnce({
        skillId: 'synthesize_identity_skill',
        success: true,
        displayResults: [],
        identityResolution: {
          version: 'identity_contract@1',
          identityRefId: 'identity:synthesize',
          target: { traceId: 'test-trace-123', source: 'skill_param' },
          status: 'verified',
          processes: [],
          threads: [],
          warnings: [],
        },
        synthesizeData: [{
          stepId: 'synth',
          stepName: 'Synthesize Rows',
          success: true,
          data: [{ frame_id: 1, blocked_ms: 120 }],
        }],
        executionTimeMs: 5,
      } as any);

      const skillResult = await callTool(tools, 'invoke_skill', {
        skillId: 'synthesize_identity_skill',
        params: { process_name: 'com.example' },
      });
      const fetchedSynthesize = await callTool(tools, 'fetch_artifact', {
        artifactId: skillResult.synthesizeArtifacts[0].artifactId,
        detail: 'rows',
      });

      expect(skillResult.synthesizeArtifacts).toHaveLength(1);
      expect(fetchedSynthesize.identityResolution).toEqual(expect.objectContaining({
        identityRefId: 'identity:synthesize',
        status: 'verified',
      }));
    });
  });

  describe('invoke_skill compatibility aliases', () => {
    it('normalizes simple timestamp arithmetic expressions in skill params', async () => {
      const { tools, mockSkillExecutor } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: 'Frame detail', goal: 'Run frame blocking skill', expectedTools: ['invoke_skill'] },
        ],
        successCriteria: 'Timestamp expressions are executable integers',
      });

      await callTool(tools, 'invoke_skill', {
        skillId: 'frame_blocking_calls',
        params: {
          process_name: 'com.example',
          start_ts: '506731768732822',
          end_ts: '506731768732822+18661250',
        },
      });

      expect(mockSkillExecutor.execute).toHaveBeenCalledWith(
        'frame_blocking_calls',
        'test-trace-123',
        {
          process_name: 'com.example',
          package: 'com.example',
          start_ts: '506731768732822',
          end_ts: '506731787394072',
        },
      );
    });

    it('delegates invoke_skill(detect_architecture) to the architecture detector and binds the architecture phase', async () => {
      const { tools, analysisPlan, mockSkillExecutor } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: 'Trace 时间范围 + 架构确认', goal: '确认渲染架构', expectedTools: ['execute_sql', 'invoke_skill'] },
          { id: 'p2', name: '滑动概览', goal: '获取帧统计', expectedTools: ['invoke_skill'] },
        ],
        successCriteria: 'Confirm rendering architecture before frame analysis',
      });

      const result = await callTool(tools, 'invoke_skill', {
        skillId: 'detect_architecture',
        params: { process_name: 'com.example.app' },
      });

      expect(result.success).toBe(true);
      expect(result.delegatedTool).toBe('detect_architecture');
      expect(result.type).toBe('Standard');
      expect(result.planPhaseId).toBe('p1');
      expect(result.sourceToolCallId).toContain('invoke_skill:');
      expect(analysisPlan.current?.phases[0].status).toBe('in_progress');
      expect(analysisPlan.current?.phases[1].status).toBe('pending');
      expect(mockSkillExecutor.execute).not.toHaveBeenCalled();
    });

    it('does not bind architecture detection to a frame-gap detection phase', async () => {
      const { tools, analysisPlan } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: '架构检测 + trace 时间范围', goal: '确认渲染架构类型和 trace 时间边界', expectedTools: ['invoke_skill'] },
          { id: 'p4', name: '缺帧检测（Phase 1.95）', goal: '检测 frame_production_gap，补充肥帧之外的感知卡顿来源', expectedTools: ['invoke_skill'] },
        ],
        successCriteria: 'Architecture detection must stay on the architecture phase',
      });

      await callTool(tools, 'invoke_skill', {
        skillId: 'detect_architecture',
        params: { process_name: 'com.example.app' },
      });

      expect(analysisPlan.current?.phases.find(p => p.id === 'p1')?.status).toBe('in_progress');
      expect(analysisPlan.current?.phases.find(p => p.id === 'p4')?.status).toBe('pending');
    });
  });

  describe('phase attribution', () => {
    it('binds trace range SQL to the trace range phase before scrolling overview', async () => {
      const { tools, analysisPlan } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: 'Trace 时间范围 + 架构确认', goal: '获取 trace 时间边界，确认渲染架构', expectedTools: ['execute_sql', 'invoke_skill'] },
          { id: 'p2', name: '滑动概览 + 掉帧分布', goal: '调用 scrolling_analysis 获取帧统计和掉帧分布', expectedTools: ['invoke_skill'] },
        ],
        successCriteria: 'Bind early trace range evidence to the setup phase',
      });

      await callTool(tools, 'execute_sql', {
        sql: "SELECT printf('%d', MIN(ts)) as start_ts, printf('%d', MAX(ts + dur)) as end_ts, COUNT(*) as total_frames FROM actual_frame_timeline_slice",
      });

      expect(analysisPlan.current?.phases[0].status).toBe('in_progress');
      expect(analysisPlan.current?.phases[1].status).toBe('pending');
    });

    it('binds full root-cause artifact fetches to the full-data phase by purpose', async () => {
      const { tools, analysisPlan } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p3', name: '滑动概览 + 掉帧列表', goal: '调用 scrolling_analysis 获取帧统计', expectedTools: ['invoke_skill'] },
          { id: 'p4', name: '获取全量掉帧数据', goal: '通过 fetch_artifact 分页获取 batch_frame_root_cause 全量数据', expectedTools: ['fetch_artifact'] },
          { id: 'p5', name: '根因深钻', goal: '对代表帧调用 jank_frame_detail 和 frame_blocking_calls', expectedTools: ['invoke_skill', 'fetch_artifact'] },
        ],
        successCriteria: 'Bind artifact fetches to the phase that explains why the table is fetched',
      });

      await callTool(tools, 'fetch_artifact', {
        artifactId: 'art-14',
        detail: 'rows',
        offset: 0,
        limit: 50,
        purpose: '获取全量掉帧根因数据，包含每帧 reason_code 和四象限，作为根因分布统计的基础',
      });

      expect(analysisPlan.current?.phases.find(p => p.id === 'p4')?.status).toBe('in_progress');
      expect(analysisPlan.current?.phases.find(p => p.id === 'p5')?.status).toBe('pending');
    });

    it('keeps root-cause verification SQL on a generic root drill phase even when execute_sql was omitted', async () => {
      const { tools, emittedUpdates } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p2', name: '根因深钻', goal: '对主要掉帧类别逐帧深钻，定位机制级根因', expectedTools: ['invoke_skill'] },
        ],
        successCriteria: 'Root drill SQL should not become unexpected timeline evidence',
      });
      await callTool(tools, 'update_plan_phase', { phaseId: 'p2', status: 'in_progress' });

      const result = await callTool(tools, 'execute_sql', {
        sql: `
          SELECT reason_code, top_slice_name, main_q4b_pct
          FROM __intrinsic_batch_frame_root_cause
          WHERE frame_id = 59665234
        `,
      });

      const envelope = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? [])
        .find((env: any) => env.meta?.source === 'execute_sql');

      expect(result.success).toBe(true);
      expect(result.sqlRewrites?.[0]).toContain('__intrinsic_batch_frame_root_cause');
      expect(envelope?.meta?.planPhaseId).toBe('p2');
      expect(envelope?.meta?.planPhaseAttribution).toBe('active');
      expect(envelope?.meta?.planPhaseWarning).toBeUndefined();
    });
  });

  describe('plan enforcement (P0-G10)', () => {
    it('execute_sql should require plan', async () => {
      const { tools } = createTestServer();
      const result = await callTool(tools, 'execute_sql', { sql: 'SELECT 1' });
      expect(result.error || result.message || '').toMatch(/submit_plan|计划/i);
    });

    it('invoke_skill should require plan', async () => {
      const { tools } = createTestServer();
      const result = await callTool(tools, 'invoke_skill', { skillId: 'scrolling_analysis' });
      expect(result.error || result.message || '').toMatch(/submit_plan|计划/i);
    });

    it('execute_sql should work after plan is submitted', async () => {
      const { tools, analysisPlan, emittedUpdates } = createTestServer();
      // Submit plan first
      await callTool(tools, 'submit_plan', {
        phases: [{ id: 'p1', name: 'Test', goal: 'Test', expectedTools: ['execute_sql'] }],
        successCriteria: 'Test done',
      });
      expect(analysisPlan.current).not.toBeNull();

      // Now execute_sql should work
      const result = await callTool(tools, 'execute_sql', { sql: 'SELECT 1' });
      expect(result.error).toBeUndefined();
      expect(result.traceSide).toBe('current');
      expect(result.traceId).toBe('test-trace-123');
      expect(result.traceProvenance.databaseScope.processorKey).toBe('test-trace-123');
      const dataUpdate = emittedUpdates.find((u: any) => u.type === 'data');
      expect(dataUpdate?.content?.[0]?.sql).toBe('SELECT 1');
      expect(dataUpdate?.content?.[0]?.traceSide).toBe('current');
      expect(dataUpdate?.content?.[0]?.traceId).toBe('test-trace-123');
      expect(dataUpdate?.content?.[0]?.meta?.planPhaseId).toBe('p1');
      expect(dataUpdate?.content?.[0]?.meta?.planPhaseAttribution).toBe('active');
      expect(dataUpdate?.content?.[0]?.meta?.planPhaseWarning).toBeUndefined();
      expect(emittedUpdates.find((u: any) => u.type === 'plan_phase_updated')?.content).toMatchObject({
        phaseId: 'p1',
        status: 'in_progress',
      });
    });

    it('blocks artifact pseudo-tables before executing raw SQL', async () => {
      const { tools, emittedUpdates, mockTpService } = createTestServer({ lightweight: true });

      const result = await callTool(tools, 'execute_sql', {
        sql: "SELECT * FROM __intrinsic_artifact_rows WHERE artifact_id='art-2'",
      });

      expect(result.success).toBe(false);
      expect(result.blocked).toBe(true);
      expect(result.action_required).toBe('fetch_artifact');
      expect(result.hint).toContain('fetch_artifact');
      expect(mockTpService.query).not.toHaveBeenCalled();
      expect(emittedUpdates.filter((u: any) => u.type === 'data')).toHaveLength(0);
    });

    it('blocks synthesizeArtifacts pseudo-table names before executing raw SQL', async () => {
      const { tools, mockTpService } = createTestServer({ lightweight: true });

      const result = await callTool(tools, 'execute_sql', {
        sql: 'SELECT * FROM synthesizeArtifacts',
      });

      expect(result.success).toBe(false);
      expect(result.action_required).toBe('fetch_artifact');
      expect(mockTpService.query).not.toHaveBeenCalled();
    });

    it('blocks quoted artifact pseudo-tables before executing raw SQL', async () => {
      const { tools, mockTpService } = createTestServer({ lightweight: true });

      const doubleQuoted = await callTool(tools, 'execute_sql', {
        sql: 'SELECT * FROM "art-2"',
      });
      const bracketQuoted = await callTool(tools, 'execute_sql', {
        sql: 'SELECT * FROM [__intrinsic_artifact_rows]',
      });

      expect(doubleQuoted.success).toBe(false);
      expect(doubleQuoted.action_required).toBe('fetch_artifact');
      expect(bracketQuoted.success).toBe(false);
      expect(bracketQuoted.action_required).toBe('fetch_artifact');
      expect(mockTpService.query).not.toHaveBeenCalled();
    });

    it('blocks artifact pseudo-tables in comma-joined table lists', async () => {
      const { tools, mockTpService } = createTestServer({ lightweight: true });

      const result = await callTool(tools, 'execute_sql', {
        sql: 'SELECT * FROM slice s, "art-2" a WHERE s.id = a.slice_id',
      });

      expect(result.success).toBe(false);
      expect(result.action_required).toBe('fetch_artifact');
      expect(mockTpService.query).not.toHaveBeenCalled();
    });

    it('does not block artifact-looking text inside SQL string literals', async () => {
      const { tools, mockTpService } = createTestServer({ lightweight: true });

      const result = await callTool(tools, 'execute_sql', {
        sql: "SELECT 'FROM art-2' AS note",
      });

      expect(result.error).toBeUndefined();
      expect(result.traceSide).toBe('current');
      expect(mockTpService.query).toHaveBeenCalledWith('test-trace-123', expect.stringContaining("SELECT 'FROM art-2' AS note"));
    });

    it('binds lightweight evidence to the synthetic quick phase', async () => {
      const { tools, emittedUpdates } = createTestServer({ lightweight: true });

      const result = await callTool(tools, 'invoke_skill', {
        skillId: 'scrolling_analysis',
        params: { process_name: 'com.example' },
      });

      const envelope = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? [])
        .find((env: any) => env.meta?.skillId === 'scrolling_analysis');

      expect(result.success).toBe(true);
      expect(result.artifacts?.[0]?.planPhaseId).toBe('quick');
      expect(envelope?.meta?.planPhaseId).toBe('quick');
      expect(envelope?.meta?.planPhaseTitle).toBe('快速回答');
      expect(envelope?.meta?.planPhaseAttribution).toBe('active');
    });

    it('normalizes actual_frame_timeline_slice process lookup before executing raw SQL', async () => {
      const { tools, mockTpService } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [{ id: 'p1', name: '滑动概览', goal: '获取帧统计和目标进程', expectedTools: ['execute_sql'] }],
        successCriteria: 'Process lookup should not emit an avoidable SQL diagnostic',
      });

      const result = await callTool(tools, 'execute_sql', {
        sql: "SELECT p.name AS process_name, p.upid, COUNT(*) as frame_count FROM actual_frame_timeline_slice a JOIN thread USING(utid) JOIN process p USING(upid) GROUP BY p.upid",
      });

      const calls = (mockTpService.query as any).mock.calls;
      const executedSql = calls[calls.length - 1]?.[1] as string;
      expect(result.success).toBe(true);
      expect(result.sqlRewrites?.[0]).toContain('JOIN thread USING(utid)');
      expect(executedSql).not.toMatch(/JOIN\s+thread\s+USING\s*\(\s*utid\s*\)/i);
      expect(executedSql).toMatch(/JOIN\s+process\s+p\s+USING\s*\(\s*upid\s*\)/i);
    });

    it('execute_sql emits sourced envelopes for empty SQL but does not stream failed SQL as frontend data', async () => {
      const { tools, emittedUpdates, mockTpService } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [{ id: 'p1', name: 'Test', goal: 'Test', expectedTools: ['execute_sql'] }],
        successCriteria: 'Test done',
      });
      await callTool(tools, 'update_plan_phase', { phaseId: 'p1', status: 'in_progress' });

      (mockTpService.query as any)
        .mockResolvedValueOnce({ columns: ['id'], rows: [], rowCount: 0, durationMs: 1 })
        .mockResolvedValueOnce({ columns: [], rows: [], rowCount: 0, durationMs: 1, error: 'bad sql' });

      const emptyResult = await callTool(tools, 'execute_sql', { sql: 'SELECT id FROM slice WHERE 0' });
      const failedResult = await callTool(tools, 'execute_sql', { sql: 'SELECT * FROM missing_table' });

      const envelopes = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? []);
      const emptyEnvelope = envelopes.find((env: any) => env.sql === 'SELECT id FROM slice WHERE 0');
      const diagnosticEnvelope = envelopes.find((env: any) => env.display?.format === 'text' && env.meta?.type === 'diagnostic');

      expect(emptyResult.success).toBe(true);
      expect(emptyEnvelope).toMatchObject({
        data: { columns: ['id'], rows: [] },
        meta: {
          evidenceRefId: emptyResult.evidenceRefId,
          planPhaseId: 'p1',
          planPhaseAttribution: 'active',
        },
      });
      expect(failedResult.success).toBe(false);
      expect(failedResult.evidenceRefId).toBeUndefined();
      expect(diagnosticEnvelope).toBeUndefined();
      expect(failedResult.diagnostic).toMatchObject({
        type: 'sql_execution_failed',
        citableEvidence: false,
      });
      expect(failedResult.error).toContain('bad sql');
      const progressMessages = emittedUpdates
        .filter((u: any) => u.type === 'progress')
        .map((u: any) => String(u.content?.message || ''));
      expect(progressMessages.some(message => message.includes('bad sql'))).toBe(false);
      expect(progressMessages.some(message => message.includes('SQL 查询错误'))).toBe(false);
      expect(progressMessages).toEqual(expect.arrayContaining([
        'SQL 查询未产出可用结果，已记录诊断信息供修正后重试。',
      ]));
    });

    it('invoke_skill emits sourced zero-row display results as auditable evidence', async () => {
      const { tools, emittedUpdates, mockSkillExecutor } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [{ id: 'p1', name: 'Skill evidence', goal: 'Check empty skill result', expectedTools: ['invoke_skill'] }],
        successCriteria: 'Empty skill outputs remain visible',
      });
      await callTool(tools, 'update_plan_phase', { phaseId: 'p1', status: 'in_progress' });

      (mockSkillExecutor.execute as any).mockResolvedValueOnce({
        skillId: 'startup_analysis',
        success: true,
        displayResults: [{
          stepId: 'empty_launches',
          title: 'No launch rows',
          layer: 'list',
          format: 'table',
          data: { rows: [], columns: ['launch_id', 'dur_ms'] },
        }],
        diagnostics: [],
        executionTimeMs: 5,
      });

      const result = await callTool(tools, 'invoke_skill', { skillId: 'startup_analysis', params: {} });
      const envelope = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? [])
        .find((env: any) => env.display?.title === 'No launch rows');

      expect(result.success).toBe(true);
      expect(envelope).toMatchObject({
        data: { rows: [], columns: ['launch_id', 'dur_ms'] },
        display: { format: 'table', title: 'No launch rows' },
        meta: {
          skillId: 'startup_analysis',
          stepId: 'empty_launches',
          planPhaseId: 'p1',
          planPhaseAttribution: 'active',
        },
      });
      expect(envelope?.meta?.evidenceRefId).toContain('data:skill:startup_analysis:empty_launches');
      expect(envelope?.meta?.producerReason).toContain('startup_analysis');
    });

    it('execute_sql should warn when raw SQL bypasses process identity gate', async () => {
      const { tools } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [{ id: 'p1', name: 'Test', goal: 'Test', expectedTools: ['execute_sql'] }],
        successCriteria: 'Test done',
      });

      const raw = await tools.get('execute_sql')?.handler({
        sql: "SELECT * FROM process p WHERE p.name GLOB 'com.example*'",
      });
      const text = raw?.content?.find((c: any) => c.type === 'text')?.text || '';

      expect(text).toContain('processIdentityWarning');
      expect(text).toContain('Process Identity Gate');
    });

    it('planning-exempt tools should work without plan', async () => {
      const { tools } = createTestServer();
      // These should NOT require a plan
      const listResult = await callTool(tools, 'list_skills', {});
      expect(listResult).toBeDefined();
      // list_skills returns an array of skill objects
      expect(Array.isArray(listResult)).toBe(true);
      expect(listResult.length).toBeGreaterThan(0);
    });

    it('lookup_sql_schema returns stdlib_docs module metadata without a plan', async () => {
      const { tools } = createTestServer();
      const result = await callTool(tools, 'lookup_sql_schema', { keyword: 'android_frames' });
      const frameEntry = result.entries.find((entry: any) => entry.name === 'android_frames');

      expect(result.sources.stdlibDocs).toBeGreaterThan(0);
      expect(frameEntry.module).toBe('android.frames.timeline');
      expect(frameEntry.include).toBe('INCLUDE PERFETTO MODULE android.frames.timeline;');
      expect(frameEntry.transitiveIncludes).toEqual(expect.arrayContaining(['slices.with_context']));
    });
  });

  describe('comparison trace provenance (M3)', () => {
    it('execute_sql_on routes reference SQL to the reference trace and returns provenance', async () => {
      const { tools, mockTpService } = createTestServer({ referenceTraceId: 'ref-trace-456' });
      await callTool(tools, 'submit_plan', {
        phases: [{ id: 'p1', name: 'Compare', goal: 'Query reference trace', expectedTools: ['execute_sql_on'] }],
        successCriteria: 'Reference query is provenanced',
      });

      const result = await callTool(tools, 'execute_sql_on', { trace: 'reference', sql: 'SELECT 1' });

      expect(mockTpService.query).toHaveBeenCalledWith('ref-trace-456', 'SELECT 1');
      expect(result.success).toBe(true);
      expect(result.traceSide).toBe('reference');
      expect(result.traceId).toBe('ref-trace-456');
      expect(result.traceProvenance).toMatchObject({
        traceSide: 'reference',
        traceId: 'ref-trace-456',
        databaseScope: {
          traceSide: 'reference',
          traceId: 'ref-trace-456',
          processorKey: 'ref-trace-456',
          isolation: 'shared',
        },
        connectionScope: {
          connectionKey: 'ref-trace-456',
        },
      });
    });

    it('execute_sql_on summary emits a sourced summary DataEnvelope tied to the active plan phase', async () => {
      const { tools, emittedUpdates } = createTestServer({ referenceTraceId: 'ref-trace-456' });
      await callTool(tools, 'submit_plan', {
        phases: [{ id: 'p1', name: 'Compare', goal: 'Collect reference summary', expectedTools: ['execute_sql_on'] }],
        successCriteria: 'Summary output is provenanced',
      });
      await callTool(tools, 'update_plan_phase', {
        phaseId: 'p1',
        status: 'in_progress',
        summary: 'Collecting reference SQL summary evidence',
      });

      const result = await callTool(tools, 'execute_sql_on', {
        trace: 'reference',
        sql: 'SELECT id FROM slice',
        summary: true,
      });

      const envelope = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? [])
        .find((env: any) => env.display?.format === 'summary');

      expect(result.success).toBe(true);
      expect(result.evidenceRefId).toBe(envelope?.meta?.evidenceRefId);
      expect(result.sourceToolCallId).toBe(envelope?.meta?.sourceToolCallId);
      expect(result.planPhaseId).toBe('p1');
      expect(envelope?.meta?.planPhaseAttribution).toBe('active');
      expect(envelope).toMatchObject({
        display: { format: 'summary', layer: 'overview' },
        meta: {
          traceSide: 'reference',
          traceId: 'ref-trace-456',
          planPhaseId: 'p1',
          planPhaseTitle: 'Compare',
          planPhaseGoal: 'Collect reference summary',
          planPhaseAttribution: 'active',
          intent: 'ad_hoc_sql_summary',
        },
      });
      expect(envelope?.meta?.producerReason).toContain('参考 Trace');
      expect(envelope?.data?.summary?.metrics).toEqual(expect.arrayContaining([
        expect.objectContaining({ label: 'total_rows' }),
      ]));
    });

    it('auto-starts a unique pending phase when no phase is active', async () => {
      const { tools, emittedUpdates } = createTestServer({ referenceTraceId: 'ref-trace-456' });
      await callTool(tools, 'submit_plan', {
        phases: [{ id: 'p1', name: 'Compare', goal: 'Collect reference summary', expectedTools: ['execute_sql_on'] }],
        successCriteria: 'Summary output is provenanced',
      });

      const result = await callTool(tools, 'execute_sql_on', {
        trace: 'reference',
        sql: 'SELECT id FROM slice',
      });

      const envelope = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? [])
        .find((env: any) => env.display?.format === 'table');

      expect(result.success).toBe(true);
      expect(result.planPhaseId).toBe('p1');
      expect(envelope?.meta?.planPhaseId).toBe('p1');
      expect(envelope?.meta?.planPhaseAttribution).toBe('active');
      expect(envelope?.meta?.planPhaseWarning).toBeUndefined();
      expect(emittedUpdates.find((u: any) => u.type === 'plan_phase_updated')?.content).toMatchObject({
        phaseId: 'p1',
        status: 'in_progress',
      });
    });

    it('leaves evidence unbound when multiple pending phases match the same tool', async () => {
      const { tools, emittedUpdates } = createTestServer({ referenceTraceId: 'ref-trace-456' });
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: 'Compare A', goal: 'Collect first reference slice', expectedTools: ['execute_sql_on'] },
          { id: 'p2', name: 'Compare B', goal: 'Collect second reference slice', expectedTools: ['execute_sql_on'] },
        ],
        successCriteria: 'Ambiguous pending matches are surfaced',
      });

      const result = await callTool(tools, 'execute_sql_on', {
        trace: 'reference',
        sql: 'SELECT id FROM slice',
      });

      const envelope = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? [])
        .find((env: any) => env.display?.format === 'table');

      expect(result.success).toBe(true);
      expect(result.planPhaseId).toBeUndefined();
      expect(envelope?.meta?.planPhaseId).toBeUndefined();
      expect(envelope?.meta?.planPhaseAttribution).toBe('ambiguous');
      expect(envelope?.meta?.planPhaseWarning).toContain('都匹配');
    });

    it('uses skill and phase semantics to disambiguate broad pending invoke_skill phases', async () => {
      const { tools, emittedUpdates } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p3', name: '根因深钻', goal: '对主要 reason_code 执行 jank_frame_detail 和 frame_blocking_calls 深钻', expectedTools: ['invoke_skill'] },
          { id: 'p4', name: '缺帧检测', goal: '检测帧间 gap 和隐形缺帧', expectedTools: ['invoke_skill'] },
        ],
        successCriteria: 'Broad invoke_skill phases remain attributable',
      });

      const result = await callTool(tools, 'invoke_skill', {
        skillId: 'frame_production_gap',
        params: { process_name: 'com.example' },
      });
      const envelope = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? [])
        .find((env: any) => env.meta?.skillId === 'frame_production_gap');

      expect(result.success).toBe(true);
      expect(envelope?.meta?.planPhaseId).toBe('p4');
      expect(envelope?.meta?.planPhaseAttribution).toBe('active');
      expect(envelope?.meta?.planPhaseWarning).toBeUndefined();
    });

    it('binds jank_frame_detail to the root-cause drill phase instead of broad classification', async () => {
      const { tools, emittedUpdates } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p2', name: '逐帧根因分类', goal: '获取全量掉帧帧的 reason_code 分布和四象限/频率数据', expectedTools: ['invoke_skill', 'fetch_artifact'] },
          { id: 'p3', name: '根因深钻', goal: '对每个占比大于15%的 reason_code 选最严重帧做机制级分析', expectedTools: ['invoke_skill', 'lookup_knowledge', 'fetch_artifact'] },
        ],
        successCriteria: 'Deep frame tables should stay attached to the drill phase',
      });

      const result = await callTool(tools, 'invoke_skill', {
        skillId: 'jank_frame_detail',
        params: { process_name: 'com.example', start_ts: '100', end_ts: '200', jank_type: 'App Deadline Missed' },
      });
      const envelope = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? [])
        .find((env: any) => env.meta?.skillId === 'jank_frame_detail');

      expect(result.success).toBe(true);
      expect(envelope?.meta?.planPhaseId).toBe('p3');
      expect(envelope?.meta?.planPhaseAttribution).toBe('active');
      expect(envelope?.meta?.planPhaseWarning).toBeUndefined();
    });

    it('switches from a broad active overview phase to a stronger pending drill phase', async () => {
      const { tools, emittedUpdates, analysisPlan } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: '架构检测与数据收集', goal: '检测渲染架构、获取帧统计和卡顿分布概览', expectedTools: ['invoke_skill', 'execute_sql'] },
          { id: 'p2', name: '逐帧根因分类', goal: '获取所有掉帧帧的根因分类和统计指标', expectedTools: ['fetch_artifact'] },
          { id: 'p3', name: '根因深钻', goal: '对占比大于15%的reason_code逐帧深钻，获取机制级证据', expectedTools: ['invoke_skill', 'lookup_knowledge', 'fetch_artifact'] },
        ],
        successCriteria: 'Deep evidence should not stay attached to overview only because overview declared invoke_skill',
      });
      await callTool(tools, 'update_plan_phase', { phaseId: 'p1', status: 'in_progress' });

      const result = await callTool(tools, 'invoke_skill', {
        skillId: 'jank_frame_detail',
        params: { process_name: 'com.example', start_ts: '100', end_ts: '200', jank_type: 'App Deadline Missed' },
      });
      const envelope = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? [])
        .find((env: any) => env.meta?.skillId === 'jank_frame_detail');

      expect(result.success).toBe(true);
      expect(envelope?.meta?.planPhaseId).toBe('p3');
      expect(envelope?.meta?.planPhaseAttribution).toBe('active');
      expect(envelope?.meta?.planPhaseWarning).toBeUndefined();
      const p1 = analysisPlan.current?.phases.find(p => p.id === 'p1');
      expect(p1?.status).toBe('completed');
      expect(p1?.summary).toContain('自动完成阶段');
      expect(analysisPlan.current?.phases.find(p => p.id === 'p3')?.status).toBe('in_progress');
    });

    it('semantically binds FrameTimeline overview SQL even when the plan forgot raw SQL', async () => {
      const { tools, emittedUpdates } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: '数据收集与概览', goal: '获取滑动帧统计、掉帧分布、滑动区间列表', expectedTools: ['invoke_skill'] },
          { id: 'p2', name: '逐帧根因分类', goal: '对所有掉帧帧进行批量根因分类', expectedTools: ['fetch_artifact'] },
          { id: 'p3', name: '根因深钻', goal: '对代表帧执行 jank_frame_detail 深钻', expectedTools: ['invoke_skill'] },
        ],
        successCriteria: 'FrameTimeline overview SQL remains attributable',
      });

      const result = await callTool(tools, 'execute_sql', {
        sql: `
          SELECT
            printf('%d', MIN(ts)) as start_ts,
            printf('%d', MAX(ts + dur)) as end_ts,
            COUNT(*) as total_frames,
            COUNT(DISTINCT layer_name) as layer_count
          FROM actual_frame_timeline_slice
        `,
      });
      const envelope = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? [])
        .find((env: any) => env.display?.format === 'table');

      expect(result.success).toBe(true);
      expect(envelope?.meta?.planPhaseId).toBe('p1');
      expect(envelope?.meta?.planPhaseAttribution).toBe('active');
      expect(envelope?.meta?.planPhaseWarning).toBeUndefined();
    });

    it('keeps Trace range SQL on the active overview phase instead of a pending architecture branch', async () => {
      const { tools, emittedUpdates, analysisPlan } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: '架构检测与概览采集', goal: '检测渲染架构并确认 trace 时间边界', expectedTools: ['detect_architecture'] },
          { id: 'p2', name: 'HWUI host 链路分析', goal: '获取 FrameTimeline 帧率统计、掉帧分布和滑动区间', expectedTools: ['execute_sql', 'invoke_skill'] },
          { id: 'p2.5', name: 'Producer 链路补充（如需要）', goal: '如果存在 Flutter/WebView/TextureView 等次级链路，补充生产端证据', expectedTools: ['execute_sql', 'invoke_skill'] },
          { id: 'p3', name: '根因深钻', goal: '对主要卡顿原因进行逐帧深钻，定位根因', expectedTools: ['invoke_skill'] },
        ],
        successCriteria: 'Trace range tables should stay connected to the overview timeline phase',
      });
      await callTool(tools, 'update_plan_phase', { phaseId: 'p1', status: 'in_progress' });

      const result = await callTool(tools, 'execute_sql', {
        sql: "SELECT printf('%d', MIN(ts)) as start_ts, printf('%d', MAX(ts + dur)) as end_ts FROM actual_frame_timeline_slice",
        summary: true,
      });
      const envelope = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? [])
        .find((env: any) => env.display?.format === 'summary');

      expect(result.success).toBe(true);
      expect(envelope?.meta?.planPhaseId).toBe('p1');
      expect(envelope?.meta?.planPhaseAttribution).toBe('active');
      expect(envelope?.meta?.planPhaseWarning).toBeUndefined();
      expect(analysisPlan.current?.phases.find(p => p.id === 'p1')?.status).toBe('in_progress');
      expect(analysisPlan.current?.phases.find(p => p.id === 'p2')?.status).toBe('pending');
    });

    it('treats Trace range SQL as active overview evidence when the overview phase omitted execute_sql', async () => {
      const { tools, emittedUpdates } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: '数据采集与概览', goal: '获取帧统计、掉帧分布、四象限特征和根因分类', expectedTools: ['invoke_skill'] },
          { id: 'p1.5', name: '架构特定掉帧分析与因果合并', goal: '根据架构拆分链路：优先 HWUI host；如检测到 WebView/TextureView/Flutter 等，追加对应 producer 链路分析；最终合并因果', expectedTools: ['execute_sql', 'invoke_skill'] },
          { id: 'p2', name: '根因深钻', goal: '对主要掉帧原因进行逐帧诊断，定位具体瓶颈', expectedTools: ['invoke_skill'] },
        ],
        successCriteria: 'Overview SQL should not be surfaced as an unexpected tool',
      });
      await callTool(tools, 'update_plan_phase', { phaseId: 'p1', status: 'in_progress' });

      const result = await callTool(tools, 'execute_sql', {
        sql: "SELECT printf('%d', MIN(ts)) as start_ts, printf('%d', MAX(ts + dur)) as end_ts FROM actual_frame_timeline_slice",
      });
      const envelope = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? [])
        .find((env: any) => env.display?.format === 'table');

      expect(result.success).toBe(true);
      expect(envelope?.meta?.planPhaseId).toBe('p1');
      expect(envelope?.meta?.planPhaseAttribution).toBe('active');
      expect(envelope?.meta?.planPhaseWarning).toBeUndefined();
    });

    it('prefers the overview phase for FrameTimeline aggregate SQL when later phases also allow SQL', async () => {
      const { tools, emittedUpdates } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: '概览采集', goal: '获取帧统计、卡顿分布、架构确认、trace时间范围', expectedTools: ['execute_sql', 'invoke_skill'] },
          { id: 'p2', name: '逐帧根因诊断', goal: '对所有掉帧帧做根因分类和深钻，回答每帧WHY慢', expectedTools: ['execute_sql', 'invoke_skill'] },
        ],
        successCriteria: 'Overview aggregate SQL should not be attributed to the deep-dive phase',
      });

      const result = await callTool(tools, 'execute_sql', {
        sql: "SELECT printf('%d', MIN(ts)) as start_ts, printf('%d', MAX(ts + dur)) as end_ts, COUNT(*) as frame_count FROM actual_frame_timeline_slice",
      });
      const envelope = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? [])
        .find((env: any) => env.display?.format === 'table');

      expect(result.success).toBe(true);
      expect(envelope?.meta?.planPhaseId).toBe('p1');
      expect(envelope?.meta?.planPhaseAttribution).toBe('active');
    });

    it('does not let a broad raw-SQL expectation steal FrameTimeline overview SQL', async () => {
      const { tools, emittedUpdates } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: '数据采集与概览', goal: '获取滑动帧统计、卡顿分布、滑动区间和 trace 时间范围', expectedTools: ['invoke_skill'] },
          { id: 'p2', name: '根因深钻', goal: '对代表帧执行 jank_frame_detail 深钻，必要时用 execute_sql 补充验证', expectedTools: ['execute_sql', 'invoke_skill'] },
        ],
        successCriteria: 'Generic execute_sql expectations must not override SQL semantic attribution',
      });

      const result = await callTool(tools, 'execute_sql', {
        sql: "SELECT printf('%d', MIN(ts)) as start_ts, printf('%d', MAX(ts + dur)) as end_ts FROM actual_frame_timeline_slice",
      });
      const envelope = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? [])
        .find((env: any) => env.display?.format === 'table');

      expect(result.success).toBe(true);
      expect(envelope?.meta?.planPhaseId).toBe('p1');
      expect(envelope?.meta?.planPhaseAttribution).toBe('active');
      expect(envelope?.meta?.planPhaseWarning).toBeUndefined();
    });

    it('binds late root-cause SQL to the semantic phase even when the plan did not declare raw SQL', async () => {
      const { tools, emittedUpdates } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: '概览采集', goal: '获取帧统计和掉帧分布', expectedTools: ['invoke_skill'] },
          { id: 'p2', name: '根因深钻', goal: '对代表帧做机制级证据深钻，检查主线程阻塞和热点 slice', expectedTools: ['invoke_skill'] },
        ],
        successCriteria: 'Late ad-hoc SQL tables remain tied to the root-cause phase',
      });
      await callTool(tools, 'update_plan_phase', {
        phaseId: 'p2',
        status: 'completed',
        summary: '已完成代表帧机制深钻，继续补查线程状态表',
      });

      const result = await callTool(tools, 'execute_sql', {
        sql: `
          SELECT state, SUM(dur) AS total_ns
          FROM thread_state
          WHERE utid = 1
          GROUP BY state
        `,
      });
      const envelope = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? [])
        .find((env: any) => env.display?.format === 'table');

      expect(result.success).toBe(true);
      expect(envelope?.meta?.planPhaseId).toBe('p2');
      expect(envelope?.meta?.planPhaseAttribution).toBe('inferred');
      expect(envelope?.meta?.planPhaseWarning).toContain('最近完成');
    });

    it('keeps active-phase SQL active when the phase omitted execute_sql but the SQL matches its goal', async () => {
      const { tools, emittedUpdates } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: '启动概览', goal: '获取启动事件和概览', expectedTools: ['invoke_skill'] },
          { id: 'p2', name: '附加诊断', goal: '内存压力检测、启动慢原因检测、阻塞链分析', expectedTools: ['invoke_skill'] },
        ],
        successCriteria: 'Ad-hoc SQL used as phase evidence should not become timeline noise',
      });
      await callTool(tools, 'update_plan_phase', { phaseId: 'p2', status: 'in_progress' });

      const result = await callTool(tools, 'execute_sql', {
        sql: `
          SELECT ts.state, SUM(ts.dur) AS total_ns
          FROM thread_state ts
          WHERE ts.utid = 948
          GROUP BY ts.state
        `,
      });
      const envelope = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? [])
        .find((env: any) => env.display?.format === 'table');

      expect(result.success).toBe(true);
      expect(envelope?.meta?.planPhaseId).toBe('p2');
      expect(envelope?.meta?.planPhaseAttribution).toBe('active');
      expect(envelope?.meta?.planPhaseWarning).toBeUndefined();
    });

    it('keeps active root-cause slice SQL active even when the phase omitted execute_sql', async () => {
      const { tools, emittedUpdates } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: '根因深钻', goal: '对代表帧做机制级证据深钻，检查主线程阻塞和热点 slice', expectedTools: ['invoke_skill'] },
          { id: 'p2', name: '综合结论', goal: '整合证据输出报告', expectedTools: [] },
        ],
        successCriteria: 'Ad-hoc slice SQL used in root-cause drill should not be marked unexpected',
      });
      await callTool(tools, 'update_plan_phase', { phaseId: 'p1', status: 'in_progress' });

      const result = await callTool(tools, 'execute_sql', {
        sql: `
          SELECT s.name AS slice_name, s.dur / 1e6 AS dur_ms
          FROM slice s
          WHERE s.name GLOB '*CustomScroll_longFrameLoad*'
          ORDER BY s.dur DESC
        `,
        summary: true,
      });
      const envelope = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? [])
        .find((env: any) => env.display?.format === 'summary');

      expect(result.success).toBe(true);
      expect(envelope?.meta?.planPhaseId).toBe('p1');
      expect(envelope?.meta?.planPhaseAttribution).toBe('active');
      expect(envelope?.meta?.planPhaseWarning).toBeUndefined();
    });

    it('keeps semantically expected blocking_chain_analysis active when the phase omitted that skill', async () => {
      const { tools, emittedUpdates } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: '启动详情深钻', goal: '获取四象限分析、热点 slice 根因、关键任务、阻塞关系图、Binder/IO 详情', expectedTools: ['execute_sql'] },
        ],
        successCriteria: 'Blocking-chain evidence belongs to the blocking relationship phase',
      });
      await callTool(tools, 'update_plan_phase', { phaseId: 'p1', status: 'in_progress' });

      const result = await callTool(tools, 'invoke_skill', {
        skillId: 'blocking_chain_analysis',
        params: { process_name: 'com.example', start_ts: '100', end_ts: '200' },
      });
      const envelope = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? [])
        .find((env: any) => env.meta?.skillId === 'blocking_chain_analysis');

      expect(result.success).toBe(true);
      expect(envelope?.meta?.planPhaseId).toBe('p1');
      expect(envelope?.meta?.planPhaseAttribution).toBe('active');
      expect(envelope?.meta?.planPhaseWarning).toBeUndefined();
    });

    it('keeps blocking_chain_analysis active for generic root-cause drill phases that omit the skill', async () => {
      const { tools, emittedUpdates } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: '根因深钻', goal: '对主要根因类别执行深入诊断，确认具体原因和机制', expectedTools: ['invoke_skill'] },
          { id: 'p2', name: '综合结论', goal: '输出最终报告', expectedTools: [] },
        ],
        successCriteria: 'Root-cause drill tools should not depend on a perfect expectedTools list',
      });
      await callTool(tools, 'update_plan_phase', { phaseId: 'p1', status: 'in_progress' });

      const result = await callTool(tools, 'invoke_skill', {
        skillId: 'blocking_chain_analysis',
        params: { process_name: 'com.example', start_ts: '100', end_ts: '200' },
      });
      const envelope = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? [])
        .find((env: any) => env.meta?.skillId === 'blocking_chain_analysis');

      expect(result.success).toBe(true);
      expect(envelope?.meta?.planPhaseId).toBe('p1');
      expect(envelope?.meta?.planPhaseAttribution).toBe('active');
      expect(envelope?.meta?.planPhaseWarning).toBeUndefined();
    });

    it('infers the pending matching phase when the active phase has stale status', async () => {
      const { tools, emittedUpdates, analysisPlan } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: '启动概览', goal: '获取启动事件和概览', expectedTools: ['execute_sql'] },
          { id: 'p2', name: '启动详情', goal: '调用 startup_detail 下钻四象限、热点和阻塞关系', expectedTools: ['invoke_skill'] },
        ],
        successCriteria: 'Stale active phase should not steal later evidence',
      });
      await callTool(tools, 'update_plan_phase', { phaseId: 'p1', status: 'in_progress' });

      const result = await callTool(tools, 'invoke_skill', {
        skillId: 'startup_detail',
        params: { process_name: 'com.example' },
      });
      const envelope = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? [])
        .find((env: any) => env.meta?.skillId === 'startup_detail');

      expect(result.success).toBe(true);
      expect(envelope?.meta?.planPhaseId).toBe('p2');
      expect(envelope?.meta?.planPhaseAttribution).toBe('active');
      expect(envelope?.meta?.planPhaseWarning).toBeUndefined();
    });

    it('uses semantic fallback when expectedCalls omit a root-cause skill', async () => {
      const { tools, emittedUpdates, analysisPlan } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          {
            id: 'p2',
            name: '启动详情与关键数据获取',
            goal: '获取四象限分析、热点操作、线程状态、CPU频率、Binder/IO 详情',
            expectedTools: ['invoke_skill', 'fetch_artifact'],
            expectedCalls: [{ tool: 'invoke_skill', skillId: 'startup_detail' }],
          },
          {
            id: 'p3',
            name: '根因深钻与交叉验证',
            goal: 'per-slice 线程状态分析、启动慢原因检测、内存压力检测、阻塞链追踪',
            expectedTools: ['invoke_skill', 'fetch_artifact'],
            expectedCalls: [
              { tool: 'invoke_skill', skillId: 'startup_slow_reasons' },
              { tool: 'invoke_skill', skillId: 'blocking_chain_analysis' },
            ],
          },
        ],
        successCriteria: 'Root-cause evidence should follow phase semantics even when expectedCalls are incomplete',
      });
      await callTool(tools, 'update_plan_phase', { phaseId: 'p2', status: 'in_progress' });

      const result = await callTool(tools, 'invoke_skill', {
        skillId: 'memory_pressure_in_range',
        params: { process_name: 'com.example', start_ts: '100', end_ts: '200' },
      });
      const envelope = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? [])
        .find((env: any) => env.meta?.skillId === 'memory_pressure_in_range');

      expect(result.success).toBe(true);
      expect(envelope?.meta?.planPhaseId).toBe('p3');
      expect(envelope?.meta?.planPhaseAttribution).toBe('active');
      expect(envelope?.meta?.planPhaseWarning).toBeUndefined();
      expect(analysisPlan.current?.phases.find(p => p.id === 'p2')?.status).toBe('completed');
      expect(analysisPlan.current?.phases.find(p => p.id === 'p3')?.status).toBe('in_progress');
    });

    it('binds pending WebView startup SQL to the WebView phase instead of the generic conclusion phase', async () => {
      const { tools, emittedUpdates } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p2.8', name: 'WebView启动分析', goal: 'WebView架构特有分析：Chromium初始化、V8引擎、CrRendererMain、页面渲染' },
          { id: 'p3', name: '综合结论', goal: '综合所有证据给出结构化报告：概览、关键发现、根因分析树、优化建议' },
        ],
        successCriteria: 'WebView verification SQL should stay attached to the WebView phase',
      });

      const result = await callTool(tools, 'execute_sql', {
        sql: `
          SELECT name AS slice_name, dur / 1e6 AS dur_ms, thread_name
          FROM thread_slice
          WHERE process_name GLOB 'com.example.launch.aosp.heavy*'
            AND (name GLOB '*WebViewChromium*' OR name GLOB '*v8.*' OR thread_name = 'CrRendererMain')
          ORDER BY dur DESC
          LIMIT 20
        `,
      });
      const envelope = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? [])
        .find((env: any) => env.meta?.source === 'execute_sql');

      expect(result.success).toBe(true);
      expect(envelope?.meta?.planPhaseId).toBe('p2.8');
      expect(envelope?.meta?.planPhaseAttribution).toBe('active');
      expect(envelope?.meta?.planPhaseWarning).toBeUndefined();
      expect(emittedUpdates).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'plan_phase_updated',
          content: expect.objectContaining({ phaseId: 'p2.8', status: 'in_progress' }),
        }),
      ]));
    });

    it('binds late evidence to a recently completed matching phase instead of dropping phase context', async () => {
      const { tools, emittedUpdates } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: 'WebView启动分析', goal: 'WebView架构特有分析：Chromium初始化、V8引擎、页面渲染', expectedTools: ['execute_sql'] },
          { id: 'p2', name: '综合结论', goal: '输出最终报告', expectedTools: [] },
        ],
        successCriteria: 'Late SQL remains tied to the phase it is verifying',
      });
      await callTool(tools, 'update_plan_phase', {
        phaseId: 'p1',
        status: 'completed',
        summary: '已完成 WebView slice 初查，继续核对 RenderThread 数据',
      });

      const result = await callTool(tools, 'execute_sql', {
        sql: "SELECT name AS slice_name FROM thread_slice WHERE name GLOB '*WebView*'",
      });
      const envelope = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? [])
        .find((env: any) => env.display?.format === 'table');

      expect(result.success).toBe(true);
      expect(envelope?.meta?.planPhaseId).toBe('p1');
      expect(envelope?.meta?.planPhaseAttribution).toBe('inferred');
      expect(envelope?.meta?.planPhaseWarning).toContain('最近完成');
    });

    it('keeps only one active plan phase for evidence attribution', async () => {
      const { tools, emittedUpdates, analysisPlan } = createTestServer({ referenceTraceId: 'ref-trace-456' });
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: 'First', goal: 'Old phase', expectedTools: ['execute_sql_on'] },
          { id: 'p2', name: 'Second', goal: 'Current phase', expectedTools: ['execute_sql_on'] },
        ],
        successCriteria: 'Only one phase is active',
      });
      await callTool(tools, 'update_plan_phase', { phaseId: 'p1', status: 'in_progress' });
      await callTool(tools, 'update_plan_phase', { phaseId: 'p2', status: 'in_progress' });

      const result = await callTool(tools, 'execute_sql_on', {
        trace: 'reference',
        sql: 'SELECT id FROM slice',
      });

      const envelope = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? [])
        .find((env: any) => env.display?.format === 'table');

      expect(analysisPlan.current?.phases.map(p => [p.id, p.status])).toEqual([
        ['p1', 'completed'],
        ['p2', 'in_progress'],
      ]);
      expect(analysisPlan.current?.phases.find(p => p.id === 'p1')?.summary).toContain('自动完成阶段');
      expect(result.planPhaseId).toBe('p2');
      expect(envelope?.meta?.planPhaseId).toBe('p2');
      expect(envelope?.meta?.planPhaseAttribution).toBe('active');
    });

    it('includes produced evidence tables when auto-closing a phase', async () => {
      const { tools, analysisPlan } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: 'Collect', goal: 'Collect overview evidence', expectedTools: ['invoke_skill'] },
          { id: 'p2', name: 'Conclude', goal: 'Write final answer', expectedTools: ['fetch_artifact'] },
        ],
        successCriteria: 'Auto completion should preserve concrete evidence context',
      });
      await callTool(tools, 'update_plan_phase', { phaseId: 'p1', status: 'in_progress' });
      await callTool(tools, 'invoke_skill', { skillId: 'scrolling_analysis', params: { process_name: 'com.example' } });
      await callTool(tools, 'update_plan_phase', { phaseId: 'p2', status: 'in_progress' });

      const p1 = analysisPlan.current?.phases.find(p => p.id === 'p1');
      expect(p1?.status).toBe('completed');
      expect(p1?.summary).toContain('自动完成阶段');
      expect(p1?.summary).toContain('1 个证据表');
      expect(p1?.summary).toContain('scrolling_analysis');
      expect(p1?.summary).toContain('Result');
      expect(p1?.summary).toContain('Collect overview evidence');
    });

    it('backfills an earlier pending phase instead of rewinding the active phase', async () => {
      const { tools, emittedUpdates, analysisPlan } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p2.5', name: '关键数据获取', goal: '获取 artifact 和 WebView SQL 证据', expectedTools: ['execute_sql'] },
          { id: 'p2.6', name: '启动慢原因检测', goal: '调用 startup_slow_reasons 交叉验证慢启动原因', expectedTools: ['invoke_skill'] },
        ],
        successCriteria: 'Late evidence should not move the timeline backwards',
      });
      await callTool(tools, 'update_plan_phase', {
        phaseId: 'p2.6',
        status: 'in_progress',
        summary: '正在验证启动慢原因',
      });

      const result = await callTool(tools, 'execute_sql', {
        sql: "SELECT name FROM thread_slice WHERE name GLOB '*WebViewChromium*'",
      });
      const envelope = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? [])
        .find((env: any) => env.meta?.source === 'execute_sql');

      expect(result.success).toBe(true);
      expect(analysisPlan.current?.phases.map(p => [p.id, p.status])).toEqual([
        ['p2.5', 'completed'],
        ['p2.6', 'in_progress'],
      ]);
      expect(envelope?.meta?.planPhaseId).toBe('p2.5');
      expect(envelope?.meta?.planPhaseAttribution).toBe('inferred');
      expect(envelope?.meta?.planPhaseWarning).toContain('补记阶段');
      expect(emittedUpdates).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'plan_phase_updated',
          content: expect.objectContaining({ phaseId: 'p2.5', status: 'completed' }),
        }),
      ]));
    });

    it('keeps stable SQL evidence IDs independent from tool-call order', async () => {
      async function run(extraToolCall: boolean) {
        const { tools, emittedUpdates } = createTestServer({ referenceTraceId: 'ref-trace-456' });
        await callTool(tools, 'submit_plan', {
          phases: [{ id: 'p1', name: 'Compare', goal: 'Collect reference summary', expectedTools: ['execute_sql_on', 'invoke_skill'] }],
          successCriteria: 'Evidence IDs are stable',
        });
        await callTool(tools, 'update_plan_phase', { phaseId: 'p1', status: 'in_progress' });
        if (extraToolCall) {
          await callTool(tools, 'invoke_skill', { skillId: 'scrolling_analysis', params: {} });
        }
        const result = await callTool(tools, 'execute_sql_on', {
          trace: 'reference',
          sql: 'SELECT id FROM slice',
        });
        const sqlEnvelopes = emittedUpdates
          .filter((u: any) => u.type === 'data')
          .flatMap((u: any) => u.content ?? [])
          .filter((env: any) => env.meta?.source === 'execute_sql');
        const envelope = sqlEnvelopes[sqlEnvelopes.length - 1];
        return { result, envelope };
      }

      const direct = await run(false);
      const afterSkill = await run(true);

      expect(direct.result.evidenceRefId).toBe(afterSkill.result.evidenceRefId);
      expect(direct.envelope?.meta?.evidenceRefId).toBe(afterSkill.envelope?.meta?.evidenceRefId);
      expect(direct.result.sourceToolCallId).not.toBe(afterSkill.result.sourceToolCallId);
    });

    it('emits sourced DataEnvelopes for empty SQL results but keeps failed SQL diagnostics out of frontend data', async () => {
      const { tools, emittedUpdates, mockTpService } = createTestServer({ referenceTraceId: 'ref-trace-456' });
      await callTool(tools, 'submit_plan', {
        phases: [{ id: 'p1', name: 'Compare', goal: 'Collect SQL evidence', expectedTools: ['execute_sql_on'] }],
        successCriteria: 'SQL outputs are explainable even when empty or failed',
      });
      await callTool(tools, 'update_plan_phase', { phaseId: 'p1', status: 'in_progress' });

      (mockTpService.query as any)
        .mockResolvedValueOnce({ columns: ['id'], rows: [], rowCount: 0, durationMs: 1 })
        .mockResolvedValueOnce({ columns: [], rows: [], rowCount: 0, durationMs: 1, error: 'bad sql' });

      const emptyResult = await callTool(tools, 'execute_sql_on', {
        trace: 'reference',
        sql: 'SELECT id FROM slice WHERE 0',
      });
      const failedResult = await callTool(tools, 'execute_sql_on', {
        trace: 'reference',
        sql: 'SELECT * FROM missing_table',
      });

      const envelopes = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? []);
      const emptyEnvelope = envelopes.find((env: any) => env.sql === 'SELECT id FROM slice WHERE 0');
      const diagnosticEnvelope = envelopes.find((env: any) => env.display?.format === 'text' && env.meta?.type === 'diagnostic');

      expect(emptyResult.success).toBe(true);
      expect(emptyEnvelope).toMatchObject({
        data: { columns: ['id'], rows: [] },
        display: { format: 'table' },
        meta: { evidenceRefId: emptyResult.evidenceRefId },
      });
      expect(failedResult.success).toBe(false);
      expect(failedResult.evidenceRefId).toBeUndefined();
      expect(diagnosticEnvelope).toBeUndefined();
      expect(failedResult.diagnostic).toMatchObject({
        type: 'sql_execution_failed',
        citableEvidence: false,
      });
      expect(failedResult.diagnostic?.message).toContain('不是可引用的性能证据');
      expect(failedResult.error).toContain('bad sql');
    });

    it('compare_skill executes both traces and emits side provenance envelopes', async () => {
      const { tools, mockSkillExecutor, emittedUpdates } = createTestServer({ referenceTraceId: 'ref-trace-456' });
      await callTool(tools, 'submit_plan', {
        phases: [{ id: 'p1', name: 'Compare', goal: 'Run both traces', expectedTools: ['compare_skill'] }],
        successCriteria: 'Both skill results are side-labeled',
      });

      const result = await callTool(tools, 'compare_skill', {
        skillId: 'scrolling_analysis',
        params: { process_name: 'com.example' },
      });

      expect(mockSkillExecutor.execute).toHaveBeenNthCalledWith(
        1,
        'scrolling_analysis',
        'test-trace-123',
        { process_name: 'com.example', package: 'com.example' },
        { __traceSide: 'current' },
      );
      expect(mockSkillExecutor.execute).toHaveBeenNthCalledWith(
        2,
        'scrolling_analysis',
        'ref-trace-456',
        { process_name: 'com.example', package: 'com.example' },
        { __traceSide: 'reference' },
      );
      expect(result.success).toBe(true);
      expect(result.current).toMatchObject({
        traceSide: 'current',
        traceId: 'test-trace-123',
        traceProvenance: {
          traceSide: 'current',
          traceId: 'test-trace-123',
          databaseScope: { processorKey: 'test-trace-123', isolation: 'shared' },
        },
      });
      expect(result.reference).toMatchObject({
        traceSide: 'reference',
        traceId: 'ref-trace-456',
        traceProvenance: {
          traceSide: 'reference',
          traceId: 'ref-trace-456',
          databaseScope: { processorKey: 'ref-trace-456', isolation: 'shared' },
        },
      });

      const envelopes = emittedUpdates
        .filter((u: any) => u.type === 'data')
        .flatMap((u: any) => u.content ?? []);
      expect(envelopes).toEqual(expect.arrayContaining([
        expect.objectContaining({ traceSide: 'current', traceId: 'test-trace-123' }),
        expect.objectContaining({ traceSide: 'reference', traceId: 'ref-trace-456' }),
      ]));
    });
  });

  describe('submit_plan', () => {
    it('should create a plan with phases', async () => {
      const { tools, analysisPlan } = createTestServer();
      const result = await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: 'Collect', goal: 'Get frame data', expectedTools: ['execute_sql'] },
          { id: 'p2', name: 'Analyze', goal: 'Find root cause', expectedTools: ['invoke_skill'] },
        ],
        successCriteria: 'Identify jank root cause',
      });
      expect(result.success).toBe(true);
      expect(analysisPlan.current?.phases).toHaveLength(2);
      expect(analysisPlan.current?.successCriteria).toBe('Identify jank root cause');
    });

    it('accepts JSON-string phases from OpenAI-compatible tool callers', async () => {
      const { tools, analysisPlan } = createTestServer();
      const result = await callTool(tools, 'submit_plan', {
        phases: JSON.stringify([
          { id: 'p1', name: 'Collect', goal: 'Get startup data', expectedTools: '["invoke_skill","fetch_artifact"]' },
        ]),
        successCriteria: 'Identify startup root cause',
        waivers: '[]',
      });

      expect(result.success).toBe(true);
      expect(analysisPlan.current?.phases).toHaveLength(1);
      expect(analysisPlan.current?.phases[0].expectedTools).toEqual(['invoke_skill', 'fetch_artifact']);
    });

    it('treats null-like waiver strings as empty waivers from OpenAI-compatible callers', async () => {
      const { tools, analysisPlan } = createTestServer();
      const result = await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: 'Collect', goal: 'Get startup data', expectedTools: ['invoke_skill'] },
        ],
        successCriteria: 'Identify startup root cause',
        waivers: 'null',
      });

      expect(result.success).toBe(true);
      expect(analysisPlan.current?.phases).toHaveLength(1);
      expect(analysisPlan.current?.waivers).toBeUndefined();
    });

    it('accepts JSON-ish string phases with unquoted object keys from tool callers', async () => {
      const { tools, analysisPlan } = createTestServer();
      const result = await callTool(tools, 'submit_plan', {
        phases: '[{"id":"p1", name:"Collect", goal:"Get startup data", expectedTools:["invoke_skill"]}]',
        successCriteria: 'Tolerate common SDK argument serialization drift',
      });

      expect(result.success).toBe(true);
      expect(analysisPlan.current?.phases).toHaveLength(1);
      expect(analysisPlan.current?.phases[0].name).toBe('Collect');
    });

    it('accepts JSON-ish string phases with missing opening quotes on object keys', async () => {
      const { tools, analysisPlan } = createTestServer();
      const result = await callTool(tools, 'submit_plan', {
        phases: '[{"id":"p1", name":"Collect", goal":"Get startup data", expectedTools":["invoke_skill"]}]',
        successCriteria: 'Tolerate half-quoted tool argument keys',
      });

      expect(result.success).toBe(true);
      expect(analysisPlan.current?.phases).toHaveLength(1);
      expect(analysisPlan.current?.phases[0].expectedTools).toEqual(['invoke_skill']);
    });

    it('accepts JSON-ish string phases with a trailing comma after the array', async () => {
      const { tools, analysisPlan } = createTestServer();
      const result = await callTool(tools, 'submit_plan', {
        phases: '[{"id":"p1", name":"Collect", goal":"Get frame data", expectedTools":["invoke_skill"]}],',
        successCriteria: 'Tolerate trailing comma from streamed tool arguments',
      });

      expect(result.success).toBe(true);
      expect(analysisPlan.current?.phases).toHaveLength(1);
      expect(analysisPlan.current?.phases[0].name).toBe('Collect');
    });

    it('moves conclusion-like phases after later data-collection phases', async () => {
      const { tools, analysisPlan } = createTestServer();
      const result = await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: '启动概览', goal: '获取启动事件', expectedTools: ['invoke_skill'] },
          { id: 'p2', name: '综合结论', goal: '输出最终报告', expectedTools: [] },
          { id: 'p3', name: 'WebView专项分析', goal: '继续验证 WebView slice', expectedTools: ['execute_sql'] },
        ],
        successCriteria: 'Conclusion should be last',
      });

      expect(result.success).toBe(true);
      expect(analysisPlan.current?.phases.map(p => p.id)).toEqual(['p1', 'p3', 'p2']);
    });
  });

  describe('update_plan_phase', () => {
    it('accepts active as an alias for in_progress', async () => {
      const { tools, analysisPlan } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: 'Collect', goal: 'Get frame data', expectedTools: ['execute_sql'] },
        ],
        successCriteria: 'Identify jank root cause',
      });

      const toolDef = tools.get('update_plan_phase');
      expect(toolDef?.schema?.status?.safeParse('active').success).toBe(true);

      const result = await callTool(tools, 'update_plan_phase', { phaseId: 'p1', status: 'active' });

      expect(result.success).toBe(true);
      expect(analysisPlan.current?.phases[0].status).toBe('in_progress');
    });

    it('does not inject next-phase reminders when merely starting a phase', async () => {
      const { tools } = createTestServer({ sceneType: 'scrolling' });
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: 'TextureView 架构检测', goal: '确认混合渲染架构类型，判断是否为 TextureView producer 场景', expectedTools: ['invoke_skill'] },
          { id: 'p2', name: '滑动帧卡顿概览', goal: '获取 scroll frame jank 帧统计和掉帧分布', expectedTools: ['invoke_skill'] },
          { id: 'p3', name: '根因诊断深钻', goal: '分析 jank root cause，对代表帧执行机制级分析', expectedTools: ['invoke_skill'] },
        ],
        successCriteria: 'Do not push conclusion or next-phase hints on phase start',
      });

      const result = await callTool(tools, 'update_plan_phase', {
        phaseId: 'p1',
        status: 'in_progress',
      });

      expect(result.success).toBe(true);
      expect(result.next_phase_reminder).toBeUndefined();
      expect(result.next).toBeUndefined();
    });

    it('does not reject overview summaries just because they cite detailed evidence', async () => {
      const { tools, analysisPlan } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: '获取启动概览', goal: '获取启动事件和数据质量概览', expectedTools: ['invoke_skill'] },
          { id: 'p2', name: '获取启动详情', goal: '获取主线程阻塞、四象限和调度详情', expectedTools: ['invoke_skill'] },
        ],
        successCriteria: 'Overview completion can cite headline detail metrics',
      });

      const result = await callTool(tools, 'update_plan_phase', {
        phaseId: 'p1',
        status: 'completed',
        summary: '检测到 1 次启动事件：冷启动，dur=1338.65ms，TTID=1912.20ms。主线程状态 Running 占 63%，blocked_functions 为空，数据质量 WARN。',
      });

      expect(result.success).toBe(true);
      expect(analysisPlan.current?.phases.find(p => p.id === 'p1')?.status).toBe('completed');
    });

    it('rejects phase updates when the summary clearly belongs to another phase', async () => {
      const { tools, analysisPlan, emittedUpdates } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p3', name: '全局上下文检查', goal: '检查温控、后台、插帧、视频和系统干扰', expectedTools: ['execute_sql'] },
          { id: 'p4', name: '根因深钻', goal: '对代表帧执行四象限和机制级根因诊断', expectedTools: ['invoke_skill', 'fetch_artifact'] },
          { id: 'p5', name: '缺帧检测', goal: '检查是否存在帧生产 Gap 导致的缺帧问题', expectedTools: ['invoke_skill'] },
          { id: 'p6', name: '综合结论', goal: '输出最终结论和优化建议', expectedTools: [] },
        ],
        successCriteria: 'Keep timeline phase updates semantically aligned',
      });

      const wrongCompletion = await callTool(tools, 'update_plan_phase', {
        phaseId: 'p3',
        status: 'completed',
        summary: '完成根因深钻：workload_heavy 6 帧由主线程 animation 耗时 58ms 导致',
      });
      expect(wrongCompletion.success).toBe(false);
      expect(wrongCompletion.action_required).toBe('retry_update_plan_phase_with_correct_phase');
      expect(wrongCompletion.suggestedPhaseId).toBe('p4');
      expect(analysisPlan.current?.phases.find(p => p.id === 'p3')?.status).toBe('pending');

      const wrongStart = await callTool(tools, 'update_plan_phase', {
        phaseId: 'p5',
        status: 'in_progress',
        summary: '开始综合结论，输出完整报告和优化建议',
      });
      expect(wrongStart.success).toBe(false);
      expect(wrongStart.suggestedPhaseId).toBe('p6');
      expect(analysisPlan.current?.phases.find(p => p.id === 'p5')?.status).toBe('pending');
      expect(emittedUpdates.some((u: any) => u.type === 'plan_phase_updated')).toBe(false);
    });

    it('rejects skipping conclusion phases so the timeline cannot finish without a conclusion step', async () => {
      const { tools, analysisPlan, emittedUpdates } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: '数据收集', goal: '获取性能数据', expectedTools: ['invoke_skill'] },
          { id: 'p2', name: '综合结论', goal: '输出最终结论和优化建议', expectedTools: [] },
        ],
        successCriteria: 'Final report must have an explicit conclusion phase',
      });

      const result = await callTool(tools, 'update_plan_phase', {
        phaseId: 'p2',
        status: 'skipped',
        summary: '暂时跳过最终结论，因为还需要补齐必要证据后才能输出完整报告',
      });

      expect(result.success).toBe(false);
      expect(result.action_required).toBe('complete_final_conclusion_phase');
      expect(analysisPlan.current?.phases.find(p => p.id === 'p2')?.status).toBe('pending');
      expect(emittedUpdates.some((u: any) => u.type === 'plan_phase_updated')).toBe(false);
    });

    it('auto-closes superseded active phases so final completion does not loop back', async () => {
      const { tools, analysisPlan } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: 'Collect', goal: 'Get frame data', expectedTools: ['execute_sql'] },
          { id: 'p2', name: 'Conclude', goal: 'Write final answer', expectedTools: ['fetch_artifact'] },
        ],
        successCriteria: 'Do not restart old phases after the conclusion phase completes',
      });

      await callTool(tools, 'update_plan_phase', { phaseId: 'p1', status: 'in_progress' });
      const p2Started = await callTool(tools, 'update_plan_phase', { phaseId: 'p2', status: 'in_progress' });
      const p2Completed = await callTool(tools, 'update_plan_phase', {
        phaseId: 'p2',
        status: 'completed',
        summary: 'Final conclusion cites collected frame data and evidence tables',
      });

      const p1 = analysisPlan.current?.phases.find(p => p.id === 'p1');
      expect(p1?.status).toBe('completed');
      expect(p1?.summary).toContain('自动完成阶段');
      expect(p2Started.next_phase_reminder).toBeUndefined();
      expect(p2Completed.allPhasesComplete).toBe(true);
    });

    it('does not report all phases complete while the final phase is still in progress', async () => {
      const { tools } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: 'Collect', goal: 'Get frame data', expectedTools: ['execute_sql'] },
          { id: 'p2', name: 'Conclude', goal: 'Write final answer', expectedTools: ['fetch_artifact'] },
        ],
        successCriteria: 'Identify jank root cause',
      });
      await callTool(tools, 'update_plan_phase', {
        phaseId: 'p1',
        status: 'completed',
        summary: 'Collected frame data with 3 janky frames',
      });

      const inProgress = await callTool(tools, 'update_plan_phase', {
        phaseId: 'p2',
        status: 'in_progress',
        summary: 'Drafting final answer from collected artifacts',
      });
      expect(inProgress.success).toBe(true);
      expect(inProgress.allPhasesComplete).toBeUndefined();

      const completed = await callTool(tools, 'update_plan_phase', {
        phaseId: 'p2',
        status: 'completed',
        summary: 'Final answer includes root cause and evidence',
      });
      expect(completed.allPhasesComplete).toBe(true);
    });

    it('rejects completed phases without enough evidence summary', async () => {
      const { tools, analysisPlan, emittedUpdates } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: 'Collect', goal: 'Get frame data', expectedTools: ['execute_sql'] },
        ],
        successCriteria: 'Identify jank root cause',
      });

      const result = await callTool(tools, 'update_plan_phase', {
        phaseId: 'p1',
        status: 'completed',
        summary: 'done',
      });

      expect(result.success).toBe(false);
      expect(result.action_required).toBe('retry_update_plan_phase_with_evidence');
      expect(analysisPlan.current?.phases[0].status).toBe('pending');
      expect(emittedUpdates.some(u => u.type === 'plan_phase_updated')).toBe(false);
    });
  });

  describe('hypothesis lifecycle (P0-G4)', () => {
    it('should submit a hypothesis', async () => {
      const { tools, hypotheses } = createTestServer();
      const result = await callTool(tools, 'submit_hypothesis', {
        statement: 'RenderThread blocked by Binder call',
        reasoning: 'Observed 50ms gap in frame rendering',
      });
      expect(result.success || result.id).toBeTruthy();
      expect(hypotheses).toHaveLength(1);
      expect(hypotheses[0].status).toBe('formed');
      expect(hypotheses[0].statement).toBe('RenderThread blocked by Binder call');
    });

    it('accepts title/reasoning/id aliases when submitting a hypothesis', async () => {
      const { tools, hypotheses } = createTestServer();
      const toolDef = tools.get('submit_hypothesis');
      expect(toolDef?.schema?.statement?.safeParse(undefined).success).toBe(true);
      expect(toolDef?.schema?.title?.safeParse('Alias title').success).toBe(true);

      const result = await callTool(tools, 'submit_hypothesis', {
        id: 'h7',
        title: 'Main-thread synthetic workload causes jank',
        reasoning: 'Every bad frame contains CustomScroll_longFrameLoad',
      });

      expect(result.success).toBe(true);
      expect(result.hypothesisId).toBe('h7');
      expect(hypotheses).toHaveLength(1);
      expect(hypotheses[0]).toMatchObject({
        id: 'h7',
        statement: 'Main-thread synthetic workload causes jank',
        basis: 'Every bad frame contains CustomScroll_longFrameLoad',
        status: 'formed',
      });

      await callTool(tools, 'submit_hypothesis', { statement: 'Follow-up hypothesis' });
      expect(hypotheses[1].id).toBe('h8');
    });

    it('should resolve a hypothesis as confirmed', async () => {
      const { tools, hypotheses } = createTestServer();
      await callTool(tools, 'submit_hypothesis', { statement: 'Test hypothesis' });
      const hId = hypotheses[0].id;

      const result = await callTool(tools, 'resolve_hypothesis', {
        hypothesisId: hId,
        status: 'confirmed',
        evidence: 'Binder latency confirmed at 45ms',
      });
      expect(result.success).toBe(true);
      expect(hypotheses[0].status).toBe('confirmed');
    });

    it('accepts verdict as an alias for status when resolving a hypothesis', async () => {
      const { tools, hypotheses } = createTestServer();
      await callTool(tools, 'submit_hypothesis', { id: 'h1', title: 'Shader compile blocks frame' });
      const toolDef = tools.get('resolve_hypothesis');
      expect(toolDef?.schema?.verdict?.safeParse('confirmed').success).toBe(true);

      const result = await callTool(tools, 'resolve_hypothesis', {
        hypothesisId: 'h1',
        verdict: 'confirmed',
        evidence: 'makePipeline lasted 12.89ms and main thread waited in postAndWait',
      });

      expect(result.success).toBe(true);
      expect(hypotheses[0].status).toBe('confirmed');
    });

    it('should resolve a hypothesis as rejected', async () => {
      const { tools, hypotheses } = createTestServer();
      await callTool(tools, 'submit_hypothesis', { statement: 'Memory pressure' });
      const hId = hypotheses[0].id;

      await callTool(tools, 'resolve_hypothesis', {
        hypothesisId: hId,
        status: 'rejected',
        evidence: 'Memory usage normal at 200MB',
      });
      expect(hypotheses[0].status).toBe('rejected');
    });

    it('backfills a missing hypothesis resolution instead of failing the run', async () => {
      const { tools, hypotheses } = createTestServer();
      const result = await callTool(tools, 'resolve_hypothesis', {
        hypothesisId: 'h3',
        status: 'confirmed',
        evidence: 'Startup phase evidence already confirms the root cause',
      });
      expect(result.success).toBe(true);
      expect(result.backfilled).toBe(true);
      expect(hypotheses).toHaveLength(1);
      expect(hypotheses[0]).toMatchObject({
        id: 'h3',
        status: 'confirmed',
        evidence: 'Startup phase evidence already confirms the root cause',
      });

      await callTool(tools, 'submit_hypothesis', { statement: 'Follow-up hypothesis' });
      expect(hypotheses[1].id).toBe('h4');
    });
  });

  describe('write_analysis_note', () => {
    it('should add a note', async () => {
      const { tools, analysisNotes } = createTestServer();
      const result = await callTool(tools, 'write_analysis_note', {
        section: 'finding',
        content: 'RenderThread is consistently blocked for >16ms in jank frames',
        priority: 'high',
      });
      expect(result.success).toBe(true);
      expect(analysisNotes).toHaveLength(1);
      expect(analysisNotes[0].section).toBe('finding');
      expect(analysisNotes[0].priority).toBe('high');
    });

    it('should evict lowest-priority note when exceeding cap of 20', async () => {
      const { tools, analysisNotes } = createTestServer();
      // Pre-fill 20 notes: 19 low + 1 medium
      for (let i = 0; i < 19; i++) {
        analysisNotes.push({
          section: 'observation',
          content: `Low note ${i} content is at least ten chars`,
          priority: 'low',
          timestamp: Date.now() - (20 - i) * 1000, // older first
        });
      }
      analysisNotes.push({
        section: 'finding',
        content: 'Medium priority note should survive eviction',
        priority: 'medium',
        timestamp: Date.now(),
      });
      // Adding 21st note should trigger eviction of oldest low-priority note
      const result = await callTool(tools, 'write_analysis_note', {
        section: 'finding',
        content: 'High priority new note added over cap',
        priority: 'high',
      });
      expect(result.success).toBe(true);
      // Should still have exactly 20 after eviction
      expect(analysisNotes).toHaveLength(20);
      // The new high-priority note should be present
      expect(analysisNotes.some(n => n.content.includes('High priority new note'))).toBe(true);
      // The medium-priority note should survive (low-priority evicted first)
      expect(analysisNotes.some(n => n.content.includes('Medium priority'))).toBe(true);
    });
  });

  describe('flag_uncertainty (P1-G1)', () => {
    it('should add uncertainty flag and emit SSE', async () => {
      const { tools, uncertaintyFlags, emittedUpdates } = createTestServer();
      const result = await callTool(tools, 'flag_uncertainty', {
        topic: 'VRR support',
        assumption: 'Assuming device does not support VRR',
        question: 'Does this device support variable refresh rate?',
      });
      expect(result.success).toBe(true);
      expect(uncertaintyFlags).toHaveLength(1);
      expect(uncertaintyFlags[0].topic).toBe('VRR support');
      // Should emit progress SSE
      expect(emittedUpdates.some((u: any) => u.type === 'progress')).toBe(true);
    });
  });

  describe('revise_plan (P1-3)', () => {
    it('should allow revising a plan', async () => {
      const { tools, analysisPlan } = createTestServer();
      // Submit initial plan
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: 'Phase 1', goal: 'G1', expectedTools: ['execute_sql'] },
        ],
        successCriteria: 'Done',
      });
      // Mark phase 1 as completed
      await callTool(tools, 'update_plan_phase', {
        phaseId: 'p1',
        status: 'completed',
        summary: 'Phase 1 completed with SQL evidence',
      });

      // Revise plan with new phase
      const result = await callTool(tools, 'revise_plan', {
        updatedPhases: [
          { id: 'p1', name: 'Phase 1', goal: 'G1', expectedTools: ['execute_sql'], status: 'completed' },
          { id: 'p2', name: 'Phase 2', goal: 'G2', expectedTools: ['invoke_skill'] },
        ],
        reason: 'Discovered new data requiring additional analysis',
      });
      expect(result.success).toBe(true);
      expect(analysisPlan.current?.phases).toHaveLength(2);
      expect(analysisPlan.current?.revisionHistory).toHaveLength(1);
    });

    it('accepts JSON-string updated phases and string expectedTools', async () => {
      const { tools, analysisPlan } = createTestServer();
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: 'Phase 1', goal: 'G1', expectedTools: ['execute_sql'] },
        ],
        successCriteria: 'Done',
      });

      const result = await callTool(tools, 'revise_plan', {
        updatedPhases: JSON.stringify([
          { id: 'p1', name: 'Phase 1', goal: 'G1', expectedTools: 'execute_sql, fetch_artifact' },
        ]),
        reason: 'Provider encoded arrays as strings',
      });

      expect(result.success).toBe(true);
      expect(analysisPlan.current?.phases[0].expectedTools).toEqual(['execute_sql', 'fetch_artifact']);
    });
  });
});

describe('loadLearnedSqlFixPairs', () => {
  it('should return empty array when no file', () => {
    const pairs = loadLearnedSqlFixPairs();
    expect(pairs).toEqual([]);
  });
});
