/**
 * Express route registration for /api/harness/*
 */

import express from 'express';
import { detectAllHarnesses, detectHarness } from './detect.js';
import { isKnownHarnessId } from './registry.js';
import {
  getSessionBinding,
  initSessionBindings,
} from './session-bindings.js';
import { createHarnessRouter } from './router.js';
import { pollLogin as pollCursorLogin, startLogin as startCursorLogin } from './translators/cursor/login.js';

/**
 * @param {import('express').Express} app
 * @param {object} [deps]
 * @param {() => ((payload: object, options?: object) => void) | null | undefined} [deps.getBroadcastGlobalUiEvent]
 * @param {boolean | (() => boolean)} [deps.getOpenCodeReady]
 * @param {ReturnType<typeof createHarnessRouter>} [deps.router]
 * @param {typeof detectAllHarnesses} [deps.detectAll]
 * @param {typeof detectHarness} [deps.detectOne]
 * @param {Parameters<typeof initSessionBindings>[0]} [deps.sessionBindings]
 * @param {boolean} [deps.initBindings]
 */
export function registerHarnessRoutes(app, deps = {}) {
  const getBroadcast = typeof deps.getBroadcastGlobalUiEvent === 'function'
    ? deps.getBroadcastGlobalUiEvent
    : () => null;
  const getOpenCodeReady = () => {
    if (typeof deps.getOpenCodeReady === 'function') return deps.getOpenCodeReady() !== false;
    if (typeof deps.getOpenCodeReady === 'boolean') return deps.getOpenCodeReady;
    return true;
  };
  const detectAll = deps.detectAll || detectAllHarnesses;
  const detectOne = deps.detectOne || detectHarness;
  const router = deps.router || createHarnessRouter({ getBroadcast });

  if (deps.initBindings !== false) {
    initSessionBindings(deps.sessionBindings);
  }

  const json = express.json({ limit: '50mb' });

  const sendError = (res, error) => {
    const statusCode = Number(error?.statusCode) || 500;
    if (statusCode >= 500) {
      console.error('[harness]', error?.code || 'HARNESS_ERROR', error?.message || error);
    }
    res.status(statusCode).json({
      error: error?.message || 'Harness request failed',
      code: error?.code || 'HARNESS_ERROR',
      ...(error?.status ? { status: error.status } : {}),
    });
  };

  app.get('/api/harness', async (_req, res) => {
    try {
      const engines = await detectAll({ openCodeReady: getOpenCodeReady() });
      res.json({ engines });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/harness/sessions/:sessionId', (req, res) => {
    const binding = getSessionBinding(req.params.sessionId);
    if (!binding) {
      return res.status(404).json({ error: 'Session binding not found', code: 'BINDING_NOT_FOUND' });
    }
    res.json({ binding });
  });

  // Cursor OAuth login (PKCE). Never returns verifier/tokens.
  app.post('/api/harness/cursor/login/start', json, async (_req, res) => {
    try {
      const result = await startCursorLogin();
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/harness/cursor/login/poll', json, async (req, res) => {
    try {
      const loginId = typeof req.body?.loginId === 'string' ? req.body.loginId : '';
      const result = await pollCursorLogin(loginId);
      // Never include tokens/verifiers — login.js already sanitizes.
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/harness/:id', async (req, res) => {
    const id = req.params.id;
    if (!isKnownHarnessId(id)) {
      return res.status(404).json({ error: 'Unknown harness', code: 'HARNESS_NOT_FOUND' });
    }
    try {
      const engine = await detectOne(id, { openCodeReady: getOpenCodeReady() });
      if (!engine) {
        return res.status(404).json({ error: 'Unknown harness', code: 'HARNESS_NOT_FOUND' });
      }
      res.json(engine);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/harness/:id/detect', async (req, res) => {
    const id = req.params.id;
    if (!isKnownHarnessId(id)) {
      return res.status(404).json({ error: 'Unknown harness', code: 'HARNESS_NOT_FOUND' });
    }
    try {
      const engine = await detectOne(id, { openCodeReady: getOpenCodeReady() });
      if (!engine) {
        return res.status(404).json({ error: 'Unknown harness', code: 'HARNESS_NOT_FOUND' });
      }
      // Detect failure must not look like ready+empty success — status field is authoritative.
      res.json(engine);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/harness/prompt', json, async (req, res) => {
    try {
      const result = await router.prompt(req.body || {});
      res.status(202).json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/harness/abort', json, async (req, res) => {
    try {
      const result = await router.abort(req.body || {});
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/harness/permission/reply', json, async (req, res) => {
    try {
      if (typeof router.replyPermission !== 'function') {
        const error = new Error('Permission reply is unavailable');
        error.code = 'PERMISSION_UNAVAILABLE';
        error.statusCode = 503;
        throw error;
      }
      const result = await router.replyPermission(req.body || {});
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });
}
