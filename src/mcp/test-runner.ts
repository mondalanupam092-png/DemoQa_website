import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import type { TestRunResult } from './types';

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

function validateTestPaths(root: string, paths: string[]): string[] {
  if (paths.length === 0) throw new Error('At least one test path is required.');
  const testRoot = path.resolve(root, 'tests');
  return [...new Set(paths)].map((requested) => {
    const absolute = path.resolve(root, requested);
    if (!absolute.startsWith(`${testRoot}${path.sep}`) || !/\.spec\.ts$/.test(absolute)) {
      throw new Error(`Only *.spec.ts files inside tests/ may be run: ${requested}`);
    }
    return path.relative(root, absolute).replaceAll(path.sep, '/');
  });
}

function parseLine(stack?: string): number | undefined {
  if (!stack) return undefined;
  const match = stack.match(/(?:\.spec\.ts|\.ts):(\d+):\d+/);
  return match ? Number(match[1]) : undefined;
}

export function summarizeReport(report: any): TestRunResult {
  const tests: TestRunResult['tests'] = [];
  const visit = (suites: any[]): void => {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          const result = test.results?.[test.results.length - 1];
          const status = result?.status ?? test.status ?? (spec.ok ? 'passed' : 'failed');
          const error = result?.error;
          const attachments = result?.attachments ?? [];
          const screenshot = attachments.find((item: any) => item.contentType?.startsWith('image/'));
          const log = attachments.find((item: any) => /trace|log|error-context/i.test(item.name ?? ''));
          tests.push({
            title: [suite.title, spec.title].filter(Boolean).join(' › '),
            status,
            ...(error?.message && { error: String(error.message).slice(0, 700) }),
            ...((result?.errorLocation?.line ?? parseLine(error?.stack))
              && { failingLine: result?.errorLocation?.line ?? parseLine(error?.stack) }),
            ...(screenshot?.path && { screenshotPath: screenshot.path }),
            ...(log?.path && { logPath: log.path }),
          });
        }
      }
      visit(suite.suites ?? []);
    }
  };
  visit(report.suites ?? []);
  const expected = Number(report.stats?.expected ?? 0);
  const flaky = Number(report.stats?.flaky ?? 0);
  const failed = Number(report.stats?.unexpected ?? tests.filter(
    (test) => !['passed', 'expected', 'skipped'].includes(test.status),
  ).length);
  const passed = expected + flaky || tests.filter((test) => test.status === 'passed').length;
  const skipped = Number(report.stats?.skipped ?? 0);
  if (!tests.length && (passed > 0 || failed > 0)) {
    const firstError = report.errors?.[0];
    tests.push({
      title: 'Selected Playwright tests',
      status: failed ? 'failed' : 'passed',
      ...(firstError?.message && { error: String(firstError.message).slice(0, 700) }),
    });
  }
  if (passed + failed === 0) {
    return {
      status: 'failed',
      passed: 0,
      failed: 1,
      tests: [{
        title: 'Selected Playwright tests',
        status: 'failed',
        error: skipped
          ? 'No selected test completed; all were skipped.'
          : 'Playwright reported zero selected tests.',
      }],
    };
  }
  return { status: failed ? 'failed' : 'passed', passed, failed, tests };
}

export async function runTests(
  root: string,
  requestedPaths: string[],
  project?: 'chromium' | 'firefox' | 'webkit',
): Promise<TestRunResult> {
  const paths = validateTestPaths(root, requestedPaths);
  const cli = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');
  const reportPath = path.join(root, '.mcp-cache', `playwright-${randomUUID()}.json`);
  await mkdir(path.dirname(reportPath), { recursive: true });
  let processFailure: (NodeJS.ErrnoException & { stdout?: string; stderr?: string }) | undefined;
  try {
    await execFileAsync(process.execPath, [
      cli,
      'test',
      ...paths,
      ...(project ? [`--project=${project}`] : []),
      '--reporter=json',
    ], {
      cwd: root,
      timeout: TEST_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
      },
    });
  } catch (error) {
    processFailure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
  }

  try {
    let reportText: string;
    try {
      const reportStat = await stat(reportPath);
      if (reportStat.size > MAX_OUTPUT_BYTES) throw new Error('Playwright JSON report exceeded the 10 MB safety limit.');
      reportText = await readFile(reportPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (processFailure) {
      return {
        status: 'failed',
        passed: 0,
        failed: 1,
        tests: [{
          title: paths.join(', '),
          status: 'failed',
            error: (processFailure.message || processFailure.stderr || 'Playwright failed without a JSON report.').slice(0, 700),
        }],
      };
      }
      throw new Error('Playwright completed without producing its JSON report.');
    }
    const report = JSON.parse(reportText);
    const summary = summarizeReport(report);
    if (processFailure && summary.status === 'passed') {
      return {
        status: 'failed',
        passed: summary.passed,
        failed: 1,
        tests: [...summary.tests, {
          title: paths.join(', '),
          status: 'failed',
          error: processFailure.message.slice(0, 700),
        }],
      };
    }
    return summary;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Playwright returned an unreadable JSON report.');
    throw error;
  } finally {
    await rm(reportPath, { force: true });
  }
}
