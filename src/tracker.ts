import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export type Tool = 'claude' | 'codex';

export interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface Entry {
	ts: number; // epoch ms; every window is measured against the provider's reset time
	tool: Tool;
	model: string;
	usage: Totals;
	prompt?: string;
	promptTs?: number;
	project?: string;
}

export interface PromptUse {
	ts: number;
	prompt: string;
	usage: Totals;
	project?: string;
}

export interface ProjectUse {
	project: string;
	tools: Record<Tool, number>;
	total: number;
}

/** One usage limit window, exactly as the provider reports it. */
export interface LimitWindow {
	/** 0-100 */
	percent: number;
	/** epoch ms */
	resetsAt: number;
}

export interface ToolLimits {
	fiveHour?: LimitWindow;
	week?: LimitWindow;
	/** when the provider last reported these numbers (epoch ms) */
	fetchedAt: number;
}

/** Tokens per day-slot of a limit window, oldest slot first. */
export interface WindowUse {
	/** epoch ms of slot 0; slot boundaries are the reset time of day, not midnight */
	start: number;
	days: number[];
}

export interface Report {
	/** tokens inside each tool's own 5-hour window */
	last5h: Record<Tool, number>;
	/** latest prompts with usage inside each tool's own 5-hour window */
	recent: Record<Tool, PromptUse[]>;
	/** tokens per project inside each tool's own weekly window, ranked by total */
	projects: ProjectUse[];
	/** tokens per day of each tool's own weekly window */
	week: Record<Tool, WindowUse>;
	/** undefined when the tool is not installed or has never reported limits */
	limits: Partial<Record<Tool, ToolLimits>>;
}

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
export const DAY_MS = 86_400_000;
export const WEEK_DAYS = 7;

/** Claude Code caches its own /usage numbers here after every fetch. */
export const CLAUDE_STATE = path.join(os.homedir(), '.claude.json');

export const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
export const CODEX_DIR = path.join(os.homedir(), '.codex', 'sessions');

function promptText(value: unknown): string | undefined {
	const text = Array.isArray(value)
		? value
				.filter((part) => part?.type === 'text' && typeof part.text === 'string')
				.map((part) => part.text)
				.join(' ')
		: typeof value === 'string'
			? value
			: undefined;
	const cleaned = text?.replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, '').replace(/\s+/g, ' ').trim();
	return cleaned || undefined;
}

function projectName(cwd: unknown): string | undefined {
	return typeof cwd === 'string' && cwd ? path.basename(cwd) : undefined;
}

export function sumTotals(t: Totals): number {
	return t.input + t.output + t.cacheRead + t.cacheWrite;
}

/**
 * Claude Code writes one line per assistant message, but the same message can be
 * re-emitted (streaming / resumed sessions), so dedupe on message.id + requestId.
 */
