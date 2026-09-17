import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { AgentRegistry } from '../src/agents/AgentRegistry.js';
import type { Agent, AgentConfig } from '../src/agents/types.js';
import { resolveLlmLabel } from '../src/config/modelAliases.js';
import { db } from '../src/db/connection.js';

after(async () => {
    await db.destroy();
});

function createCodexAgent(alias: string): Agent {
    const config: AgentConfig = {
        id: `codex-${alias}`,
        type: 'codex',
        alias,
        enabled: true,
        dockerImage: 'propr/agent:latest',
        configPath: `~/.propr/agent-credentials/codex-${alias}/.codex`,
        supportedModels: ['gpt-5.6-sol'],
        defaultModel: 'gpt-5.6-sol',
    };
    return { config } as Agent;
}

test('same-provider Codex aliases resolve independently to physical model IDs', async (t) => {
    const registry = AgentRegistry.getInstance() as unknown as {
        initialized: boolean;
        agents: Map<string, Agent>;
        agentsByAlias: Map<string, Agent>;
        defaultAgentAlias: string | null;
        ensureInitialized(): Promise<void>;
    };
    const primary = createCodexAgent('codex-primary');
    const secondary = createCodexAgent('codex-secondary');

    const previous = {
        initialized: registry.initialized,
        agents: registry.agents,
        agentsByAlias: registry.agentsByAlias,
        defaultAgentAlias: registry.defaultAgentAlias,
    };
    t.mock.method(registry, 'ensureInitialized', async () => undefined);
    registry.initialized = true;
    registry.agents = new Map([
        [primary.config.id, primary],
        [secondary.config.id, secondary],
    ]);
    registry.agentsByAlias = new Map([
        [primary.config.alias, primary],
        [secondary.config.alias, secondary],
    ]);
    registry.defaultAgentAlias = primary.config.alias;

    try {
        assert.deepEqual(await resolveLlmLabel('codex-primary-gpt56-sol'), {
            agentAlias: 'codex-primary',
            model: 'gpt-5.6-sol',
        });
        assert.deepEqual(await resolveLlmLabel('codex-secondary-gpt56-sol'), {
            agentAlias: 'codex-secondary',
            model: 'gpt-5.6-sol',
        });
        assert.deepEqual(await resolveLlmLabel('codex-secondary:gpt-5.6-sol'), {
            agentAlias: 'codex-secondary',
            model: 'gpt-5.6-sol',
        });
    } finally {
        registry.initialized = previous.initialized;
        registry.agents = previous.agents;
        registry.agentsByAlias = previous.agentsByAlias;
        registry.defaultAgentAlias = previous.defaultAgentAlias;
    }
});
