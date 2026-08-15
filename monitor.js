/**
 * X search results are checked once with Playwright. A post is notified only
 * after its Discord invite passes member-count, language-relevance, and spam
 * filters. Designed for GitHub Actions scheduled runs.
 *
 * Required secrets:
 *   AUTH_JSON           Playwright storage-state JSON for a dedicated X account
 *   DISCORD_WEBHOOK_URL Discord webhook URL
 *
 * Optional GitHub Actions variables:
 *   SEARCH_QUERY                    Defaults to "discord.gg/"
 *   SCROLL_ROUNDS                   Defaults to 20
 *   MIN_MEMBER_COUNT                Defaults to 10
 *   MAX_MEMBER_COUNT                Defaults to 1000
 *   NON_JAPANESE_SCORE_THRESHOLD    Defaults to 3
 *   SPAM_TEXT_MIN_LENGTH            Defaults to 120
 *   SPAM_ENGLISH_RATIO              Defaults to 0.6
 *   DISCORD_API_DELAY_MS            Defaults to 300
 *
 * AUTH_JSON and DISCORD_WEBHOOK_URL are secrets; never commit them.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const SEARCH_QUERY = process.env.SEARCH_QUERY || 'discord.gg/';
const AUTH_JSON = process.env.AUTH_JSON;
const AUTH_FILE = path.join(__dirname, 'auth.json');
const SEEN_FILE = path.join(__dirname, 'state', 'seen.json');
const SCROLL_ROUNDS = numberFromEnv('SCROLL_ROUNDS', 20, { min: 0, max: 50 });
const DISCORD_INVITE_REGEX = /discord\.gg\/([A-Za-z0-9-]+)/gi;
const MAX_SEEN_IDS = 2000;

function numberFromEnv(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

const MIN_MEMBER_COUNT = numberFromEnv('MIN_MEMBER_COUNT', 10, { min: 0 });
const MAX_MEMBER_COUNT = numberFromEnv('MAX_MEMBER_COUNT', 1000, { min: MIN_MEMBER_COUNT });
// FOREIGN_SCORE_THRESHOLD is supported as an older compatibility alias.
const NON_JAPANESE_SCORE_THRESHOLD = numberFromEnv(
  'NON_JAPANESE_SCORE_THRESHOLD',
  numberFromEnv('FOREIGN_SCORE_THRESHOLD', 3, { min: 1 }),
  { min: 1 },
);
const SPAM_TEXT_MIN_LENGTH = numberFromEnv('SPAM_TEXT_MIN_LENGTH', 120, { min: 1 });
const SPAM_ENGLISH_RATIO = numberFromEnv('SPAM_ENGLISH_RATIO', 0.6, { min: 0, max: 1 });
const DISCORD_API_DELAY_MS = numberFromEnv('DISCORD_API_DELAY_MS', 300, { min: 0 });

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

function extractInviteCodes(text) {
  const codes = new Set();
  for (const match of text.matchAll(DISCORD_INVITE_REGEX)) {
    codes.add(match[1]);
  }
  return [...codes];
}

function englishRatio(text) {
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  const meaningfulCharacters = (text.match(/[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  return meaningfulCharacters === 0 ? 0 : letters / meaningfulCharacters;
}

function hasJapaneseScript(text) {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(text);
}

/**
 * Scores content relevance from the text itself. This deliberately does not
 * classify people by nationality; it only suppresses server and post content
 * that appears predominantly non-Japanese under the configured threshold.
 */
function nonJapaneseContentScore(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return 0;

  const ratio = englishRatio(normalized);
  let score = 0;
  if (ratio >= 0.55) score += 1;
  if (ratio >= 0.75) score += 1;
  if (!hasJapaneseScript(normalized)) score += 1;
  if (/\b(english|international|global|worldwide|community|server|giveaway|crypto|airdrop|nft)\b/i.test(normalized)) score += 1;
  return score;
}

