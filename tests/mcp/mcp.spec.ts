import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test, expect } from '@playwright/test';
import { extractAcceptanceCriteria, jiraPlainText, validateTicketId } from '../../src/mcp/jira';
import { createBranchAndPush } from '../../src/mcp/github';
import { generateAutomationScript, generateTestCases, prepareLocalAutomationPlans, readTestCases } from '../../src/mcp/test-cases';
import { captureWorkingTreeBaseline, healScript } from '../../src/mcp/pipeline';

const execFileAsync = promisify(execFile);

test('normalizes and validates Jira ticket IDs', () => {
  expect(validateTicketId(' kan-4 ')).toBe('KAN-4');
  expect(() => validateTicketId('KAN four')).toThrow(/Invalid Jira ticket ID/);
});

test('extracts only acceptance criteria from the matching description section', () => {
  expect(extractAcceptanceCriteria([
    'Summary text',
    '## Acceptance Criteria',
    '- User can submit a valid form.',
    '- Invalid email is rejected.',
    '## Notes',
    '- Not an acceptance criterion.',
  ].join('\n'))).toEqual([
    'User can submit a valid form.',
    'Invalid email is rejected.',
  ]);
  expect(extractAcceptanceCriteria('Acceptance Criteria: The user can save changes.'))
    .toEqual(['The user can save changes.']);
});

test('extracts criteria written inline in a Markdown heading', () => {
  expect(extractAcceptanceCriteria([
    '## Acceptance Criteria: The user can save changes.',
    '## Notes',
    'Not an acceptance criterion.',
  ].join('\n'))).toEqual(['The user can save changes.']);
});

test('extracts KAN-5-style acceptance criteria with numbered nested headings', () => {
  expect(extractAcceptanceCriteria([
    'Objective:',
    'Automate the Elements module.',
    '## Acceptance Criteria (AC)',
    '## 1. Framework & Architecture Standards',
    '- Page Object Model (POM): A dedicated ElementsPage is created.',
    '- Locator Strategy: Resilient locators are prioritized.',
    '- Synchronization: No static waitForTimeout calls.',
    '- Test Data Management: Inputs are externalized.',
  ].join('\n'))).toEqual([
    'Page Object Model (POM): A dedicated ElementsPage is created.',
    'Locator Strategy: Resilient locators are prioritized.',
    'Synchronization: No static waitForTimeout calls.',
    'Test Data Management: Inputs are externalized.',
  ]);
});

test('preserves Jira ADF headings and bullet lists when extracting criteria', () => {
  const description = jiraPlainText({
    type: 'doc',
    content: [
      { type: 'heading', content: [{ type: 'text', text: 'Acceptance Criteria' }] },
      { type: 'bulletList', content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Valid input is accepted.' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Invalid input is rejected.' }] }] },
      ] },
      { type: 'heading', content: [{ type: 'text', text: 'Notes' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Not a criterion.' }] },
    ],
  });
  expect(extractAcceptanceCriteria(description)).toEqual([
    'Valid input is accepted.',
    'Invalid input is rejected.',
  ]);
});

