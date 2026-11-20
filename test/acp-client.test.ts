import { describe, it, expect } from "vitest";
import { AcpClient } from "../src/acp/acp-client";
import type AgentClientPlugin from "../src/plugin";
import { buildPromptInjectionInstructions } from "../src/utils/prompt-injection";

const allOn = { enabled: true, latex: true, wikiLinks: true, tables: true };
const [WIKI, TABLES, LATEX] = buildPromptInjectionInstructions(allOn);

/**
 * An AcpClient connected to a stand-in for the agent, which records the
 * requests and answers session/new and session/fork with a new session id.
 */
function connectedClient(options: {
	takesSystemPrompt: boolean;
	promptInjection?: typeof allOn;
}) {
	const settings = {
		promptInjection: options.promptInjection ?? allOn,
		windowsWslMode: false,
		autoAllowPermissions: false,
	};
	const client = new AcpClient({ settings } as unknown as AgentClientPlugin);
	const requests: Array<{ method: string; params: Record<string, unknown> }> =
		[];
	const connection = {
		agent: {
			request: (method: string, params: Record<string, unknown>) => {
				requests.push({ method, params });
				const sessionId =
					method === "session/new"
						? "new"
						: method === "session/fork"
							? "forked"
							: undefined;
				return Promise.resolve(sessionId ? { sessionId } : {});
			},
		},
	};
	// Stand in for initialize(), which spawns the agent
	const connect = (agentId = "claude") =>
		Object.assign(client, {
			connection,
			isInitializedFlag: true,
			currentAgentId: agentId,
			takesSystemPrompt: options.takesSystemPrompt,
		});
	connect();
	const systemPrompt = (method: string) =>
		requests.find((r) => r.method === method)?.params.systemPrompt;
	return { client, settings, systemPrompt, connect };
}

const appended = (...instructions: string[]) => ({
	mode: "append",
	content: instructions.map((text) => ({ type: "text", text })),
});

describe("AcpClient systemPrompt", () => {
	it("starts a session with the instructions turned on, and records them", async () => {
		const { client, systemPrompt } = connectedClient({
			takesSystemPrompt: true,
			promptInjection: { ...allOn, latex: false },
		});
		await client.newSession("/vault");
		expect(systemPrompt("session/new")).toEqual(appended(WIKI, TABLES));
		expect(client.getSessionPromptInjection("new")).toEqual([WIKI, TABLES]);
	});

	it("sends none to an agent that takes no system prompt, or with none turned on", async () => {
		for (const options of [
			{ takesSystemPrompt: false },
			{
				takesSystemPrompt: true,
				promptInjection: { ...allOn, enabled: false },
			},
		]) {
			const { client, systemPrompt } = connectedClient(options);
			await client.newSession("/vault");
			expect(systemPrompt("session/new")).toBeUndefined();
			expect(client.getSessionPromptInjection("new")).toEqual([]);
		}
	});

	it("restores a session with the instructions it was saved with, not the current settings", async () => {
		const { client, systemPrompt } = connectedClient({
			takesSystemPrompt: true,
		});
		await client.loadSession("a", "/vault", [WIKI]);
		await client.resumeSession("b", "/vault", [TABLES]);
		expect(systemPrompt("session/load")).toEqual(appended(WIKI));
		expect(systemPrompt("session/resume")).toEqual(appended(TABLES));
		expect(client.getSessionPromptInjection("a")).toEqual([WIKI]);
		expect(client.getSessionPromptInjection("b")).toEqual([TABLES]);
	});

	it("restores a session saved without instructions with none", async () => {
		const { client, systemPrompt } = connectedClient({
			takesSystemPrompt: true,
		});
		await client.loadSession("old", "/vault");
		expect(systemPrompt("session/load")).toBeUndefined();
		expect(client.getSessionPromptInjection("old")).toEqual([]);
	});

	it("ignores saved instructions that are not a list", async () => {
		const { client, systemPrompt } = connectedClient({
			takesSystemPrompt: true,
		});
		await client.loadSession(
			"bad",
			"/vault",
			"wiki" as unknown as string[],
		);
		expect(systemPrompt("session/load")).toBeUndefined();
	});

	it("keeps what a session got across a disconnect, for a turn that ends after it", async () => {
		const { client, connect, systemPrompt } = connectedClient({
			takesSystemPrompt: true,
		});
		await client.newSession("/vault");
		await client.disconnect();
		expect(client.getSessionPromptInjection("new")).toEqual([
			WIKI,
			TABLES,
			LATEX,
		]);
		// and for restoring it, not saved yet, once the agent is back
		connect();
		await client.resumeSession("new", "/vault");
		expect(systemPrompt("session/resume")).toEqual(
			appended(WIKI, TABLES, LATEX),
		);
	});

	it("does not give what a session got to another agent's session with the same id", async () => {
		const { client, connect, systemPrompt } = connectedClient({
			takesSystemPrompt: true,
		});
		await client.newSession("/vault");
		await client.disconnect();
		connect("custom");
		await client.loadSession("new", "/vault");
		expect(systemPrompt("session/load")).toBeUndefined();
		expect(client.getSessionPromptInjection("new")).toEqual([]);
	});

	it("forks a session with the instructions of its source", async () => {
		const { client, settings, systemPrompt } = connectedClient({
			takesSystemPrompt: true,
		});
		await client.newSession("/vault");
		settings.promptInjection = { ...allOn, enabled: false };
		await client.forkSession("new", "/vault");
		expect(systemPrompt("session/fork")).toEqual(
			appended(WIKI, TABLES, LATEX),
		);
		expect(client.getSessionPromptInjection("forked")).toEqual([
			WIKI,
			TABLES,
			LATEX,
		]);
	});
});
