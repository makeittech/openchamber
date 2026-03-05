import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Soul API Integration', () => {
  let tempDir;
  let originalCwd;
  let server;
  let baseUrl;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-api-test-'));
    originalCwd = process.cwd();
    
    // We'll test the loadSoulMd function directly since starting the server
    // for each test would be too heavy
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should load soul.md via loadSoulMd function', async () => {
    const { loadSoulMd } = await import('../opencode/soul.js');
    
    const soulContent = '# Test Soul\n\nTest content for API integration.';
    fs.writeFileSync(path.join(tempDir, 'soul.md'), soulContent);

    const result = loadSoulMd(tempDir);
    assert.ok(result !== null);
    assert.strictEqual(result.content, soulContent);
    assert.strictEqual(result.path, path.join(tempDir, 'soul.md'));
  });

  it('should return null when soul.md does not exist', async () => {
    const { loadSoulMd } = await import('../opencode/soul.js');
    
    const result = loadSoulMd(tempDir);
    assert.strictEqual(result, null);
  });

  it('should load soul.md from custom configured path', async () => {
    const { loadSoulMd, getSoulPath } = await import('../opencode/soul.js');
    
    const customPath = 'custom/my-soul.md';
    const soulContent = '# Custom Soul\n\nCustom path test.';
    const customDir = path.join(tempDir, 'custom');
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, customPath), soulContent);

    const config = {
      agents: {
        defaults: {
          soulPath: customPath
        }
      }
    };

    const configuredPath = getSoulPath(config);
    assert.strictEqual(configuredPath, customPath);

    const result = loadSoulMd(tempDir, config);
    assert.ok(result !== null);
    assert.strictEqual(result.content, soulContent);
  });

  it('should handle soul.md with markdown formatting', async () => {
    const { loadSoulMd } = await import('../opencode/soul.js');
    
    const soulContent = `# Agent Soul

## Core Values
- Value 1
- Value 2

## Instructions
Some detailed instructions here.

\`\`\`javascript
const example = "code";
\`\`\`
`;

    fs.writeFileSync(path.join(tempDir, 'soul.md'), soulContent);

    const result = loadSoulMd(tempDir);
    assert.ok(result !== null);
    assert.strictEqual(result.content, soulContent);
  });

  it('should handle large soul.md files', async () => {
    const { loadSoulMd } = await import('../opencode/soul.js');
    
    // Create a large soul.md file (100KB)
    const lines = [];
    for (let i = 0; i < 2000; i++) {
      lines.push(`Line ${i}: This is a test line with some content to make it larger.`);
    }
    const soulContent = lines.join('\n');
    
    fs.writeFileSync(path.join(tempDir, 'soul.md'), soulContent);

    const result = loadSoulMd(tempDir);
    assert.ok(result !== null);
    assert.strictEqual(result.content, soulContent);
    assert.ok(result.content.length > 90000); // Verify it's actually large
  });
});
