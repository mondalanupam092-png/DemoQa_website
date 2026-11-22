import 'dotenv/config';
import path from 'node:path';
import { runCliPipeline } from './pipeline';
import { validateTicketId } from './jira';

async function main(): Promise<void> {
  const requestedId = process.argv[2];
  if (!requestedId || requestedId === '--help') {
    console.log('Usage: npm run pipeline -- <JIRA-ID>');
    if (!requestedId) process.exitCode = 2;
    return;
  }
  const ticketId = validateTicketId(requestedId);
  const root = path.resolve(process.env.MCP_REPO_PATH ?? process.cwd());
  const result = await runCliPipeline(root, ticketId, (stage) => console.log(`\n==> ${stage}`));
  console.log(`\nPipeline complete:\n${JSON.stringify(result, null, 2)}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown pipeline error.';
  console.error(`Pipeline stopped: ${message}`);
  process.exitCode = 1;
});
