/**
 * Minimal Cursor Agent Run client (HTTP/2 via h2-bridge child process).
 * Extracted from opencode-cursor proxy — no Bun.serve / OpenAI façade.
 *
 * Never log access tokens or Authorization material.
 */

import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  AgentClientMessageSchema,
  AgentRunRequestSchema,
  AgentServerMessageSchema,
  ClientHeartbeatSchema,
  ConversationActionSchema,
  ConversationStateStructureSchema,
  CursorRuleSchema,
  CursorRuleTypeGlobalSchema,
  CursorRuleTypeSchema,
  DeleteRejectedSchema,
  DeleteResultSchema,
  DiagnosticsResultSchema,
  ExecClientMessageSchema,
  FetchErrorSchema,
  FetchResultSchema,
  GetBlobResultSchema,
  GrepErrorSchema,
  GrepResultSchema,
  KvClientMessageSchema,
  LsRejectedSchema,
  LsResultSchema,
  McpErrorSchema,
  McpResultSchema,
  ModelDetailsSchema,
  ReadRejectedSchema,
  ReadResultSchema,
  RequestContextResultSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
  RequestedModelSchema,
  RequestedModel_ModelParameterbytesSchema,
  SetBlobResultSchema,
  ShellRejectedSchema,
  ShellResultSchema,
  UserMessageActionSchema,
  UserMessageSchema,
  WriteRejectedSchema,
  WriteResultSchema,
} from './proto/agent_pb.js';
import { literalCursorModelSelection } from './model-selection.js';

const CURSOR_API_URL = process.env.CURSOR_API_URL ?? 'https://api2.cursor.sh';
const CONNECT_END_STREAM_FLAG = 0b00000010;
const AGENT_RUN_PATH = '/agent.v1.AgentService/Run';
const HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_UNARY_TIMEOUT_MS = 5_000;

const HERE = typeof import.meta.dirname === 'string'
  ? import.meta.dirname
  : (typeof import.meta.dir === 'string'
    ? import.meta.dir
    : dirname(fileURLToPath(import.meta.url)));
const BRIDGE_PATH = pathResolve(HERE, 'h2-bridge.mjs');

const REJECT_REASON = 'Native Cursor tools are not available in OpenChamber. Use host tools instead.';

/**
 * @param {Uint8Array} data
 * @returns {Buffer}
 */
function lpEncode(data) {
  const buf = Buffer.alloc(4 + data.length);
  buf.writeUInt32BE(data.length, 0);
  buf.set(data, 4);
  return buf;
}

/**
 * Connect protocol frame: [1-byte flags][4-byte BE length][payload]
 * @param {Uint8Array} data
 * @param {number} [flags]
 * @returns {Buffer}
 */
export function frameConnectMessage(data, flags = 0) {
  const frame = Buffer.alloc(5 + data.length);
  frame[0] = flags;
  frame.writeUInt32BE(data.length, 1);
  frame.set(data, 5);
  return frame;
}

/**
 * @param {{
 *   accessToken: string,
 *   rpcPath: string,
 *   url?: string,
 *   unary?: boolean,
 *   contentType?: 'application/proto' | 'application/json',
 *   connectProtocolVersion?: '1',
 * }} options
 */
export function spawnBridge(options) {
  const proc = Bun.spawn(['node', BRIDGE_PATH], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });

  const config = JSON.stringify({
    accessToken: options.accessToken,
    url: options.url ?? CURSOR_API_URL,
    path: options.rpcPath,
    unary: options.unary ?? false,
    contentType: options.contentType,
    connectProtocolVersion: options.connectProtocolVersion,
  });
  proc.stdin.write(lpEncode(new TextEncoder().encode(config)));

  /** @type {{ data: ((chunk: Buffer) => void) | null, close: ((code: number) => void) | null }} */
  const cbs = { data: null, close: null };
  let exited = false;
  let exitCode = 1;

  void (async () => {
    const reader = proc.stdout.getReader();
    let pending = Buffer.alloc(0);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending = Buffer.concat([pending, Buffer.from(value)]);
        while (pending.length >= 4) {
          const len = pending.readUInt32BE(0);
          if (pending.length < 4 + len) break;
          const payload = pending.subarray(4, 4 + len);
          pending = pending.subarray(4 + len);
          cbs.data?.(Buffer.from(payload));
        }
      }
    } catch {
      // stream ended
    }
    const code = (await proc.exited) ?? 1;
    exited = true;
    exitCode = code;
    cbs.close?.(code);
  })();

  return {
    proc,
    get alive() {
      return !exited;
    },
    /** @param {Uint8Array} data */
    write(data) {
      try {
        proc.stdin.write(lpEncode(data));
      } catch {
        // ignore
      }
    },
    end() {
      try {
        proc.stdin.write(lpEncode(new Uint8Array(0)));
        proc.stdin.end();
      } catch {
        // ignore
      }
    },
    kill() {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    },
    /** @param {(chunk: Buffer) => void} cb */
    onData(cb) {
      cbs.data = cb;
    },
    /** @param {(code: number) => void} cb */
    onClose(cb) {
      if (exited) queueMicrotask(() => cb(exitCode));
      else cbs.close = cb;
    },
  };
}

