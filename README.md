# UI Testing Playground Playwright POM Framework

A TypeScript test framework built with Playwright Test and the Page Object Model (POM), targeting UI Testing Playground. It starts with one smoke test and is structured so you can add page objects and test cases as the suite grows.

## Requirements

- Node.js 20 or newer
- npm

## Setup

```powershell
npm install
npx playwright install
```

To install only Chromium while getting started:

```powershell
npx playwright install chromium
```

## Run tests

```powershell
npm test
npm run test:chromium
npm run test:headed
npm run test:ui
npm run report
```

The default base URL is `http://www.uitestingplayground.com/`. Set `BASE_URL` to point tests at another environment. For example, in PowerShell:

```powershell
$env:BASE_URL = "http://www.uitestingplayground.com/"
npm test
```

## Project layout

```text
src/
  fixtures/
    test.ts             # Shared Playwright fixtures and expect
  pages/
    HomePage.ts         # Page object for the UI Testing Playground homepage
    PageManager.ts      # One place to register and access page objects
  mcp/
    server.ts           # Jira-to-PR MCP server and pipeline tools
tests/
  smoke/
    home.spec.ts        # Example smoke test
  mcp/
    mcp.spec.ts         # MCP input, case-generation, and healing checks
playwright.config.ts    # Browser projects, timeouts, reporting, and artifacts
```

## Add a test

1. Add a page object under `src/pages/` for the page or feature. Accept a Playwright `Page` in its constructor and keep page interactions in that class.
2. Register it in `PageManager.ts` as a `readonly` property, constructing it with the `Page` passed to the manager.
3. Add a `*.spec.ts` file under `tests/`, import `test` and `expect` from `src/fixtures/test`, then use the needed object through `pages`, for example `pages.homePage`.
4. Prefer role-, label-, and text-based locators. Use stable test IDs when the application provides them; avoid brittle CSS and XPath selectors.

The config runs Chromium, Firefox, and WebKit. It retries failed tests and limits workers in CI, and saves an HTML report plus trace and screenshot artifacts as configured. The Jira pipeline runs its generated spec in Chromium only, so the Chromium-only install above is sufficient for that workflow. `npm test` and the standalone MCP `run_tests` tool use all configured projects; install all browsers with `npx playwright install` to run them.

## Jira-to-PR MCP server

The official Model Context Protocol TypeScript SDK exposes tools for framework analysis, Jira requirements, test-case drafts, POM-based script generation, targeted test execution, bounded failure diagnosis, branch/push, pull request creation, and orchestration. The server supports the GitHub remote used by this repository.

### One-command CLI

The CLI runs the supported workflow without an interactive review pause:

```powershell
Copy-Item .env.example .env
# Edit .env and replace the example values with your credentials.
npm.cmd run pipeline -- KAN-4
```

Run it from the repository root, or set `MCP_REPO_PATH` in `.env`. The local planner supports homepage requirements with one quoted button/link label or multiple quoted homepage headings or card/div labels marked present or visible. Heading assertions use accessible heading roles; the other label checks use visible text. For the DemoQA `JOIN NOW` banner, the label is artwork inside an SVG image; the page exposes it as the accessible link `Selenium Online Training`. The generated test checks that link is visible and points to the training URL. The same assertions are applied to positive, negative, and edge drafts, so those generated cases are not distinct negative or boundary tests. For other workflows, add a reviewed `automationPlan` to `test-cases/<JIRA-ID>.json` using a registered page-object method, then set `reviewRequired` to `false`. The pipeline preserves these plans. Missing, unsupported, or unreviewed plans stop with the affected criterion/test-case IDs and remediation guidance before tests or push; framework/design standards alone are not runnable UI scenarios. No Jira description or repository code is sent to an external model.

The CLI loads `.env` through `dotenv`; `.env` and `.vscode/mcp.json` are ignored by Git. If tests fail, `heal_script` diagnoses the failure but does not edit code; the pipeline stops before branch creation and push. A successful test run proceeds to branch/push and PR creation. Git push still requires Git authentication to be configured on the machine, in addition to the GitHub token used by the PR API. Never paste real tokens into source files, README, or chat.

Use dotenv syntax in `.env` (not PowerShell `$env:` assignments):

```dotenv
MCP_REPO_PATH=C:\path\to\repository
JIRA_BASE_URL=https://your-site.atlassian.net
JIRA_EMAIL=your-atlassian-email
JIRA_API_TOKEN=your-jira-token
GITHUB_TOKEN=your-github-token
```

For the MCP server, credentials may instead be configured in the MCP client's environment.
The GitHub token needs repository contents write and pull-request write access. Jira credentials are sent only to the configured Jira host; GitHub credentials are sent only to `api.github.com`. Requests use timeouts and retry transient failures without logging credentials.

### VS Code MCP client configuration

Save this as `.vscode/mcp.json` and replace the workspace path as needed. VS Code prompts for the account email and both tokens; token inputs are masked and aren't stored in the config:

```json
{
  "inputs": [
    { "type": "promptString", "id": "jira-api-token", "description": "Jira API token", "password": true },
    { "type": "promptString", "id": "github-token", "description": "GitHub token", "password": true }
  ],
  "servers": {
    "demoqa-automation": {
      "type": "stdio",
      "command": "npm.cmd",
      "args": ["run", "mcp"],
      "cwd": "C:\\Users\\USER\\OneDrive\\Desktop\\Testing",
      "env": {
        "MCP_REPO_PATH": "C:\\Users\\USER\\OneDrive\\Desktop\\Testing",
        "JIRA_BASE_URL": "https://mondalanupam092.atlassian.net",
        "JIRA_EMAIL": "your-jira-email",
        "JIRA_API_TOKEN": "${input:jira-api-token}",
        "GITHUB_TOKEN": "${input:github-token}"
      }
    }
  }
}
```

### Example use

Call `analyze_framework`, then `fetch_jira_requirements` and `generate_test_cases` with a ticket ID such as `KAN-4`. Cases are written to `test-cases/<JIRA-ID>.json`, mapped to acceptance criteria, and include positive, negative, and edge drafts. Standalone case-generation leaves plans for manual review; the `run_pipeline` tool applies the same limited local visibility rule as the CLI. For a manually reviewed case, use a registered `PageManager` page, its indexed methods, and a supported assertion (`textVisible` or `titleContains`). For example:

```json
{
  "pageObject": "homePage",
  "actions": [{ "method": "goto" }],
  "assertion": { "kind": "titleContains", "expected": "demosite" }
}
```

Then call `generate_automation_script`, `run_tests` with only the generated spec path, and—after a pass—`create_branch_and_push` and `create_pull_request`.

`run_pipeline` uses the limited local visibility rules and supports reviewed manual plans. It stops with criterion IDs and next steps for unsupported or unreviewed plans, failed assertions, and ambiguous locator/timing failures rather than guessing at a fix. `heal_script` diagnoses and stops without editing code. Branch creation rejects pre-staged changes, uses `feature/<JIRA-ID>-automation` from the fetched remote default branch, and stages only the generated test-case/spec files. Unrelated existing work is not staged. Cache, report, and screenshot paths are excluded from commits.
