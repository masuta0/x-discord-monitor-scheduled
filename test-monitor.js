const assert = require('assert/strict');
const { takeFreshTweets } = require('./monitor');

const seenPostKeys = new Set();
const firstBatch = [
  { postKey: '/alice/status/100', xUserName: 'alice', text: 'first invite' },
  { postKey: '/alice/status/100', xUserName: 'alice', text: 'first invite' },
  { postKey: '/bob/status/101', xUserName: 'bob', text: 'second invite' },
];

assert.deepEqual(
  takeFreshTweets(firstBatch, seenPostKeys).map((tweet) => tweet.postKey),
  ['/alice/status/100', '/bob/status/101'],
  '同じ投稿は同一スクロール内で一度だけ取得する'
);

const secondBatch = [
  { postKey: '/alice/status/100', xUserName: 'alice', text: 'first invite' },
  { postKey: '', xUserName: 'carol', text: 'fallback key invite' },
  { postKey: '', xUserName: 'carol', text: 'fallback key invite' },
];

assert.deepEqual(
  takeFreshTweets(secondBatch, seenPostKeys).map((tweet) => tweet.xUserName),
  ['carol'],
  '次のスクロールで再表示された投稿を除外し、status URLがない投稿も本文と投稿者で重複排除する'
);

assert.equal(takeFreshTweets([], seenPostKeys).length, 0, '空の読込結果を安全に扱う');

console.log('Monitor collection tests passed.');