/**
 * @param {{
 *   accessToken: string,
 *   rpcPath: string,
 *   requestBody: Uint8Array,
 *   url?: string,
 *   timeoutMs?: number,
 *   contentType?: 'application/proto' | 'application/json',
 *   connectProtocolVersion?: '1',
 * }} options
 * @returns {Promise<{ body: Uint8Array, exitCode: number, timedOut: boolean }>}
 */
export async function callCursorUnaryRpc(options) {
  const bridge = spawnBridge({
    accessToken: options.accessToken,
    rpcPath: options.rpcPath,
    url: options.url,
    unary: true,
    contentType: options.contentType,
    connectProtocolVersion: options.connectProtocolVersion,
  });

  const chunks = [];
  let timedOut = false;
  const timeoutMs = options.timeoutMs ?? DEFAULT_UNARY_TIMEOUT_MS;
  const timeout = timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true;
      try {
        bridge.proc.kill();
      } catch {
        // ignore
      }
    }, timeoutMs)
    : undefined;

  const promise = new Promise((resolve) => {
    bridge.onData((chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    bridge.onClose((exitCode) => {
      if (timeout) clearTimeout(timeout);
      resolve({
        body: Buffer.concat(chunks),
        exitCode,
        timedOut,
      });
    });
  });

  bridge.write(options.requestBody);
  bridge.end();
  return promise;
}

/**
 * @param {(bytes: Uint8Array) => void} onMessage
 * @param {(bytes: Uint8Array) => void} onEndStream
 * @returns {(incoming: Buffer) => void}
 */
export function createConnectFrameParser(onMessage, onEndStream) {
  let pending = Buffer.alloc(0);
  return (incoming) => {
    pending = Buffer.concat([pending, incoming]);
    while (pending.length >= 5) {
      const flags = pending[0];
      const msgLen = pending.readUInt32BE(1);
      if (pending.length < 5 + msgLen) break;
      const messageBytes = pending.subarray(5, 5 + msgLen);
      pending = pending.subarray(5 + msgLen);
      if (flags & CONNECT_END_STREAM_FLAG) onEndStream(messageBytes);
      else onMessage(messageBytes);
    }
  };
}

/**
 * @param {Uint8Array} data
 * @returns {Error | null}
 */
export function parseConnectEndStream(data) {
  try {
    const payload = JSON.parse(new TextDecoder().decode(data));
    const error = payload?.error;
    if (error) {
      const code = error.code ?? 'unknown';
      const message = error.message ?? 'Unknown error';
      return new Error(`Connect error ${code}: ${message}`);
    }
    return null;
  } catch {
    return new Error('Failed to parse Connect end stream');
  }
}

function makeHeartbeatBytes() {
  const heartbeat = create(AgentClientMessageSchema, {
    message: {
      case: 'clientHeartbeat',
      value: create(ClientHeartbeatSchema, {}),
    },
  });
  return frameConnectMessage(toBinary(AgentClientMessageSchema, heartbeat));
}

/**
 * Build a simplified AgentClientMessage runRequest.
 *
 * @param {{
 *   text: string,
 *   cwd?: string,
 *   modelSelection?: { publicId: string, modelId: string, displayName: string, parameters: Array<{ id: string, value: string }>, maxMode: boolean },
 *   conversationId?: string,
 *   conversationState?: Uint8Array | null,
 * }} options
 */
export function buildCursorRequest(options) {
  const text = typeof options.text === 'string' ? options.text : '';
  const cwd = typeof options.cwd === 'string' ? options.cwd.trim() : '';
  const selection = options.modelSelection && typeof options.modelSelection === 'object'
    ? options.modelSelection
    : literalCursorModelSelection('composer-1.5');
  const conversationId = typeof options.conversationId === 'string' && options.conversationId
    ? options.conversationId
    : randomUUID();

  /** @type {Map<string, Uint8Array>} */
  const blobStore = new Map();

  const systemPrompt = cwd
    ? `You are a coding agent in OpenChamber. Workspace root: ${cwd}. Prefer absolute paths under that root.`
    : 'You are a coding agent in OpenChamber.';
  const systemBytes = new TextEncoder().encode(JSON.stringify({
    role: 'system',
    content: systemPrompt,
  }));
  const systemBlobId = createHash('sha256').update(systemBytes).digest();
  blobStore.set(Buffer.from(systemBlobId).toString('hex'), systemBytes);

  let conversationState;
  if (options.conversationState && options.conversationState.length > 0) {
    conversationState = fromBinary(
      ConversationStateStructureSchema,
      options.conversationState,
    );
  } else {
    conversationState = create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: [systemBlobId],
      turns: [],
      todos: [],
      pendingToolCalls: [],
      previousWorkspaceUris: [],
      fileStates: {},
      fileStatesV2: {},
      summaryArchives: [],
      turnTimings: [],
      subagentStates: {},
      selfSummaryCount: 0,
      readPaths: [],
    });
  }

  const userMessage = create(UserMessageSchema, {
    text,
    messageId: randomUUID(),
  });
  const userMsgBytes = toBinary(UserMessageSchema, userMessage);
  blobStore.set(Buffer.from(userMsgBytes).toString('hex'), userMsgBytes);

  const action = create(ConversationActionSchema, {
    action: {
      case: 'userMessageAction',
      value: create(UserMessageActionSchema, { userMessage }),
    },
  });

  const modelDetails = create(ModelDetailsSchema, {
    modelId: selection.publicId,
    displayModelId: selection.publicId,
    displayName: selection.displayName,
    maxMode: selection.maxMode,
  });
  const requestedModel = create(RequestedModelSchema, {
    modelId: selection.modelId,
    maxMode: selection.maxMode,
    parameters: (selection.parameters || []).map((parameter) =>
      create(RequestedModel_ModelParameterbytesSchema, parameter)),
  });

  const runRequest = create(AgentRunRequestSchema, {
    conversationState,
    action,
    modelDetails,
    requestedModel,
    conversationId,
  });

  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: 'runRequest', value: runRequest },
  });

  return {
    requestBytes: toBinary(AgentClientMessageSchema, clientMessage),
    blobStore,
    conversationId,
  };
}

