# X search → Discord notification monitor

This project checks X search results once with Playwright, detects `discord.gg/` links, and sends new matches to a Discord webhook. GitHub Actions invokes the job every 15 minutes.

> The project uses an authenticated browser session. Use only an account and access method that you are authorized to use, and make sure the workflow complies with X's rules. X may challenge or invalidate sessions from GitHub-hosted runners.

## What is public and what is private

The repository contains code, the workflow definition, and `state/seen.json` (the list of processed post IDs). It does **not** contain account cookies, Playwright storage state, Discord webhook URLs, or other credentials.

| Item | Where it belongs | Never commit it? |
|---|---|---:|
| X session storage JSON | `AUTH_JSON` GitHub repository secret | Yes |
| Discord webhook URL | `DISCORD_WEBHOOK_URL` GitHub repository secret | Yes |
| Search query | `SEARCH_QUERY` GitHub Actions variable, optional | No secret required |
| Processed post IDs | `state/seen.json` in this repository | No; it is committed after successful runs |

## One-time GitHub configuration

Open the repository's **Settings** page, then select **Secrets and variables → Actions**. Create the following **repository secrets**:

| Secret name | Value |
|---|---|
| `AUTH_JSON` | The complete content of your Playwright `auth.json` file, as raw JSON |
| `DISCORD_WEBHOOK_URL` | Your full Discord webhook URL |

Optionally, create a repository variable named `SEARCH_QUERY`. If it is omitted, the workflow searches for `discord.gg/`.

The workflow commits the updated `state/seen.json` after each successful run. If GitHub reports a permission error at that step, open **Settings → Actions → General** and allow workflows to have **Read and write permissions**.

## Start and monitor the workflow

After adding the two secrets, open the **Actions** tab, choose **Monitor X search results**, and select **Run workflow** to perform an initial test. Scheduled runs then use this cron expression:

```text
7,22,37,52 * * * *
```

GitHub schedules these times in UTC. The job may start later than the requested minute when GitHub's hosted runners are busy, so this is a best-effort 15-minute schedule rather than a strict real-time service.

## Local testing

Create a local `auth.json`, set the webhook as an environment variable, then run:

```bash
npm ci
npx playwright install chromium
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..." npm start
```

Do not publish `auth.json`, a webhook URL, cookies, `.env` files, or logs containing sensitive values.
