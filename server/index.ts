import { github, GitHubWorkflowJobsSchema, GitHubWorkflowListSchema, GitHubWorkflowRunSchema, GitHubWorkflowRunsSchema, } from './github-app';
import { AccessValidationSchema, config, repositoryConfig, } from './config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer as createViteServer } from 'vite';
import type { IncomingMessage } from 'node:http';
import type { ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import sirv from 'sirv';
import { z } from 'zod';

export type WorkflowState = {
	id: number;
	name: string;
	path: string;
	repo: string;
	status: string;
	conclusion: string | null;
	branch: string;
	event: string;
	updatedAt: string;
	runUrl: string;
	progress: number | null;
};

export type PublicWorkflowState = Omit<WorkflowState, 'repo' | 'runUrl'> & {
	repositoryId: string;
	runUrl?: string;
};

export type PublicRepositoryState = {
	id: string;
	name: string;
};

export type ConfiguredRepository = {
	repo: string;
	name: string;
};

export type InternalState = {
	workflows: WorkflowState[];
	repositories: ConfiguredRepository[];
	updatedAt: string;
};

const root = resolve(import.meta.dirname, '..');
const maxWebhookBodyBytes = 1_000_000;
const deliveryRetentionMs = 10 * 60 * 1000;

const port = 3000;
const {
	ACTIVE_WORKFLOW_REFRESH_MS: activeWorkflowRefreshMs,
	GITHUB_WEBHOOK_SECRET: webhookSecret,
} = config;
const configuredRepositories: ConfiguredRepository[] = repositoryConfig.map((item) => ({
	repo: typeof item === 'string' ? item : item.repo,
	name: typeof item === 'string' ? item : item.name,
}));

const configuredRepositoryNames = new Set(configuredRepositories.map((repository) => repository.repo));

const WebhookPayloadSchema = z.object({
	action: z.string().min(1),
	repository: z.object({
		full_name: z.string().min(1),
	}),
	workflow_run: z.object({
		id: z.number(),
		workflow_id: z.number(),
	}).optional(),
	workflow_job: z.object({
		run_id: z.number(),
		workflow_id: z.number(),
	}).optional(),
});

let stateRefresh: Promise<InternalState> | undefined;
let cached: { at: number; body: InternalState } | undefined;

const eventClients = new Set<ServerResponse>();
const processedDeliveries = new Map<string, number>();
const accessAttempts = new Map<string, { count: number; resetAt: number }>();
const activeWorkflowRefreshes = new Map<string, NodeJS.Timeout>();

export function repositoryId(repo: string) {
	return createHmac('sha256', config.DASHBOARD_ACCESS_SECRET)
		.update(repo)
		.digest('hex');
}

export function hasDashboardAccess(header: string | string[] | undefined) {
	const provided = Array.isArray(header) ? header[0] : header;
	return provided ? matchesDashboardAccess(provided) : false;
}

export function matchesDashboardAccess(provided: string) {
	const expected = Buffer.from(config.DASHBOARD_ACCESS_SECRET);
	const actual = Buffer.from(provided);

	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function scheduleActiveWorkflowRefresh(workflow: WorkflowState) {
	const key = `${workflow.repo}:${workflow.id}`;
	const existing = activeWorkflowRefreshes.get(key);
	if (workflow.status === 'completed') {
		if (existing) clearTimeout(existing);
		activeWorkflowRefreshes.delete(key);
		return;
	}

	if (existing) return;

	const timer = setTimeout(() => {
		activeWorkflowRefreshes.delete(key);
		void refreshWorkflowFromWebhook(workflow.repo, workflow.id).catch((error: unknown) => {
			console.error(`Failed to refresh active workflow ${workflow.id}.`, error);
			scheduleActiveWorkflowRefresh(workflow);
		});
	}, activeWorkflowRefreshMs);
	timer.unref();
	activeWorkflowRefreshes.set(key, timer);
}

export async function refreshState() {
	if (cached) return cached.body;
	if (stateRefresh) return stateRefresh;

	stateRefresh = (async () => {
		const startedAt = Date.now();
		const workflows: WorkflowState[] = [];
		console.info(`Loading workflow state for ${configuredRepositories.length} configured repositories.`);

		for (const configuredRepo of configuredRepositories) {
			console.info(`Fetching workflow definitions for ${configuredRepo.name}.`);
			const workflowList = await github(`/repos/${configuredRepo.repo}/actions/workflows?per_page=100`, GitHubWorkflowListSchema);

			for (const workflow of workflowList.workflows ?? []) {
				const runs = await github(`/repos/${configuredRepo.repo}/actions/workflows/${workflow.id}/runs?per_page=1`, GitHubWorkflowRunsSchema);
				const run = runs.workflow_runs?.[0];
				if (!run) continue;

				const jobs = await github(`/repos/${configuredRepo.repo}/actions/runs/${run.id}/jobs?per_page=100`, GitHubWorkflowJobsSchema);
				const jobList = jobs.jobs ?? [];
				const completed = jobList.filter((job) => job.status === 'completed').length;
				const steps = jobList.flatMap((job) => job.steps ?? []);
				const completedSteps = steps.filter((step) => step.status === 'completed').length;
				const progress = steps.length
					? Math.round((completedSteps / steps.length) * 100)
					: jobList.length
						? Math.round((completed / jobList.length) * 100)
						: null;

				workflows.push({
					id: workflow.id,
					name: workflow.name,
					path: workflow.path,
					repo: configuredRepo.repo,
					status: run.status,
					conclusion: run.conclusion,
					branch: run.head_branch ?? '',
					event: run.event,
					updatedAt: run.updated_at,
					runUrl: run.html_url,
					progress,
				});
			}
		}

		const body: InternalState = {
			workflows,
			updatedAt: new Date().toISOString(),
			repositories: configuredRepositories,
		};
		cached = { at: Date.now(), body };
		for (const workflow of workflows) scheduleActiveWorkflowRefresh(workflow);
		console.info(`Loaded ${workflows.length} workflows in ${Date.now() - startedAt}ms.`);
		return body;
	})();

	try {
		return await stateRefresh;
	} finally {
		stateRefresh = undefined;
	}
}

async function getState() {
	return cached?.body ?? (await refreshState());
}

async function refreshWorkflowFromWebhook(
	repo: string,
	workflowId: number,
	runId?: number,
) {
	if (!cached) await refreshState();
	if (!cached) return;

	const configuredRepo = configuredRepositories.find((item) => item.repo === repo);
	const existing = cached.body.workflows.find((workflow) => workflow.repo === repo && workflow.id === workflowId);

	if (!configuredRepo || !existing) {
		console.info(`The webhook references a new workflow in ${repo}; loading the full state.`);
		cached = undefined;
		await refreshState();
		broadcast();
		return;
	}

	const run = runId
		? await github(`/repos/${repo}/actions/runs/${runId}`, GitHubWorkflowRunSchema)
		: (await github(`/repos/${repo}/actions/workflows/${workflowId}/runs?per_page=1`, GitHubWorkflowRunsSchema)).workflow_runs?.[0];

	if (!run || !cached) return;

	const jobs = await github(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`, GitHubWorkflowJobsSchema);
	const jobList = jobs.jobs ?? [];
	const completed = jobList.filter((job) => job.status === 'completed').length;

	const steps = jobList.flatMap((job) => job.steps ?? []);
	const completedSteps = steps.filter((step) => step.status === 'completed').length;

	const progress = steps.length
		? Math.round((completedSteps / steps.length) * 100)
		: jobList.length
			? Math.round((completed / jobList.length) * 100)
			: null;

	const updated: WorkflowState = {
		...existing,
		status: run.status,
		conclusion: run.conclusion,
		branch: run.head_branch ?? '',
		event: run.event,
		updatedAt: run.updated_at,
		runUrl: run.html_url,
		progress,
	};

	cached = {
		at: Date.now(),
		body: {
			...cached.body,
			updatedAt: new Date().toISOString(),
			workflows: cached.body.workflows.map((workflow) =>
				workflow.repo === repo && workflow.id === workflowId ? updated : workflow,
			),
		},
	};

	scheduleActiveWorkflowRefresh(updated);
	console.info(`Updated workflow ${workflowId} in ${configuredRepo.name}.`);
	broadcast();
}

function isDuplicateDelivery(deliveryId: string) {
	const now = Date.now();
	for (const [storedId, storedAt] of processedDeliveries) {
		if (now - storedAt > deliveryRetentionMs) {
			processedDeliveries.delete(storedId);
		}
	}

	if (processedDeliveries.has(deliveryId)) return true;
	if (processedDeliveries.size >= 10_000) {
		const oldest = processedDeliveries.keys().next().value;
		if (oldest) processedDeliveries.delete(oldest);
	}

	processedDeliveries.set(deliveryId, now);
	return false;
}

function canValidateAccess(address: string) {
	const now = Date.now();
	const current = accessAttempts.get(address);

	if (!current || current.resetAt <= now) {
		accessAttempts.set(address, { count: 1, resetAt: now + 900_000 });
		return true;
	}

	if (current.count >= 10) return false;
	current.count += 1;
	return true;
}

function publicState(state: InternalState, includeRunUrls: boolean) {
	const publicWorkflows: PublicWorkflowState[] = state.workflows.map(
		(workflow) => ({
			id: workflow.id,
			name: workflow.name,
			path: workflow.path,
			repositoryId: repositoryId(workflow.repo),
			status: workflow.status,
			conclusion: workflow.conclusion,
			branch: workflow.branch,
			event: workflow.event,
			updatedAt: workflow.updatedAt,
			...(includeRunUrls ? { runUrl: workflow.runUrl } : {}),
			progress: workflow.progress,
		}),
	);

	const repositories: PublicRepositoryState[] = state.repositories.map(
		(repository) => ({
			id: repositoryId(repository.repo),
			name: repository.name,
		}),
	);

	return {
		workflows: publicWorkflows,
		repositories,
		updatedAt: state.updatedAt,
	};
}

const production = process.env.NODE_ENV === 'production';
const vite = production ? undefined : await createViteServer({
	root,
	server: { middlewareMode: true },
	appType: 'spa',
});

const staticFiles = sirv(resolve(root, 'dist'), { single: true });

function readBody(req: IncomingMessage) {
	return new Promise<string>((resolveBody, reject) => {
		let body = '';
		let size = 0;
		let rejected = false;

		req.setEncoding('utf8');
		req.on('data', (chunk: string) => {
			size += Buffer.byteLength(chunk, 'utf8');
			if (size > maxWebhookBodyBytes) {
				rejected = true;
				reject(new Error('Webhook payload is too large'));
				return;
			}

			body += chunk;
		});

		req.on('end', () => {
			if (!rejected) resolveBody(body);
		});

		req.on('error', reject);
	});
}

export function validSignature(body: string, signatureHeader: string | string[] | undefined) {
	const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
	if (!webhookSecret || !signature?.startsWith('sha256=')) return false;

	const expected = Buffer.from(`sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`);
	const actual = Buffer.from(signature);

	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function broadcast() {
	for (const client of eventClients) {
		try {
			client.write(`data: ${JSON.stringify({ updatedAt: new Date().toISOString() })}\n\n`);
		} catch {
			eventClients.delete(client);
			client.end();
		}
	}
}

export function setSecurityHeaders(res: ServerResponse) {
	res.setHeader('X-Content-Type-Options', 'nosniff');
	res.setHeader('X-Frame-Options', 'DENY');
	res.setHeader('Referrer-Policy', 'no-referrer');
	res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

const heartbeat = setInterval(() => {
	for (const client of eventClients) {
		try {
			client.write(': heartbeat\n\n');
		} catch {
			eventClients.delete(client);
			client.end();
		}
	}
}, 25000);
heartbeat.unref();

const server = createServer(async (req, res) => {
	setSecurityHeaders(res);
	if (req.method === 'GET' && req.url === '/api/events') {
		if (eventClients.size >= 100) {
			res.statusCode = 503;
			res.end('Too many event clients');
			return;
		}

		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
		});

		res.write(': connected\n\n');
		eventClients.add(res);

		req.on('close', () => eventClients.delete(res));
		return;
	}

	if (req.method === 'GET' && req.url === '/api/config') {
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({
			logoUrl: config.VITE_LOGO_URL,
			faviconUrl: config.VITE_FAVICON_URL,
		}));

		return;
	}

	if (req.method === 'POST' && req.url === '/api/github/webhook') {
		const contentLength = Number(req.headers['content-length']);
		if (Number.isFinite(contentLength) && contentLength > maxWebhookBodyBytes) {
			res.statusCode = 413;
			res.end('Webhook payload is too large');
			return;
		}

		let body: string;
		try {
			body = await readBody(req);
		} catch {
			res.statusCode = 413;
			res.end('Webhook payload is too large');
			return;
		}

		if (!validSignature(body, req.headers['x-hub-signature-256'])) {
			res.statusCode = 401;
			res.end('Invalid webhook signature');
			return;
		}

		const deliveryId = req.headers['x-github-delivery'];
		const normalizedDeliveryId = Array.isArray(deliveryId) ? deliveryId[0] : deliveryId;
		if (!normalizedDeliveryId) {
			res.statusCode = 400;
			res.end('Missing webhook delivery ID');
			return;
		}

		const event = req.headers['x-github-event'];
		console.info(`Received GitHub ${event ?? 'unknown'} webhook delivery ${normalizedDeliveryId}.`);

		if (event === 'ping') {
			console.info('Responded to GitHub ping with pong.');
			res.statusCode = 200;
			res.end('pong');
			return;
		}

		if (isDuplicateDelivery(normalizedDeliveryId)) {
			console.info(`Rejected duplicate GitHub webhook delivery ${normalizedDeliveryId}.`);
			res.statusCode = 202;
			res.end('Already accepted');
			return;
		}

		if (event === 'workflow_run' || event === 'workflow_job') {
			let payload: unknown;
			try {
				payload = JSON.parse(body);
			} catch {
				res.statusCode = 400;
				res.end('Invalid webhook payload');
				return;
			}

			const parsedPayload = WebhookPayloadSchema.safeParse(payload);
			if (!parsedPayload.success) {
				res.statusCode = 400;
				res.end('Invalid webhook payload');
				return;
			}

			if (!configuredRepositoryNames.has(parsedPayload.data.repository.full_name)) {
				console.warn(`Rejected webhook from unconfigured repository ${parsedPayload.data.repository.full_name}.`);
				res.statusCode = 403;
				res.end('Repository is not configured');
				return;
			}

			const workflowId = event === 'workflow_run'
				? parsedPayload.data.workflow_run?.workflow_id
				: parsedPayload.data.workflow_job?.workflow_id;

			const runId = event === 'workflow_job'
				? parsedPayload.data.workflow_job?.run_id
				: undefined;

			if (!workflowId) {
				res.statusCode = 400;
				res.end('Invalid workflow webhook payload');
				return;
			}

			console.info(`Accepted ${event} for ${parsedPayload.data.repository.full_name}; updating workflow ${workflowId}.`);
			void refreshWorkflowFromWebhook(
				parsedPayload.data.repository.full_name,
				workflowId,
				runId,
			).catch((error: unknown) => {
				console.error('Failed to update workflow from webhook.', error);
			});
		}

		res.statusCode = 202;
		res.end('Accepted');
		return;
	}

	if (req.method === 'POST' && req.url === '/api/access/validate') {
		if (!canValidateAccess(req.socket.remoteAddress ?? 'unknown')) {
			res.statusCode = 429;
			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify({ valid: false }));
			return;
		}

		let body: string;
		try {
			body = await readBody(req);
		} catch {
			res.statusCode = 413;
			res.end('Request body is too large');
			return;
		}

		let parsedBody: unknown;
		try {
			parsedBody = JSON.parse(body);
		} catch {
			parsedBody = undefined;
		}

		const validation = AccessValidationSchema.safeParse(parsedBody);
		const valid = validation.success && matchesDashboardAccess(validation.data.secret);

		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({ valid }));
		return;
	}

	if (req.method === 'GET' && req.url === '/api/state') {
		try {
			const state = await getState();
			const includeRunUrls = hasDashboardAccess(req.headers['x-ci-access-secret']);

			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify(publicState(state, includeRunUrls)));
		} catch (error) {
			console.error(error);
			res.statusCode = 502;
			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify({
				workflows: [],
				repositories: [],
				updatedAt: new Date().toISOString(),
				error: 'GitHub request failed',
			}));
		}

		return;
	}

	if (vite) {
		vite.middlewares(req, res, () => {
			res.statusCode = 404;
			res.end('Not found');
		});

		return;
	}
	
	staticFiles(req, res, () => {
		res.statusCode = 404;
		res.end('Not found');
	});
});

server.listen(port, () => {
	console.log(`ci running at http://localhost:${port}`);
});
