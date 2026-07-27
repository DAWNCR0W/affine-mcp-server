import type { Page } from '@playwright/test';

const EMAIL_INPUT_SELECTOR = 'input[type="email"], input[name="email"], input[placeholder*="email"]';
const PASSWORD_INPUT_SELECTOR = 'input[type="password"], input[name="password"]';
const CONTINUE_BUTTON_SELECTOR =
  'button:has-text("Continue with email"), button:has-text("Continue"), button[type="submit"]';
const SIGN_IN_BUTTON_SELECTOR =
  'button:has-text("Sign in"), button:has-text("Log in"), button[type="submit"]';

type SignInOptions = {
  baseUrl: string;
  email: string;
  password: string;
};

export async function signInToAffine(
  page: Page,
  { baseUrl, email, password }: SignInOptions,
): Promise<void> {
  const signInUrl = `${baseUrl}/sign-in`;
  let lastError: unknown;

  for (let attempt = 1; attempt <= 24; attempt++) {
    await page.goto(signInUrl, { waitUntil: 'domcontentloaded' });

    const emailInput = page.locator(EMAIL_INPUT_SELECTOR);
    const passwordInput = page.locator(PASSWORD_INPUT_SELECTOR);
    await emailInput.waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1_000);
    await emailInput.fill(email);
    await page.locator(CONTINUE_BUTTON_SELECTOR).first().click();

    try {
      await passwordInput.waitFor({ timeout: 4_000 });
    } catch (error) {
      lastError = error;
      continue;
    }

    await passwordInput.fill(password);
    await page.waitForTimeout(1_000);
    await page.locator(SIGN_IN_BUTTON_SELECTOR).first().click();
    try {
      await page.waitForURL(
        (url) => !url.toString().includes('/sign-in'),
        { timeout: 4_000, waitUntil: 'commit' },
      );
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}
