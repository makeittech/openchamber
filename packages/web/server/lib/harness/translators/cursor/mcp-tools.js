/**
 * OpenChamber MCP tool definitions + decode/execute for Cursor Agent Run.
 * Tool schemas follow OpenCode-ish shapes; providerIdentifier is "openchamber".
 */

import { create, fromBinary, fromJson, toBinary, toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { McpToolDefinitionSchema } from './proto/agent_pb.js';

const PROVIDER_ID = 'openchamber';

/**
 * @param {string} name
 * @param {string} description
 * @param {Record<string, unknown>} jsonSchema
 */
function defineTool(name, description, jsonSchema) {
  const inputSchema = toBinary(ValueSchema, fromJson(ValueSchema, /** @type {any} */ (jsonSchema)));
  return create(McpToolDefinitionSchema, {
    name,
    description,
    providerIdentifier: PROVIDER_ID,
    toolName: name,
    inputSchema,
  });
}

/**
 * Build OpenCode-compatible MCP tool definitions injected into RequestContext.
 *
 * @returns {import('./proto/agent_pb.js').McpToolDefinition[]}
 */
export function buildOpenChamberMcpTools() {
  return [
    defineTool(
      'bash',
      'Run a shell command in the session workspace. Use this MCP tool for all shell/terminal work — never use native Cursor shell tools.',
      {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          working_directory: {
            type: 'string',
            description: 'Optional working directory relative to or under the session workspace root',
          },
        },
        required: ['command'],
      },
    ),
    defineTool(
      'read',
      'Read a text file under the session workspace. Use this MCP tool for all file reads — never use native Cursor read tools.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to or under the workspace root' },
          offset: { type: 'number', description: '1-based line offset to start reading from' },
          limit: { type: 'number', description: 'Maximum number of lines to return' },
        },
        required: ['path'],
      },
    ),
    defineTool(
      'write',
      'Write or create a text file under the session workspace. Use this MCP tool for all file writes — never use native Cursor write tools.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to or under the workspace root' },
          content: { type: 'string', description: 'Full file contents to write' },
        },
        required: ['path', 'content'],
      },
    ),
    defineTool(
      'edit',
      'Replace an exact string in a file under the session workspace. old_string must match exactly once. Use this MCP tool instead of native Cursor edit/write tools.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to or under the workspace root' },
          old_string: { type: 'string', description: 'Exact text to find (must match once)' },
          new_string: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    ),
    defineTool(
      'delete',
      'Delete a file under the session workspace. Use this MCP tool instead of native Cursor delete tools.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to or under the workspace root' },
        },
        required: ['path'],
      },
    ),
    defineTool(
      'list',
      'List files and directories under a path in the session workspace. Use this MCP tool instead of native Cursor ls tools.',
      {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Directory path relative to or under the workspace root (defaults to root)',
          },
        },
        required: [],
      },
    ),
    defineTool(
      'glob',
      'Find files by glob pattern under the session workspace. Use this MCP tool for file discovery.',
      {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern (supports * and **)' },
          path: {
            type: 'string',
            description: 'Optional subdirectory to search under (relative to workspace root)',
          },
        },
        required: ['pattern'],
      },
    ),
    defineTool(
      'grep',
      'Search file contents with a regex pattern under the session workspace. Use this MCP tool instead of native Cursor grep tools.',
      {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression pattern' },
          path: {
            type: 'string',
            description: 'Optional file or directory to search under',
          },
          glob: {
            type: 'string',
            description: 'Optional filename glob filter (e.g. "*.js")',
          },
          case_insensitive: {
            type: 'boolean',
            description: 'Case-insensitive search when true',
          },
        },
        required: ['pattern'],
      },
    ),
  ];
}

/**
 * Decode a Cursor MCP arg value (protobuf Value bytes) to a JS value.
 *
 * @param {Uint8Array} value
 * @returns {unknown}
 */
export function decodeMcpArgValue(value) {
  try {
    const parsed = fromBinary(ValueSchema, value);
    return toJson(ValueSchema, parsed);
  } catch {
    try {
      return new TextDecoder().decode(value);
    } catch {
      return null;
    }
  }
}

/**
 * Decode a map of MCP arg values.
 *
 * @param {Record<string, Uint8Array> | Map<string, Uint8Array> | undefined | null} args
 * @returns {Record<string, unknown>}
 */
export function decodeMcpArgsMap(args) {
  /** @type {Record<string, unknown>} */
  const decoded = {};
  if (!args) return decoded;
  const entries = args instanceof Map ? args.entries() : Object.entries(args);
  for (const [key, value] of entries) {
    if (value instanceof Uint8Array) {
      decoded[key] = decodeMcpArgValue(value);
    } else if (value && typeof value === 'object' && value.buffer instanceof ArrayBuffer) {
      decoded[key] = decodeMcpArgValue(new Uint8Array(value));
    } else {
      decoded[key] = value;
    }
  }
  return decoded;
}

/**
 * Normalize tool name aliases (shell→bash, ls→list).
 *
 * @param {string} toolName
 * @returns {string}
 */
export function normalizeMcpToolName(toolName) {
  const name = typeof toolName === 'string' ? toolName.trim().toLowerCase() : '';
  if (name === 'shell') return 'bash';
  if (name === 'ls') return 'list';
  return name;
}

/**
 * Execute an OpenChamber MCP tool against a hostTools instance.
 *
 * @param {string} toolName
 * @param {Record<string, unknown>} decodedArgs
 * @param {{
 *   bash: Function,
 *   read: Function,
 *   write: Function,
 *   edit: Function,
 *   delete: Function,
 *   list: Function,
 *   glob: Function,
 *   grep: Function,
 * }} hostTools
 * @returns {Promise<{ ok: boolean, text: string }>}
 */
export async function executeMcpTool(toolName, decodedArgs, hostTools) {
  const name = normalizeMcpToolName(toolName);
  const args = decodedArgs && typeof decodedArgs === 'object' ? decodedArgs : {};

  if (!hostTools || typeof hostTools !== 'object') {
    return { ok: false, text: 'Host tools are not available' };
  }

  /** @type {{ ok: boolean, output: string, error?: string } | undefined} */
  let result;
  try {
    switch (name) {
      case 'bash':
        result = await hostTools.bash(args);
        break;
      case 'read':
        result = await hostTools.read(args);
        break;
      case 'write':
        result = await hostTools.write(args);
        break;
      case 'edit':
        result = await hostTools.edit(args);
        break;
      case 'delete':
        result = await hostTools.delete(args);
        break;
      case 'list':
        result = await hostTools.list(args);
        break;
      case 'glob':
        result = await hostTools.glob(args);
        break;
      case 'grep':
        result = await hostTools.grep(args);
        break;
      default:
        return { ok: false, text: `Unknown MCP tool: ${toolName || '(missing)'}` };
    }
  } catch (error) {
    return {
      ok: false,
      text: error instanceof Error ? error.message : 'Tool execution failed',
    };
  }

  if (!result) {
    return { ok: false, text: 'Tool returned no result' };
  }
  if (result.ok) {
    return { ok: true, text: typeof result.output === 'string' ? result.output : '' };
  }
  const errText = typeof result.error === 'string' && result.error
    ? result.error
    : (typeof result.output === 'string' ? result.output : 'Tool failed');
  return { ok: false, text: errText };
}
