import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeRepoConfig, preserveRepoDeployment } from '../routes/configRepoValidation.js';

test('repository config defaults missing automatic failed-CI follow-up to false', () => {
  const normalized = normalizeRepoConfig({
    id: 'repo-1',
    name: 'integry/propr',
    enabled: true
  });

  assert.equal(normalized.ok, true);
  if (normalized.ok) {
    assert.equal(normalized.value.autoFollowupOnFailedCi, false);
    assert.deepEqual(normalized.value.visualPreview, { enabled: false, types: ['image'] });
  }
});

test('repository deployment config is retained and validates the explicit workflow and production branch', () => {
  const normalized = normalizeRepoConfig({
    id: 'repo-wordrush',
    name: 'nrdgrrrl/WordRush',
    enabled: true,
    deployment: {
      enabled: true,
      workflow: 'deploy-production.yml',
      productionBranch: 'master',
      commitInput: 'commit',
      modeInput: 'mode',
      deployValue: 'deploy',
      dryRunValue: 'dry-run'
    }
  });
  assert.equal(normalized.ok, true);
  if (normalized.ok) assert.deepEqual(normalized.value.deployment, {
    enabled: true, workflow: 'deploy-production.yml', productionBranch: 'master',
    commitInput: 'commit', modeInput: 'mode', deployValue: 'deploy', dryRunValue: 'dry-run'
  });
});

test('repository deployment config rejects paths and missing workflow inputs', () => {
  for (const deployment of [
    { enabled: true, workflow: '../workflow.yml', productionBranch: 'master', commitInput: 'commit', modeInput: 'mode', deployValue: 'deploy', dryRunValue: 'dry-run' },
    { enabled: true, workflow: 'deploy.yml', productionBranch: 'master', commitInput: '', modeInput: 'mode', deployValue: 'deploy', dryRunValue: 'dry-run' }
  ]) {
    const normalized = normalizeRepoConfig({ id: 'repo-1', name: 'nrdgrrrl/WordRush', enabled: true, deployment });
    assert.equal(normalized.ok, false);
  }
});

test('repository updates preserve existing deployment settings when unrelated clients omit them', () => {
  const deployment = {
    enabled: true, workflow: 'deploy-production.yml', productionBranch: 'master',
    commitInput: 'commit', modeInput: 'mode', deployValue: 'deploy', dryRunValue: 'dry-run'
  };
  const previous = [{ id: 'repo-wordrush', name: 'nrdgrrrl/WordRush', enabled: true, deployment }];
  const incoming = [{ id: 'repo-wordrush', name: 'nrdgrrrl/WordRush', enabled: true }];
  const normalized = [normalizeRepoConfig(incoming[0])];
  assert.equal(normalized[0].ok, true);
  if (normalized[0].ok) {
    assert.deepEqual(preserveRepoDeployment(previous as never, [normalized[0].value], incoming)[0].deployment, deployment);
  }
});

test('repository config accepts visual preview types and trims instructions', () => {
  const normalized = normalizeRepoConfig({
    id: 'repo-1',
    name: 'integry/propr',
    enabled: true,
    visualPreview: {
      enabled: true,
      types: ['video', 'image', 'video'],
      instructions: '  Capture desktop and mobile views.  '
    }
  });

  assert.equal(normalized.ok, true);
  if (normalized.ok) {
    assert.deepEqual(normalized.value.visualPreview, {
      enabled: true,
      types: ['video', 'image'],
      instructions: 'Capture desktop and mobile views.'
    });
  }
});

test('repository config defaults omitted visual preview types', () => {
  const normalized = normalizeRepoConfig({
    id: 'repo-1',
    name: 'integry/propr',
    enabled: true,
    visualPreview: { enabled: false }
  });

  assert.equal(normalized.ok, true);
  if (normalized.ok) {
    assert.deepEqual(normalized.value.visualPreview, { enabled: false, types: ['image'] });
  }
});

test('repository config rejects invalid visual preview settings', () => {
  const invalidValues = [
    { enabled: 'true', types: ['image'] },
    { enabled: true, types: [] },
    { enabled: true, types: ['animation'] },
    { enabled: true, types: ['image'], instructions: 42 }
  ];

  for (const visualPreview of invalidValues) {
    const normalized = normalizeRepoConfig({
      id: 'repo-1',
      name: 'integry/propr',
      enabled: true,
      visualPreview
    });
    assert.equal(normalized.ok, false);
    if (!normalized.ok) assert.match(normalized.error, /visualPreview/);
  }
});

test('repository config accepts explicit automatic failed-CI follow-up booleans', () => {
  for (const autoFollowupOnFailedCi of [true, false]) {
    const normalized = normalizeRepoConfig({
      id: `repo-${autoFollowupOnFailedCi}`,
      name: 'integry/propr',
      enabled: true,
      autoFollowupOnFailedCi
    });

    assert.equal(normalized.ok, true);
    if (normalized.ok) {
      assert.equal(normalized.value.autoFollowupOnFailedCi, autoFollowupOnFailedCi);
    }
  }
});

test('repository config rejects non-boolean automatic failed-CI follow-up values', () => {
  for (const autoFollowupOnFailedCi of ['true', 1, null, {}]) {
    const normalized = normalizeRepoConfig({
      id: 'repo-1',
      name: 'integry/propr',
      enabled: true,
      autoFollowupOnFailedCi
    });

    assert.equal(normalized.ok, false);
    if (!normalized.ok) {
      assert.match(normalized.error, /autoFollowupOnFailedCi.*must be a boolean/);
    }
  }
});

test('validates attachment override and ignores client-supplied effective capacity', () => {
  for (const plan of ['auto', 'free', 'paid']) {
    const result = normalizeRepoConfig({ id: 'repo-1', name: 'integry/propr', enabled: true, visualPreview: { enabled: true, types: ['video'], githubAttachmentPlan: plan, githubAttachmentCapacity: { effectivePlan: 'paid' } } });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.visualPreview?.githubAttachmentPlan, plan);
      assert.equal(result.value.visualPreview?.githubAttachmentCapacity, undefined);
    }
  }
  for (const plan of ['invalid', '', null, true, 100]) {
    const result = normalizeRepoConfig({ id: 'repo-1', name: 'integry/propr', enabled: true, visualPreview: { enabled: true, types: ['video'], githubAttachmentPlan: plan } });
    assert.equal(result.ok, false);
  }
});
