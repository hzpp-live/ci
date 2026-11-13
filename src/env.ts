import { z } from 'zod';

const FrontendConfigSchema = z.object({
	logoUrl: z.url(),
	faviconUrl: z.url(),
});

export type FrontendConfig = z.infer<typeof FrontendConfigSchema>;

export async function loadFrontendConfig(): Promise<FrontendConfig> {
	const response = await fetch('/api/config');
	if (!response.ok) {
		throw new Error(`Frontend configuration request failed (${response.status})`);
	}

	const config = FrontendConfigSchema.safeParse(await response.json());
	if (!config.success) {
		throw new Error(
			`Invalid frontend configuration:\n${z.prettifyError(config.error)}`,
		);
	}

	return config.data;
}