export function parseClaudeFile(text: string, seen: Set<string>): Entry[] {
	const out: Entry[] = [];
	let prompt: string | undefined;
	let promptTs: number | undefined;
	let project: string | undefined;
	for (const line of text.split('\n')) {
		let row: any;
		try {
			row = JSON.parse(line);
		} catch {
			continue; // partial last line while the file is being appended to
		}
		project = projectName(row?.cwd) ?? project;
		if (row?.type === 'user' && row.message?.role === 'user') {
			const next = promptText(row.message.content);
			if (next) {
				prompt = next;
				promptTs = Date.parse(row.timestamp);
			}
		}
		const usage = row?.message?.usage;
		if (row?.type !== 'assistant' || !usage) {
			continue;
		}
		const key = `${row.message.id}:${row.requestId ?? ''}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		const ts = Date.parse(row.timestamp);
		if (Number.isNaN(ts)) {
			continue;
		}
		out.push({
			ts,
			tool: 'claude',
			model: row.message.model ?? 'unknown',
			prompt,
			promptTs,
			project,
			usage: {
				input: usage.input_tokens ?? 0,
				output: usage.output_tokens ?? 0,
				cacheRead: usage.cache_read_input_tokens ?? 0,
				cacheWrite: usage.cache_creation_input_tokens ?? 0,
			},
		});
	}
	return out;
}

/**
 * Codex logs a running `total_token_usage` on every token_count event, so a turn's
 * cost is the delta against the previous event in the same rollout file.
 * (`cached_input_tokens` is a subset of `input_tokens`, unlike Claude's cache fields.)
 */
export function parseCodexFile(text: string): Entry[] {
	const out: Entry[] = [];
	let prev = { input: 0, output: 0, cached: 0, write: 0 };
	let model = 'unknown';
	let currentPrompt: string | undefined;
	let currentPromptTs: number | undefined;
	let currentProject: string | undefined;
	for (const line of text.split('\n')) {
		let row: any;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		currentProject = projectName(row?.payload?.cwd) ?? currentProject;
		const prompt = row?.type === 'event_msg' && row.payload?.type === 'user_message' ? promptText(row.payload.message) : undefined;
		if (prompt) {
			currentPrompt = prompt;
			currentPromptTs = Date.parse(row.timestamp);
		}
		if (line.includes('"model"')) {
			const m = /"model":"([^"]+)"/.exec(line);
			if (m) {
				model = m[1];
			}
		}
		if (!line.includes('"token_count"')) {
			continue;
		}
		const t = row?.payload?.info?.total_token_usage;
		if (!t) {
			continue;
		}
		const cur = {
			input: t.input_tokens ?? 0,
			output: t.output_tokens ?? 0,
			cached: t.cached_input_tokens ?? 0,
			write: t.cache_write_input_tokens ?? 0,
		};
		// a reset (new baseline) counts as the full value, never a negative delta
		const d = (a: number, b: number) => (a >= b ? a - b : a);
		const usage: Totals = {
			input: d(cur.input, prev.input) - d(cur.cached, prev.cached),
			output: d(cur.output, prev.output),
			cacheRead: d(cur.cached, prev.cached),
			cacheWrite: d(cur.write, prev.write),
		};
		prev = cur;
		if (sumTotals(usage) <= 0) {
			continue;
		}
		const ts = Date.parse(row.timestamp);
		if (!Number.isNaN(ts)) {
			out.push({ ts, tool: 'codex', model, prompt: currentPrompt, promptTs: currentPromptTs, project: currentProject, usage });
		}
	}
	return out;
}

/**
 * A window whose reset time has already passed is dead data: the provider reset it
 * long ago and simply has not told us yet. Reporting its percentage would pin the UI
 * to a number that can never move, so an expired window is dropped entirely and the
 * caller falls back to counting tokens over the real trailing window.
 */
function liveWindow(percent: unknown, resetsAt: number, now: number): LimitWindow | undefined {
	return typeof percent === 'number' && Number.isFinite(resetsAt) && resetsAt > now
		? { percent, resetsAt }
		: undefined;
}

/** `~/.claude.json` holds the last utilization the CLI fetched: real percentages, real reset times. */
export function claudeLimits(json: string, now = Date.now()): ToolLimits | undefined {
	let raw: any;
	try {
		raw = JSON.parse(json);
	} catch {
		return undefined;
	}
	const cached = raw?.cachedUsageUtilization;
	const u = cached?.utilization;
	if (!u) {
		return undefined;
	}
	const win = (w: any): LimitWindow | undefined =>
		w?.resets_at ? liveWindow(w.utilization, Date.parse(w.resets_at), now) : undefined;
	return { fiveHour: win(u.five_hour), week: win(u.seven_day), fetchedAt: cached.fetchedAtMs ?? 0 };
}

/** Codex stamps the same numbers onto every `token_count` event; the last one in the file wins. */
export function parseCodexLimits(text: string, now = Date.now()): ToolLimits | undefined {
	const lines = text.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!lines[i].includes('"rate_limits"')) {
			continue;
		}
		let row: any;
		try {
			row = JSON.parse(lines[i]);
		} catch {
			continue;
		}
		const rl = row?.payload?.rate_limits;
		if (!rl) {
			continue;
		}
		// windows are identified by their length, not by primary/secondary
		const win = (mins: number): LimitWindow | undefined => {
			const w = [rl.primary, rl.secondary].find((x) => x?.window_minutes === mins);
			return w?.resets_at ? liveWindow(w.used_percent, w.resets_at * 1000, now) : undefined;
		};
		return {
			fiveHour: win(FIVE_HOURS_MS / 60_000),
			week: win((WEEK_DAYS * DAY_MS) / 60_000),
			fetchedAt: Date.parse(row.timestamp) || 0,
		};
	}
	return undefined;
}

/** Split a tool's entries into the 7 day-slots of a window starting at `start`. */
export function weekSlots(entries: Entry[], tool: Tool, start: number): number[] {
	const days = new Array<number>(WEEK_DAYS).fill(0);
	for (const e of entries) {
		if (e.tool !== tool) {
			continue;
		}
		const i = Math.floor((e.ts - start) / DAY_MS);
		if (i >= 0 && i < WEEK_DAYS) {
			days[i] += sumTotals(e.usage);
		}
	}
	return days;
}

/** Each day's share of the provider's reported weekly limit. */
export function weeklyDayPercents(use: WindowUse, week: LimitWindow | undefined): number[] {
	const total = use.days.reduce((sum, n) => sum + n, 0);
	const fill = week ? Math.min(Math.max(week.percent, 0), 100) : 0;
	return total ? use.days.map((tokens) => (fill * tokens) / total) : use.days.map(() => 0);
}

export function recentPromptUses(entries: Entry[], tool: Tool, start: number): PromptUse[] {
	const grouped = new Map<string, PromptUse>();
	for (const entry of entries) {
		if (entry.tool !== tool || entry.ts < start || !entry.prompt) {
			continue;
		}
		const ts = entry.promptTs && !Number.isNaN(entry.promptTs) ? entry.promptTs : entry.ts;
		const key = `${ts}:${entry.project ?? ''}:${entry.prompt}`;
		const use = grouped.get(key) ?? {
			ts,
			prompt: entry.prompt,
			project: entry.project,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		use.usage.input += entry.usage.input;
		use.usage.output += entry.usage.output;
		use.usage.cacheRead += entry.usage.cacheRead;
		use.usage.cacheWrite += entry.usage.cacheWrite;
		grouped.set(key, use);
	}
	return [...grouped.values()].sort((a, b) => b.ts - a.ts);
}

export function projectUses(entries: Entry[], starts: Record<Tool, number>): ProjectUse[] {
	const grouped = new Map<string, ProjectUse>();
	for (const entry of entries) {
		const project = entry.project ?? 'Unknown';
		const start = starts[entry.tool];
		if (entry.ts < start || entry.ts >= start + WEEK_DAYS * DAY_MS) {
			continue;
		}
		const use = grouped.get(project) ?? { project, tools: { claude: 0, codex: 0 }, total: 0 };
		const tokens = sumTotals(entry.usage);
		use.tools[entry.tool] += tokens;
		use.total += tokens;
		grouped.set(project, use);
	}
	return [...grouped.values()].sort((a, b) => b.total - a.total || a.project.localeCompare(b.project));
}

function mockTokens(tokens: number): Totals {
	return { input: tokens * 0.2, output: tokens * 0.1, cacheRead: tokens * 0.6, cacheWrite: tokens * 0.1 };
}

function mockPrompts(now: number, items: [string, number, string][]): PromptUse[] {
	return items.map(([prompt, tokens, project], i) => ({
		ts: now - (i + 1) * 20 * 60_000,
		prompt,
		project,
		usage: mockTokens(tokens),
	}));
}

/** Synthetic data for screenshots; enabled only by explicitly setting IS_MOCK=true. */
export function mockReport(now = Date.now()): Report {
	const start = now - 2 * DAY_MS - 60 * 60_000;
	const reset5h = now + 1 * 60 * 60_000 + 42 * 60_000;
	const resetWeek = start + WEEK_DAYS * DAY_MS;
	const limits = {
		claude: { fiveHour: { percent: 42, resetsAt: reset5h }, week: { percent: 63, resetsAt: resetWeek }, fetchedAt: now - 4 * 60_000 },
		codex: { fiveHour: { percent: 31, resetsAt: now + 2 * 60 * 60_000 + 18 * 60_000 }, week: { percent: 48, resetsAt: resetWeek }, fetchedAt: now - 7 * 60_000 },
	} satisfies Report['limits'];

	return {
		last5h: { claude: 3_205_000, codex: 2_560_000 },
		recent: {
			claude: mockPrompts(now, [
				['Polish the onboarding flow and make the empty states feel more intentional', 1_350_000, 'codaude-web'],
				['Review the token aggregation logic for edge cases around reset windows', 640_000, 'infra-tools'],
				['Refactor the dashboard cards without changing the visual hierarchy', 410_000, 'client-dashboard'],
				['Add loading and error states to the usage panel', 270_000, 'codaude-web'],
				['Write a concise release note for the new project slider', 205_000, 'docs-site'],
				['Check the dark theme contrast for secondary labels', 150_000, 'design-system'],
				['Explain why the weekly pace calculation includes today', 110_000, 'docs-site'],
				['Suggest three names for the compact status bar label', 70_000, 'codaude-web'],
			]),
			codex: mockPrompts(now, [
				['Implement the API adapter and keep the types narrow at the boundary', 980_000, 'client-dashboard'],
				['Trace the slow startup path and remove unnecessary filesystem reads', 540_000, 'infra-tools'],
				['Build a responsive command palette with keyboard navigation', 370_000, 'mobile-app'],
				['Compare the current layout against the latest product brief', 240_000, 'codaude-web'],
				['Generate realistic seed records for the analytics preview', 175_000, 'prompt-lab'],
				['Tighten the README setup instructions for first-time users', 120_000, 'docs-site'],
				['Find the smallest safe fix for the stale cache indicator', 85_000, 'infra-tools'],
				['Summarize the changed files for the pull request description', 50_000, 'codaude-web'],
			]),
		},
		projects: [
			{ project: 'codaude-web', tools: { claude: 3_200_000, codex: 2_400_000 }, total: 5_600_000 },
			{ project: 'client-dashboard', tools: { claude: 2_700_000, codex: 2_100_000 }, total: 4_800_000 },
			{ project: 'prompt-lab', tools: { claude: 2_100_000, codex: 2_000_000 }, total: 4_100_000 },
			{ project: 'mobile-app', tools: { claude: 2_300_000, codex: 1_100_000 }, total: 3_400_000 },
			{ project: 'infra-tools', tools: { claude: 1_400_000, codex: 2_300_000 }, total: 3_700_000 },
			{ project: 'docs-site', tools: { claude: 1_000_000, codex: 800_000 }, total: 1_800_000 },
			{ project: 'design-system', tools: { claude: 800_000, codex: 500_000 }, total: 1_300_000 },
		],
		week: {
			claude: { start, days: [1_100_000, 1_900_000, 2_800_000, 2_400_000, 3_500_000, 2_200_000, 1_600_000] },
			codex: { start, days: [800_000, 1_400_000, 2_200_000, 1_700_000, 2_900_000, 1_800_000, 1_300_000] },
		},
		limits,
	};
}

async function jsonlFiles(dir: string, since: number): Promise<string[]> {
	let names: string[];
	try {
		names = await fs.readdir(dir, { recursive: true });
	} catch {
		return []; // tool not installed
	}
	const found: { file: string; mtime: number }[] = [];
	await Promise.all(
		names.map(async (name) => {
			if (!name.endsWith('.jsonl')) {
				return;
			}
			const file = path.join(dir, name);
			try {
				const st = await fs.stat(file);
				if (st.isFile() && st.mtimeMs >= since) {
					found.push({ file, mtime: st.mtimeMs });
				}
			} catch {
				/* deleted mid-scan */
			}
		})
	);
	// newest first: the freshest file is the one carrying the current limit snapshot
	found.sort((a, b) => b.mtime - a.mtime);
	return found.map((f) => f.file);
}

async function readFile(file: string): Promise<string | undefined> {
	try {
		return await fs.readFile(file, 'utf8');
	} catch {
		return undefined; // unreadable / deleted / tool not installed
	}
}

/** The newest rollout usually carries a snapshot, but a short session may have none. */
async function firstCodexLimits(files: string[]): Promise<ToolLimits | undefined> {
	for (const file of files.slice(0, 5)) {
		const text = await readFile(file);
		const limits = text && parseCodexLimits(text);
		if (limits) {
			return limits;
		}
	}
	return undefined;
}

async function mockEnabled(): Promise<boolean> {
	if (process.env.IS_MOCK?.trim().toLowerCase() === 'true') {
		return true;
	}
	const env = await readFile(path.join(__dirname, '..', '.env'));
	return /^\s*IS_MOCK\s*=\s*["']?true["']?\s*(?:#.*)?$/im.test(env ?? '');
}

/** Scan both tools' logs for the last `days` days (files older than that are skipped). */
export async function scan(days = 7): Promise<Report> {
	if (await mockEnabled()) {
		return mockReport();
	}
	const since = Date.now() - days * 86_400_000;
	const [claudeFiles, codexFiles] = await Promise.all([
		jsonlFiles(CLAUDE_DIR, since),
		jsonlFiles(CODEX_DIR, since),
	]);

	const seen = new Set<string>();
	const entries: Entry[] = [];
	const read = async (file: string, parse: (text: string) => Entry[]) => {
		const text = await readFile(file);
		if (text) {
			entries.push(...parse(text));
		}
	};
	// claude files are read sequentially: `seen` dedupes across resumed sessions
	for (const f of claudeFiles) {
		await read(f, (text) => parseClaudeFile(text, seen));
	}
	await Promise.all(codexFiles.map((f) => read(f, parseCodexFile)));

	const limits: Report['limits'] = {
		claude: await readFile(CLAUDE_STATE).then((t) => (t ? claudeLimits(t) : undefined)),
		codex: await firstCodexLimits(codexFiles),
	};

	// without a reported window, fall back to the last 5 hours / 7 days ending now
	const now = Date.now();
	const last5h = {} as Report['last5h'];
	const recent = {} as Report['recent'];
	const week = {} as Report['week'];
	const weekStarts = {} as Record<Tool, number>;
	for (const tool of ['claude', 'codex'] as Tool[]) {
		const l = limits[tool];
		const start5 = l?.fiveHour ? l.fiveHour.resetsAt - FIVE_HOURS_MS : now - FIVE_HOURS_MS;
		last5h[tool] = entries
			.filter((e) => e.tool === tool && e.ts >= start5)
			.reduce((s, e) => s + sumTotals(e.usage), 0);
		recent[tool] = recentPromptUses(entries, tool, start5);
		const start = l?.week ? l.week.resetsAt - WEEK_DAYS * DAY_MS : now - WEEK_DAYS * DAY_MS;
		weekStarts[tool] = start;
		week[tool] = { start, days: weekSlots(entries, tool, start) };
	}

	return { last5h, recent, projects: projectUses(entries, weekStarts), week, limits };
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) {
		return `${(n / 1_000_000).toFixed(2)}M`;
	}
	if (n >= 1_000) {
		return `${(n / 1_000).toFixed(1)}K`;
	}
	return String(n);
}
