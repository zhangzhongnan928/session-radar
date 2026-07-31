import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AppleFoundationModelsClient,
  AppleHelperFailure,
  invokeAppleHelper,
  type LocalSemanticInput,
} from './apple-model.js';

const AVAILABLE = {
  state: 'available' as const,
  reasonCode: 'available',
  message: 'Apple Foundation Models is available.',
  locale: 'en_AU',
  localeSupported: true,
  deviceOnly: true as const,
  cloudUsed: false as const,
  helperVersion: '1',
};

const INPUT: LocalSemanticInput = {
  excerpt: 'AUTHORISED SYNTHETIC TASK CONTENT',
  lifecycleStatus: 'done',
  inputCharacters: 33,
  sourceResultCharacters: 33,
  inputTruncated: false,
  grounding: {
    outcome: 'Implemented the bounded analyzer.',
    verifiedResults: ['12 focused tests passed.'],
    unresolvedItems: ['Review the change.'],
    risksOrBlockers: null,
    codeChangeSummary: 'Added a local analyzer.',
    recommendedNextStep: 'Review the change.',
    recommendedNextStepInferred: false,
  },
};

describe('AppleFoundationModelsClient', () => {
  it('probes without task content and caches the content-free result briefly', async () => {
    const requests: unknown[] = [];
    const client = new AppleFoundationModelsClient({
      now: () => 1_800_000_000_000,
      invoke: async (request) => {
        requests.push(request);
        return {
          ok: true,
          operation: 'probe',
          availability: AVAILABLE,
          message: AVAILABLE.message,
        };
      },
    });

    const first = await client.probe();
    const second = await client.probe();

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      provider: 'apple_foundation_models',
      state: 'available',
      deviceOnly: true,
      cloudUsed: false,
    });
    expect(requests).toEqual([{ operation: 'probe' }]);
    expect(JSON.stringify(requests)).not.toContain(INPUT.excerpt);
  });

  it('sends one exact excerpt through the injected stdin transport and returns only structured output', async () => {
    let captured: unknown;
    const client = new AppleFoundationModelsClient({
      now: () => 1_800_000_000_000,
      invoke: async (request) => {
        captured = request;
        return {
          ok: true,
          operation: 'summarize',
          availability: AVAILABLE,
          result: {
            summary:
              'Implemented the bounded analyzer. 12 focused tests passed. A secret production deployment succeeded.',
            outcome: 'Implemented the bounded analyzer.',
            verifiedResults: ['12 focused tests passed.'],
            unresolvedItems: ['Review the change.'],
            risksOrBlockers: null,
            codeChangeSummary: 'Added a local analyzer.',
            recommendedNextStep: 'Review the change.',
            uncertainties: ['The source report was not independently reproduced.'],
          },
          message: 'Generated locally.',
        };
      },
    });

    const enhancement = await client.enhance(INPUT);

    expect(captured).toEqual({
      operation: 'summarize',
      excerpt: INPUT.excerpt,
      lifecycleStatus: 'done',
      grounding: INPUT.grounding,
    });
    expect(enhancement).toMatchObject({
      status: 'applied',
      generatedAt: 1_800_000_000_000,
      result: {
        summary: 'Implemented the bounded analyzer. 12 focused tests passed.',
        outcome: 'Implemented the bounded analyzer.',
        verifiedResults: ['12 focused tests passed.'],
        uncertainties: expect.arrayContaining([
          'Model-generated summary details outside the deterministic grounding were discarded.',
        ]),
      },
      provenance: {
        execution: 'on_device',
        factFieldsGroundedBy: 'deterministic_bounded_projection',
        summaryMode: 'model_grounded',
        requestScoped: true,
        toolsAvailable: false,
        cloudUsed: false,
        rawInputStored: false,
        rawPromptStored: false,
        rawModelOutputStored: false,
      },
    });
    expect(JSON.stringify(enhancement)).not.toContain(INPUT.excerpt);
  });

  it('keeps the deterministic fallback when the model is not ready', async () => {
    const client = new AppleFoundationModelsClient({
      invoke: async () => ({
        ok: false,
        operation: 'summarize',
        availability: {
          ...AVAILABLE,
          state: 'not_ready',
          reasonCode: 'model_not_ready',
          message: 'The on-device model is downloading.',
        },
        errorCode: 'model_not_ready',
        message: 'The on-device model is downloading.',
      }),
    });

    const enhancement = await client.enhance(INPUT);

    expect(enhancement.status).toBe('unavailable');
    expect(enhancement.result).toBeNull();
    expect(enhancement.availability).toMatchObject({
      state: 'not_ready',
      reasonCode: 'model_not_ready',
      cloudUsed: false,
    });
    expect(enhancement.message).toMatch(/deterministic bounded result/i);
  });

  it('reports a missing helper as unavailable instead of failing task analysis', async () => {
    const client = new AppleFoundationModelsClient({
      invoke: async () => {
        throw new AppleHelperFailure('helper_not_built');
      },
    });

    expect(await client.probe()).toMatchObject({
      state: 'unavailable',
      reasonCode: 'helper_not_built',
      cloudUsed: false,
    });
    expect(await client.enhance(INPUT)).toMatchObject({
      status: 'unavailable',
      availability: { reasonCode: 'helper_not_built' },
      result: null,
    });
  });

  it('rejects concurrent generation instead of creating a background queue', async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    let calls = 0;
    const client = new AppleFoundationModelsClient({
      invoke: async () => {
        calls += 1;
        return await new Promise<unknown>((resolve) => {
          resolveFirst = resolve;
        });
      },
    });

    const first = client.enhance(INPUT);
    const second = await client.enhance(INPUT);
    expect(second).toMatchObject({
      status: 'failed',
      availability: { reasonCode: 'model_busy' },
    });
    expect(calls).toBe(1);

    resolveFirst?.({
      ok: false,
      operation: 'summarize',
      availability: AVAILABLE,
      errorCode: 'model_refusal',
      message: 'The model declined.',
    });
    await first;
  });

  it('never includes a thrown transport error or raw excerpt in its failure response', async () => {
    const client = new AppleFoundationModelsClient({
      invoke: async () => {
        throw new Error(`SECRET ERROR WITH ${INPUT.excerpt}`);
      },
    });

    const enhancement = await client.enhance(INPUT);
    expect(enhancement.status).toBe('failed');
    expect(JSON.stringify(enhancement)).not.toMatch(
      /SECRET ERROR|AUTHORISED SYNTHETIC TASK CONTENT/,
    );
  });
});

