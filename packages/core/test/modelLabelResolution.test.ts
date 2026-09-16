import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { AgentRegistry } from '../src/agents/AgentRegistry.js';
import type { Agent, AgentConfig } from '../src/agents/types.js';
import { resolveLlmLabel } from '../src/config/modelAliases.js';
import { db } from '../src/db/connection.js';

after(async () => {
    await db.destroy();
});

function createClaudeAgent(alias: string): Agent {
    const config: AgentConfig = {
        id: `claude-${alias}`,
        type: 'claude',
        alias,
        enabled: true,
        dockerImage: 'propr/agent:latest',
        configPath: '~/.claude',
        supportedModels: ['claude-sonnet-5'],
        defaultModel: 'claude-sonnet-5',
    };
    return { config } as Agent;
}

test('account-specific Claude model labels keep the account alias out of the provider model ID', async (t) => {
    const registry = AgentRegistry.getInstance() as unknown as {
        initialized: boolean;
        agents: Map<string, Agent>;
        agentsByAlias: Map<string, Agent>;
        defaultAgentAlias: string | null;
        ensureInitialized(): Promise<void>;
    };
    const defaultClaude = createClaudeAgent('claude');
    const first = createClaudeAgent('claude-vholowiski');
    const second = createClaudeAgent('claude-second');

    const previous = {
        initialized: registry.initialized,
        agents: registry.agents,
        agentsByAlias: registry.agentsByAlias,
        defaultAgentAlias: registry.defaultAgentAlias,
    };
    t.mock.method(registry, 'ensureInitialized', async () => undefined);
    registry.initialized = true;
    registry.agents = new Map([[defaultClaude.config.id, defaultClaude], [first.config.id, first], [second.config.id, second]]);
    registry.agentsByAlias = new Map([[defaultClaude.config.alias, defaultClaude], [first.config.alias, first], [second.config.alias, second]]);
    registry.defaultAgentAlias = defaultClaude.config.alias;

    try {
        assert.deepEqual(await resolveLlmLabel('claude-vholowiski-sonnet5'), {
            agentAlias: 'claude-vholowiski',
            model: 'claude-sonnet-5',
        });
        assert.deepEqual(await resolveLlmLabel('claude-second-sonnet5'), {
            agentAlias: 'claude-second',
            model: 'claude-sonnet-5',
        });
    } finally {
        registry.initialized = previous.initialized;
        registry.agents = previous.agents;
        registry.agentsByAlias = previous.agentsByAlias;
        registry.defaultAgentAlias = previous.defaultAgentAlias;
    }
});
