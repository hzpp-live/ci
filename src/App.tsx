import { Check, ChevronsDownUp, ChevronsUpDown, KeyRound, X, } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type Workflow = {
	id: number;
	name: string;
	path: string;
	repositoryId: string;
	status: string;
	conclusion: string | null;
	branch: string;
	event: string;
	updatedAt: string;
	runUrl?: string;
	progress: number | null;
};

export type Dashboard = {
	workflows: Workflow[];
	updatedAt: string;
	repositories: Repository[];
	error?: string;
};

type Repository = {
	id: string;
	name: string;
};

type AccessValidationResponse = {
	valid: boolean;
};

const blank: Dashboard = {
	workflows: [],
	updatedAt: '',
	repositories: [],
};
const Icon = ({
	name,
}: {
	name: 'chevron' | 'check' | 'cross' | 'spinner' | 'clock';
}) => {
	const paths = {
		chevron: <path d='m6 4 4 4-4 4' />,
		check: <path d='m4.5 8 2.2 2.2L11.5 5.5' />,
		cross: <path d='m5.5 5.5 5 5m0-5-5 5' />,
		spinner: <path d='M8 2.5A5.5 5.5 0 0 1 13.5 8' />,
		clock: (
			<>
				<circle cx='8' cy='8' r='5.5' />
				<path d='M8 5v3.5l2 1' />
			</>
		),
	}[name];
	return (
		<svg
			className={`icon icon-${name}`}
			viewBox='0 0 16 16'
			aria-hidden='true'
		>
			{paths}
		</svg>
	);
};

export function age(value: string) {
	const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));

	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;

	return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

export function tone(workflow: Workflow) {
	if (['in_progress', 'queued', 'waiting'].includes(workflow.status)) return 'active';
	if (workflow.conclusion === 'success') return 'success';
	if (workflow.conclusion) return 'failure';
	return 'quiet';
}

export function label(workflow: Workflow) {
	if (workflow.status === 'in_progress') return 'In progress';
	if (['queued', 'waiting'].includes(workflow.status)) return 'Queued';
	if (workflow.conclusion === 'success') return 'Success';
	if (workflow.conclusion === 'cancelled') return 'Cancelled';
	if (workflow.conclusion) return 'Failed';
	return 'Unknown';
}

export function StatusIcon({ workflow }: { workflow: Workflow }) {
	const kind = tone(workflow);
	return (
		<span className={`status-icon ${kind}`}>
			<Icon
				name={
					kind === 'success'
						? 'check'
						: kind === 'failure'
							? 'cross'
							: kind === 'active'
								? 'spinner'
								: 'clock'
				}
			/>
		</span>
	);
}

