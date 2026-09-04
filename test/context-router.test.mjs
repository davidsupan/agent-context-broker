import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { loadContextProfiles, routeContextProfile } from '../src/context-router.mjs';

describe('context profile router', () => {
  test('loads the bounded profile catalog and honors an explicit profile', () => {
    const profiles = loadContextProfiles();
    const result = routeContextProfile({ profiles, profileId: 'review' });

    assert.equal(Object.keys(profiles).length, 7);
    assert.equal(result.shouldQuery, true);
    assert.equal(result.profile.id, 'review');
    assert.equal(result.reason, 'explicit-profile');
  });

  test('routes recognized task kinds without inspecting prompt text', () => {
    const result = routeContextProfile({ taskKind: 'build', projectScope: true });

    assert.equal(result.profile.id, 'build');
    assert.equal(result.reason, 'task-kind');
  });

  test('uses the bounded custom profile only for an explicit project scope', () => {
    const project = routeContextProfile({ projectScope: true });
    const unrelated = routeContextProfile({ projectScope: false });

    assert.equal(project.profile.id, 'custom-project');
    assert.equal(project.shouldQuery, true);
    assert.equal(unrelated.profile, null);
    assert.equal(unrelated.shouldQuery, false);
  });

  test('strict isolation overrides every profile and blocks querying', () => {
    const result = routeContextProfile({
      strictIsolation: true,
      profileId: 'implementation',
      taskKind: 'review',
      projectScope: true
    });

    assert.equal(result.profile.id, 'strict-isolation');
    assert.equal(result.shouldQuery, false);
    assert.equal(result.reason, 'strict-isolation-requested');
  });
});