/**
 * @param {any} kvMsg
 * @param {string} messageCase
 * @param {unknown} value
 * @param {(data: Uint8Array) => void} sendFrame
 */
function sendKvResponse(kvMsg, messageCase, value, sendFrame) {
  const response = create(KvClientMessageSchema, {
    id: kvMsg.id,
    message: { case: messageCase, value },
  });
  const clientMsg = create(AgentClientMessageSchema, {
    message: { case: 'kvClientMessage', value: response },
  });
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMsg)));
}

/**
 * @param {any} execMsg
 * @param {string} messageCase
 * @param {unknown} value
 * @param {(data: Uint8Array) => void} sendFrame
 */
function sendExecResult(execMsg, messageCase, value, sendFrame) {
  const execClientMessage = create(ExecClientMessageSchema, {
    id: execMsg.id,
    execId: execMsg.execId,
    message: { case: messageCase, value },
  });
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: 'execClientMessage', value: execClientMessage },
  });
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
}

/**
 * @param {any} kvMsg
 * @param {Map<string, Uint8Array>} blobStore
 * @param {(data: Uint8Array) => void} sendFrame
 */
function handleKvMessage(kvMsg, blobStore, sendFrame) {
  const kvCase = kvMsg.message.case;
  if (kvCase === 'getBlobArgs') {
    const blobId = kvMsg.message.value.blobId;
    const blobIdKey = Buffer.from(blobId).toString('hex');
    const blobData = blobStore.get(blobIdKey);
    sendKvResponse(
      kvMsg,
      'getBlobResult',
      create(GetBlobResultSchema, blobData ? { blobData } : {}),
      sendFrame,
    );
  } else if (kvCase === 'setBlobArgs') {
    const { blobId, blobData } = kvMsg.message.value;
    blobStore.set(Buffer.from(blobId).toString('hex'), blobData);
    sendKvResponse(kvMsg, 'setBlobResult', create(SetBlobResultSchema, {}), sendFrame);
  }
}

/**
 * MVP: reject native tool exec; answer requestContext with a no-native-tools rule.
 *
 * @param {any} execMsg
 * @param {(data: Uint8Array) => void} sendFrame
 * @param {string} [cwd]
 * @param {(event: object) => void} [onEvent]
 */
