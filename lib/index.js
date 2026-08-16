/**
 * @fww/dsh-web-search-zhipu
 *
 * Zhipu BigModel-backed `WebSearchProvider` for the DeepSeek Harness web
 * capability seam (`ctx.web`). Talks to Zhipu's hosted MCP endpoints
 * (open.bigmodel.cn/api/mcp/<service>/mcp, streamable-http JSON-RPC 2.0)
 * with Bearer auth — no anonymous mode.
 *
 * The server requires a stateful MCP handshake (initialize →
 * `mcp-session-id` → `notifications/initialized`) before `tools/call`;
 * stateless calls are rejected with -401. The session id is cached per
 * endpoint and transparently re-established when the server drops it.
 *
 * Configuration is user-owned for the variable parts only: the API key
 * (env or literal), result count, and extra tool arguments. The endpoint
 * and tool are FIXED constants (web_search_prime) — Zhipu changing them
 * is a source change + release, not a config knob; this keeps the config
 * surface exactly as wide as the actual variability.
 *
 * This is an implementation package: it registers a provider INTO `ctx.web`
 * (`inject: ['web']`) and owns no model-facing tools (those belong to
 * `@deepseek-ai/dsh-tool-web`). It also installs a Settings section
 * (`web-search-zhipu`) into the settings service for hot edits.
 *
 * Structure follows @tonydua/dsh-web-search-exa (MIT) — see README.
 */

import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { WebError } from "@deepseek-ai/dsh-web";
import z from "@deepseek-ai/schemastery";

/** Default provider id this provider registers under (`ctx.web` registry key). */
const DEFAULT_PROVIDER_ID = "zhipu";
/** Environment variable consulted when no literal `apiKey` is configured. */
const DEFAULT_API_KEY_ENV = "ZHIPU_API_KEY";
/** The Zhipu MCP endpoint (fixed): the web_search_prime search service. */
const MCP_URL = "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp";
/** The MCP tool called on that endpoint (fixed). */
const TOOL = "web_search_prime";
/** Default result count when the request carries no `maxResults`. */
const DEFAULT_COUNT = 5;
/** Handshake and search timeout per request (ms). */
const REQUEST_TIMEOUT_MS = 30_000;
/** Snippet cap for text-derived snippets. */
const MAX_SNIPPET_CHARS = 500;
/** Settings namespace carrying this provider's configuration. */
const SETTINGS_NAMESPACE = settingsNamespace("web-search-zhipu");
/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError";
}

/** Throw the seam's stable cancellation error when the caller is already aborted. */
function throwIfAborted(signal) {
	if (signal?.aborted === true) {
		throw new WebError("Zhipu search aborted", "WEB_ABORTED", { cause: signal.reason });
	}
}

/**
 * Resolve the API key: literal config first, then the environment variable.
 * `undefined` means the provider reports itself unavailable.
 */
function resolveApiKey(options) {
	if (options.apiKey != null && options.apiKey.length > 0) return options.apiKey;
	const fromEnv = process.env[options.apiKeyEnv];
	if (fromEnv != null && fromEnv.length > 0) return fromEnv;
	return undefined;
}

/** An `AbortSignal.timeout`-alike combined with the caller's signal, if any. */
function timeoutSignal(ms, external) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	const abort = () => controller.abort(external?.reason);
	if (external !== undefined) {
		if (external.aborted) {
			clearTimeout(timer);
			controller.abort(external.reason);
		} else {
			external.addEventListener("abort", abort, { once: true });
		}
	}
	return {
		signal: controller.signal,
		done: () => {
			clearTimeout(timer);
			if (external !== undefined) external.removeEventListener("abort", abort);
		},
	};
}

/**
 * Parse one `text/event-stream` response body into its first `data:`
 * JSON payload, falling back to plain JSON. Returns `null` when neither parses.
 */
function parseSsePayload(text) {
	const dataLines = text.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).replace(/^\s/, ""));
	if (dataLines.length > 0) {
		try {
			return JSON.parse(dataLines.join("\n"));
		} catch {
			return null;
		}
	}
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Extract a human-readable message from a JSON-RPC error payload, best effort. */
function rpcErrorMessage(payload) {
	const error = payload?.error;
	if (error == null) return null;
	const message = error.message ?? error.data;
	if (message === undefined) return null;
	return typeof message === "string" ? message : JSON.stringify(message);
}

/**
 * Map one Zhipu search result (as returned by web_search_prime) to a
 * normalized source, or `undefined` when it has no portable snippet.
 * The payload arrives double-encoded: content[0].text is a JSON string of
 * an array of `{ title, link, content, refer, ... }` rows.
 */
