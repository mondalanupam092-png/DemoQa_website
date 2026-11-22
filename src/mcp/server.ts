import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { analyzeFramework } from './framework';
import {
  createAutomationScript,
  createCases,
  fetchRequirements,
  healScript,
  openPullRequest,
  pushTicketBranch,
  runPipeline,
  runSpecifiedTests,
} from './pipeline';

const root = path.resolve(process.env.MCP_REPO_PATH ?? process.cwd());
const server = new McpServer({
  name: 'demoqa-playwright-automation',
  version: '1.0.0',
});

function response(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function errorResponse(error: unknown) {
  if (!(error instanceof Error)) throw error;
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `Error: ${error.message}` }],
  };
}

server.registerTool(
  'analyze_framework',
  { description: 'Build or refresh the compact POM framework index.', inputSchema: {} },
  async () => {
    try {
      return response(await analyzeFramework(root));
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'fetch_jira_requirements',
  {
    description: 'Fetch Jira summary, description, acceptance criteria, labels, and linked issues.',
    inputSchema: { ticket_id: z.string().min(1).max(64) },
  },
  async ({ ticket_id }) => {
    try {
      return response(await fetchRequirements(root, ticket_id));
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'generate_test_cases',
  { description: 'Create positive, negative, and edge test-case drafts mapped to Jira acceptance criteria.', inputSchema: { ticket_id: z.string().min(1).max(64) } },
  async ({ ticket_id }) => {
    try {
      return response(await createCases(root, ticket_id));
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'generate_automation_script',
  { description: 'Generate a POM-based spec from reviewed automation plans in the ticket test-case JSON.', inputSchema: { ticket_id: z.string().min(1).max(64) } },
  async ({ ticket_id }) => {
    try {
      return response(await createAutomationScript(root, ticket_id));
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'run_tests',
  {
    description: 'Run only specified *.spec.ts files under tests/ and return a compact result.',
    inputSchema: { paths: z.array(z.string().min(1)).min(1).max(20) },
  },
  async ({ paths }) => {
    try {
      return response(await runSpecifiedTests(root, paths));
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'heal_script',
  {
    description: 'Diagnose a compact test failure; stop rather than alter assertions or make unsupported fixes.',
    inputSchema: {
      test: z.string().min(1).max(512),
      failure: z.string().min(1).max(12_000),
    },
  },
  async ({ test, failure }) => {
    try {
      return response(await healScript(root, test, failure));
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'create_branch_and_push',
  { description: 'Create feature/<JIRA-ID>-automation from the remote default branch and push only this run’s files.', inputSchema: { ticket_id: z.string().min(1).max(64) } },
  async ({ ticket_id }) => {
    try {
      return response(await pushTicketBranch(root, ticket_id));
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'create_pull_request',
  { description: 'Open a GitHub pull request against the remote default branch after tests pass.', inputSchema: { ticket_id: z.string().min(1).max(64) } },
  async ({ ticket_id }) => {
    try {
      return response(await openPullRequest(root, ticket_id));
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  'run_pipeline',
  {
    description: 'Run framework analysis, Jira retrieval, case/script generation, targeted tests, bounded healing, push, and PR.',
    inputSchema: { ticket_id: z.string().min(1).max(64) },
  },
  async ({ ticket_id }) => {
    try {
      return response(await runPipeline(root, ticket_id));
    } catch (error) {
      return errorResponse(error);
    }
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown MCP server startup error.';
  console.error(`MCP server startup failed: ${message}`);
  process.exitCode = 1;
});