function handleExecMessage(execMsg, sendFrame, cwd, onEvent) {
  const execCase = execMsg.message.case;

  if (execCase === 'requestContextArgs') {
    const workspaceNote = cwd
      ? ` The project workspace root is "${cwd}".`
      : '';
    const rule = `CRITICAL: Do NOT use native Cursor tools (read, ls, grep, shell, write, delete, fetch). They are disabled in OpenChamber.${workspaceNote}`;
    const requestContext = create(RequestContextSchema, {
      rules: [
        create(CursorRuleSchema, {
          fullPath: '.cursorrules',
          content: rule,
          type: create(CursorRuleTypeSchema, {
            type: { case: 'global', value: create(CursorRuleTypeGlobalSchema, {}) },
          }),
          source: 0,
        }),
      ],
      repositoryInfo: [],
      tools: [],
      gitRepos: [],
      projectLayouts: [],
      mcpInstructions: [],
      fileContents: {},
      customSubagents: [],
    });
    const result = create(RequestContextResultSchema, {
      result: {
        case: 'success',
        value: create(RequestContextSuccessSchema, { requestContext }),
      },
    });
    sendExecResult(execMsg, 'requestContextResult', result, sendFrame);
    return;
  }

  if (execCase === 'mcpArgs') {
    const toolName = execMsg.message.value?.toolName || execMsg.message.value?.name || 'tool';
    onEvent?.({
      type: 'tool-call',
      toolName,
      rejected: true,
      message: REJECT_REASON,
    });
    sendExecResult(execMsg, 'mcpResult', create(McpResultSchema, {
      result: {
        case: 'error',
        value: create(McpErrorSchema, { error: REJECT_REASON }),
      },
    }), sendFrame);
    return;
  }

  if (execCase === 'readArgs') {
    const args = execMsg.message.value;
    sendExecResult(execMsg, 'readResult', create(ReadResultSchema, {
      result: { case: 'rejected', value: create(ReadRejectedSchema, { path: args.path, reason: REJECT_REASON }) },
    }), sendFrame);
    return;
  }
  if (execCase === 'lsArgs') {
    const args = execMsg.message.value;
    sendExecResult(execMsg, 'lsResult', create(LsResultSchema, {
      result: { case: 'rejected', value: create(LsRejectedSchema, { path: args.path, reason: REJECT_REASON }) },
    }), sendFrame);
    return;
  }
  if (execCase === 'grepArgs') {
    sendExecResult(execMsg, 'grepResult', create(GrepResultSchema, {
      result: { case: 'error', value: create(GrepErrorSchema, { error: REJECT_REASON }) },
    }), sendFrame);
    return;
  }
  if (execCase === 'writeArgs') {
    const args = execMsg.message.value;
    sendExecResult(execMsg, 'writeResult', create(WriteResultSchema, {
      result: { case: 'rejected', value: create(WriteRejectedSchema, { path: args.path, reason: REJECT_REASON }) },
    }), sendFrame);
    return;
  }
  if (execCase === 'deleteArgs') {
    const args = execMsg.message.value;
    sendExecResult(execMsg, 'deleteResult', create(DeleteResultSchema, {
      result: { case: 'rejected', value: create(DeleteRejectedSchema, { path: args.path, reason: REJECT_REASON }) },
    }), sendFrame);
    return;
  }
  if (execCase === 'shellArgs' || execCase === 'shellStreamArgs') {
    const args = execMsg.message.value;
    sendExecResult(execMsg, 'shellResult', create(ShellResultSchema, {
      result: {
        case: 'rejected',
        value: create(ShellRejectedSchema, {
          command: args.command ?? '',
          workingDirectory: args.workingDirectory ?? '',
          reason: REJECT_REASON,
          isReadonly: false,
        }),
      },
    }), sendFrame);
    return;
  }
  if (execCase === 'fetchArgs') {
    const args = execMsg.message.value;
    sendExecResult(execMsg, 'fetchResult', create(FetchResultSchema, {
      result: { case: 'error', value: create(FetchErrorSchema, { url: args.url ?? '', error: REJECT_REASON }) },
    }), sendFrame);
    return;
  }
  if (execCase === 'diagnosticsArgs') {
    sendExecResult(execMsg, 'diagnosticsResult', create(DiagnosticsResultSchema, {}), sendFrame);
  }
}

