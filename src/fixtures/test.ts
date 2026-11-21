import { test as base, expect } from '@playwright/test';
import { PageManager } from '../pages/PageManager';

type PageFixtures = {
  pages: PageManager;
};

export const test = base.extend<PageFixtures>({
  pages: async ({ page }, use) => {
    await use(new PageManager(page));
  },
});

export { expect };
