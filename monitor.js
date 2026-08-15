/**
 * X search results are checked once with Playwright and matching Discord invites
 * are sent to a Discord webhook. Designed for GitHub Actions scheduled runs.
 *
 * Required secret:
 *   AUTH_JSON           Playwright storage-state JSON for a dedicated X account
 *   DISCORD_WEBHOOK_URL Discord webhook URL
 *
 * Optional variable:
 *   SEARCH_QUERY        Defaults to "discord.gg/"
 *
 * The public repository never stores AUTH_JSON or the webhook URL.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const SEARCH_QUERY = process.env.SEARCH_QUERY || 'discord.gg/';
const AUTH_JSON = process.env.AUTH_JSON;
const AUTH_FILE = path.join(__dirname, 'auth.json');
const SEEN_FILE = path.join(__dirname, 'state', 'seen.json');
const DISCORD_INVITE_REGEX = /discord\.gg\/[A-Za-z0-9-]+/g;
const MAX_SEEN_IDS = 2000;

function loadSeen() {
  try {
    return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')));
  } catch {
    return new Set();
  }
}

function saveSeen(seenSet) {
  const entries = [...seenSet].slice(-MAX_SEEN_IDS);
  fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
  fs.writeFileSync(SEEN_FILE, JSON.stringify(entries, null, 2));
}

function materializeAuthFile() {
  if (fs.existsSync(AUTH_FILE)) return false;
  if (!AUTH_JSON) return false;

  try {
    JSON.parse(AUTH_JSON);
  } catch {
    throw new Error('AUTH_JSON must contain valid Playwright storage-state JSON.');
  }

  fs.writeFileSync(AUTH_FILE, AUTH_JSON, { mode: 0o600 });
  return true;
}

function removeTemporaryAuthFile(createdTemporarily) {
  if (createdTemporarily && fs.existsSync(AUTH_FILE)) {
    fs.rmSync(AUTH_FILE, { force: true });
  }
}

async function sendToDiscord({ author, invites, url }) {
  const content = [
    'discord.gg link detected',
    `Author: ${author}`,
    `Invite: ${invites.join(', ')}`,
    `Post: ${url}`,
  ].join('\n');

  const response = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord webhook error: ${response.status} ${body}`);
  }
}

async function main() {
  if (!DISCORD_WEBHOOK_URL) {
    throw new Error('DISCORD_WEBHOOK_URL is not configured.');
  }

  const createdAuthFile = materializeAuthFile();
  if (!fs.existsSync(AUTH_FILE)) {
    throw new Error('AUTH_JSON is not configured and auth.json is unavailable.');
  }

  let browser;
  try {
    const seen = loadSeen();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: AUTH_FILE });
    const page = await context.newPage();
    const searchUrl = `https://x.com/search?q=${encodeURIComponent(SEARCH_QUERY)}&f=live`;

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('article', { timeout: 20000 }).catch(() => {
      console.log('No articles found; the query may have no results or the page structure may have changed.');
    });

    for (let i = 0; i < 3; i += 1) {
      await page.mouse.wheel(0, 2000);
      await page.waitForTimeout(1000);
    }

    const posts = await page.$$eval('article', (articles) => articles.map((element) => {
      const link = [...element.querySelectorAll('a[href*="/status/"]')]
        .find((anchor) => /\/status\/\d+$/.test(anchor.getAttribute('href') || ''));
      const href = link ? link.getAttribute('href') : null;
      const textElement = element.querySelector('[data-testid="tweetText"]');
      return { href, text: textElement ? textElement.innerText : element.innerText };
    }));

    let notificationCount = 0;
    for (const post of posts) {
      if (!post.href) continue;
      const match = post.href.match(/^\/([^/]+)\/status\/(\d+)$/);
      if (!match) continue;

      const [, username, id] = match;
      if (seen.has(id)) continue;

      const invites = post.text.match(DISCORD_INVITE_REGEX);
      seen.add(id);
      if (!invites?.length) continue;

      const postUrl = `https://x.com/${username}/status/${id}`;
      await sendToDiscord({
        author: `@${username}`,
        invites: [...new Set(invites)],
        url: postUrl,
      });
      notificationCount += 1;
      console.log(`Notification sent for ${id} (@${username}).`);
    }

    saveSeen(seen);
    console.log(`Completed. New notifications: ${notificationCount}.`);
  } finally {
    await browser?.close();
    removeTemporaryAuthFile(createdAuthFile);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
