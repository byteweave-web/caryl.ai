// Local memory, stored on the user's disk - private, free, offline. JSON file (zero
// native deps = painless install). Now organised into conversations ("chats") so the
// user can start new chats, switch between them, and delete messages or whole chats.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const FILE = path.join(app.getPath('userData'), 'memory.json');

// store = { conversations: [{ id, title, ts, messages:[{role,content,ts}] }], activeId }
let store = { conversations: [], activeId: null };
let ready = false;

function genId() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function init() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(parsed)) {
      // Migrate the old flat message array into a single conversation.
      const c = { id: genId(), title: 'Chat', ts: Date.now(), messages: parsed };
      store = { conversations: [c], activeId: c.id };
    } else if (parsed && Array.isArray(parsed.conversations)) {
      store = parsed;
    }
  } catch (_e) {
    store = { conversations: [], activeId: null };
  }
  if (!store.conversations.length) {
    const c = { id: genId(), title: 'New chat', ts: Date.now(), messages: [] };
    store.conversations.push(c);
    store.activeId = c.id;
  }
  if (!store.activeId || !store.conversations.find((c) => c.id === store.activeId)) {
    store.activeId = store.conversations[store.conversations.length - 1].id;
  }
  ready = true;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(store));
  } catch (_e) { /* non-fatal */ }
}

function active() {
  if (!ready) init();
  return store.conversations.find((c) => c.id === store.activeId) || store.conversations[0];
}

function add(role, content) {
  if (!ready) init();
  const c = active();
  c.messages.push({ role, content, ts: Date.now() });
  // Auto-title a fresh chat from the first user line.
  if (role === 'user' && (!c.title || c.title === 'New chat')) {
    c.title = String(content || '').slice(0, 40) || 'Chat';
  }
  persist();
}

function recent(limit) {
  if (!ready) init();
  const n = limit || 200;
  return active().messages.slice(-n);
}

function all() {
  if (!ready) init();
  return active().messages.slice();
}

function clear() { // clears the CURRENT chat only
  if (!ready) init();
  active().messages = [];
  persist();
}

function newChat() {
  if (!ready) init();
  const c = { id: genId(), title: 'New chat', ts: Date.now(), messages: [] };
  store.conversations.push(c);
  store.activeId = c.id;
  persist();
  return c.id;
}

function listChats() {
  if (!ready) init();
  return store.conversations
    .map((c) => ({ id: c.id, title: c.title || 'Chat', ts: c.ts || 0, count: c.messages.length, active: c.id === store.activeId }))
    .sort((a, b) => b.ts - a.ts);
}

function switchChat(id) {
  if (!ready) init();
  if (store.conversations.find((c) => c.id === id)) { store.activeId = id; persist(); return true; }
  return false;
}

function deleteChat(id) {
  if (!ready) init();
  store.conversations = store.conversations.filter((c) => c.id !== id);
  if (!store.conversations.length) { newChat(); return; }
  if (store.activeId === id) store.activeId = store.conversations[store.conversations.length - 1].id;
  persist();
}

function deleteMessage(index) {
  if (!ready) init();
  const c = active();
  if (index >= 0 && index < c.messages.length) { c.messages.splice(index, 1); persist(); return true; }
  return false;
}

module.exports = { init, add, recent, all, clear, newChat, listChats, switchChat, deleteChat, deleteMessage };