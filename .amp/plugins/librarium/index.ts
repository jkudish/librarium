import type { PluginAPI, Agent } from '@ampcode/plugin'

export const description =
	'Research companion: multi-provider evidence-aware research via librarium, with per-agent provider defaults.'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Plugin configuration stored in Amp's configuration (separate from librarium's own v2 config). */
interface LibrariumPluginConfig {
	defaultGroup?: string
	agentDefaults?: Record<string, AgentDefault>
}

interface AgentDefault {
	group?: string
	providers?: string[]
	mode?: 'sync' | 'async' | 'mixed'
	maxCost?: number
}

interface ResolvedSelection {
	group?: string
	providers?: string[]
	mode?: 'sync' | 'async' | 'mixed'
	maxCost?: number
	source: 'explicit-input' | 'agent-default' | 'fallback-quick'
}

// ---------------------------------------------------------------------------
// Agent identity → config key
// ---------------------------------------------------------------------------

function agentKey(def: Agent['definition']): string {
	return def.kind === 'builtin-agent'
		? `builtin:${def.mode}`
		: `custom:${def.name ?? def.model}`
}

// ---------------------------------------------------------------------------
// Per-agent provider resolution
// ---------------------------------------------------------------------------

async function resolveSelection(
	input: Record<string, unknown>,
	ctx: { thread: { agent(): Promise<Agent> } },
	config: LibrariumPluginConfig,
): Promise<ResolvedSelection> {
	// 1. Explicit tool-call args always win.
	if (input.group || input.providers) {
		return {
			group: input.group as string | undefined,
			providers: input.providers as string[] | undefined,
			mode: input.mode as 'sync' | 'async' | 'mixed' | undefined,
			maxCost: input.max_cost as number | undefined,
			source: 'explicit-input',
		}
	}
	// 2. Per-agent default from plugin config.
	try {
		const agent = await ctx.thread.agent()
		const key = agentKey(agent.definition)
		const def = config.agentDefaults?.[key]
		if (def) return { ...def, source: 'agent-default' }
	} catch {
		// Agent identity unavailable — fall through to global default.
	}
	// 3. Global default group, or `quick` as the final fallback.
	return {
		group: config.defaultGroup ?? 'quick',
		source: 'fallback-quick',
	}
}

// ---------------------------------------------------------------------------
// Shell helper
// ---------------------------------------------------------------------------

