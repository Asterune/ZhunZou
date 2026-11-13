import { describe, expect, it } from 'vitest';

import {
  agentTaskSchema,
  taskLogSchema,
  type AgentTask,
  type TaskLog,
} from '@zhunzou/shared';

import {
  buildDiagnosisMessages,
  collectEvidence,
  evaluateBreaker,
  LOG_TAIL_CHARS,
  parseDiagnosis,
  type FailureEvidence,
} from '../src/supervisor/healer.js';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return agentTaskSchema.parse({
    id: '7',
    env: 'office-cursor',
    title: '修好构建',
    instruction: '把类型错误清零并跑通 pnpm test。',
    status: 'FAILED',
    attempts: 1,
    engine: 'claude-code',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
    ...overrides,
  });
}

function makeEvidence(overrides: Partial<FailureEvidence> = {}): FailureEvidence {
  return {
    task: makeTask(),
    heals: [],
    logTail: '',
    ...overrides,
  };
}

function heal(diagnosis: string, extra: Record<string, unknown> = {}) {
  return { diagnosis, ...extra };
}

/* ------------------------------------------------------------------ */
/* The breaker                                                         */
/* ------------------------------------------------------------------ */

describe('L2 circuit breaker', () => {
  it('B1: leaves a run alone while it still has retry budget', () => {
    expect(
      evaluateBreaker(makeEvidence({ task: makeTask({ retryCount: 2 }) })),
    ).toBeUndefined();
  });

  it('B2: stops a run that has used up the ceiling', () => {
    const reason = evaluateBreaker(
      makeEvidence({ task: makeTask({ retryCount: 3 }) }),
    );
    expect(reason).toContain('已自愈 3 次');
  });

  it('B3: the ceiling stands on its own, however new the error looks', () => {
    expect(
      evaluateBreaker(
        makeEvidence({
          task: makeTask({ retryCount: 9 }),
          lastSignature: 'TS2304 src/z.ts',
          heals: [heal('上次', { errorSignature: 'ECONNREFUSED 3000' })],
        }),
      ),
    ).toContain('已自愈 9 次');
  });

  it('B4: blocks when the same error returns across attempts', () => {
    const reason = evaluateBreaker(
      makeEvidence({
        lastSignature: 'TS2322 src/a.ts',
        heals: [heal('补类型', { errorSignature: 'TS2322 src/a.ts' })],
      }),
    );
    expect(reason).toContain('同一个错');
  });

  it('B5: stays quiet when the errors are unrelated', () => {
    expect(
      evaluateBreaker(
        makeEvidence({
          lastSignature: "Cannot find module './a'",
          heals: [heal('补类型', { errorSignature: 'TS2322 src/a.ts' })],
        }),
      ),
    ).toBeUndefined();
  });

  it('B6: recognises a Chinese error that only changed word order', () => {
    expect(
      evaluateBreaker(
        makeEvidence({
          lastSignature: '编译失败 缺少分号',
          heals: [heal('补分号', { errorSignature: '缺少分号 编译失败' })],
        }),
      ),
    ).toContain('同一个错');
  });

  it('B7: says nothing without a signature to compare', () => {
    expect(
      evaluateBreaker(
        makeEvidence({ heals: [heal('补类型', { errorSignature: 'TS2322 src/a.ts' })] }),
      ),
    ).toBeUndefined();
  });

  it('B8: blocks when the worktree did not move between attempts', () => {
    expect(
      evaluateBreaker(
        makeEvidence({
          lastDiffHash: 'a'.repeat(32),
          heals: [heal('再看一次', { diffHash: 'a'.repeat(32) })],
        }),
      ),
    ).toContain('没有任何变化');
  });

  it('B9: tolerates a retry that actually changed files', () => {
    expect(
      evaluateBreaker(
        makeEvidence({
          lastDiffHash: 'b'.repeat(32),
          heals: [heal('再看一次', { diffHash: 'a'.repeat(32) })],
        }),
      ),
    ).toBeUndefined();
  });

  it('B10: an old node without a fingerprint does not trip the diff rule', () => {
    expect(
      evaluateBreaker(
        makeEvidence({
          lastDiffHash: 'a'.repeat(32),
          heals: [heal('补类型', { errorSignature: 'TS2322 src/b.ts' })],
        }),
      ),
    ).toBeUndefined();

    expect(
      evaluateBreaker(
        makeEvidence({
          task: makeTask({ retryCount: 3 }),
          lastDiffHash: 'a'.repeat(32),
          heals: [heal('补类型', { errorSignature: 'TS2322 src/b.ts' })],
        }),
      ),
    ).toContain('已自愈 3 次');
  });

  it('B11: reports the first rule that condemns, in cost order', () => {
    const reason = evaluateBreaker(
      makeEvidence({
        task: makeTask({ retryCount: 4 }),
        lastSignature: 'TS2322 src/a.ts',
        lastDiffHash: 'a'.repeat(32),
        heals: [
          heal('补类型', {
            errorSignature: 'TS2322 src/a.ts',
            diffHash: 'a'.repeat(32),
          }),
        ],
      }),
    );
    expect(reason).toContain('已自愈 4 次');
    expect(reason).not.toContain('同一个错');
  });

  it('B12: compares against the last handled attempt only', () => {
    const evidence = makeEvidence({
      lastSignature: 'TS2322 src/a.ts',
      heals: [
        heal('第一次', { errorSignature: 'TS2322 src/a.ts' }),
        heal('第二次', { errorSignature: 'ECONNREFUSED 3000' }),
        heal('第三次', { errorSignature: 'ENOENT package.json' }),
      ],
    });
    expect(evaluateBreaker(evidence)).toBeUndefined();

    expect(
      evaluateBreaker(
        makeEvidence({
          ...evidence,
          heals: [...evidence.heals, heal('第四次', { errorSignature: 'TS2322 src/a.ts' })],
        }),
      ),
    ).toContain('同一个错');
  });
});

