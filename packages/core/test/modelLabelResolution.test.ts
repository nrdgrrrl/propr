import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { AgentRegistry } from '../src/agents/AgentRegistry.js';
import type { Agent, AgentConfig } from '../src/agents/types.js';
import { resolveLlmLabel } from '../src/config/modelAliases.js';
import { db } from '../src/db/connection.js';

after(async () => {
    await db.destroy();
});

function createAgent(config: AgentConfig): Agent {
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
    const defaultClaude = createAgent({
        id: 'claude-claude', type: 'claude', alias: 'claude', enabled: true,
        dockerImage: 'propr/agent:latest', configPath: '~/.claude',
        supportedModels: ['claude-sonnet-5'], defaultModel: 'claude-sonnet-5',
    });
    const first = createAgent({
        id: 'claude-claude-vholowiski', type: 'claude', alias: 'claude-vholowiski', enabled: true,
        dockerImage: 'propr/agent:latest', configPath: '~/.claude',
        supportedModels: ['claude-sonnet-5'], defaultModel: 'claude-sonnet-5',
    });
    const second = createAgent({
        id: 'claude-claude-second', type: 'claude', alias: 'claude-second', enabled: true,
        dockerImage: 'propr/agent:latest', configPath: '~/.claude',
        supportedModels: ['claude-sonnet-5'], defaultModel: 'claude-sonnet-5',
    });

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

test('same-provider Codex aliases resolve independently to physical model IDs', async (t) => {
    const registry = AgentRegistry.getInstance() as unknown as {
        initialized: boolean;
        agents: Map<string, Agent>;
        agentsByAlias: Map<string, Agent>;
        defaultAgentAlias: string | null;
        ensureInitialized(): Promise<void>;
    };
    const primary = createAgent({
        id: 'codex-codex-primary', type: 'codex', alias: 'codex-primary', enabled: true,
        dockerImage: 'propr/agent:latest', configPath: '~/.propr/agent-credentials/codex-primary/.codex',
        supportedModels: ['gpt-5.6-sol'], defaultModel: 'gpt-5.6-sol',
    });
    const secondary = createAgent({
        id: 'codex-codex-secondary', type: 'codex', alias: 'codex-secondary', enabled: true,
        dockerImage: 'propr/agent:latest', configPath: '~/.propr/agent-credentials/codex-secondary/.codex',
        supportedModels: ['gpt-5.6-sol'], defaultModel: 'gpt-5.6-sol',
    });

    const previous = {
        initialized: registry.initialized,
        agents: registry.agents,
        agentsByAlias: registry.agentsByAlias,
        defaultAgentAlias: registry.defaultAgentAlias,
    };
    t.mock.method(registry, 'ensureInitialized', async () => undefined);
    registry.initialized = true;
    registry.agents = new Map([[primary.config.id, primary], [secondary.config.id, secondary]]);
    registry.agentsByAlias = new Map([[primary.config.alias, primary], [secondary.config.alias, secondary]]);
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
