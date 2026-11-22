import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { analyzeFramework } from './framework';
import { fetchJiraRequirements, validateTicketId } from './jira';
import { createBranchAndPush, createPullRequest } from './github';
import { generateAutomationScript, generateTestCases, prepareLocalAutomationPlans, readTestCases } from './test-cases';
import { runTests } from './test-runner';
import type { JiraRequirements, TestRunResult } from './types';

const execFileAsync = promisify(execFile);
const MAX_HEAL_ATTEMPTS = 3;
const contexts = new Map<string, {
  files: Set<string>;
  baselinePaths?: Set<string>;
  requirements?: JiraRequirements;
  run?: TestRunResult;
  branch?: Awaited<ReturnType<typeof createBranchAndPush>>;
}>();

function context(ticketId: string) {
  let current = contexts.get(ticketId);
  if (!current) {
    current = { files: new Set<string>() };
    contexts.set(ticketId, current);
  }
  return current;
}

export async function captureWorkingTreeBaseline(root: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all']);
  const entries = stdout.split(/\r?\n/).filter(Boolean);
  const staged = entries.filter((line) => line.slice(0, 2) !== '??' && line[0] !== ' ');
  if (staged.length) {
    const changed = staged.map((line) => line.slice(3)).join(', ');
    throw new Error(`Pipeline will not run with staged changes; unstage or commit them first: ${changed}.`);
  }
  return entries.map((line) => line.slice(3).replace(/^"|"$/g, '').replaceAll('\\', '/'));
}

export async function fetchRequirements(root: string, requestedId: string): Promise<JiraRequirements> {
  const ticketId = validateTicketId(requestedId);
  const current = context(ticketId);
  if (!current.baselinePaths) current.baselinePaths = new Set(await captureWorkingTreeBaseline(root));
  const requirements = await fetchJiraRequirements(root, ticketId);
  current.requirements = requirements;
  return requirements;
}

export async function createCases(
  root: string,
  requestedId: string,
  autoPlan = false,
): Promise<{ path: string; count: number; cases: Awaited<ReturnType<typeof readTestCases>>; created: boolean }> {
  const ticketId = validateTicketId(requestedId);
  const current = context(ticketId);
  const requirements = current.requirements ?? await fetchRequirements(root, ticketId);
  const generated = await generateTestCases(root, ticketId, requirements);
  if (!autoPlan) {
    if (generated.created) current.files.add(generated.path);
    return { ...generated, cases: await readTestCases(root, ticketId) };
  }
  const prepared = await prepareLocalAutomationPlans(root, ticketId, requirements);
  current.files.add(generated.path);
  return { ...generated, cases: prepared.cases };
}

export async function createAutomationScript(
  root: string,
  requestedId: string,
): Promise<{ paths: string[]; generated: boolean }> {
  const ticketId = validateTicketId(requestedId);
  const generated = await generateAutomationScript(root, ticketId);
  for (const file of generated.paths) context(ticketId).files.add(file);
  return generated;
}

export async function runSpecifiedTests(root: string, requestedPaths: string[]): Promise<TestRunResult> {
  const result = await runTests(root, requestedPaths);
  for (const requestedPath of requestedPaths) {
    const normalized = requestedPath.replaceAll('\\', '/');
    const ticketId = normalized.match(/^tests\/generated\/([A-Z][A-Z0-9]+-\d+)\.spec\.ts$/)?.[1];
    if (ticketId && contexts.has(ticketId)) context(ticketId).run = result;
  }
  return result;
}

export async function healScript(
  root: string,
  requestedTest: string,
  compactFailure: string,
): Promise<{
  category: 'assertion-mismatch' | 'locator-or-timing' | 'data' | 'unknown';
  changed: false;
  stop: true;
  reason: string;
}> {
  const absolute = path.resolve(root, requestedTest);
  if (!absolute.startsWith(`${path.resolve(root, 'tests')}${path.sep}`) || !/\.spec\.ts$/.test(absolute)) {
    throw new Error('heal_script accepts only a test file inside tests/ with a .spec.ts suffix.');
  }
  if (!compactFailure.trim() || compactFailure.length > 12_000) {
    throw new Error('Provide a non-empty compact failure message no longer than 12,000 characters.');
  }

  if (/Expected:|Received:|expect\(.+\)\.to/i.test(compactFailure)) {
    return {
      category: 'assertion-mismatch',
      changed: false,
      stop: true,
      reason: 'Assertion mismatch may indicate a product defect or an incorrect requirement. Assertions were not changed.',
    };
  }
  if (/timeout|timed out|locator|strict mode/i.test(compactFailure)) {
    return {
      category: 'locator-or-timing',
      changed: false,
      stop: true,
      reason: 'The compact failure lacks current DOM evidence needed to safely change a locator or wait condition.',
    };
  }
  if (/invalid input|validation|data|expected value/i.test(compactFailure)) {
    return {
      category: 'data',
      changed: false,
      stop: true,
      reason: 'The failure does not identify a safe data-only correction; test code and assertions were left unchanged.',
    };
  }
  return {
    category: 'unknown',
    changed: false,
    stop: true,
    reason: 'No deterministic, assertion-preserving fix can be justified from the compact failure output.',
  };
}

