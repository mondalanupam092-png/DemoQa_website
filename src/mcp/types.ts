export type JiraRequirements = {
  ticketId: string;
  updated: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  labels: string[];
  linkedIssues: string[];
};

export type TestCase = {
  id: string;
  acceptanceCriterionId: string;
  category: 'positive' | 'negative' | 'edge';
  title: string;
  steps: string[];
  expectedResult: string;
  reviewRequired: boolean;
  automationPlan?: AutomationPlan | null;
  automationPlanSource?: 'local-rule';
};

export type AutomationPlan = {
  pageObject: string;
  actions: Array<{ method: string; args?: string[] }>;
  assertion:
    | { kind: 'textVisible' | 'titleContains'; expected: string }
    | { kind: 'textsVisible'; expected: string[] }
    | { kind: 'linkVisible'; expected: string; href: string };
};

export type TestRunResult = {
  status: 'passed' | 'failed';
  passed: number;
  failed: number;
  tests: Array<{
    title: string;
    status: string;
    error?: string;
    failingLine?: number;
    screenshotPath?: string;
    logPath?: string;
  }>;
};

export type FrameworkIndex = {
  version: 1;
  gitHead: string;
  framework: {
    language: string;
    runner: string;
    pattern: string;
    tests: string;
    config: string[];
    fixtures: string;
    locators: string;
    testData: string;
    naming: string;
  };
  sourceSnapshot: Record<string, [number, number]>;
  reusable: Array<{
    name: string;
    file: string;
    signature: string;
    purpose: string;
  }>;
};
