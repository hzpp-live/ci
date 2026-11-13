import { z } from 'zod';

const EnvironmentSchema = z.object({
	VITE_LOGO_URL: z.url(),
	VITE_FAVICON_URL: z.url(),

	GITHUB_APP_ID: z.coerce.number().int().positive(),
	GITHUB_APP_INSTALLATION_ID: z.coerce.number().int().positive(),
	GITHUB_APP_PRIVATE_KEY: z.string().trim().min(1),
	
	GITHUB_WEBHOOK_SECRET: z.string().trim().min(16),
	DASHBOARD_ACCESS_SECRET: z.string().trim().min(16),
	
	PUBLIC_URL: z.url(),
	REPOSITORIES_JSON: z.string().trim().min(1).max(100_000),
});

const RepositoryEntrySchema = z.union([
	z.string().trim().regex(/^[^/\s]+\/[^/\s]+$/),
	z.object({
		repo: z.string().trim().regex(/^[^/\s]+\/[^/\s]+$/),
		name: z.string().trim().min(1).max(120),
	}),
]);

export const RepositoryConfigSchema = z
	.array(RepositoryEntrySchema)
	.min(1, 'At least one repository is required')
	.max(100, 'At most 100 repositories are supported')
	.superRefine((repositories, context) => {
		const seen = new Set<string>();
		for (const repository of repositories) {
			const repo = typeof repository === 'string' ? repository : repository.repo;
			if (seen.has(repo)) {
				context.addIssue({
					code: 'custom',
					message: `Duplicate repository: ${repo}`,
				});
			}

			seen.add(repo);
		}
	});

export type RepoConfig = z.infer<typeof RepositoryConfigSchema>;

const environment = EnvironmentSchema.safeParse(process.env);
if (!environment.success) {
	console.error('Invalid environment configuration:');
	console.error(z.prettifyError(environment.error));
	process.exit(1);
}

export const config = environment.data;

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

const repositories = RepositoryConfigSchema.safeParse(parseJson(config.REPOSITORIES_JSON));
if (!repositories.success) {
	console.error('Invalid REPOSITORIES_JSON configuration:');
	console.error(z.prettifyError(repositories.error));
	process.exit(1);
}

export const repositoryConfig = repositories.data;

export const AccessValidationSchema = z.object({
	secret: z.string().trim().min(1),
});
