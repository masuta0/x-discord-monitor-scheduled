const assert = require('assert/strict');
const {
  extractInviteCodes,
  filterInvite,
  looksLikeSpamPost,
  nonJapaneseContentScore,
} = require('./monitor');

assert.deepEqual(
  extractInviteCodes('a discord.gg/Alpha-1 b https://discord.gg/Alpha-1'),
  ['Alpha-1'],
);

assert.equal(
  filterInvite(
    { valid: true, memberCount: 9, serverName: '日本語', serverDescription: 'テスト' },
    { author: 'tester', text: '日本語の投稿' },
  ),
  'member_count_below_minimum',
);

assert.equal(
  filterInvite(
    { valid: true, memberCount: 1001, serverName: '日本語', serverDescription: 'テスト' },
    { author: 'tester', text: '日本語の投稿' },
  ),
  'member_count_above_maximum',
);

assert.equal(
  filterInvite(
    {
      valid: true,
      memberCount: 100,
      serverName: 'Global English Community',
      serverDescription: 'English worldwide community server',
    },
    { author: 'english_user', text: 'Join our international English community' },
  ),
  'predominantly_non_japanese_content',
);

assert.equal(
  filterInvite(
    { valid: true, memberCount: 10, serverName: '日本語サーバー', serverDescription: 'ゲーム仲間募集' },
    { author: '日本語ユーザー', text: 'ゲームを一緒に遊ぶ人募集 discord.gg/Test' },
  ),
  null,
);

assert.equal(looksLikeSpamPost({ text: 'price $100 discord.gg/Test', isVerified: false, hasMedia: false }), true);
assert.equal(looksLikeSpamPost({ text: 'regular Japanese post discord.gg/Test', isVerified: true, hasMedia: false }), true);
assert.equal(
  looksLikeSpamPost({
    text: 'a'.repeat(121),
    isVerified: false,
    hasMedia: true,
  }),
  true,
);
assert.ok(nonJapaneseContentScore('Global English community') >= 3);
assert.ok(nonJapaneseContentScore('日本語のゲームコミュニティ') < 3);

console.log('Filter tests passed.');