function looksLikeSpamPost(post) {
  const text = String(post.text || '');
  if (/[#$]/.test(text)) return true;
  if (post.isVerified) return true;
  return text.length >= SPAM_TEXT_MIN_LENGTH
    && englishRatio(text) >= SPAM_ENGLISH_RATIO
    && post.hasMedia;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchInviteInfo(code) {
  const response = await fetch(
    `https://discord.com/api/v9/invites/${encodeURIComponent(code)}?with_counts=true&with_expiration=true`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } },
  );

  if (!response.ok) {
    if (response.status === 404) return { valid: false, reason: 'invalid_or_expired' };
    throw new Error(`Discord invite lookup failed for ${code}: ${response.status}`);
  }

  const invite = await response.json();
  const memberCount = invite.approximate_member_count;
  const serverName = invite.guild?.name || '';
  const serverDescription = invite.guild?.description || '';

  return {
    valid: true,
    code,
    url: `https://discord.gg/${code}`,
    memberCount,
    serverName,
    serverDescription,
  };
}

function filterInvite(invite, post) {
  if (!invite.valid) return invite.reason;
  if (!Number.isFinite(invite.memberCount)) return 'member_count_unavailable';
  if (invite.memberCount < MIN_MEMBER_COUNT) return 'member_count_below_minimum';
  if (invite.memberCount > MAX_MEMBER_COUNT) return 'member_count_above_maximum';

  const languageText = [
    post.displayName,
    post.author,
    post.text,
    invite.serverName,
    invite.serverDescription,
  ].filter(Boolean).join('\n');
  if (nonJapaneseContentScore(languageText) >= NON_JAPANESE_SCORE_THRESHOLD) {
    return 'predominantly_non_japanese_content';
  }
  return null;
}

async function sendToDiscord({ invite }) {
  const response = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: invite.url }),
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
      console.log('No posts found; the query may have no results or the page structure may have changed.');
    });

    for (let i = 0; i < SCROLL_ROUNDS; i += 1) {
      await page.mouse.wheel(0, 2000);
      await page.waitForTimeout(1000);
    }

    const posts = await page.$$eval('article', (articles) => articles.map((element) => {
      const link = [...element.querySelectorAll('a[href*="/status/"]')]
        .find((anchor) => /\/status\/\d+$/.test(anchor.getAttribute('href') || ''));
      const href = link ? link.getAttribute('href') : null;
      const match = href?.match(/^\/([^/]+)\/status\/(\d+)$/);
      const textElement = element.querySelector('[data-testid="tweetText"]');
      const userNameElement = element.querySelector('[data-testid="User-Name"]');
      const userNameText = userNameElement?.innerText || '';
      const displayName = userNameText.split('\n').find((line) => line && !line.startsWith('@')) || '';
      return {
        author: match?.[1] || null,
        displayName,
        id: match?.[2] || null,
        text: textElement ? textElement.innerText : element.innerText,
        isVerified: Boolean(element.querySelector('[data-testid="icon-verified"]')),
        hasMedia: Boolean(element.querySelector('video, img[src*="twimg.com/media"], [data-testid="videoPlayer"]')),
      };
    }));

    const counters = { notified: 0, seen: 0, spam: 0, noInvite: 0, rejected: 0 };
    for (const post of posts) {
      if (!post.author || !post.id) continue;
      if (seen.has(post.id)) {
        counters.seen += 1;
        continue;
      }

      const codes = extractInviteCodes(post.text);
      if (codes.length === 0) {
        seen.add(post.id);
        counters.noInvite += 1;
        continue;
      }

      if (looksLikeSpamPost(post)) {
        seen.add(post.id);
        counters.spam += 1;
        continue;
      }

      for (const code of codes) {
        let invite;
        try {
          invite = await fetchInviteInfo(code);
        } catch (error) {
          console.warn(error.message);
          continue;
        }

        const rejectionReason = filterInvite(invite, post);
        if (rejectionReason) {
          console.log(`Skipped ${code}: ${rejectionReason}.`);
          counters.rejected += 1;
          await sleep(DISCORD_API_DELAY_MS);
          continue;
        }

        await sendToDiscord({ invite });
        counters.notified += 1;
        console.log(`Notification sent for ${code} from @${post.author}.`);
        await sleep(DISCORD_API_DELAY_MS);
      }

      seen.add(post.id);
    }

    saveSeen(seen);
    console.log(`Completed: ${JSON.stringify(counters)}.`);
  } finally {
    await browser?.close();
    removeTemporaryAuthFile(createdAuthFile);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  englishRatio,
  extractInviteCodes,
  filterInvite,
  looksLikeSpamPost,
  nonJapaneseContentScore,
};
