#!/usr/bin/env node
/**
 * UI smoke driver for the local Trident app (frontend :5173 + backend :3000).
 * Uses the machine's installed Google Chrome via playwright-core — no browser
 * download. Logs in with the dev-seed admin and screenshots each step.
 *
 * Setup (once, outside the repo so node_modules stays clean):
 *   mkdir -p /tmp/trident-ui-driver && cd /tmp/trident-ui-driver
 *   npm init -y && npm i playwright-core
 *
 * Run (from the driver dir so playwright-core resolves):
 *   node <repo>/.claude/skills/run-local/driver.mjs [outDir]
 *
 * Exit 0 = login flow reached the app shell; screenshots in outDir.
 */
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'noop.js'));
const { chromium } = require('playwright-core');

const BASE = process.env.TRIDENT_URL ?? 'http://localhost:5173';
const USER = process.env.TRIDENT_USER ?? 'admin';
const PASS = process.env.TRIDENT_PASS ?? 'admin12345';
const OUT = process.argv[2] ?? process.cwd();

const shot = async (page, name) => {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`screenshot: ${file}`);
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await shot(page, '01-login');

  await page.getByPlaceholder('User ID').fill(USER);
  await page.getByPlaceholder('Password').fill(PASS);
  await page.keyboard.press('Enter');

  // Successful login leaves the login form; the app shell renders.
  await page.waitForSelector('.login-form', { state: 'detached', timeout: 15000 });
  await page.waitForLoadState('networkidle');
  await shot(page, '02-after-login');

  console.log('OK: logged in as', USER, '— title:', await page.title());
} catch (err) {
  await shot(page, '99-failure');
  console.error('FAIL:', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