function mapZhipuRow(row) {
	const url = typeof row.link === "string" && row.link.length > 0 ? row.link : undefined;
	if (url === undefined) return undefined;
	const snippet = typeof row.content === "string" && row.content.trim().length > 0
		? row.content.trim().slice(0, MAX_SNIPPET_CHARS)
		: undefined;
	if (snippet === undefined) return undefined;
	return {
		url,
		...typeof row.title === "string" && row.title.length > 0 ? { title: row.title } : {},
		snippet,
	};
}

/** Decode the result array out of a successful `tools/call`. */
function decodeResultRows(payload) {
	const content = payload?.result?.content;
	if (!Array.isArray(content)) return null;
	const joined = content
		.map((item) => (typeof item?.text === "string" ? item.text : ""))
		.filter((text) => text.length > 0)
		.join("\n");
	if (joined.length === 0) return null;
	// Primary shape: content[0].text is a JSON-encoded string of the array
	// (double-encoded), i.e. '"[{...}]"'. Unwrap string layers until an array.
	let current = joined;
	for (let depth = 0; depth < 3 && !Array.isArray(current); depth += 1) {
		try {
			current = JSON.parse(current);
		} catch {
			return null;
		}
	}
	return Array.isArray(current) ? current : null;
}

// ── Provider ────────────────────────────────────────────────────────────────

/**
 * Project one resolved configuration section into the options the provider
 * serves its next search with. Called per operation so live Settings edits
 * take effect on the next search.
 */
function resolveOptions(section) {
	return {
		providerId: section.providerId ?? DEFAULT_PROVIDER_ID,
		apiKey: section.apiKey ?? "",
		apiKeyEnv: section.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
		count: section.count ?? DEFAULT_COUNT,
		toolArguments: section.toolArguments ?? {},
	};
}

class ZhipuSearchProvider {
	resolveOptions;
	id;
	#session; // { url, apiKey, id } — cached MCP session for reuse

	/**
	 * @param resolveOptions - thunk returning the options for the NEXT
	 * operation, snapshotted once at each operation's entry so one search
	 * never mixes two settings sections (same pattern as the official
	 * DeepSeek provider).
	 */
	constructor(resolveOptions) {
		this.resolveOptions = resolveOptions;
		this.id = resolveOptions().providerId ?? DEFAULT_PROVIDER_ID;
	}

	/** Usable only with a key and a parseable endpoint — no anonymous mode. */
	available() {
		const options = this.resolveOptions();
		return resolveApiKey(options) !== undefined;
	}

	async search(request, signal) {
		throwIfAborted(signal);
		const options = this.resolveOptions();
		const apiKey = resolveApiKey(options);
		if (apiKey === undefined) {
			throw new WebError(
				`Zhipu provider has no API key (configure one, or set ${options.apiKeyEnv})`,
				"WEB_PROVIDER_CREDENTIAL_MISSING",
			);
		}
		return await this.#mcpSearch(request, apiKey, options, signal);
	}

