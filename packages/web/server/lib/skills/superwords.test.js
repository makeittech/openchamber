import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseSuperwords, getSkillForSuperword, injectSuperwordSkill } from './superwords.js';

describe('parseSuperwords', () => {
  it('returns null for empty message', () => {
    assert.strictEqual(parseSuperwords('', { '/plan': 'planning' }), null);
    assert.strictEqual(parseSuperwords('   ', { '/plan': 'planning' }), null);
    assert.strictEqual(parseSuperwords(null, { '/plan': 'planning' }), null);
    assert.strictEqual(parseSuperwords(undefined, { '/plan': 'planning' }), null);
  });

  it('returns null for empty or invalid config', () => {
    assert.strictEqual(parseSuperwords('/plan this', {}), null);
    assert.strictEqual(parseSuperwords('/plan this', null), null);
    assert.strictEqual(parseSuperwords('/plan this', undefined), null);
  });

  it('matches trigger at start of message', () => {
    const config = { '/plan': 'planning', '@debug': 'debugging' };
    const result = parseSuperwords('/plan this task', config);
    
    assert.ok(result);
    assert.strictEqual(result.trigger, '/plan');
    assert.strictEqual(result.skillId, 'planning');
    assert.strictEqual(result.remainingMessage, 'this task');
  });

  it('does not match trigger in middle of message', () => {
    const config = { '/plan': 'planning' };
    const result = parseSuperwords('Let me /plan this', config);
    
    assert.strictEqual(result, null);
  });

  it('handles trigger with no remaining message', () => {
    const config = { '/plan': 'planning' };
    const result = parseSuperwords('/plan', config);
    
    assert.ok(result);
    assert.strictEqual(result.trigger, '/plan');
    assert.strictEqual(result.skillId, 'planning');
    assert.strictEqual(result.remainingMessage, '');
  });

  it('handles leading whitespace', () => {
    const config = { '/plan': 'planning' };
    const result = parseSuperwords('   /plan this', config);
    
    assert.ok(result);
    assert.strictEqual(result.trigger, '/plan');
    assert.strictEqual(result.remainingMessage, 'this');
  });

  it('matches longer triggers first', () => {
    const config = { '/plan': 'planning', '/plan-mode': 'plan-mode' };
    const result = parseSuperwords('/plan-mode advanced', config);
    
    assert.ok(result);
    assert.strictEqual(result.trigger, '/plan-mode');
    assert.strictEqual(result.skillId, 'plan-mode');
    assert.strictEqual(result.remainingMessage, 'advanced');
  });

  it('does not match partial trigger', () => {
    const config = { '/plan': 'planning' };
    const result = parseSuperwords('/planning this', config);
    
    assert.strictEqual(result, null);
  });

  it('requires whitespace or end after trigger', () => {
    const config = { '/plan': 'planning' };
    
    // Should match - trigger followed by space
    assert.ok(parseSuperwords('/plan task', config));
    
    // Should match - trigger at end
    assert.ok(parseSuperwords('/plan', config));
    
    // Should not match - trigger followed by non-whitespace
    assert.strictEqual(parseSuperwords('/planning', config), null);
  });

  it('handles @ triggers', () => {
    const config = { '@debug': 'debugging' };
    const result = parseSuperwords('@debug the issue', config);
    
    assert.ok(result);
    assert.strictEqual(result.trigger, '@debug');
    assert.strictEqual(result.skillId, 'debugging');
    assert.strictEqual(result.remainingMessage, 'the issue');
  });

  it('ignores invalid skillId in config', () => {
    const config = { '/plan': '', '@debug': null, '/test': '  ' };
    
    assert.strictEqual(parseSuperwords('/plan this', config), null);
    assert.strictEqual(parseSuperwords('@debug this', config), null);
    assert.strictEqual(parseSuperwords('/test this', config), null);
  });

  it('preserves multiple spaces in remaining message', () => {
    const config = { '/plan': 'planning' };
    const result = parseSuperwords('/plan  this   task', config);
    
    assert.ok(result);
    assert.strictEqual(result.remainingMessage, 'this   task');
  });
});

describe('getSkillForSuperword', () => {
  it('returns skillId for valid trigger', () => {
    const config = { '/plan': 'planning', '@debug': 'debugging' };
    
    assert.strictEqual(getSkillForSuperword('/plan', config), 'planning');
    assert.strictEqual(getSkillForSuperword('@debug', config), 'debugging');
  });

  it('returns null for missing trigger', () => {
    const config = { '/plan': 'planning' };
    
    assert.strictEqual(getSkillForSuperword('/missing', config), null);
  });

  it('handles null/undefined inputs', () => {
    const config = { '/plan': 'planning' };
    
    assert.strictEqual(getSkillForSuperword(null, config), null);
    assert.strictEqual(getSkillForSuperword(undefined, config), null);
    assert.strictEqual(getSkillForSuperword('/plan', null), null);
    assert.strictEqual(getSkillForSuperword('/plan', undefined), null);
  });

  it('normalizes trigger whitespace', () => {
    const config = { '/plan': 'planning' };
    
    assert.strictEqual(getSkillForSuperword('  /plan  ', config), 'planning');
  });

  it('returns null for invalid skillId', () => {
    const config = { '/plan': '', '@debug': null };
    
    assert.strictEqual(getSkillForSuperword('/plan', config), null);
    assert.strictEqual(getSkillForSuperword('@debug', config), null);
  });
});

describe('injectSuperwordSkill', () => {
  it('injects skill context into request body', () => {
    const body = { role: 'user', content: '/plan this task' };
    const result = injectSuperwordSkill(body, 'planning', 'this task');
    
    assert.ok(result._superword);
    assert.strictEqual(result._superword.skillId, 'planning');
    assert.strictEqual(result._superword.activated, true);
    assert.strictEqual(result.message, 'this task');
  });

  it('does not mutate original body', () => {
    const body = { role: 'user', content: '/plan task' };
    const result = injectSuperwordSkill(body, 'planning', 'task');
    
    assert.ok(!body._superword);
    assert.ok(result._superword);
  });

  it('returns original body for invalid inputs', () => {
    const body = { role: 'user', content: 'test' };
    
    assert.strictEqual(injectSuperwordSkill(body, '', 'test'), body);
    assert.strictEqual(injectSuperwordSkill(body, null, 'test'), body);
    assert.strictEqual(injectSuperwordSkill(null, 'planning', 'test'), null);
  });

  it('handles missing remainingMessage', () => {
    const body = { role: 'user', content: '/plan' };
    const result = injectSuperwordSkill(body, 'planning');
    
    assert.strictEqual(result._superword.skillId, 'planning');
    assert.strictEqual(result.message, undefined);
    assert.strictEqual(result.content, '/plan');
  });

  it('updates message field when remainingMessage provided', () => {
    const body = { role: 'user', content: '/plan this' };
    const result = injectSuperwordSkill(body, 'planning', 'this');
    
    assert.strictEqual(result.message, 'this');
  });

  it('preserves other body fields', () => {
    const body = { role: 'user', content: '/plan', sessionId: '123', model: 'gpt-4' };
    const result = injectSuperwordSkill(body, 'planning', '');
    
    assert.strictEqual(result.role, 'user');
    assert.strictEqual(result.sessionId, '123');
    assert.strictEqual(result.model, 'gpt-4');
    assert.strictEqual(result.content, '/plan');
  });
});
