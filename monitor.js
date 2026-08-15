/**
 * auth.json のセッションを使い、Xの検索結果(discord.gg/)を
 * ヘッドレスブラウザで開いて新着Discordサーバーリンクを抽出し、
 * Discord Webhookへ通知するスクリプト。
 *
 * 必要な環境変数:
 *   DISCORD_WEBHOOK_URL : 通知先のDiscord Webhook URL
 *   AUTH_JSON           : auth.json の中身をそのまま貼り付けた文字列 (Railway等)
 *   SEARCH_QUERY        : (任意) デフォルトは 'discord.gg/'
 *   SCROLL_ROUNDS        : (任意) スクロール回数。デフォルト60(多めに取得)
 *   CHROMIUM_PATH       : (任意) Chromium のパス
 *   MIN_MEMBER_COUNT    : (任意) この人数未満のサーバーは通知しない。デフォルト10
 *   MAX_MEMBER_COUNT    : (任意) この人数以上のサーバーは通知しない。デフォルト1000
 *   FOREIGN_SCORE_THRESHOLD: (任意) 外国人サーバー判定スコアの閾値。デフォルト3
 *   SPAM_TEXT_MIN_LENGTH: (任意) この文字数を超え、かつ他の条件も満たすとスパム扱い。デフォルト120
 *   SPAM_ENGLISH_RATIO  : (任意) 英字比率がこれ以上だと「英語の投稿」と判定。デフォルト0.6
 *   DISCORD_API_DELAY_MS: (任意) Discord invite API 呼び出し間の待機時間(ms)。デフォルト300
 *
 * 重複防止のため、送信済みの招待リンクを seen.json に保存する。
 *
 * フィルタリング:
 *  - $ や # を含む投稿、認証マーク(青バッジ)付きアカウントの投稿はスパムとして除外
 *  - 長文 かつ 英語主体 かつ 画像/動画付きの投稿もスパムとして除外
 *    (勧誘目的の宣伝ポストによくあるパターンのため)
 *  - 招待リンクごとに Discord の招待情報API(with_counts)でメンバー数、
 *    サーバー名、サーバー説明を確認し、MIN_MEMBER_COUNT 未満の小規模サーバーと
 *    MAX_MEMBER_COUNT 以上の大規模サーバーは通知しない
 *  - Xの表示名、Xのユーザー名、投稿本文、Discordサーバー名、Discordサーバー説明の
 *    5項目で外国人サーバーらしさを判定し、閾値以上なら除外する
 *  - 同じ招待リンクは再送しない
 *
 * 注意:
 *  - Xの利用規約に抵触する可能性があるため、サブ垢の使用を推奨。
 *  - 実行間隔は詰めすぎない(目安10〜15分以上)。
 *  - Xの画面構成変更でセレクタが壊れることがある。
 *  - Cronは10分おきに設定する想定。日本時間2:00〜7:00は間引いて実質20分おきになる。
 *
 * このファイルは1回分のスクレイピング処理を runOnce() としてエクスポートする。
 * Railwayの Cron Schedule により定期的に `node monitor.js` として実行される想定。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright');

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const SEARCH_QUERY = process.env.SEARCH_QUERY || 'discord.gg/';
const AUTH_FILE = path.join(__dirname, 'auth.json');
const SEEN_FILE = path.join(__dirname, 'seen.json');
const DISCORD_INVITE_REGEX = /discord\.gg\/[A-Za-z0-9-]+/g;
const MAX_SEEN = 5000; // 肥大化防止
const SCROLL_ROUNDS = Number(process.env.SCROLL_ROUNDS || 60);

// 10人未満など、まだ小さすぎるサーバーは対象外にする
const MIN_MEMBER_COUNT = Number(process.env.MIN_MEMBER_COUNT || 10);
// 1000人以上など、すでに大きいサーバーは対象外にする
const MAX_MEMBER_COUNT = Number(process.env.MAX_MEMBER_COUNT || 1000);
// 「長文 & 英語主体 & 画像/動画付き」を宣伝スパムとみなすための閾値
const SPAM_TEXT_MIN_LENGTH = Number(process.env.SPAM_TEXT_MIN_LENGTH || 100);
const SPAM_ENGLISH_RATIO = Number(process.env.SPAM_ENGLISH_RATIO || 0.6);
// Discord invite API を連打しないための待機時間
const DISCORD_API_DELAY_MS = Number(process.env.DISCORD_API_DELAY_MS || 300);
const FOREIGN_SCORE_THRESHOLD = Number(process.env.FOREIGN_SCORE_THRESHOLD || 3);
const SEARCH_SETTLE_MIN_MS = Number(process.env.SEARCH_SETTLE_MIN_MS || 700);
const SEARCH_SETTLE_JITTER_MS = Number(process.env.SEARCH_SETTLE_JITTER_MS || 400);


// 環境変数から auth.json を復元
function ensureAuthFile() {
  if (fs.existsSync(AUTH_FILE)) return;
  if (process.env.AUTH_JSON) {
    fs.writeFileSync(AUTH_FILE, process.env.AUTH_JSON, 'utf-8');
    console.log('AUTH_JSON 環境変数から auth.json を復元しました。');
    return;
  }
  throw new Error('auth.json がありません。AUTH_JSON 環境変数を設定するか、先に convert-cookies.js を実行してください。');
}

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try {
    return execSync('which chromium', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null; // Playwright のバンドル版にフォールバック
  }
}

function loadSeen() {
  try {
    return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf-8')));
  } catch {
    return new Set();
  }
}

function saveSeen(seenSet) {
  const arr = [...seenSet].slice(-MAX_SEEN);
  fs.writeFileSync(SEEN_FILE, JSON.stringify(arr, null, 2));
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
  const normalized = (text || '').replace(/https?:\/\/\S+|discord\.gg\/\S+/gi, '').replace(/\s/g, '');
  if (!normalized) return 0;
  const letters = normalized.match(/[A-Za-z]/g) || [];
  return letters.length / normalized.length;
}

function hasForeignKeyword(text) {
  return /\b(english|global|international|worldwide|usa|america|europe|eu|asia|korea|china|philippines|indonesia|vietnam|thailand|russia|brasil|brazil|espa[nñ]ol|fran[cç]ais|deutsch|server|community|gaming|crypto|nft|airdrop)\b/i.test(text || '');
}

function isLikelyForeignServer({ xDisplayName, xUserName, tweetText, guildName, guildDescription }) {
  const signals = [xDisplayName, xUserName, tweetText, guildName, guildDescription].map((value) => value || '');
  let score = 0;

  for (const value of signals) {
    if (!value.trim()) continue;
    if (containsJapanese(value)) continue;
    if (latinLetterRatio(value) >= 0.6 || hasForeignKeyword(value)) score++;
  }

  return score >= FOREIGN_SCORE_THRESHOLD;
}

// 「長文 & 英語主体 & 画像/動画付き」の投稿を宣伝スパムとして判定する。
// 3条件がすべて揃った場合のみスパム扱いとし、
// 通常の短い招待投稿(例: 日本語+リンクのみ)は誤って除外しないようにする。
function isPromoSpamText(text, hasMedia) {
  if (!hasMedia) return false;

  const trimmed = (text || '').trim();
  if (trimmed.length < SPAM_TEXT_MIN_LENGTH) return false;

  const asciiLetters = trimmed.match(/[A-Za-z]/g) || [];
  const nonWhitespace = trimmed.replace(/\s/g, '');
  if (nonWhitespace.length === 0) return false;

  const englishRatio = asciiLetters.length / nonWhitespace.length;
  return englishRatio >= SPAM_ENGLISH_RATIO;
}

// Discord の公開招待APIでメンバー数を取得する(認証不要)。
// 無効化・期限切れの招待や、取得に失敗した場合は null を返し、
// 呼び出し側で「判断材料なし」として扱えるようにする。
async function fetchInviteInfo(inviteCode) {
  try {
    const res = await fetch(
      `https://discord.com/api/v10/invites/${encodeURIComponent(inviteCode)}?with_counts=true`
    );
    if (!res.ok) return null; // 無効・期限切れなど
    const data = await res.json();
    // guild がない招待はフレンド申請リンク(type:2 等)なのでフラグを立てる
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

async function sendToDiscord(inviteUrl) {
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: `https://${inviteUrl}` }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord Webhook error: ${res.status} ${body}`);
  }
}

async function runOnce() {
  if (!DISCORD_WEBHOOK_URL) {
    throw new Error('DISCORD_WEBHOOK_URL を環境変数に設定してください。');
  }

  ensureAuthFile();

  const seen = loadSeen();
  const chromiumPath = findChromium();

  let browser;
  let tweets = [];

  try {
    browser = await chromium.launch({
      headless: true,
      ...(chromiumPath ? { executablePath: chromiumPath } : {}),
      args: [
        // メモリに余裕があるRailway向けの標準的なコンテナ用フラグ
        // (--single-process のような不安定化リスクのある極端な節約フラグは使わない)
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-extensions',
        '--disable-background-networking',
        '--mute-audio',
      ],
    });

    const context = await browser.newContext({
      storageState: AUTH_FILE,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    // 画像・フォント・メディア・CSSは検出には不要なのでブロックして読み込みを高速化
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
        return route.abort();
      }
      return route.continue();
    });

    const url = `https://x.com/search?q=${encodeURIComponent(SEARCH_QUERY)}&f=live`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // 検索結果の読み込みを待つ
    await page.waitForSelector('article', { timeout: 45000 }).catch(() => {
      console.log('ツイートが見つかりませんでした(検索結果0件、またはページ構造変更の可能性)。');
    });

    // スクロール→見えている分を読み取る→読み取った要素はDOMから削除、を繰り返す。
    // メモリに余裕があっても、DOMを無限に太らせないための良い習慣として維持する。
    for (let i = 0; i < SCROLL_ROUNDS; i++) {
      if (i > 0) {
        await page.mouse.wheel(0, randomInt(1400, 2600));
        await page.waitForTimeout(SEARCH_SETTLE_MIN_MS + randomInt(0, SEARCH_SETTLE_JITTER_MS));
      }

      const batch = await page.$$eval('article', (articles) => {
        return articles.map((el) => {
          // querySelectorAll で全 tweetText を取得することで、
          // 引用ツイートや RT に埋め込まれた元ツイートのテキストも漏れなく拾う
          const textEls = el.querySelectorAll('[data-testid="tweetText"]');
          const text = textEls.length > 0
            ? Array.from(textEls).map((t) => t.innerText).join('\n')
            : el.innerText;
          const userNameEl = el.querySelector('[data-testid="User-Name"]');
          const userNameText = userNameEl ? userNameEl.innerText : '';
          const userNameLines = userNameText.split('\n').map((line) => line.trim()).filter(Boolean);
          const xDisplayName = userNameLines.find((line) => !line.startsWith('@')) || '';
          const handle = userNameLines.find((line) => line.startsWith('@')) || '';
          const xUserName = handle.replace(/^@/, '');
          const verified = !!el.querySelector('svg[aria-label="Verified account"]');
          const hasMedia = !!el.querySelector(
            '[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="videoComponent"]'
          );
          el.remove();
          return { text, verified, hasMedia, xDisplayName, xUserName };
        });
      });

      if (batch.length === 0 && i > 0) break; // 新規に読み込まれる分がなくなったら打ち切り
      tweets = tweets.concat(batch);
    }
  } finally {
    // 途中でエラーが起きてもブラウザは必ず閉じる(閉じ忘れによるゾンビプロセス化を防止)
    if (browser) {
      await browser.close().catch((err) => console.error('ブラウザのクローズに失敗:', err));
    }
  }

  let newCount = 0;

  for (const tweet of tweets) {
    // $ や # を含む投稿、および認証マーク(青バッジ)付きアカウントの投稿は
    // スパムの割合が高いため除外する
    if (tweet.text.includes('$') || tweet.text.includes('#') || tweet.verified) continue;

    // 長文・英語主体・画像/動画付きの宣伝スパムを除外する
    if (isPromoSpamText(tweet.text, tweet.hasMedia)) continue;

    const invites = tweet.text.match(DISCORD_INVITE_REGEX);
    if (!invites || invites.length === 0) continue;

    // 招待リンク単位で重複チェック・メンバー数チェック・送信
    for (const invite of [...new Set(invites)]) {
      const normalized = invite.toLowerCase();
      if (seen.has(normalized)) continue;

      const inviteCode = invite.split('/').pop();
      const inviteInfo = await fetchInviteInfo(inviteCode);
      await sleep(DISCORD_API_DELAY_MS + randomInt(0, 200)); // Discord API連打防止

      if (inviteInfo?.isFriendInvite) {
        console.log(`スキップ(フレンド申請リンク): https://${invite}`);
        seen.add(normalized);
        continue;
      }

      const memberCount = inviteInfo?.memberCount ?? null;
      if (memberCount !== null && memberCount < MIN_MEMBER_COUNT) {
        console.log(`スキップ(${memberCount}人 < ${MIN_MEMBER_COUNT}): https://${invite}`);
        // 少人数すぎるサーバーも「既知」としてマークし、以後は毎回APIを叩かないようにする
        seen.add(normalized);
        continue;
      }

      if (memberCount !== null && memberCount >= MAX_MEMBER_COUNT) {
        console.log(`スキップ(${memberCount}人 >= ${MAX_MEMBER_COUNT}): https://${invite}`);
        // 大規模サーバーは「既知」としてマークし、以後は毎回APIを叩かないようにする
        seen.add(normalized);
        continue;
      }

      if (
        isLikelyForeignServer({
          xDisplayName: tweet.xDisplayName,
          xUserName: tweet.xUserName,
          tweetText: tweet.text,
          guildName: inviteInfo?.guildName,
          guildDescription: inviteInfo?.guildDescription,
        })
      ) {
        console.log(`スキップ(外国人サーバー判定): https://${invite}`);
        seen.add(normalized);
        continue;
      }

      await sendToDiscord(invite);
      console.log(`通知送信: https://${invite}${memberCount !== null ? ` (${memberCount}人)` : ''}`);

      seen.add(normalized);
      newCount++;
    }
  }

  saveSeen(seen);
  console.log(`完了。新規通知件数: ${newCount}`);
  return newCount;
}

module.exports = { runOnce };

// `node monitor.js` で直接実行した場合(Railwayの Cron Schedule 実行を含む)
if (require.main === module) {
  runOnce().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}