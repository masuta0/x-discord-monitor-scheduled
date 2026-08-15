# X search → Discord notification monitor

This project checks X search results once with Playwright and notifies Discord only when a Discord invite passes the configured member-count, language-relevance, and spam filters. GitHub Actions is configured for a 15-minute schedule, but the workflow is currently **disabled pending review of the restored filters**.

> The project uses an authenticated browser session. Use only an account and access method that you are authorized to use, and make sure the workflow complies with X's rules. X may challenge or invalidate sessions from GitHub-hosted runners.

## Notification rules

A post is not sent merely because it contains a `discord.gg/` link. The monitor first applies the following checks.

| Rule | Default | Behavior |
|---|---:|---|
| Minimum server members | `10` | Rejects a server below this approximate member count |
| Maximum server members | `1000` | Rejects a server with this many members or more |
| Non-Japanese-content score | `3` | Scores the X display name, X username, post text, server name, and server description separately; rejects at the threshold |
| Spam markers | — | Rejects posts containing `$` or `#`, verified-account posts, and long English-heavy posts with media |
| Default notification content | — | Sends **only the Discord invite URL**; it never sends an X post URL, server name, member count, or author |

The non-Japanese-content check is a relevance heuristic based on textual signals; it does not attempt to identify a person’s nationality. Discord notifications contain only the Discord invite URL.

## What is public and what is private

The repository contains code, the workflow definition, and `seen.json` (a list of processed Discord invite links). It does **not** contain account cookies, Playwright storage state, Discord webhook URLs, or other credentials.

| Item | Where it belongs | Never commit it? |
|---|---|---:|
| X session storage JSON | `AUTH_JSON` GitHub repository secret | Yes |
| Discord webhook URL | `DISCORD_WEBHOOK_URL` GitHub repository secret | Yes |
| Search query and filter values | GitHub Actions variables, optional | No secret required |
| Processed post IDs | `state/seen.json` in this repository | No; it is committed after successful runs |

## GitHub Actions configuration

The repository needs these two repository secrets:

| Secret name | Value |
|---|---|
| `AUTH_JSON` | Complete Playwright `auth.json` content as raw JSON |
| `DISCORD_WEBHOOK_URL` | Primary Discord webhook URL |
| `DISCORD_WEBHOOK_URL_SECONDARY` | Optional second Discord webhook URL; each accepted invite is sent to both endpoints concurrently |

You may optionally add the following repository variables under **Settings → Secrets and variables → Actions → Variables**.

| Variable | Default | Purpose |
|---|---:|---|
| `SEARCH_QUERY` | `discord.gg/` | X search query |
| `SCROLL_ROUNDS` | `60` | Number of result-page scrolls per run |
| `MIN_MEMBER_COUNT` | `10` | Lowest allowed server size |
| `MAX_MEMBER_COUNT` | `1000` | Highest allowed server size |
| `NON_JAPANESE_SCORE_THRESHOLD` | `3` | Lower values reject more non-Japanese content |
| `SPAM_TEXT_MIN_LENGTH` | `100` | Long-post spam threshold |
| `SPAM_ENGLISH_RATIO` | `0.6` | English-heavy spam threshold |
| `DISCORD_API_DELAY_MS` | `300` | Delay between Discord invite API lookups |

The workflow uses this UTC cron schedule:

```text
7,22,37,52 * * * *
```

GitHub-hosted scheduled workflows are best effort and can begin later than their requested minute when runners are busy.

## State and safety

`seen.json` avoids repeatedly processing the same Discord invite link. The file is public with the repository and therefore contains only invite URLs, never cookies, webhooks, or other credentials. If GitHub reports a permission error when saving this file, open **Settings → Actions → General** and allow workflows to have **Read and write permissions**.

Do not publish `auth.json`, a webhook URL, cookies, `.env` files, or logs containing sensitive values.