/* ------------------------------------------------------------------ */
/* Evidence                                                            */
/* ------------------------------------------------------------------ */

function makeLog(overrides: Partial<TaskLog> & { id: number }): TaskLog {
  return taskLogSchema.parse({
    taskId: '7',
    stream: 'stderr',
    chunk: 'boom',
    createdAt: 1_700_000_000_000 + overrides.id,
    ...overrides,
  });
}

describe('L2 evidence collection', () => {
  it('E1: reads the newest signature, not an older one', () => {
    const evidence = collectEvidence(makeTask(), [
      makeLog({ id: 1, chunk: 'working' }),
      makeLog({ id: 2, errorSignature: 'TS2307 src/old.ts' }),
      makeLog({ id: 3, errorSignature: 'TS2322 src/new.ts' }),
    ]);
    expect(evidence.lastSignature).toBe('TS2322 src/new.ts');
  });

  it('E2: reports no signature for a run that only made progress', () => {
    const evidence = collectEvidence(makeTask(), [
      makeLog({ id: 1, stream: 'stdout', chunk: 'building…' }),
      makeLog({ id: 2, stream: 'stdout', chunk: 'done' }),
    ]);
    expect(evidence.lastSignature).toBeUndefined();
  });

  it('E3: keeps handled attempts oldest first', () => {
    const evidence = collectEvidence(makeTask(), [
      makeLog({ id: 1, chunk: 'a', diagnosis: '第一次诊断' }),
      makeLog({ id: 2, chunk: 'b' }),
      makeLog({ id: 3, chunk: 'c', diagnosis: '第二次诊断' }),
    ]);
    expect(evidence.heals.map((item) => item.diagnosis)).toEqual([
      '第一次诊断',
      '第二次诊断',
    ]);
  });

  it('E4: keeps the evidence a handled row carries with it', () => {
    const evidence = collectEvidence(makeTask(), [
      makeLog({
        id: 1,
        chunk: 'a',
        diagnosis: '补类型',
        errorSignature: 'TS2322 src/a.ts',
        diffHash: 'f'.repeat(32),
      }),
    ]);
    expect(evidence.heals).toEqual([
      {
        diagnosis: '补类型',
        errorSignature: 'TS2322 src/a.ts',
        diffHash: 'f'.repeat(32),
      },
    ]);
  });

  it('E5: treats a node row as evidence, never as a handled attempt', () => {
    const evidence = collectEvidence(makeTask(), [
      makeLog({ id: 1, chunk: 'a', diffHash: 'd'.repeat(32) }),
    ]);
    expect(evidence.lastDiffHash).toBe('d'.repeat(32));
    expect(evidence.heals).toEqual([]);
  });

  it('E6: ships the tail of a long run, inside the budget', () => {
    const logs = Array.from({ length: 8 }, (_unused, index) =>
      makeLog({
        id: index + 1,
        stream: 'stdout',
        chunk: `${'x'.repeat(15_990)}[${index}]`,
      }),
    );
    const evidence = collectEvidence(makeTask(), logs);
    expect(evidence.logTail.length).toBeLessThanOrEqual(LOG_TAIL_CHARS);
    expect(evidence.logTail.endsWith('[7]')).toBe(true);
    expect(evidence.logTail).not.toContain('[0]');
  });

  it('E7: handles a task with no logs at all', () => {
    const evidence = collectEvidence(makeTask(), []);
    expect(evidence.lastSignature).toBeUndefined();
    expect(evidence.lastDiffHash).toBeUndefined();
    expect(evidence.heals).toEqual([]);
    expect(evidence.logTail).toBe('');
  });

  it('E8: is pure: same input, same output, untouched logs', () => {
    const logs = [
      makeLog({ id: 1, chunk: 'a', errorSignature: 'E1' }),
      makeLog({ id: 2, chunk: 'b', diagnosis: '诊断', errorSignature: 'E2' }),
    ];
    const snapshot = structuredClone(logs);
    const task = makeTask();

    expect(collectEvidence(task, logs)).toEqual(collectEvidence(task, logs));
    expect(logs).toEqual(snapshot);
  });
});

