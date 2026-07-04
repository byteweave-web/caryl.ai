// preload.js (REFINED build)
// Secure bridge. The renderer has NO direct Node access; it can only call these.
// REFINED: adds new IPC channels for VAD config, push-to-talk toggle, and a status field
// that exposes the refined config keys so the renderer's Settings panel can show them.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  // settings (AI Engine section)
  getConfig: () => ipcRenderer.invoke('config:get'),
  // OS-aware shell: { osVariant: 'win10'|'win11'|'other', blur: boolean }
  getShellStyle: () => ipcRenderer.invoke('shell:style'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  clearMemory: () => ipcRenderer.invoke('memory:clear'),

  // chats + memory editing
  newChat: () => ipcRenderer.invoke('memory:newChat'),
  listChats: () => ipcRenderer.invoke('memory:listChats'),
  switchChat: (id) => ipcRenderer.invoke('memory:switchChat', id),
  deleteChat: (id) => ipcRenderer.invoke('memory:deleteChat', id),
  listMemory: () => ipcRenderer.invoke('memory:list'),
  deleteMessage: (index) => ipcRenderer.invoke('memory:deleteMessage', index),

  // polled state (drives orb, pills, chat thread)
  status: () => ipcRenderer.invoke('ui:status'),
  activity: () => ipcRenderer.invoke('ui:activity'),
  overlayActivity: () => ipcRenderer.invoke('overlay:activity'),

  // chat
  sendText: (text) => ipcRenderer.invoke('ui:sendText', text),
  stopChat: () => ipcRenderer.invoke('chat:stop'),

  // speech-to-text: send recorded audio (ArrayBuffer) -> get transcript
  // REFINED: main now runs a server-side VAD check FIRST and drops silence/noise before
  // ever calling Whisper. The return shape is unchanged, but a new field `vad_dropped`
  // is set when the clip was dropped so the renderer can skip the "transcript received"
  // visual ping (otherwise the orb flashes for every dropped silence clip).
  transcribe: (buf) => ipcRenderer.invoke('stt:transcribe', buf),

  // global voice hotkey pressed (fires even when the app is in the background)
  onToggleMic: (cb) => ipcRenderer.on('mic:toggle', () => cb()),
  // REFINED: push-to-talk events. When PTT mode is on, the renderer gets mic:pttStart on
  // hotkey down and mic:pttStop on hotkey up. The renderer records only between these two.
  onPttStart: (cb) => ipcRenderer.on('mic:pttStart', () => cb()),
  onPttStop: (cb) => ipcRenderer.on('mic:pttStop', () => cb()),

  // models + legacy toggles
  getModels: () => ipcRenderer.invoke('ui:getModels'),
  setModel: (model) => ipcRenderer.invoke('ui:setModel', model),
  setFlag: (path, body) => ipcRenderer.invoke('ui:setFlag', { path, body }),

  // text-to-speech: main asks the renderer to speak a finished reply.
  // meta ({cardId, seg, last}) tags kernel-card narration segments; null for normal speech.
  onSpeak: (cb) => {
    const handler = (_e, text, meta) => cb(text, meta || null);
    ipcRenderer.on('tts:speak', handler);
    return () => ipcRenderer.removeListener('tts:speak', handler);
  },

  // Piper TTS: main sends finished WAV audio (ArrayBuffer) for the renderer to play
  onTtsAudio: (cb) => ipcRenderer.on('tts:audio', (_e, buf, meta) => cb(buf, meta || null)),

  // narration progress back to main (fire-and-forget)
  ttsProgress: (info) => { try { ipcRenderer.send('tts:progress', info); } catch (_e) {} },
  ttsIdle: (info) => { try { ipcRenderer.send('tts:idle', info); } catch (_e) {} },

  // test the configured voice (returns {ok, error?})
  testVoice: () => ipcRenderer.invoke('tts:test'),

  // one-click voice install
  listVoices: () => ipcRenderer.invoke('voice:list'),
  installVoice: (id) => ipcRenderer.invoke('voice:install', id),
  downloadVoice: (id) => ipcRenderer.invoke('voice:download', id),
  useVoice: (id) => ipcRenderer.invoke('voice:use', id),
  onVoiceProgress: (cb) => ipcRenderer.on('voice:progress', (_e, msg) => cb(msg)),

  // image generation (after the user picks a style)
  generateImage: (id, styleKey) => ipcRenderer.invoke('image:generate', id, styleKey),
  saveImage: (src) => ipcRenderer.invoke('image:save', src),

  // webcam vision
  lookCamera: (dataUrl, question) => ipcRenderer.invoke('vision:camera', dataUrl, question),
  cameraFrame: (dataUrl) => ipcRenderer.invoke('camera:frame', dataUrl),
  onCameraCapture: (cb) => ipcRenderer.on('camera:capture', () => cb()),
  onCameraClose: (cb) => ipcRenderer.on('camera:close', () => cb()),

  // 3D models (AI-built from shapes)
  makeModelFromImage: (dataUrl) => ipcRenderer.invoke('model3d:fromImage', dataUrl),
  saveModel: (name, b64) => ipcRenderer.invoke('model3d:save', name, b64),
  onShowModel: (cb) => ipcRenderer.on('model3d:show', (_e, m) => cb(m)),
  onModelLoading: (cb) => ipcRenderer.on('model3d:loading', (_e, on) => cb(on)),

  // ----- Floating overlay window -----
  overlayExpand: () => ipcRenderer.invoke('overlay:expand'),
  overlayCollapse: () => ipcRenderer.invoke('overlay:collapse'),
  overlayHide: () => ipcRenderer.invoke('overlay:hide'),
  overlayMoveBy: (dx, dy) => ipcRenderer.invoke('overlay:moveBy', dx, dy),
  onOverlayMode: (cb) => ipcRenderer.on('overlay:mode', (_e, mode) => cb(mode)),

  // ----- Kernel overlay card (push-based; the card never polls) -----
  onCardRender: (cb) => ipcRenderer.on('card:render', (_e, payload) => cb(payload)),
  onCardScrollTo: (cb) => ipcRenderer.on('card:scrollTo', (_e, index) => cb(index)),
  onCardDismiss: (cb) => ipcRenderer.on('card:dismiss', () => cb()),
  cardClose: () => { try { ipcRenderer.send('card:close'); } catch (_e) {} },

  // ----- Document import -----
  importDoc: () => ipcRenderer.invoke('doc:import'),
  importDocPath: (filePath) => ipcRenderer.invoke('doc:importPath', filePath),
  getPathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (e) { return ''; } },

  // ----- Local wake word (openWakeWord) -----
  wakewordEnsure: () => ipcRenderer.invoke('wakeword:ensure'),
  wakewordModel: (name) => ipcRenderer.invoke('wakeword:model', name),
  onWakewordProgress: (cb) => ipcRenderer.on('wakeword:progress', (_e, msg) => cb(msg)),

  // ----- Assistant identity -----
  setAssistantName: (name) => ipcRenderer.invoke('assistant:setName', name),

  // ----- Onboarding -----
  ensureMedia: () => ipcRenderer.invoke('media:ensure'),
  onboardingComplete: (patch) => ipcRenderer.invoke('onboarding:complete', patch),
  redoSetup: () => ipcRenderer.invoke('onboarding:redo'),

  // ----- Engines & Models download manager -----
  downloadsStatus: () => ipcRenderer.invoke('downloads:status'),
  downloadsStart: (id) => ipcRenderer.invoke('downloads:start', id),
  onDownloadsProgress: (cb) => ipcRenderer.on('downloads:progress', (_e, p) => cb(p)),

  // ----- Desktop automation -----
  automationApprovePlan: (id) => ipcRenderer.invoke('automation:approvePlan', id),
  automationCancelPlan: (id) => ipcRenderer.invoke('automation:cancelPlan', id),
  automationStop: () => ipcRenderer.invoke('automation:stop'),
  automationConfirmShell: (id, approve) => ipcRenderer.invoke('automation:confirmShell', id, approve),
  automationPick: (id, choice) => ipcRenderer.invoke('automation:pick', id, choice),
  automationSetPermissions: (perms) => ipcRenderer.invoke('automation:setPermissions', perms),

  // ----- [OFFLINE-INTEGRATION] Offline mode / local AI (Ollama) -----
  ollamaModels: () => ipcRenderer.invoke('ollama:models'),
  ollamaEnsure: () => ipcRenderer.invoke('ollama:ensure'),
  ollamaCatalog: () => ipcRenderer.invoke('ollama:catalog'),
  ollamaPull: (model) => ipcRenderer.invoke('ollama:pull', model),
  onOllamaPullProgress: (cb) => ipcRenderer.on('ollama:pull-progress', (_e, msg) => cb(msg)),

  // ----- REFINED: VAD / push-to-talk config (used by the new Settings card) -----
  // All of these are just config keys under the hood; the helpers exist so the renderer
  // doesn't have to know the exact key names.
  setVadEnabled: (enabled) => ipcRenderer.invoke('config:set', { vadEnabled: !!enabled }),
  setPushToTalk: (enabled) => ipcRenderer.invoke('config:set', { pushToTalkMode: !!enabled }),
  setVadAggressiveness: (n) => ipcRenderer.invoke('config:set', { vadAggressiveness: Math.max(0, Math.min(3, n | 0)) })
});
