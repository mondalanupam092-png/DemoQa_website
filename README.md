# DemoQA Playwright POM Framework

A TypeScript test framework built with Playwright Test and the Page Object Model (POM). It starts with one smoke test and is structured so you can add page objects and test cases as the suite grows.

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

Set `BASE_URL` to point tests at another environment. For example, in PowerShell:

```powershell
$env:BASE_URL = "https://demoqa.com"
npm test
```

## Project layout

```text
src/
  fixtures/
    test.ts             # Shared Playwright fixtures and expect
  pages/
    HomePage.ts         # Page object for the DemoQA homepage
    PageManager.ts      # One place to register and access page objects
tests/
  smoke/
    home.spec.ts        # Example smoke test
playwright.config.ts    # Browser projects, timeouts, reporting, and artifacts
```

## Add a test

1. Add a page object under `src/pages/` for the page or feature. Accept a Playwright `Page` in its constructor and keep page interactions in that class.
2. Register it in `PageManager.ts` as a `readonly` property, constructing it with the `Page` passed to the manager.
3. Add a `*.spec.ts` file under `tests/`, import `test` and `expect` from `src/fixtures/test`, then use the needed object through `pages`, for example `pages.homePage`.
4. Prefer role-, label-, and text-based locators. Use stable test IDs when the application provides them; avoid brittle CSS and XPath selectors.

The config runs Chromium, Firefox, and WebKit. It retries failed tests and limits workers in CI, and saves an HTML report plus trace and screenshot artifacts as configured.