describe('invokeAppleHelper', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('uses stdin with zero helper arguments', async () => {
    root = mkdtempSync(join(tmpdir(), 'session-radar-helper-'));
    const helper = join(root, 'helper');
    writeFileSync(
      helper,
      [
        '#!/usr/bin/env node',
        'let input = "";',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", (chunk) => { input += chunk; });',
        'process.stdin.on("end", () => {',
        '  const parsed = JSON.parse(input);',
        '  process.stdout.write(JSON.stringify({ argumentCount: process.argv.length - 2, operation: parsed.operation }));',
        '});',
      ].join('\n'),
    );
    chmodSync(helper, 0o755);

    await expect(
      invokeAppleHelper(helper, { operation: 'probe' }, 1_000),
    ).resolves.toEqual({ argumentCount: 0, operation: 'probe' });
  });

  it('kills a helper that exceeds the request timeout', async () => {
    root = mkdtempSync(join(tmpdir(), 'session-radar-helper-'));
    const helper = join(root, 'helper');
    writeFileSync(
      helper,
      [
        '#!/usr/bin/env node',
        'process.stdin.resume();',
        'setTimeout(() => process.stdout.write("{}"), 10_000);',
      ].join('\n'),
    );
    chmodSync(helper, 0o755);

    await expect(
      invokeAppleHelper(helper, { operation: 'probe' }, 20),
    ).rejects.toEqual(new AppleHelperFailure('helper_timeout'));
  });
});