export function App({ logoUrl }: { logoUrl: string }) {
	const [data, setData] = useState<Dashboard>(blank);
	const [allOpen, setAllOpen] = useState(true);
	
	const [accessInput, setAccessInput] = useState('');
	const [accessInvalid, setAccessInvalid] = useState(false);
	const [accessChecking, setAccessChecking] = useState(false);
	const [accessModalOpen, setAccessModalOpen] = useState(false);

	const accessButtonRef = useRef<HTMLButtonElement>(null);
	const [accessEnabled, setAccessEnabled] = useState(() => Boolean(localStorage.getItem('CI_ACCESS_SECRET')));

	const load = useCallback(async () => {
		try {
			const accessSecret = localStorage.getItem('CI_ACCESS_SECRET');
			const headers = accessSecret ? { 'x-ci-access-secret': accessSecret } : undefined;
			const response = await fetch('/api/state', {
				cache: 'no-store',
				headers,
			});

			if (response.ok) setData((await response.json()) as Dashboard);
		} catch {
			// Keep the last good snapshot while the connection recovers.
		}
	}, []);

	useEffect(() => {
		void load();

		const events = new EventSource('/api/events');
		events.onopen = () => void load();
		events.onmessage = () => void load();

		return () => {
			events.close();
		};
	}, [load]);

	useEffect(() => {
		if (!accessModalOpen) return;

		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			setAccessInput('');
			setAccessInvalid(false);
			setAccessModalOpen(false);
			accessButtonRef.current?.focus();
		};

		document.addEventListener('keydown', closeOnEscape);
		return () => document.removeEventListener('keydown', closeOnEscape);
	}, [accessModalOpen]);

	const validateAccess = async () => {
		setAccessChecking(true);
		setAccessInvalid(false);

		try {
			const response = await fetch('/api/access/validate', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ secret: accessInput }),
			});

			const result = (await response.json()) as AccessValidationResponse;

			if (!response.ok || !result.valid) {
				setAccessInvalid(true);
				return;
			}

			localStorage.setItem('CI_ACCESS_SECRET', accessInput);
			setAccessEnabled(true);
			setAccessInput('');
			setAccessModalOpen(false);
			accessButtonRef.current?.focus();
			void load();
		} catch {
			setAccessInvalid(true);
		} finally {
			setAccessChecking(false);
		}
	};

	const groups = useMemo(() => {
		const map = new Map<string, { id: string; name: string; workflows: Workflow[] }>();

		for (const repository of data.repositories) {
			map.set(repository.id, {
				id: repository.id,
				name: repository.name,
				workflows: [],
			});
		}

		for (const workflow of data.workflows) {
			const group = map.get(workflow.repositoryId);
			if (group) group.workflows.push(workflow);
		}

		return [...map.values()].sort((a, b) => b.name.length - a.name.length || a.name.localeCompare(b.name));
	}, [data.repositories, data.workflows]);

	return (
		<main className='workspace'>
			<header className='app-header'>
				<div className='title'>
					<img className='logo' src={logoUrl} alt='Logo' />
					<h1>Workflow status</h1>
				</div>
				<div className='header-actions'>
					<button
						ref={accessButtonRef}
						className={`icon-button${accessEnabled ? ' enabled' : ''}`}
						type='button'
						onClick={() => {
							setAccessInvalid(false);
							setAccessModalOpen(true);
						}}
						aria-label='Set access secret'
						title='Set access secret'
					>
						<KeyRound size={18} strokeWidth={1.6} aria-hidden='true' />
					</button>
					<button
						className='icon-button'
						type='button'
						onClick={() => setAllOpen((open) => !open)}
						aria-label={
							allOpen
								? 'Collapse all repositories'
								: 'Expand all repositories'
						}
						title={
							allOpen
								? 'Collapse all repositories'
								: 'Expand all repositories'
						}
					>
						{allOpen ? (
							<ChevronsDownUp
								size={18}
								strokeWidth={1.6}
								aria-hidden='true'
							/>
						) : (
							<ChevronsUpDown
								size={18}
								strokeWidth={1.6}
								aria-hidden='true'
							/>
						)}
					</button>
				</div>
			</header>
			{accessModalOpen && (
				<div
					className='access-modal-backdrop'
					role='presentation'
					onMouseDown={(event) => {
						if (event.target === event.currentTarget) {
							setAccessInput('');
							setAccessInvalid(false);
							setAccessModalOpen(false);
							accessButtonRef.current?.focus();
						}
					}}
				>
					<form
						className='access-modal'
						role='dialog'
						aria-modal='true'
						aria-label='Access secret'
						autoComplete='off'
						onSubmit={(event) => {
							event.preventDefault();
							if (!accessChecking) void validateAccess();
						}}
					>
						<input
							autoFocus
							className={accessInvalid ? 'invalid' : ''}
							value={accessInput}
							type='password'
							name='ci-access-secret'
							autoComplete='new-password'
							autoCorrect='off'
							autoCapitalize='none'
							spellCheck={false}
							aria-label='Access secret'
							onChange={(event) => {
								setAccessInput(event.target.value);
								setAccessInvalid(false);
							}}
							aria-invalid={accessInvalid}
						/>
						<div className='access-modal-actions'>
							<button
								className='icon-button'
								type='button'
								onClick={() => {
									setAccessInput('');
									setAccessInvalid(false);
									setAccessModalOpen(false);
								accessButtonRef.current?.focus();
								}}
								aria-label='Cancel'
							>
								<X size={17} strokeWidth={1.6} aria-hidden='true' />
							</button>
							<button
								className='icon-button'
								type='submit'
								disabled={accessChecking || !accessInput}
								aria-label='Validate access secret'
							>
								<Check size={17} strokeWidth={1.6} aria-hidden='true' />
							</button>
						</div>
					</form>
				</div>
			)}
			{data.error && <div className='notice error'>{data.error}</div>}
			<section className='run-table' aria-label='Workflow status'>
				{groups.map((group) => (
					<details className='repository' key={group.id} open={allOpen}>
						<summary>
							<Icon name='chevron' />
							<span className='repo-name'>{group.name}</span>
							<span className='repo-count'>
								{group.workflows.length}
							</span>
						</summary>
						<div className='workflow-rows'>
							{group.workflows.map((workflow) => (
								<WorkflowRow
									key={`${workflow.repositoryId}-${workflow.path}`}
									workflow={workflow}
								/>
							))}
						</div>
					</details>
				))}
				{!groups.length && (
					<div className='empty'>No workflows available.</div>
				)}
			</section>
		</main>
	);
}

export function WorkflowRow({ workflow }: { workflow: Workflow }) {
	const kind = tone(workflow);
	const percentage = workflow.progress == null ? 0 : Math.max(0, Math.min(100, workflow.progress));

	return (
		<div className='workflow-row'>
			<div className='workflow-cell'>
				<StatusIcon workflow={workflow} />
				<div>
					{workflow.runUrl ? (
						<a
							className='workflow-title'
							href={workflow.runUrl}
							target='_blank'
							rel='noreferrer'
						>
							{workflow.name}
						</a>
					) : (
						<span className='workflow-title'>{workflow.name}</span>
					)}
					<code>
						{workflow.path.replace('.github/workflows/', '')}
					</code>
				</div>
			</div>
			<div className={`state ${kind}`}>{label(workflow)}</div>
			<div className='progress-cell'>
				<div className='progress-track'>
					<span
						className={kind}
						style={{ width: `${percentage}%` }}
					/>
				</div>
			</div>
			<span className='progress-value'>
				{workflow.progress == null ? '—' : `${workflow.progress}%`}
			</span>
			<div className='updated'>{age(workflow.updatedAt)}</div>
		</div>
	);
}

export default App;
