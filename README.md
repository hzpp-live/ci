# CI

Small dashboard for the latest GitHub Actions run of every workflow in configured private repositories.

It shows status, progress, and timing. It never fetches or displays logs.

## Local setup

Requirements: Node.js 24+ and pnpm 10+.

```powershell
pnpm install
pnpm dev
```

Open `http://localhost:5173`.

## Environment

For local development, copy `.env.example` to `.env` and fill in the values.

```env
GITHUB_APP_ID=123456
GITHUB_APP_INSTALLATION_ID=12345678
GITHUB_APP_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nreplace_me\n-----END PRIVATE KEY-----
GITHUB_WEBHOOK_SECRET=your_webhook_secret
DASHBOARD_ACCESS_SECRET=another_long_random_secret
REPOSITORIES_JSON=[{"repo":"owner/private-repository","name":"Display name"}]
```

`REPOSITORIES_JSON` must be a JSON array. The repository path is used only by the server for GitHub requests. It is not returned to the browser.

Never commit `.env`.

## Create the GitHub App

GitHub requires an owner approval to create and install an App. Use the [GitHub App creation page](https://github.com/settings/apps/new) or read GitHub's [manifest registration guide](https://docs.github.com/en/apps/sharing-github-apps/registering-github-app-from-a-manifest).

The following matches the fields shown on GitHub's **Create GitHub App** page.

### Basic information

Use values like these:

| GitHub field | Value |
| --- | --- |
| GitHub App name | `CI` or another available name |
| Homepage URL | The value of `PUBLIC_URL` |
| Description | A private GitHub Actions status dashboard |
| Callback URL | Leave empty; CI does not use user authorization or OAuth |
| Setup URL | Leave empty; installation setup is manual |
| Setup URL after update | Leave disabled |
| Request user authorization during installation | Leave disabled |
| Enable device flow | Leave disabled |
| Webhook active | Enabled |
| Webhook URL | `PUBLIC_URL/api/github/webhook` |
| Webhook secret | The exact value of `GITHUB_WEBHOOK_SECRET` |
| SSL verification | Enabled |
| Visibility | **Any account** if it must be installed on an organization; `Only on this account` works only for the account that owns the App |

The homepage and webhook values must be complete HTTPS URLs in production. The webhook URL must be reachable from GitHub; `localhost` is not reachable by GitHub.

### Permissions

Under **Repository permissions**, select only:

- `Actions: Read-only`
- `Metadata: Read-only` (GitHub may mark this as mandatory)

Leave all other repository, organization, account, and enterprise permissions at `No access`. The dashboard reads workflow definitions, workflow runs, and workflow jobs; it does not write to repositories, dispatch workflows, read logs, or manage hooks.

### Subscribe to events

Enable only these repository events:

- `Workflow run`
- `Workflow job`

These events let the server refresh the in-memory state as soon as a run or job changes. The server still performs a periodic reconciliation using `POLL_INTERVAL_MS`, which repairs missed deliveries and detects changes that happened while the server was offline.

### Finish creation and installation

1. Select **Create GitHub App**.
2. Open the new App's settings and copy its numeric **App ID** into `GITHUB_APP_ID`.
3. Under **Private keys**, choose **Generate a private key** and save the downloaded PEM file securely. Put its contents in `GITHUB_APP_PRIVATE_KEY`. In an env file, line breaks may be represented as literal `\\n` characters.
4. Choose **Install App**, select the organization, and choose **All repositories** or **Only select repositories**. The latter should include every repository listed in `REPOSITORIES_JSON`.
5. If GitHub shows **Request** instead of **Install**, an organization owner must approve or install it. Organization policies can also prevent repository admins from installing Apps.
6. Copy the numeric installation ID from the installation URL or GitHub App installation page into `GITHUB_APP_INSTALLATION_ID`.
7. Confirm the App's webhook URL, secret, selected events, and SSL verification.

The installation ID identifies the installation used by this server. It is different from the App ID. Installing the App on **All repositories** does not make the dashboard show all repositories: the server still requests and returns only the repositories listed in `REPOSITORIES_JSON`.

After that, the server signs a short-lived App JWT, exchanges it for an installation token, caches that token until shortly before expiry, and uses it for GitHub API requests. No personal access token is used.

### Optional manifest setup

GitHub's manifest flow can prefill most App fields, but it still requires a callback endpoint that exchanges GitHub's temporary code for the App credentials. This project does not currently implement that one-time callback, so use the normal creation form above. Do not paste a private key or webhook secret into a public manifest, issue, URL, or README.

On the server, start the image published by GitHub Actions:

```powershell
Copy-Item .env.example .env
docker login ghcr.io
docker compose pull
docker compose up -d
```

`CI_ENV_FILE` only selects the Compose env file. It is not passed into the container.

## GitHub webhook

Set `PUBLIC_URL` to the deployed site origin:

```env
PUBLIC_URL=https://ci.example.com
```

The webhook is configured on the GitHub App itself. The server does not create repository webhooks.

The App needs Actions read-only and Metadata read-only permissions, plus the Workflow runs and Workflow jobs webhook events. Install it on the repositories listed in `REPOSITORIES_JSON`.

Copy the App ID, installation ID, and private key into the deployment env file. The private key may use literal `\\n` characters or a multiline value.

The webhook endpoint is:

```text
https://ci.example.com/api/github/webhook
```

The server validates the signature and delivery ID, rejects workflow events from repositories not listed in `REPOSITORIES_JSON`, rejects duplicate deliveries, and refreshes the cached state when a relevant configured workflow event arrives.

GitHub's `ping` test event is acknowledged with `200 pong`; it does not trigger a GitHub API refresh. Workflow run and workflow job deliveries return success after invalidating the cached state and notifying connected browsers.

## Run links

Run links are hidden by default. Use the key button in the dashboard header, enter the value of `DASHBOARD_ACCESS_SECRET`, and confirm it. The server validates it before the browser stores it.

## License

This project is licensed under the GNU General Public License v3.0. See [LICENSE](LICENSE) for details.
