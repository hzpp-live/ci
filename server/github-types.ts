export type GitHubWorkflow = {
	id: number;
	name: string;
	path: string;
};

export type GitHubWorkflowRun = {
	id: number;
	status: string;
	conclusion: string | null;
	head_branch: string | null;
	event: string;
	updated_at: string;
	html_url: string;
};

export type GitHubWorkflowStep = {
	status: string;
};

export type GitHubWorkflowJob = {
	status: string;
	steps?: GitHubWorkflowStep[] | null;
};

export type GitHubWorkflowListResponse = {
	workflows?: GitHubWorkflow[];
};

export type GitHubWorkflowRunsResponse = {
	workflow_runs?: GitHubWorkflowRun[];
};

export type GitHubWorkflowJobsResponse = {
	jobs?: GitHubWorkflowJob[];
};
