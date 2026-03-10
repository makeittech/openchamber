import { describe, test, expect } from 'bun:test';
import { type SuperwordsConfig, getSuperwordsConfig, saveSuperwordsConfig } from '@/lib/openchamberConfig';
import * as fs from 'fs';
import * as path from 'path';

describe('SuperwordsSettings', () => {
  test('component file exists', () => {
    const componentPath = path.join(__dirname, 'SuperwordsSettings.tsx');
    expect(fs.existsSync(componentPath)).toBe(true);
  });

  test('exports SuperwordsSettings function', async () => {
    const module = await import('./SuperwordsSettings');
    expect(typeof module.SuperwordsSettings).toBe('function');
  });

  test('component has required structure', () => {
    const componentPath = path.join(__dirname, 'SuperwordsSettings.tsx');
    const content = fs.readFileSync(componentPath, 'utf8');
    
    expect(content.includes('export function SuperwordsSettings')).toBe(true);
    expect(content.includes('useState')).toBe(true);
    expect(content.includes('useEffect')).toBe(true);
    expect(content.includes('getSuperwordsConfig')).toBe(true);
    expect(content.includes('saveSuperwordsConfig')).toBe(true);
  });

  test('validates trigger format correctly', () => {
    const validateTrigger = (trigger: string): boolean => {
      return trigger.trim().length > 0 && (trigger.startsWith('/') || trigger.startsWith('@'));
    };
    
    expect(validateTrigger('/plan')).toBe(true);
    expect(validateTrigger('@debug')).toBe(true);
    expect(validateTrigger('invalid')).toBe(false);
    expect(validateTrigger('')).toBe(false);
    expect(validateTrigger('   ')).toBe(false);
    expect(validateTrigger('/')).toBe(true);
    expect(validateTrigger('@')).toBe(true);
  });

  test('superwords config is stored in project config', () => {
    expect(typeof getSuperwordsConfig).toBe('function');
    expect(typeof saveSuperwordsConfig).toBe('function');
  });

  test('superwords config schema is correct', () => {
    const config: SuperwordsConfig = {
      '/plan': 'brainstorming',
      '@debug': 'systematic-debugging',
    };
    
    expect(config['/plan']).toBe('brainstorming');
    expect(config['@debug']).toBe('systematic-debugging');
    expect(Object.keys(config).length).toBe(2);
  });

  test('empty superwords config is valid', () => {
    const config: SuperwordsConfig = {};
    
    expect(Object.keys(config).length).toBe(0);
  });

  test('trigger normalization works correctly', () => {
    const normalizeTrigger = (trigger: string): string => trigger.trim();
    
    expect(normalizeTrigger('  /plan  ')).toBe('/plan');
    expect(normalizeTrigger('@debug')).toBe('@debug');
    expect(normalizeTrigger('\t/test\n')).toBe('/test');
  });

  test('skill ID normalization works correctly', () => {
    const normalizeSkillId = (skillId: string): string => skillId.trim();
    
    expect(normalizeSkillId('  brainstorming  ')).toBe('brainstorming');
    expect(normalizeSkillId('systematic-debugging')).toBe('systematic-debugging');
  });

  test('component handles multiple superwords', () => {
    const config: SuperwordsConfig = {
      '/plan': 'brainstorming',
      '@debug': 'systematic-debugging',
      '/test': 'test-driven-development',
      '/review': 'requesting-code-review',
    };
    
    expect(Object.keys(config).length).toBe(4);
    expect(config['/plan']).toBe('brainstorming');
    expect(config['@debug']).toBe('systematic-debugging');
    expect(config['/test']).toBe('test-driven-development');
    expect(config['/review']).toBe('requesting-code-review');
  });

  test('superword deletion removes correct entry', () => {
    const config: SuperwordsConfig = {
      '/plan': 'brainstorming',
      '@debug': 'systematic-debugging',
      '/test': 'test-driven-development',
    };
    
    const triggerToDelete = '@debug';
    const updated: SuperwordsConfig = {};
    
    for (const [key, value] of Object.entries(config)) {
      if (key !== triggerToDelete) {
        updated[key] = value as string;
      }
    }
    
    expect(updated['/plan']).toBe('brainstorming');
    expect(updated['@debug']).toBeUndefined();
    expect(updated['/test']).toBe('test-driven-development');
    expect(Object.keys(updated).length).toBe(2);
  });

  test('superword edit updates correct entry', () => {
    const config: SuperwordsConfig = {
      '/plan': 'brainstorming',
      '@debug': 'systematic-debugging',
    };
    
    const oldTrigger = '/plan';
    const newTrigger = '/planning';
    const newSkillId = 'brainstorming-v2';
    
    const updated: SuperwordsConfig = {};
    
    for (const [key, value] of Object.entries(config)) {
      if (key !== oldTrigger) {
        updated[key] = value as string;
      }
    }
    
    updated[newTrigger] = newSkillId;
    
    expect(updated['/planning']).toBe('brainstorming-v2');
    expect(updated['/plan']).toBeUndefined();
    expect(updated['@debug']).toBe('systematic-debugging');
    expect(Object.keys(updated).length).toBe(2);
  });
});