export async function pushTicketBranch(
  root: string,
  requestedId: string,
): Promise<Awaited<ReturnType<typeof createBranchAndPush>>> {
  const ticketId = validateTicketId(requestedId);
  const current = context(ticketId);
  if (!current.run || current.run.status !== 'passed' || current.run.failed !== 0) {
    throw new Error(`Tests have not passed for ${ticketId}; refusing to create or push a branch.`);
  }
  const result = await createBranchAndPush(
    root,
    ticketId,
    [...current.files],
    [...(current.baselinePaths ?? [])],
  );
  current.branch = result;
  return result;
}

export async function openPullRequest(
  root: string,
  requestedId: string,
): Promise<Awaited<ReturnType<typeof createPullRequest>>> {
  const ticketId = validateTicketId(requestedId);
  const current = context(ticketId);
  if (!current.requirements || !current.run || !current.branch) {
    throw new Error(`Run requirements, tests, and branch/push steps before creating the PR for ${ticketId}.`);
  }
  const cases = await readTestCases(root, ticketId);
  return createPullRequest(root, ticketId, {
    requirements: current.requirements,
    cases,
    run: current.run,
    branch: current.branch.branch,
    files: current.branch.files,
    defaultBranch: current.branch.defaultBranch,
  });
}

type PipelineResult = {
  ticketId: string;
  framework: string;
  testCases: number;
  run: TestRunResult;
  healAttempts: number;
  branch: string;
  pullRequest: string;
};

async function executePipeline(
  root: string,
  requestedId: string,
  onStage?: (stage: string) => void,
): Promise<PipelineResult> {
  const ticketId = validateTicketId(requestedId);
  contexts.set(ticketId, { files: new Set<string>() });
  onStage?.('Analyze the Playwright framework');
  const analysis = await analyzeFramework(root);
  onStage?.('Fetch Jira requirements');
  const requirements = await fetchRequirements(root, ticketId);
  onStage?.('Generate test cases and local automation plans');
  const generatedCases = await createCases(root, ticketId, true);
  onStage?.('Generate the POM test script');
  const generatedScript = await createAutomationScript(root, ticketId);
  if (generatedScript.paths.length === 0) throw new Error('Automation generation produced no test paths.');

  onStage?.('Run only the generated test');
  let run = await runTests(root, generatedScript.paths, 'chromium');
  let healAttempts = 0;
  while (run.status === 'failed' && healAttempts < MAX_HEAL_ATTEMPTS) {
    healAttempts += 1;
    const failed = run.tests.find((test) => test.status !== 'passed');
    if (!failed) break;
    onStage?.(`Diagnose failed test (attempt ${healAttempts}/${MAX_HEAL_ATTEMPTS})`);
    const healed = await healScript(root, generatedScript.paths[0], failed.error ?? 'Unknown test failure.');
    if (!healed.changed) break;
    onStage?.('Re-run the changed test');
    run = await runTests(root, [generatedScript.paths[0]], 'chromium');
  }
  context(ticketId).run = run;
  if (run.status !== 'passed') {
    throw new Error(`Tests failed after ${healAttempts} heal attempt(s); branch and PR were not created.`);
  }

  onStage?.('Create the feature branch and push generated files');
  const branch = await pushTicketBranch(root, ticketId);
  onStage?.('Create the pull request');
  const pullRequest = await openPullRequest(root, ticketId);
  return {
    ticketId,
    framework: analysis.summary,
    testCases: generatedCases.count,
    run,
    healAttempts,
    branch: branch.branch,
    pullRequest: pullRequest.url,
  };
}

export async function runPipeline(root: string, requestedId: string): Promise<PipelineResult> {
  return executePipeline(root, requestedId);
}

export async function runCliPipeline(
  root: string,
  requestedId: string,
  onStage?: (stage: string) => void,
): Promise<PipelineResult> {
  return executePipeline(root, requestedId, onStage);
}
