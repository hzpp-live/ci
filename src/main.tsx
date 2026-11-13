import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import App from './App';
import { loadFrontendConfig } from './env';
import './styles.css';

async function bootstrap() {
	const config = await loadFrontendConfig();
	const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
	if (favicon) favicon.href = config.faviconUrl;

	createRoot(document.getElementById('root')!).render(
		<StrictMode>
			<App logoUrl={config.logoUrl} />
		</StrictMode>,
	);
}

void bootstrap();