/**
 * @param {any} msg
 * @param {Map<string, Uint8Array>} blobStore
 * @param {(data: Uint8Array) => void} sendFrame
 * @param {(event: object) => void} onEvent
 * @param {string} [cwd]
 */
function processServerMessage(msg, blobStore, sendFrame, onEvent, cwd) {
  const msgCase = msg.message.case;

  if (msgCase === 'interactionUpdate') {
    const update = msg.message.value;
    const updateCase = update.message?.case;
    if (updateCase === 'textDelta') {
      const delta = update.message.value.text || '';
      if (delta) onEvent({ type: 'text-delta', text: delta });
    } else if (updateCase === 'thinkingDelta') {
      const delta = update.message.value.text || '';
      if (delta) onEvent({ type: 'thinking-delta', text: delta });
    }
    return;
  }

  if (msgCase === 'kvServerMessage') {
    handleKvMessage(msg.message.value, blobStore, sendFrame);
    return;
  }

  if (msgCase === 'execServerMessage') {
    handleExecMessage(msg.message.value, sendFrame, cwd, onEvent);
    return;
  }

  if (msgCase === 'conversationCheckpointUpdate') {
    const stateStructure = msg.message.value;
    onEvent({
      type: 'checkpoint',
      bytes: toBinary(ConversationStateStructureSchema, stateStructure),
    });
  }
}

/**
 * Run one Cursor agent turn. Streams events via onEvent.
 *
 * @param {{
 *   accessToken: string,
 *   text: string,
 *   cwd?: string,
 *   modelSelection?: object,
 *   conversationId?: string,
 *   conversationState?: Uint8Array | null,
 *   onEvent?: (event: object) => void,
 *   abortSignal?: AbortSignal,
 * }} options
 * @returns {Promise<{ conversationId: string, checkpoint: Uint8Array | null }>}
 */
export async function runCursorAgentTurn(options) {
  const accessToken = typeof options.accessToken === 'string' ? options.accessToken : '';
  if (!accessToken) {
    const error = new Error('Cursor access token is required');
    error.code = 'CURSOR_AUTH_MISSING';
    throw error;
  }

  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  const payload = buildCursorRequest({
    text: options.text,
    cwd: options.cwd,
    modelSelection: options.modelSelection,
    conversationId: options.conversationId,
    conversationState: options.conversationState,
  });

  const bridge = spawnBridge({
    accessToken,
    rpcPath: AGENT_RUN_PATH,
    url: CURSOR_API_URL,
  });

  /** @type {Uint8Array | null} */
  let lastCheckpoint = null;
  let settled = false;
  let heartbeatTimer;

  const finish = (error) => {
    if (settled) return;
    settled = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    try {
      bridge.kill();
    } catch {
      // ignore
    }
    if (error) {
      onEvent({ type: 'error', error: error instanceof Error ? error.message : String(error) });
    }
    onEvent({ type: 'done' });
  };

  const abortHandler = () => {
    finish(new Error('Aborted'));
  };
  if (options.abortSignal) {
    if (options.abortSignal.aborted) {
      finish(new Error('Aborted'));
      return {
        conversationId: payload.conversationId,
        checkpoint: null,
      };
    }
    options.abortSignal.addEventListener('abort', abortHandler, { once: true });
  }

  await new Promise((resolve) => {
    const sendFrame = (data) => bridge.write(data);

    bridge.onData(createConnectFrameParser(
      (messageBytes) => {
        try {
          const serverMessage = fromBinary(AgentServerMessageSchema, messageBytes);
          processServerMessage(
            serverMessage,
            payload.blobStore,
            sendFrame,
            (event) => {
              if (event.type === 'checkpoint' && event.bytes) {
                lastCheckpoint = event.bytes;
              }
              onEvent(event);
            },
            options.cwd,
          );
        } catch {
          // ignore unparseable frames
        }
      },
      (endStreamBytes) => {
        const err = parseConnectEndStream(endStreamBytes);
        if (err) finish(err);
        else finish();
        resolve(undefined);
      },
    ));

    bridge.onClose(() => {
      if (!settled) finish();
      resolve(undefined);
    });

    bridge.write(frameConnectMessage(payload.requestBytes));
    heartbeatTimer = setInterval(() => {
      if (!settled && bridge.alive) {
        bridge.write(makeHeartbeatBytes());
      }
    }, HEARTBEAT_INTERVAL_MS);
  });

  options.abortSignal?.removeEventListener('abort', abortHandler);

  return {
    conversationId: payload.conversationId,
    checkpoint: lastCheckpoint,
  };
}
