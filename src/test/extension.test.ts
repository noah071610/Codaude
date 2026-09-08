import * as assert from 'assert';
import {
	DAY_MS,
	Entry,
	claudeLimits,
	parseClaudeFile,
	parseCodexFile,
	parseCodexLimits,
	projectUses,
	recentPromptUses,
	sumTotals,
	weekSlots,
} from '../tracker';

suite('token parsing', () => {
		test('claude: dedupes repeated messages, keeps cache fields', () => {
		const prompt = JSON.stringify({
			type: 'user',
			timestamp: '2026-09-07T09:59:00.000Z',
			cwd: '/Users/dev/demo-project',
			message: { role: 'user', content: [{ type: 'text', text: 'show recent prompts' }] },
		});
		const line = JSON.stringify({
			type: 'assistant',
			requestId: 'req_1',
			timestamp: '2026-09-07T10:00:00.000Z',
			message: {
				id: 'msg_1',
				model: 'claude-opus-5',
				usage: {
					input_tokens: 2,
					output_tokens: 161,
					cache_read_input_tokens: 27909,
					cache_creation_input_tokens: 22734,
				},
			},
		});
		const entries = parseClaudeFile(`${prompt}\n${line}\n${line}\n{bad json`, new Set());
		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0].model, 'claude-opus-5');
		assert.strictEqual(entries[0].prompt, 'show recent prompts');
		assert.strictEqual(entries[0].project, 'demo-project');
		assert.strictEqual(sumTotals(entries[0].usage), 2 + 161 + 27909 + 22734);
	});

		test('codex: turn cost is the delta of the running total', () => {
		const prompt = JSON.stringify({
			type: 'event_msg',
			timestamp: '2026-09-07T09:59:00.000Z',
			payload: { type: 'session_meta', cwd: '/Users/dev/demo-project' },
		});
		const userPrompt = JSON.stringify({
			type: 'event_msg',
			timestamp: '2026-09-07T09:59:00.000Z',
			payload: { type: 'user_message', message: 'show recent prompts' },
		});
		const event = (input: number, cached: number, output: number) =>
			JSON.stringify({
				type: 'event_msg',
				timestamp: '2026-09-07T10:00:00.000Z',
				payload: {
					type: 'token_count',
					info: {
						total_token_usage: {
							input_tokens: input,
							cached_input_tokens: cached,
							cache_write_input_tokens: 0,
							output_tokens: output,
						},
					},
				},
			});
		const entries = parseCodexFile(
			[prompt, userPrompt, '{"model":"gpt-5.6-luna"}', event(1000, 800, 50), event(1000, 800, 50), event(1600, 1200, 90)].join('\n')
		);
		assert.strictEqual(entries.length, 2, 'a repeated event has a zero delta');
		assert.strictEqual(entries[0].model, 'gpt-5.6-luna');
		assert.strictEqual(entries[0].prompt, 'show recent prompts');
		assert.strictEqual(entries[0].project, 'demo-project');
		assert.deepStrictEqual(entries[0].usage, { input: 200, output: 50, cacheRead: 800, cacheWrite: 0 });
		assert.deepStrictEqual(entries[1].usage, { input: 200, output: 40, cacheRead: 400, cacheWrite: 0 });
	});
});

suite('limit windows', () => {
	test('claude: reads the cached /usage utilization', () => {
		const l = claudeLimits(
			JSON.stringify({
				cachedUsageUtilization: {
					fetchedAtMs: 1788836778048,
					utilization: {
						five_hour: { utilization: 25, resets_at: '2026-09-08T07:20:00.000+00:00' },
						seven_day: { utilization: 10, resets_at: '2026-09-13T14:00:00.000+00:00' },
					},
				},
			})
		)!;
		assert.strictEqual(l.fiveHour?.percent, 25);
		assert.strictEqual(l.week?.percent, 10);
		assert.strictEqual(l.week?.resetsAt, Date.parse('2026-09-13T14:00:00Z'));
	});

	test('codex: last snapshot wins, windows keyed by length', () => {
		const snap = (pct: number, reset: number) =>
			JSON.stringify({
				timestamp: '2026-09-08T03:15:08.364Z',
				type: 'event_msg',
				payload: {
					type: 'token_count',
					rate_limits: {
						primary: { used_percent: pct, window_minutes: 300, resets_at: reset },
						secondary: { used_percent: 2, window_minutes: 10080, resets_at: reset + 600 },
					},
				},
			});
		const l = parseCodexLimits(`${snap(1, 1788852543)}\n${snap(7, 1788852999)}\n`)!;
		assert.strictEqual(l.fiveHour?.percent, 7);
		assert.strictEqual(l.fiveHour?.resetsAt, 1788852999 * 1000);
		assert.strictEqual(l.week?.percent, 2);
	});

	test('no snapshot in the file', () => {
		assert.strictEqual(parseCodexLimits('{"type":"event_msg"}\n'), undefined);
		assert.strictEqual(claudeLimits('not json'), undefined);
	});
});

suite('week slots', () => {
	const start = Date.parse('2026-09-06T14:00:00Z'); // a reset at 23:00 KST
	const at = (ts: number, tool: 'claude' | 'codex' = 'claude'): Entry => ({
		ts,
		tool,
		model: 'm',
		usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
	});

	test('buckets by the reset hour, not by midnight', () => {
		const days = weekSlots(
			[
				at(start + 1000), // slot 0
				at(start + DAY_MS - 1000), // still slot 0, though it is the next calendar day
				at(start + DAY_MS + 1000), // slot 1
				at(start + 6 * DAY_MS), // last slot
			],
			'claude',
			start
		);
		assert.deepStrictEqual(days, [2, 1, 0, 0, 0, 0, 1]);
	});

	test('drops entries outside the window and other tools', () => {
		const days = weekSlots(
			[at(start - 1), at(start + 7 * DAY_MS), at(start + 1000, 'codex')],
			'claude',
			start
		);
		assert.deepStrictEqual(days, [0, 0, 0, 0, 0, 0, 0]);
	});

	test('groups repeated token events under one prompt', () => {
		const entries: Entry[] = [
			{ ts: start + 2, promptTs: start + 1, prompt: 'one', tool: 'claude', model: 'm', usage: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 } },
			{ ts: start + 3, promptTs: start + 1, prompt: 'one', tool: 'claude', model: 'm', usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 } },
		];
		const recent = recentPromptUses(entries, 'claude', start);
		assert.strictEqual(recent.length, 1);
		assert.strictEqual(sumTotals(recent[0].usage), 5);
	});

	test('ranks project usage across both tools', () => {
		const usage = (input: number) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 });
		const start = Date.parse('2026-09-01T00:00:00Z');
		const entries: Entry[] = [
			{ ts: start + 1, tool: 'claude', model: 'm', project: 'alpha', usage: usage(3) },
			{ ts: start + 2, tool: 'codex', model: 'm', project: 'alpha', usage: usage(2) },
			{ ts: start + 3, tool: 'codex', model: 'm', project: 'beta', usage: usage(4) },
		];
		assert.deepStrictEqual(projectUses(entries, { claude: start, codex: start }), [
			{ project: 'alpha', tools: { claude: 3, codex: 2 }, total: 5 },
			{ project: 'beta', tools: { claude: 0, codex: 4 }, total: 4 },
		]);
	});
});
