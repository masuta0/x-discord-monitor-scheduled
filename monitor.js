const fs = require('fs');
const path = require('path');

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DISCORD_WEBHOOK_URL_SECONDARY = process.env.DISCORD_WEBHOOK_URL_SECONDARY;
const DISCORD_WEBHOOKS = [
  ['primary', DISCORD_WEBHOOK_URL],
  ['secondary', DISCORD_WEBHOOK_URL_SECONDARY],
].filter(([, url]) => Boolean(url));

const SEARCH_QUERY = process.env.SEARCH_QUERY || 'discord.gg/';
const SEEN_FILE = path.join(__dirname, 'seen.json');
const DISCORD_INVITE_REGEX = /discord\.gg\/[A-Za-z0-9-]+/gi;
const MAX_SEEN = 5000;
const SEARCH_PAGES = Number(process.env.SEARCH_PAGES || process.env.SCROLL_ROUNDS || 10);
const MIN_MEMBER_COUNT = Number(process.env.MIN_MEMBER_COUNT || 10);
const MAX_MEMBER_COUNT = Number(process.env.MAX_MEMBER_COUNT || 1000);
const SPAM_TEXT_MIN_LENGTH = Number(process.env.SPAM_TEXT_MIN_LENGTH || 100);
const SPAM_ENGLISH_RATIO = Number(process.env.SPAM_ENGLISH_RATIO || 0.6);
const DISCORD_API_DELAY_MS = Number(process.env.DISCORD_API_DELAY_MS || 300);
const FOREIGN_SCORE_THRESHOLD = Number(process.env.FOREIGN_SCORE_THRESHOLD || 3);
const FXTWITTER_API = process.env.FXTWITTER_API || 'https://api.fxtwitter.com/2/search';

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
    const res = await fetch(`https://discord.com/api/v10/invites/${encodeURIComponent(inviteCode)}?with_counts=true`);
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

function normalizeSearchResult(result) {
  const author = result?.author || {};
  const media = result?.media || {};
  const hasMedia = Boolean(
    (Array.isArray(media.photos) && media.photos.length) ||
    (Array.isArray(media.videos) && media.videos.length) ||
    media.external || media.all?.length
  );
  const verification = author.verification || {};
  return {
    postKey: result?.id ? `https://x.com/${author.screen_name || 'i'}/status/${result.id}` : '',
    text: result?.text || '',
    verified: Boolean(verification.verified),
    hasMedia,
    xDisplayName: author.name || '',
    xUserName: author.screen_name || '',
  };
}

async function searchFxTwitter() {
  const tweets = [];
  const seenPostKeys = new Set();
  let cursor = '';

  for (let pageNo = 1; pageNo <= SEARCH_PAGES; pageNo++) {
    const params = new URLSearchParams({
      q: SEARCH_QUERY,
      count: '100',
      feed: 'latest',
    });
    if (cursor) params.set('cursor', cursor);

    const url = `${FXTWITTER_API}?${params.toString()}`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'x-discord-monitor-scheduled/1.0' },
    });
    const bodyText = await res.text();
    let data;
    try { data = JSON.parse(bodyText); } catch { data = null; }

    if (!res.ok || !data || data.code >= 400) {
      throw new Error(`FxTwitter検索失敗: HTTP ${res.status} ${data?.message || bodyText.slice(0, 300)}`);
    }

    const results = Array.isArray(data.results) ? data.results : [];
    for (const result of results) {
      if (result?.type !== 'status') continue;
      const tweet = normalizeSearchResult(result);
      const key = tweet.postKey || `${tweet.xUserName}\n${tweet.text}`;
      if (seenPostKeys.has(key)) continue;
      seenPostKeys.add(key);
      tweets.push(tweet);
    }

    console.log(`FxTwitter検索: ${pageNo}/${SEARCH_PAGES}ページ ${results.length}件`);
    cursor = data.cursor?.bottom || '';
    if (!cursor || results.length === 0) break;
    await sleep(250 + randomInt(0, 300));
  }

  return tweets;
}

async function runOnce() {
  if (!DISCORD_WEBHOOKS.length) throw new Error('DISCORD_WEBHOOK_URL を環境変数に設定してください。');

  const seen = loadSeen();
  const tweets = await searchFxTwitter();
  const extractedInviteUrls = new Set(
    tweets.flatMap((tweet) => tweet.text.match(DISCORD_INVITE_REGEX) || [])
      .map((invite) => invite.toLowerCase())
  );

  console.log(`X検索取得: ${tweets.length}件のユニーク投稿、${extractedInviteUrls.size}件のDiscord招待URL`);

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

      if (isLikelyForeignServer({
        xDisplayName: tweet.xDisplayName,
        xUserName: tweet.xUserName,
        tweetText: tweet.text,
        guildName: inviteInfo?.guildName || '',
        guildDescription: inviteInfo?.guildDescription || '',
      })) {
        console.log(`スキップ(海外判定): https://${invite}`);
        markSeenForAll(seen, invite);
        continue;
      }

      const succeeded = await sendToDiscord(invite);
      if (succeeded.length) {
        for (const name of succeeded) seen[name].add(invite);
        newCount++;
        console.log(`通知成功(${succeeded.join(',')}): https://${invite}`);
      }
    }
  }

  saveSeen(seen);
  console.log(`完了。新規通知件数: ${newCount}`);
}

runOnce().catch((err) => {
  console.error('監視処理に失敗:', err?.stack || err);
  process.exitCode = 1;
});
