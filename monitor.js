const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright');

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DISCORD_WEBHOOK_URL_SECONDARY = process.env.DISCORD_WEBHOOK_URL_SECONDARY;
const DISCORD_WEBHOOKS = [
  ['primary', DISCORD_WEBHOOK_URL],
  ['secondary', DISCORD_WEBHOOK_URL_SECONDARY],
].filter(([, url]) => Boolean(url));

const SEARCH_QUERY = process.env.SEARCH_QUERY || 'discord.gg/';
const AUTH_FILE = path.join(__dirname, 'auth.json');
const SEEN_FILE = path.join(__dirname, 'seen.json');
const DISCORD_INVITE_REGEX = /discord\.gg\/[A-Za-z0-9-]+/gi;
const MAX_SEEN = 5000;
const SCROLL_ROUNDS = Number(process.env.SCROLL_ROUNDS || 60);
const MIN_MEMBER_COUNT = Number(process.env.MIN_MEMBER_COUNT || 10);
const MAX_MEMBER_COUNT = Number(process.env.MAX_MEMBER_COUNT || 1000);
const SPAM_TEXT_MIN_LENGTH = Number(process.env.SPAM_TEXT_MIN_LENGTH || 100);
const SPAM_ENGLISH_RATIO = Number(process.env.SPAM_ENGLISH_RATIO || 0.6);
const DISCORD_API_DELAY_MS = Number(process.env.DISCORD_API_DELAY_MS || 300);
const FOREIGN_SCORE_THRESHOLD = Number(process.env.FOREIGN_SCORE_THRESHOLD || 3);
const SEARCH_SETTLE_MIN_MS = Number(process.env.SEARCH_SETTLE_MIN_MS || 1800);
const SEARCH_SETTLE_JITTER_MS = Number(process.env.SEARCH_SETTLE_JITTER_MS || 1200);
const MAX_IDLE_SCROLL_ROUNDS = Number(process.env.MAX_IDLE_SCROLL_ROUNDS || 10);
const PAGE_LOAD_TIMEOUT_MS = Number(process.env.PAGE_LOAD_TIMEOUT_MS || 60000);
const INITIAL_POST_WAIT_MS = Number(process.env.INITIAL_POST_WAIT_MS || 12000);
const HEADLESS = process.env.HEADLESS !== 'false';