	/** POST one JSON-RPC message; returns `{ payload, sessionId }` (header, when sent). */
	async #rpc(message, apiKey, options, sessionId, signal) {
		const { signal: inner, done } = timeoutSignal(REQUEST_TIMEOUT_MS, signal);
		let response;
		try {
			response = await fetch(MCP_URL, {
				method: "POST",
				redirect: "error",
				headers: {
					"authorization": `Bearer ${apiKey}`,
					"content-type": "application/json",
					"accept": "application/json, text/event-stream",
					...(sessionId !== undefined ? { "mcp-session-id": sessionId } : {}),
				},
				body: JSON.stringify(message),
				signal: inner,
			});
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw new WebError("Zhipu search aborted", "WEB_ABORTED", { cause: signal?.reason ?? error });
			throw new WebError(`Zhipu MCP request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		} finally {
			done();
		}
		const newSessionId = response.headers.get("mcp-session-id") ?? undefined;
		const text = await response.text();
		if (!response.ok) {
			throw new WebError(`Zhipu MCP error (HTTP ${response.status})`, "WEB_PROVIDER_ERROR");
		}
		// Notifications (no message id) legitimately get an empty body back.
		const payload = text.length === 0 && message.id === undefined ? {} : parseSsePayload(text);
		if (payload === null) {
			throw new WebError("Zhipu MCP returned an unprocessable response body", "WEB_PROVIDER_ERROR");
		}
		return { payload, newSessionId };
	}

	/** Full MCP handshake: initialize → (session id) → notifications/initialized. */
	async #handshake(apiKey, options, signal) {
		const init = await this.#rpc({
			jsonrpc: "2.0",
			id: this.#nextId(),
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "dsh-web-search-zhipu", version: "0.1.0" },
			},
		}, apiKey, options, undefined, signal);
		if (init.payload.error != null) {
			throw new WebError(`Zhipu MCP initialize failed: ${rpcErrorMessage(init.payload) ?? "unknown error"}`, "WEB_PROVIDER_ERROR");
		}
		const id = init.newSessionId;
		if (id === undefined) {
			throw new WebError("Zhipu MCP did not return a session id", "WEB_PROVIDER_ERROR");
		}
		const ready = await this.#rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, apiKey, options, id, signal);
		if (ready.payload.error != null) {
			throw new WebError(`Zhipu MCP initialized notification failed: ${rpcErrorMessage(ready.payload) ?? "unknown error"}`, "WEB_PROVIDER_ERROR");
		}
		return id;
	}

	#nextIdCounter = 0;
	#nextId() {
		this.#nextIdCounter += 1;
		return this.#nextIdCounter;
	}

	async #mcpSearch(request, apiKey, options, signal) {
		throwIfAborted(signal);
		const count = request.maxResults ?? options.count;
		// Base arguments (query/count) first so user toolArguments can override them.
		const args = { search_query: request.query, ...count !== undefined ? { count } : {}, ...options.toolArguments };

		const attempt = async (sessionId) => {
			this.#nextIdCounter += 1;
			const { payload } = await this.#rpc({
				jsonrpc: "2.0",
				id: this.#nextIdCounter,
				method: "tools/call",
				params: { name: TOOL, arguments: args },
			}, apiKey, options, sessionId, signal);
			return payload;
		};

		// Session reuse: cached when endpoint+key unchanged, else re-handshake.
		let session = this.#session;
		if (session !== undefined && session.apiKey !== apiKey) {
			session = undefined;
		}
		let payload;
		if (session !== undefined) {
			payload = await attempt(session.id);
			// Server dropped the session (restart/expire): re-handshake once.
			if (payload.error != null && payload.error.code === -401) {
				session = undefined;
				payload = undefined;
			}
		}
		if (session === undefined) {
			const id = await this.#handshake(apiKey, options, signal);
			this.#session = { apiKey, id };
			payload = await attempt(id);
		}
		if (payload.error != null) {
			const message = rpcErrorMessage(payload);
			// A second -401 here means the fresh session was rejected too.
			throw new WebError(`Zhipu MCP error${message !== null ? `: ${message}` : ""}`, "WEB_PROVIDER_ERROR");
		}
		if (payload.result?.isError === true) {
			const detail = (Array.isArray(payload.result.content)
				? payload.result.content.map((item) => (typeof item?.text === "string" ? item.text : "")).join("\n").trim()
				: "");
			throw new WebError(`Zhipu MCP tool error${detail.length > 0 ? `: ${detail}` : ""}`, "WEB_PROVIDER_ERROR");
		}
		const rows = decodeResultRows(payload);
		if (rows === null) {
			throw new WebError("Zhipu MCP returned no parseable results", "WEB_PROVIDER_ERROR");
		}
		const sources = rows.map(mapZhipuRow).filter((source) => source !== undefined);
		return { sources, truncated: false };
	}
}

// ── Cordis plugin wiring ────────────────────────────────────────────────────

/** Cordis plugin name used by loader diagnostics. */
const name = "web-search-zhipu";
/** The web seam this provider registers into. */
const inject = ["web"];

const Config = z.object({
	/**
	 * Provider id registered into `ctx.web`. Defaults to `zhipu`. Change it
	 * only when multiple Zhipu-shaped providers coexist in one profile — the
	 * seam rejects duplicate ids with `WEB_DUPLICATE_PROVIDER`.
	 */
	providerId: z.string().default(DEFAULT_PROVIDER_ID),
	/** Literal Zhipu API key; required unless `apiKeyEnv` is set in the environment. */
	apiKey: z.string().role("secret"),
	/** Environment variable consulted when no literal `apiKey` is configured. */
	apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
	/** Default result count when the request carries no `maxResults`. */
	count: z.number().step(1).min(1).default(DEFAULT_COUNT),
	/**
	 * Extra MCP tool arguments merged over the base `{ search_query, count }`
	 * (user-owned escape hatch for endpoint-specific filters, e.g.
	 * `search_domain_filter` / `recency_filter`); user keys win.
	 */
	toolArguments: z.object({}),
});

/**
 * Register the Zhipu search provider with `ctx.web` and install its Settings
 * section, so the Web panel edits the same config the provider serves.
 */
function apply(ctx, config) {
	let current = () => config;
	installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, config, {
		setSource: (source) => {
			current = source;
		},
		onChange: () => {},
	});
	ctx.web.registerSearchProvider(new ZhipuSearchProvider(() => resolveOptions(current())));
}

export {
	Config,
	DEFAULT_API_KEY_ENV,
	DEFAULT_COUNT,
	DEFAULT_PROVIDER_ID,
	MAX_SNIPPET_CHARS,
	SETTINGS_NAMESPACE,
	ZhipuSearchProvider,
	apply,
	inject,
	name,
};
