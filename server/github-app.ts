import { createPrivateKey, type KeyObject } from 'node:crypto';
import { config } from './config';
import { SignJWT } from 'jose';
import { z } from 'zod';

export const GitHubWorkflowListSchema = z.object({
	workflows: z.array(z.object({
		id: z.number(),
		name: z.string(),
		path: z.string(),
	})).optional(),
});

export const GitHubWorkflowRunsSchema = z.object({
	workflow_runs: z.array(z.object({
		id: z.number(),
		status: z.string(),
		conclusion: z.string().nullable(),
		head_branch: z.string().nullable(),
		event: z.string(),
		updated_at: z.string(),
		html_url: z.string().url(),
	})).optional(),
});

export const GitHubWorkflowJobsSchema = z.object({
	jobs: z.array(z.object({
		status: z.string(),
		steps: z.array(z.object({ status: z.string() })).nullable().optional(),
	})).optional(),
});

const InstallationTokenSchema = z.object({
	token: z.string().min(1),
	expires_at: z.string().datetime(),
});

let privateKey: KeyObject | undefined;
let cachedToken: { token: string; expiresAt: number } | undefined;

async function appJwt() {
	privateKey ??= createPrivateKey(config.GITHUB_APP_PRIVATE_KEY.replace(/\\+n/g, '\n'));

	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({})
		.setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
		.setIssuedAt(now - 60)
		.setExpirationTime(now + 540)
		.setIssuer(String(config.GITHUB_APP_ID))
		.sign(privateKey);
}

async function installationToken(forceRefresh = false) {
	if (!forceRefresh && cachedToken && cachedToken.expiresAt - Date.now() > 60000) {
		return cachedToken.token;
	}

	const response = await fetch(`https://api.github.com/app/installations/${config.GITHUB_APP_INSTALLATION_ID}/access_tokens`, {
		method: 'POST',
		headers: {
			Accept: 'application/vnd.github+json',
			Authorization: `Bearer ${await appJwt()}`,
			'Content-Type': 'application/json',
		},
		signal: AbortSignal.timeout(15_000),
	});

	if (!response.ok) {
		console.error(`GitHub App token request failed (${response.status})`);
		throw new Error('GitHub App token request failed');
	}

	const token = InstallationTokenSchema.parse(await response.json());

	cachedToken = {
		token: token.token,
		expiresAt: new Date(token.expires_at).getTime(),
	};

	return token.token;
}

export async function github<TResponse>(path: string, schema: z.ZodType<TResponse>) {
	let token = await installationToken();
	let response = await fetch(`https://api.github.com${path}`, {
		headers: {
			Accept: 'application/vnd.github+json',
			Authorization: `Bearer ${token}`,
		},
		signal: AbortSignal.timeout(15_000),
	});

	if (response.status === 401) {
		token = await installationToken(true);
		response = await fetch(`https://api.github.com${path}`, {
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: `Bearer ${token}`,
			},
			signal: AbortSignal.timeout(15_000),
		});
	}

	if (!response.ok) {
		console.error(`GitHub request failed (${response.status})`);
		throw new Error('GitHub request failed');
	}

	return schema.parse(await response.json());
}