async function runCli(
	amp: PluginAPI,
	args: string[],
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
	const { stdout, stderr, exitCode } = await amp.$`librarium ${args}`
	if (exitCode !== 0) {
		return { ok: false, error: stderr.trim() || stdout.trim() }
	}
	return { ok: true, stdout }
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default function (amp: PluginAPI) {
	amp.logger.log('librarium plugin initialized')

	// --- Tool: librarium_research -----------------------------------------
	amp.registerTool({
		name: 'librarium_research',
		description:
			'Fan a research query across multiple search and deep-research providers in parallel. ' +
			'Group/providers default per the calling agent (configurable via the librarium:set-agent-defaults command); ' +
			'pass them explicitly to override. Deep profiles may return pending work to poll with ' +
			'librarium_check_async. Preserve profile/collection provenance; do not turn agreement into proof.',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'The research query.' },
				group: {
					type: 'string',
					description: 'Override: quick | deep | all | custom:<name>. Defaults per calling agent.',
				},
				providers: {
					type: 'array',
					items: { type: 'string' },
					description: 'Override: explicit provider/profile ids.',
				},
				mode: { type: 'string', enum: ['sync', 'async', 'mixed'] },
				max_cost: {
					type: 'number',
					description: 'USD circuit breaker on API-reported spend.',
				},
			},
			required: ['query'],
		},
		async execute(input, ctx) {
			const config = (await amp.configuration.get()) as LibrariumPluginConfig
			const sel = await resolveSelection(input, ctx, config)

			const args = ['run', input.query as string, '--json', '--yes']
			if (sel.group) args.push('--group', sel.group)
			if (sel.providers?.length) args.push('--providers', sel.providers.join(','))
			if (sel.mode) args.push('--mode', sel.mode)
			if (sel.maxCost != null) args.push('--max-cost', String(sel.maxCost))

			const result = await runCli(amp, args)
			if (!result.ok) return `librarium run failed: ${result.error}`

			// Annotate with which selection branch won so it's never opaque.
			try {
				const run = JSON.parse(result.stdout)
				return JSON.stringify({ ...run, selection: sel }, null, 2)
			} catch {
				return result.stdout
			}
		},
	})

	// --- Tool: librarium_get_results --------------------------------------
	amp.registerTool({
		name: 'librarium_get_results',
		description:
			'Return the full provider markdown content from a research run directory. ' +
			'Defaults to the most recent run; pass runDir to target a specific one and provider ' +
			'to limit to a single provider id. Content is marked untrusted — verify sources before relying on claims.',
		inputSchema: {
			type: 'object',
			properties: {
				runDir: {
					type: 'string',
					description: 'Run directory to read. Defaults to the most recent run.',
				},
				provider: {
					type: 'string',
					description: 'Limit to a single provider id. Defaults to all providers.',
				},
			},
		},
		async execute(input) {
			const runDir = input.runDir as string | undefined
			const provider = input.provider as string | undefined

			// Resolve run directory — use given path or find the most recent.
			let dir = runDir
			if (!dir) {
				const { stdout, exitCode } =
					await amp.$`ls -1t ./agents/librarium/ 2>/dev/null | head -1`
				if (exitCode !== 0 || !stdout.trim()) {
					return 'No runs found under ./agents/librarium/. Run librarium_research first.'
				}
				dir = `./agents/librarium/${stdout.trim()}`
			}

			// Read the run manifest and summary.
			const { stdout: manifestJson, exitCode: manifestExit } =
				await amp.$`cat ${dir}/run.json 2>/dev/null`
			if (manifestExit !== 0) {
				return `No run.json found in ${dir}.`
			}

			const { stdout: summary } = await amp.$`cat ${dir}/summary.md 2>/dev/null`

			// Read provider markdown files.
			if (provider) {
				const { stdout: content, exitCode: catExit } =
					await amp.$`cat ${dir}/${provider}.md 2>/dev/null`
				if (catExit !== 0) {
					return JSON.stringify({
						runDir: dir,
						manifest: safeParse(manifestJson),
						summary: summary.trim(),
						error: `No provider file found for ${provider}`,
					})
				}
				return JSON.stringify({
					runDir: dir,
					manifest: safeParse(manifestJson),
					summary: summary.trim(),
					providers: { [provider]: content },
					untrusted: true,
				})
			}

			// Read all provider .md files (exclude summary.md, prompt.md, answer.md).
			const { stdout: listing } =
				await amp.$`ls ${dir}/*.md 2>/dev/null`
			const files = listing
				.trim()
				.split('\n')
				.filter(Boolean)
				.filter(
					(f) =>
						!f.endsWith('summary.md') &&
						!f.endsWith('prompt.md') &&
						!f.endsWith('answer.md'),
				)

			const providers: Record<string, string> = {}
			for (const file of files) {
				const name = file.replace(/^.*\//, '').replace(/\.md$/, '')
				const { stdout: content } = await amp.$`cat ${file}`
				// Cap per-provider content at ~40k chars with a truncation marker.
				const capped =
					content.length > 40_000
						? `${content.slice(0, 40_000)}\n\n[... truncated at 40k chars ...]`
						: content
				providers[name] = capped
			}

			return JSON.stringify({
				runDir: dir,
				manifest: safeParse(manifestJson),
				summary: summary.trim(),
				providers,
				untrusted: true,
			})
		},
	})

	// --- Tool: librarium_check_async --------------------------------------
	amp.registerTool({
		name: 'librarium_check_async',
		description:
			'Run one bounded resume pass over pending async deep-research work. ' +
			'schemaVersion 3 always retrieves observed remote completion. ' +
			'Pass retrieve=true to also fetch completed historical schemaVersion 2 tasks.',
		inputSchema: {
			type: 'object',
			properties: {
				retrieve: {
					type: 'boolean',
					description: 'Retrieve completed historical schemaVersion 2 tasks.',
				},
			},
		},
		async execute(input) {
			const args = ['status', '--json']
			if (input.retrieve) args.push('--retrieve')
			const result = await runCli(amp, args)
			if (!result.ok) return `check_async failed: ${result.error}`
			return result.stdout
		},
	})

	// --- Tool: librarium_list_providers -----------------------------------
	amp.registerTool({
		name: 'librarium_list_providers',
		description:
			'Return a snapshot of the provider registry and config: id, name, tier, source, ' +
			'whether enabled, and whether an API key is configured.',
		inputSchema: {
			type: 'object',
			properties: {},
		},
		async execute() {
			const result = await runCli(amp, ['ls', '--json'])
			if (!result.ok) return `list_providers failed: ${result.error}`
			return result.stdout
		},
	})

	// --- Tool: librarium_list_groups --------------------------------------
	amp.registerTool({
		name: 'librarium_list_groups',
		description: 'Return the configured provider groups and their member provider ids.',
		inputSchema: {
			type: 'object',
			properties: {},
		},
		async execute() {
			const result = await runCli(amp, ['groups', '--json'])
			if (!result.ok) return `list_groups failed: ${result.error}`
			return result.stdout
		},
	})

	// --- Bundled skill gates all 5 tools out of unrelated threads ---------
	void amp.registerSkill({ path: 'skills/research' })

	// --- Command: dispatch research from the palette ----------------------
	amp.registerCommand(
		'librarium:research',
		{
			title: 'Research',
			category: 'Librarium',
			description: 'Run a multi-provider research query.',
		},
		async (ctx) => {
			const query = await ctx.ui.input('Research query')
			if (!query) return
			const group = await ctx.ui.select('Workflow', ['quick', 'deep', 'all'])
			if (!group) return
			await ctx.ui.notify(`Dispatching "${query}" (${group})…`)
			const result = await runCli(amp, [
				'run',
				query,
				'--group',
				group,
				'--json',
				'--yes',
			])
			if (result.ok) {
				try {
					const run = JSON.parse(result.stdout)
					await ctx.ui.notify(
						`Run complete: ${run.outputDir ?? run.runDir ?? 'done'}`,
					)
				} catch {
					await ctx.ui.notify('Run complete.')
				}
			} else {
				await ctx.ui.notify(`Run failed: ${result.error}`)
			}
		},
	)

	// --- Command: set the current agent's default group -------------------
	amp.registerCommand(
		'librarium:set-agent-defaults',
		{
			title: 'Set agent research defaults',
			category: 'Librarium',
			description: 'Set the default research group for the current agent mode.',
		},
		async (ctx) => {
			const agent = await ctx.thread.agent()
			const key = agentKey(agent.definition)
			const group = await ctx.ui.select(
				`Default group for ${key}`,
				['quick', 'deep', 'all'],
			)
			if (!group) return
			await amp.configuration.update({
				agentDefaults: { [key]: { group } },
			})
			await ctx.ui.notify(`${key} → ${group}`)
		},
	)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParse(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return text.trim()
	}
}