/* ------------------------------------------------------------------ */
/* The question and the answer                                         */
/* ------------------------------------------------------------------ */

describe('L2 diagnosis prompt', () => {
  it('N1: offers exactly the three verdicts and every piece of evidence', () => {
    const { system, user } = buildDiagnosisMessages(
      makeEvidence({
        task: makeTask({ instruction: '把 uploads 目录改成可配置。' }),
        lastSignature: 'EACCES uploads/x.png',
        lastDiffHash: 'c'.repeat(32),
        heals: [heal('上次说改权限')],
        logTail: 'Error: EACCES permission denied',
      }),
    );

    for (const decision of ['APPROVE', 'RETRY_WITH_FIX', 'ESCALATE_TO_HUMAN']) {
      expect(system).toContain(decision);
    }
    expect(user).toContain('把 uploads 目录改成可配置。');
    expect(user).toContain('EACCES uploads/x.png');
    expect(user).toContain('上次说改权限');
    expect(user).toContain('EACCES permission denied');
    expect(user).toContain('c'.repeat(32));
  });

  it('N2: clips long evidence so one diagnosis cannot cost an arm', () => {
    const instruction = 'long instruction '.repeat(115);
    expect(instruction.length).toBeLessThanOrEqual(2_000);
    const { user } = buildDiagnosisMessages(
      makeEvidence({
        task: makeTask({ instruction }),
        logTail: 'tail '.repeat(5_000),
      }),
    );
    expect(user).not.toContain(instruction);
    expect(user.length).toBeLessThan(4_000);
  });

  it('N2b: marks missing evidence as missing instead of inventing it', () => {
    const { user } = buildDiagnosisMessages(makeEvidence());
    expect(user).toContain('（节点未上报）');
    expect(user).toContain('（管家没有处置过）');
    expect(user).toContain('（没有日志）');
  });
});

describe('L2 diagnosis parsing', () => {
  const valid =
    '{"decision":"RETRY_WITH_FIX","diagnosisSummary":"上传目录写权限缺失","fixPrompt":"chmod 后重跑测试","errorSignature":"EACCES uploads"}';

  it('N3: accepts the strict JSON it asked for', () => {
    expect(parseDiagnosis(valid)).toEqual({
      decision: 'RETRY_WITH_FIX',
      diagnosisSummary: '上传目录写权限缺失',
      fixPrompt: 'chmod 后重跑测试',
      errorSignature: 'EACCES uploads',
    });
  });

  it('N4: strips a markdown fence first', () => {
    expect(parseDiagnosis(`\`\`\`json\n${valid}\n\`\`\``)?.decision).toBe(
      'RETRY_WITH_FIX',
    );
  });

  it('N5: rejects a retry with nothing to hand the engine', () => {
    expect(
      parseDiagnosis('{"decision":"RETRY_WITH_FIX","diagnosisSummary":"再试"}'),
    ).toBeUndefined();
  });

  it('N6: refuses a verdict the model was never offered', () => {
    expect(
      parseDiagnosis('{"decision":"DENY","diagnosisSummary":"不让跑"}'),
    ).toBeUndefined();
  });

  it('N7: keeps the inbox line a one-liner', () => {
    expect(
      parseDiagnosis(
        `{"decision":"APPROVE","diagnosisSummary":"${'字'.repeat(60)}"}`,
      ),
    ).toBeUndefined();
  });

  it('N8: rejects a field it did not ask for', () => {
    expect(
      parseDiagnosis(
        '{"decision":"APPROVE","diagnosisSummary":"合理失败","confidence":0.9}',
      ),
    ).toBeUndefined();
  });

  it('N9: answers undefined for anything that is not a verdict', () => {
    expect(parseDiagnosis('')).toBeUndefined();
    expect(parseDiagnosis('这次失败是合理的，建议人工确认。')).toBeUndefined();
    expect(parseDiagnosis('{"decision":')).toBeUndefined();
    expect(parseDiagnosis('{"decision":"MAYBE_RETRY","diagnosisSummary":"x"}')).toBeUndefined();
  });
});
