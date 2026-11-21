import { test, expect } from '../../src/fixtures/test';

test('homepage loads successfully', async ({ pages }) => {
  await pages.homePage.goto();

  await expect.poll(() => pages.homePage.getTitle()).toMatch(/demosite/i);
});