function ensureAuthFile() {
  if (fs.existsSync(AUTH_FILE)) return;
  if (process.env.AUTH_JSON) {
    fs.writeFileSync(AUTH_FILE, process.env.AUTH_JSON, 'utf8');
    console.log('AUTH_JSON から auth.json を復元しました。');
    return;
  }
  throw new Error('auth.json がありません。AUTH_JSON 環境変数を設定してください。');
}

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try {
    return execSync('which chromium', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

function emptySeenState() {
  return Object.fromEntries(DISCORD_WEBHOOKS.map(([name]) => [name, new Set()]));
}

function loadSeen() {
  try {
    const raw = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
    const state = emptySeenState();
    if (Array.isArray(raw)) {
      for (const [, set] of Object.entries(state)) raw.forEach((v) => set.add(v));
      return state;
    }
    for (const [name, set] of Object.entries(state)) {
      for (const invite of Array.isArray(raw[name]) ? raw[name] : []) set.add(invite);
    }
    return state;
  } catch {
    return emptySeenState();
  }
}

function saveSeen(state) {
  const raw = Object.fromEntries(
    Object.entries(state).map(([name, set]) => [name, [...set].slice(-MAX_SEEN)])
  );
  fs.writeFileSync(SEEN_FILE, JSON.stringify(raw, null, 2));
}

function markSeenForAll(state, invite) {
  for (const [, set] of Object.entries(state)) set.add(invite);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function containsJapanese(text) {
  return /[ぁ-んァ-ヶ一-龠々]/.test(text || '');
}

function latinLetterRatio(text) {
  const normalized = (text || '')
    .replace(/https?:\/\/\S+|discord\.gg\/\S+/gi, '')
    .replace(/\s/g, '');
  if (!normalized) return 0;
  return (normalized.match(/[A-Za-z]/g) || []).length / normalized.length;
}

function hasForeignKeyword(text) {
  return /\b(english|global|international|worldwide|usa|america|europe|eu|asia|korea|china|philippines|indonesia|vietnam|thailand|russia|brasil|brazil|espa[nñ]ol|fran[cç]ais|deutsch|server|community|gaming|crypto|nft|airdrop)\b/i.test(text || '');
}

function isLikelyForeignServer({ xDisplayName, xUserName, tweetText, guildName, guildDescription }) {
  const signals = [xDisplayName, xUserName, tweetText, guildName, guildDescription];
  let score = 0;
  for (const value of signals) {
    if (!value || !value.trim() || containsJapanese(value)) continue;
    if (latinLetterRatio(value) >= 0.6 || hasForeignKeyword(value)) score++;
  }
  return score >= FOREIGN_SCORE_THRESHOLD;
}

function isPromoSpamText(text, hasMedia) {
  if (!hasMedia) return false;
  const trimmed = (text || '').trim();
  if (trimmed.length < SPAM_TEXT_MIN_LENGTH) return false;
  const nonWhitespace = trimmed.replace(/\s/g, '');
  if (!nonWhitespace) return false;
  const asciiLetters = trimmed.match(/[A-Za-z]/g) || [];
  return asciiLetters.length / nonWhitespace.length >= SPAM_ENGLISH_RATIO;
}

async function fetchInviteInfo(inviteCode) {
  try {
    const res = await fetch(
      `https://discord.com/api/v10/invites/${encodeURIComponent(inviteCode)}?with_counts=true`
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.guild) return { isFriendInvite: true };
    return {
      isFriendInvite: false,
      memberCount: typeof data.approximate_member_count === 'number' ? data.approximate_member_count : null,
      guildName: data.guild?.name || '',
      guildDescription: data.guild?.description || '',
    };
  } catch (err) {
    console.error(`招待情報の取得に失敗 (${inviteCode}):`, err.message);
    return null;
  }
}

async function sendToDiscord(inviteUrl, targets = DISCORD_WEBHOOKS) {
  const payload = JSON.stringify({ content: `https://${inviteUrl}` });
  const results = await Promise.allSettled(targets.map(async ([name, webhookUrl]) => {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${await res.text()}`);
    return name;
  }));

  const succeeded = [];
  for (const result of results) {
    if (result.status === 'fulfilled') succeeded.push(result.value);
    else console.error(`通知失敗(${result.reason?.message || 'unknown error'})`);
  }
  return succeeded;
}

function takeFreshTweets(batch, seenPostKeys) {
  return batch.filter((tweet) => {
    const postKey = tweet.postKey || `${tweet.xUserName}\n${tweet.text}`;
    if (seenPostKeys.has(postKey)) return false;
    seenPostKeys.add(postKey);
    return true;
  });
}

async function collectTweetBatch(page) {
  return page.evaluate(() => {
    const primary = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    const fallback = Array.from(document.querySelectorAll('article'));
    const elements = primary.length ? primary : fallback;

    return elements.map((el) => {
      const textEls = Array.from(el.querySelectorAll('[data-testid="tweetText"]'));
      const text = textEls.length
        ? textEls.map((node) => node.innerText || '').join('\n').trim()
        : (el.innerText || '').trim();

      const userNameEl = el.querySelector('[data-testid="User-Name"]');
      const userNameLines = (userNameEl?.innerText || '')
        .split('\n').map((line) => line.trim()).filter(Boolean);
      const xDisplayName = userNameLines.find((line) => !line.startsWith('@')) || '';
      const handle = userNameLines.find((line) => line.startsWith('@')) || '';
      const xUserName = handle.replace(/^@/, '');

      const statusLink = Array.from(el.querySelectorAll('a[href*="/status/"]'))
        .map((a) => a.getAttribute('href') || '')
        .find((href) => /\/[^/]+\/status\/\d+(?:\?|$)/.test(href));

      const hasMedia = Boolean(el.querySelector(
        '[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="videoComponent"], video, img'
      ));
      const verified = Boolean(el.querySelector(
        '[data-testid="icon-verified"], svg[aria-label="Verified account"]'
      ));

      return {
        postKey: statusLink ? statusLink.split('?')[0] : '',
        text,
        verified,
        hasMedia,
        xDisplayName,
        xUserName,
      };
    });
  });
}

async function waitForTweets(page, timeout) {
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('article[data-testid="tweet"], article').length > 0,
      { timeout }
    );
    return true;
  } catch {
    return false;
  }
}

async function openSearch(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS });
  await page.waitForTimeout(2500);

  if (await waitForTweets(page, INITIAL_POST_WAIT_MS)) return true;

  await page.reload({ waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS }).catch(() => {});
  return await waitForTweets(page, INITIAL_POST_WAIT_MS);
}

async function runOnce() {
  if (!DISCORD_WEBHOOKS.length) throw new Error('DISCORD_WEBHOOK_URL を環境変数に設定してください。');
  ensureAuthFile();

  const seen = loadSeen();
  const chromiumPath = findChromium();
  let browser;
  let tweets = [];

  try {
    browser = await chromium.launch({
      headless: HEADLESS,
      ...(chromiumPath ? { executablePath: chromiumPath } : {}),
      args: [
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-extensions',
        '--mute-audio',
      ],
    });

    const context = await browser.newContext({
      storageState: AUTH_FILE,
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font'].includes(type)) return route.abort();
      return route.continue();
    });

    page.on('response', (response) => {
      const url = response.url();
      if (url.includes('/search') && response.status() >= 400) {
        console.log(`X検索レスポンス警告: HTTP ${response.status()} ${url.slice(0, 180)}`);
      }
    });

    const url = `https://x.com/search?q=${encodeURIComponent(SEARCH_QUERY)}&src=typed_query&f=live`;
    const loaded = await openSearch(page, url);

    console.log(`ブラウザモード: ${HEADLESS ? 'headless' : 'headed'} / X検索ページ: title="${await page.title().catch(() => '')}" url=${page.url()} 投稿要素=${await page.locator('article[data-testid="tweet"], article').count().catch(() => 0)}`);

    if (!loaded) {
      const body = await page.locator('body').innerText().catch(() => '');
      console.log(`投稿要素を待っても見つかりませんでした。本文先頭: ${body.replace(/\s+/g, ' ').slice(0, 700)}`);
    }

    const seenPostKeys = new Set();
    let idleScrollRounds = 0;
    let scrollRoundsCompleted = 0;

    for (let i = 0; i < SCROLL_ROUNDS; i++) {
      if (i > 0) {
        await page.evaluate(() => window.scrollBy({ top: Math.floor(1400 + Math.random() * 1200), behavior: 'instant' }));
        await page.waitForTimeout(SEARCH_SETTLE_MIN_MS + randomInt(0, SEARCH_SETTLE_JITTER_MS));
      }

      const batch = await collectTweetBatch(page);
      const freshTweets = takeFreshTweets(batch, seenPostKeys);
      scrollRoundsCompleted = i + 1;

      if (freshTweets.length === 0) idleScrollRounds++;
      else {
        idleScrollRounds = 0;
        tweets.push(...freshTweets);
      }

      if (i > 3 && idleScrollRounds >= MAX_IDLE_SCROLL_ROUNDS) break;
    }

    const extractedInviteUrls = new Set(
      tweets.flatMap((tweet) => tweet.text.match(DISCORD_INVITE_REGEX) || [])
        .map((invite) => invite.toLowerCase())
    );

    console.log(
      `X検索取得: ${tweets.length}件のユニーク投稿、${extractedInviteUrls.size}件のDiscord招待URL ` +
      `(${scrollRoundsCompleted}/${SCROLL_ROUNDS}回、連続空読込: ${idleScrollRounds}回)`
    );
  } finally {
    if (browser) await browser.close().catch((err) => console.error('ブラウザのクローズに失敗:', err));
  }

  let newCount = 0;

  for (const tweet of tweets) {
    if (tweet.text.includes('$') || tweet.text.includes('#') || tweet.verified) continue;
    if (isPromoSpamText(tweet.text, tweet.hasMedia)) continue;

    const invites = tweet.text.match(DISCORD_INVITE_REGEX);
    if (!invites?.length) continue;

    for (const invite of [...new Set(invites.map((v) => v.toLowerCase()))]) {
      if (DISCORD_WEBHOOKS.every(([name]) => seen[name].has(invite))) continue;

      const inviteCode = invite.split('/').pop();
      const inviteInfo = await fetchInviteInfo(inviteCode);
      await sleep(DISCORD_API_DELAY_MS + randomInt(0, 200));

      if (inviteInfo?.isFriendInvite) {
        console.log(`スキップ(フレンド申請リンク): https://${invite}`);
        markSeenForAll(seen, invite);
        continue;
      }

      const memberCount = inviteInfo?.memberCount ?? null;
      if (memberCount !== null && memberCount < MIN_MEMBER_COUNT) {
        console.log(`スキップ(${memberCount}人 < ${MIN_MEMBER_COUNT}): https://${invite}`);
        markSeenForAll(seen, invite);
        continue;
      }
      if (memberCount !== null && memberCount > MAX_MEMBER_COUNT) {
        console.log(`スキップ(${memberCount}人 > ${MAX_MEMBER_COUNT}): https://${invite}`);
        markSeenForAll(seen, invite);
        continue;
      }

      if (inviteInfo && isLikelyForeignServer({
        xDisplayName: tweet.xDisplayName,
        xUserName: tweet.xUserName,
        tweetText: tweet.text,
        guildName: inviteInfo.guildName,
        guildDescription: inviteInfo.guildDescription,
      })) {
        console.log(`スキップ(海外サーバー判定): https://${invite}`);
        markSeenForAll(seen, invite);
        continue;
      }

      const targets = DISCORD_WEBHOOKS.filter(([name]) => !seen[name].has(invite));
      const succeeded = await sendToDiscord(invite, targets);
      for (const name of succeeded) seen[name].add(invite);
      if (succeeded.length) {
        newCount++;
        console.log(`通知成功(${succeeded.join(',')}): https://${invite}`);
      }
      await sleep(DISCORD_API_DELAY_MS + randomInt(0, 200));
    }
  }

  saveSeen(seen);
  console.log(`完了。新規通知件数: ${newCount}`);
}

runOnce().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
