import { test, expect } from '@playwright/test';
import { summarizeReport } from '../../src/mcp/test-runner';

test('summarizes passing Playwright JSON reporter output', () => {
  const result = summarizeReport({
    suites: [{
      title: 'mcp',
      specs: [{
        title: 'parses result',
        tests: [{ status: 'expected', results: [{ status: 'passed', attachments: [] }] }],
      }],
    }],
    stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 0 },
  });
  expect(result).toMatchObject({ status: 'passed', passed: 1, failed: 0 });
  expect(result.tests[0].title).toBe('mcp › parses result');
});

test('returns failure line and screenshot from Playwright JSON reporter output', () => {
  const result = summarizeReport({
    suites: [{
      title: 'mcp',
      specs: [{
        title: 'fails visibly',
        tests: [{
          status: 'unexpected',
          results: [{
            status: 'failed',
            error: { message: 'Assertion failed', stack: 'at test (sample.spec.ts:12:3)' },
            errorLocation: { line: 12 },
            attachments: [{ name: 'screenshot', contentType: 'image/png', path: 'test-results/failure.png' }],
          }],
        }],
      }],
    }],
    stats: { expected: 0, skipped: 0, unexpected: 1, flaky: 0 },
  });
  expect(result).toMatchObject({ status: 'failed', passed: 0, failed: 1 });
  expect(result.tests[0]).toMatchObject({
    failingLine: 12,
    screenshotPath: 'test-results/failure.png',
    error: 'Assertion failed',
  });
});
