// lib/swarm/install.js
// ------------------------------------------------------------------
// Self-contained install for the 7-agent swarm into the host main.js
// process. The host calls install({ ipcMain, BrowserWindow, sidecarCall })
// exactly once on startup and never touches the swarm again — except
// through the IPC channels this module registers:
//
//   orchestrator:dispatch       - 1 payload + Critic retry loop
//   orchestrator:dispatchChain  - JSONL parser + dependency order
//   swarm:event                 - broadcast to every webContents
//
// All bubble-up errors are caught and translated to {ok:false,error}
// so a single failing handler never crashes main.js.
// ------------------------------------------------------------------

'use strict';

const { SwarmRouter, EVENT_CHANNEL } = require('./router');
const { buildRegistry } = require('./handlers');

function install(deps) {
  if (!deps || typeof deps !== 'object') throw new Error('swarm.install called without deps');
  const { ipcMain, BrowserWindow, sidecarCall, getConfig, setConfig, onConfigChange } = deps;
  if (typeof ipcMain !== 'object' || typeof ipcMain.handle !== 'function') {
    throw new Error('swarm.install: ipcMain is required');
  }
  if (typeof BrowserWindow !== 'function') {
    throw new Error('swarm.install: BrowserWindow is required');
  }
  if (typeof sidecarCall !== 'function') {
    throw new Error('swarm.install: sidecarCall is required');
  }
  if (typeof getConfig !== 'function') {
    throw new Error('swarm.install: getConfig is required so the swarm renderer can read swarmShowOrbs');
  }

  // Closure over the existing sidecarCall(/uia_run) so the Executor
  // sub-agent can forward UIA intents into the running sidecar process.
  async function executorInvoke(d) {
    try {
      const r = await sidecarCall('/uia_run', { intent: d.action, params: d.data || {} });
      if (r && r.ok === true) return { ok: true, result: r.result != null ? r.result : r };
      return { ok: false, error: (r && (r.error || r.reason)) || 'uia_failed' };
    } catch (e) {
      return { ok: false, error: 'sidecar_threw: ' + (e && e.message ? e.message : String(e)) };
    }
  }

  function broadcast(ev) {
    try {
      BrowserWindow.getAllWindows().forEach(function (w) {
        if (w && !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed()) {
          try { w.webContents.send(EVENT_CHANNEL, ev); } catch (_e) {}
        }
      });
    } catch (_e) { /* renderer gone */ }
  }

  const router = new SwarmRouter({
    registry: buildRegistry({ executorInvoke: executorInvoke }),
    emitter: broadcast,
  });

  ipcMain.handle('orchestrator:dispatch', async function (_e, payload) {
    try {
      if (!payload || typeof payload !== 'object') {
        return { ok: false, error: 'payload_not_object' };
      }
      return await router.dispatchWithCritic(payload);
    } catch (err) {
      return { ok: false, error: 'dispatch_threw: ' + (err && err.message ? err.message : String(err)) };
    }
  });

  ipcMain.handle('orchestrator:dispatchChain', async function (_e, body) {
    try {
      const payloads = Array.isArray(body)
        ? body
        : (body && typeof body.raw === 'string' ? SwarmRouter.parseDispatchPayloads(body.raw) : []);
      return await router.dispatchChain(payloads);
    } catch (err) {
      return { ok: false, error: 'chain_threw: ' + (err && err.message ? err.message : String(err)) };
    }
  });

  // Coder:apply IPC. The swarm normal-dispatch path can NEVER trigger this
  // (the router's dispatch() calls handlers in the registry; this module is
  // not registered). It is a side-channel the renderer hits after the user
  // explicitly clicks Apply on a diff modal.
  const { apply: coderApply } = require('./handlers/coder-apply');
  ipcMain.handle('coder:apply', async function (_e, payload) {
    try {
      // Belt-and-braces: even if the renderer forgets confirmed:true, the
      // apply() function refuses to write and returns must_be_confirmed.
      const config = (typeof getConfig === 'function') ? getConfig() : null;
      payload = payload || {};
      // Session-long auto-apply gate: a per-session toggle can flip confirmed
      // → true server-side so trusted users don't have to click each time.
      if (config && config.coderAutoApply === true && payload.confirmed !== false) {
        payload = Object.assign({}, payload, { confirmed: true });
      }
      const r = await coderApply(payload);
      try { broadcast({ kind: 'coder-applied', file: r.file || null, ok: r.ok === true, target: r.target || null }); } catch (_e) {}
      return r;
    } catch (err) {
      return { ok: false, error: 'coder_apply_threw: ' + (err && err.message ? err.message : String(err)) };
    }
  });

  // Coder preview IPC: returns the rendered unified-diff text so the
  // renderer can show a unified diff without re-implementing the logic.
  ipcMain.handle('coder:preview', async function (_e, payload) {
    try {
      const { _renderDiff } = require('./handlers/coder');
      const file = payload && payload.file;
      const before = (payload && payload.original_text) || '';
      const after = (payload && payload.new_text) || '';
      return { ok: true, diff: _renderDiff(file, before, after) };
    } catch (err) {
      return { ok: false, error: 'coder_preview_threw: ' + (err && err.message ? err.message : String(err)) };
    }
  });

  // Render-side config getter. The renderer reads swarmShowOrbs and the
  // coderAutoApply gate BEFORE mounting the SVG layer or wiring the
  // coder apply button, so we don't pay rAF cost for invisible orbs.
  ipcMain.handle('swarm:config', async function () {
    try {
      const c = (typeof getConfig === 'function') ? getConfig() : {};
      return { ok: true, swarmShowOrbs: c.swarmShowOrbs !== false, coderAutoApply: c.coderAutoApply === true };
    } catch (err) {
      return { ok: false, error: 'swarm_config_threw: ' + (err && err.message ? err.message : String(err)) };
    }
  });

  // Bridge host-side config:changes onto the swarm:event channel so any
  // window showing the orbs can react when the user toggles them in Settings.
  if (typeof onConfigChange === 'function') {
    onConfigChange(function (newCfg, oldCfg) {
      try {
        broadcast({ kind: 'config-changed', key: 'swarmShowOrbs', value: newCfg.swarmShowOrbs });
        broadcast({ kind: 'config-changed', key: 'coderAutoApply', value: newCfg.coderAutoApply });
      } catch (_e) { /* swallow */ }
      void oldCfg;
    });
  }

  return {
    router: router,
    EVENT_CHANNEL: EVENT_CHANNEL,
    executorInvoke: executorInvoke,
    broadcast: broadcast,
  };
}

module.exports = { install, EVENT_CHANNEL };