test('creates positive, negative, and edge cases traceable to each criterion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'demoqa-mcp-'));
  try {
    const result = await generateTestCases(root, 'KAN-4', {
      ticketId: 'KAN-4',
      updated: '2026-11-21T00:00:00.000Z',
      title: 'Example requirement',
      description: '',
      acceptanceCriteria: ['The form accepts valid input.'],
      labels: [],
      linkedIssues: [],
    });
    const saved = JSON.parse(await readFile(path.join(root, result.path), 'utf8'));
    expect(result.count).toBe(3);
    expect(saved.testCases.map((item: { category: string }) => item.category))
      .toEqual(['positive', 'negative', 'edge']);
    expect(saved.testCases.every((item: { acceptanceCriterionId: string }) => item.acceptanceCriterionId === 'KAN-4-AC1'))
      .toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('creates local visibility plans and reuses them on later runs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'demoqa-mcp-plans-'));
  const requirements = {
    ticketId: 'KAN-4',
    updated: '2026-11-21T00:00:00.000Z',
    title: 'Join button visibility on the DemoQA homepage',
    description: '',
    acceptanceCriteria: ['The "JOIN NOW" button is visible on the homepage.'],
    labels: [],
    linkedIssues: [],
  };
  try {
    const generated = await generateTestCases(root, 'KAN-4', requirements);
    expect(generated.created).toBe(true);

    const prepared = await prepareLocalAutomationPlans(root, 'KAN-4', requirements);
    expect(prepared.updated).toBe(true);
    expect(prepared.cases).toHaveLength(3);
    expect(prepared.cases.every((testCase) => testCase.reviewRequired === false
      && testCase.automationPlan?.pageObject === 'homePage'
      && testCase.automationPlan.assertion.kind === 'linkVisible'
      && testCase.automationPlan.assertion.expected === 'Selenium Online Training'
      && testCase.automationPlan.assertion.href === 'https://www.toolsqa.com/selenium-training/'
      && testCase.automationPlanSource === 'local-rule')).toBe(true);

    const saved = JSON.parse(await readFile(path.join(root, generated.path), 'utf8'));
    for (const testCase of saved.testCases) {
      delete testCase.automationPlanSource;
      testCase.automationPlan = {
        pageObject: 'homePage',
        actions: [{ method: 'goto' }],
        assertion: { kind: 'textVisible', expected: 'JOIN NOW' },
      };
    }
    await writeFile(path.join(root, generated.path), JSON.stringify(saved), 'utf8');
    const migrated = await prepareLocalAutomationPlans(root, 'KAN-4', requirements);
    expect(migrated.updated).toBe(true);
    expect(migrated.cases.every((testCase) => testCase.automationPlan?.assertion.kind === 'linkVisible')).toBe(true);

    const repeated = await generateTestCases(root, 'KAN-4', requirements);
    expect(repeated.created).toBe(false);
    expect((await prepareLocalAutomationPlans(root, 'KAN-4', requirements)).updated).toBe(false);
    expect((await readTestCases(root, 'KAN-4')).every((testCase) => Boolean(testCase.automationPlan))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not infer a local plan when a criterion has no quoted button or link label', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'demoqa-mcp-unsupported-plan-'));
  const requirements = {
    ticketId: 'KAN-4',
    updated: '2026-11-21T00:00:00.000Z',
    title: 'Form validation',
    description: '',
    acceptanceCriteria: ['The form accepts valid input.'],
    labels: [],
    linkedIssues: [],
  };
  try {
    await generateTestCases(root, 'KAN-4', requirements);
    await expect(prepareLocalAutomationPlans(root, 'KAN-4', requirements))
      .rejects.toThrow(/Cannot prepare automation for KAN-4; no tests were run\.[\s\S]*KAN-4-AC1[\s\S]*Framework\/design standards alone are not runnable UI scenarios/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves reviewed manual plans when a criterion cannot be auto-planned', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'demoqa-mcp-reviewed-plan-'));
  const requirements = {
    ticketId: 'KAN-4',
    updated: '2026-11-21T00:00:00.000Z',
    title: 'Form validation',
    description: '',
    acceptanceCriteria: ['The form accepts valid input.'],
    labels: [],
    linkedIssues: [],
  };
  try {
    const generated = await generateTestCases(root, 'KAN-4', requirements);
    const testCaseFile = path.join(root, generated.path);
    const saved = JSON.parse(await readFile(testCaseFile, 'utf8'));
    for (const testCase of saved.testCases) {
      testCase.reviewRequired = false;
      testCase.automationPlan = {
        pageObject: 'homePage',
        actions: [{ method: 'goto' }],
        assertion: { kind: 'titleContains', expected: 'demosite' },
      };
    }
    await writeFile(testCaseFile, JSON.stringify(saved), 'utf8');

    const prepared = await prepareLocalAutomationPlans(root, 'KAN-4', requirements);
    expect(prepared.updated).toBe(false);
    expect(prepared.cases.every((testCase) => testCase.reviewRequired === false
      && testCase.automationPlan?.assertion.kind === 'titleContains')).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not generate a spec while automation plans still require review', async () => {
  const root = await mkdtemp(path.join(process.cwd(), '.mcp-cache', 'unreviewed-plan-test-'));
  try {
    for (const file of [
      'package.json',
      'playwright.config.ts',
      'tsconfig.json',
      'src/pages/HomePage.ts',
      'src/pages/PageManager.ts',
      'src/fixtures/test.ts',
    ]) {
      const target = path.join(root, file);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(process.cwd(), file), target);
    }
    await mkdir(path.join(root, 'test-cases'), { recursive: true });
    await writeFile(path.join(root, 'test-cases', 'KAN-4.json'), JSON.stringify({
      ticketId: 'KAN-4',
      testCases: [{
        id: 'KAN-4-AC1-POSITIVE',
        acceptanceCriterionId: 'KAN-4-AC1',
        category: 'positive',
        title: 'Homepage displays DemoQA',
        steps: ['Open the homepage.'],
        expectedResult: 'The page title contains demosite.',
        reviewRequired: true,
        automationPlan: {
          pageObject: 'homePage',
          actions: [{ method: 'goto' }],
          assertion: { kind: 'titleContains', expected: 'demosite' },
        },
      }],
    }), 'utf8');

    await expect(generateAutomationScript(root, 'KAN-4'))
      .rejects.toThrow(/1 test cases still require review[\s\S]*KAN-4-AC1-POSITIVE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plans visibility checks for multiple quoted homepage card labels', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'demoqa-mcp-homepage-labels-'));
  const requirements = {
    ticketId: 'KAN-4',
    updated: '2026-11-21T00:00:00.000Z',
    title: 'Validate homepage cards',
    description: '',
    acceptanceCriteria: ['The homepage div “Elements”, “Forms”, “Interactions”, and “Widgets” are present.'],
    labels: [],
    linkedIssues: [],
  };
  try {
    await generateTestCases(root, 'KAN-4', requirements);
    const prepared = await prepareLocalAutomationPlans(root, 'KAN-4', requirements);
    expect(prepared.cases).toHaveLength(3);
    expect(prepared.cases.every((testCase) => testCase.automationPlan?.assertion.kind === 'textsVisible'
      && testCase.automationPlan.assertion.expected.join(',') === 'Elements,Forms,Interactions,Widgets')).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plans semantic heading visibility checks for homepage headings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'demoqa-mcp-homepage-headings-'));
  const requirements = {
    ticketId: 'KAN-6',
    updated: '2026-11-22T00:00:00.000Z',
    title: 'UI Testing Playground homepage scenario catalog',
    description: '',
    acceptanceCriteria: [
      'On the homepage, the heading “UI Test Automation Playground” and scenario headings “Dynamic ID” and “Class Attribute” are visible.',
    ],
    labels: [],
    linkedIssues: [],
  };
  try {
    await generateTestCases(root, 'KAN-6', requirements);
    const prepared = await prepareLocalAutomationPlans(root, 'KAN-6', requirements);
    expect(prepared.cases).toHaveLength(3);
    expect(prepared.cases.every((testCase) => testCase.automationPlan?.assertion.kind === 'headingsVisible'
      && testCase.automationPlan.assertion.expected.join(',') === 'UI Test Automation Playground,Dynamic ID,Class Attribute')).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generates a POM spec from registered page-object methods and a reviewed plan', async () => {
  const root = await mkdtemp(path.join(process.cwd(), '.mcp-cache', 'generation-test-'));
  try {
    for (const file of [
      'package.json',
      'playwright.config.ts',
      'tsconfig.json',
      'src/pages/HomePage.ts',
      'src/pages/PageManager.ts',
      'src/fixtures/test.ts',
    ]) {
      const target = path.join(root, file);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(process.cwd(), file), target);
    }
    await mkdir(path.join(root, 'test-cases'), { recursive: true });
    await writeFile(path.join(root, 'test-cases', 'KAN-4.json'), JSON.stringify({
      ticketId: 'KAN-4',
      testCases: [{
        id: 'KAN-4-AC1-POSITIVE',
        acceptanceCriterionId: 'KAN-4-AC1',
        category: 'positive',
        title: 'Homepage displays DemoQA',
        steps: ['Open the homepage.'],
        expectedResult: 'The page title contains demosite.',
        reviewRequired: false,
        automationPlan: {
          pageObject: 'homePage',
          actions: [{ method: 'goto' }],
          assertion: { kind: 'titleContains', expected: 'demosite' },
        },
      }, {
        id: 'KAN-4-AC2-POSITIVE',
        acceptanceCriterionId: 'KAN-4-AC2',
        category: 'positive',
        title: 'Training banner link is visible',
        steps: ['Open the homepage.'],
        expectedResult: 'The training link is visible.',
        reviewRequired: false,
        automationPlan: {
          pageObject: 'homePage',
          actions: [{ method: 'goto' }],
          assertion: {
            kind: 'linkVisible',
            expected: 'Selenium Online Training',
            href: 'https://www.toolsqa.com/selenium-training/',
          },
        },
      }, {
        id: 'KAN-4-AC3-POSITIVE',
        acceptanceCriterionId: 'KAN-4-AC3',
        category: 'positive',
        title: 'Homepage card labels are visible',
        steps: ['Open the homepage.'],
        expectedResult: 'The card labels are visible.',
        reviewRequired: false,
        automationPlan: {
          pageObject: 'homePage',
          actions: [{ method: 'goto' }],
          assertion: { kind: 'textsVisible', expected: ['Elements', 'Forms'] },
        },
      }, {
        id: 'KAN-4-AC4-POSITIVE',
        acceptanceCriterionId: 'KAN-4-AC4',
        category: 'positive',
        title: 'UI Testing Playground headings are visible',
        steps: ['Open the homepage.'],
        expectedResult: 'The page and scenario headings are visible.',
        reviewRequired: false,
        automationPlan: {
          pageObject: 'homePage',
          actions: [{ method: 'goto' }],
          assertion: { kind: 'headingsVisible', expected: ['UI Test Automation Playground', 'Dynamic ID'] },
        },
      }],
    }), 'utf8');

    const result = await generateAutomationScript(root, 'KAN-4');
    const generated = await readFile(path.join(root, result.paths[0]), 'utf8');
    expect(result.generated).toBe(true);
    expect(generated).toContain('await pages.homePage.goto();');
    expect(generated).toContain('page.title()).toContain("demosite")');
    expect(generated).toContain('page.getByRole(\'link\', { name: "Selenium Online Training", exact: true })');
    expect(generated).toContain('toHaveAttribute(\'href\', "https://www.toolsqa.com/selenium-training/")');
    expect(generated).toContain('page.getByText("Elements", { exact: true })');
    expect(generated).toContain('page.getByText("Forms", { exact: true })');
    expect(generated).toContain('page.getByRole(\'heading\', { name: "UI Test Automation Playground", exact: true })');

    const saved = JSON.parse(await readFile(path.join(root, 'test-cases', 'KAN-4.json'), 'utf8'));
    saved.testCases[1].automationPlan.assertion.href = 'https://example.test/training/';
    await writeFile(path.join(root, 'test-cases', 'KAN-4.json'), JSON.stringify(saved), 'utf8');
    const regenerated = await generateAutomationScript(root, 'KAN-4');
    const updatedSpec = await readFile(path.join(root, regenerated.paths[0]), 'utf8');
    expect(regenerated.generated).toBe(true);
    expect(updatedSpec).toContain('toHaveAttribute(\'href\', "https://example.test/training/")');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not alter assertions after a mismatch', async () => {
  const result = await healScript(
    process.cwd(),
    'tests/smoke/home.spec.ts',
    'Expected: "accepted"\nReceived: "rejected"',
  );
  expect(result.category).toBe('assertion-mismatch');
  expect(result.changed).toBe(false);
  expect(result.stop).toBe(true);
});

test('refuses to start the pipeline when the repository has staged changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'demoqa-git-baseline-'));
  try {
    await execFileAsync('git', ['-C', root, 'init']);
    await writeFile(path.join(root, 'staged.txt'), 'staged change', 'utf8');
    await execFileAsync('git', ['-C', root, 'add', 'staged.txt']);
    await expect(captureWorkingTreeBaseline(root)).rejects.toThrow(/staged changes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reuses the interrupted ticket branch when only generated files are staged', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'demoqa-branch-recovery-'));
  const bare = path.join(root, 'github.com', 'test-owner', 'test-repo.git');
  const repo = path.join(root, 'work');
  const git = async (args: string[]) => execFileAsync('git', ['-C', repo, ...args]);
  try {
    await mkdir(path.dirname(bare), { recursive: true });
    await mkdir(repo, { recursive: true });
    await execFileAsync('git', ['init', '--bare', bare]);
    await execFileAsync('git', ['--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
    await git(['init']);
    await git(['config', 'user.name', 'Local Test']);
    await git(['config', 'user.email', 'local-test@example.invalid']);
    await writeFile(path.join(repo, 'README.md'), 'test\n');
    await writeFile(path.join(repo, '.gitignore'), 'base ignore rules\n');
    await git(['add', 'README.md', '.gitignore']);
    await git(['commit', '-m', 'initial']);
    await git(['branch', '-M', 'main']);
    await git(['remote', 'add', 'origin', pathToFileURL(bare).href]);
    await git(['push', '-u', 'origin', 'main']);
    await git(['fetch', 'origin', 'refs/heads/main:refs/remotes/origin/main']);
    await git(['checkout', '-b', 'feature/KAN-4-automation', 'origin/main']);

    await mkdir(path.join(repo, 'test-cases'), { recursive: true });
    await mkdir(path.join(repo, 'tests', 'generated'), { recursive: true });
    await writeFile(path.join(repo, '.gitignore'), 'local cache rules\n');
    await writeFile(path.join(repo, 'test-cases', 'KAN-4.json'), '{}\n');
    await writeFile(path.join(repo, 'tests', 'generated', 'KAN-4.spec.ts'), '// generated\n');
    await git(['add', 'test-cases/KAN-4.json']);

    const result = await createBranchAndPush(repo, 'KAN-4', [
      'test-cases/KAN-4.json',
      'tests/generated/KAN-4.spec.ts',
    ], ['.gitignore']);

    expect(result.pushed).toBe(true);
    expect(result.files).toEqual(['test-cases/KAN-4.json', 'tests/generated/KAN-4.spec.ts']);
    const reused = await createBranchAndPush(repo, 'KAN-4', [
      'test-cases/KAN-4.json',
      'tests/generated/KAN-4.spec.ts',
    ], ['.gitignore']);
    expect(reused.branch).toBe(result.branch);
    expect(reused.commit).toBe(result.commit);
    const { stdout } = await execFileAsync('git', ['-C', repo, 'ls-remote', '--heads', 'origin', 'feature/KAN-4-automation']);
    expect(stdout).toContain('refs/heads/feature/KAN-4-automation');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
