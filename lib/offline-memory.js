// lib/offline-memory.js
// [OFFLINE-INTEGRATION] A separate chat store used ONLY when the user turns on
// "keep offline chats separate" in Settings -> AI Mode.
//
// Design decision (deliberate): when chats are MERGED (the default), both modes keep
// using the app's existing lib/memory.js untouched - zero risk to existing chat data.
// When the user opts into SEPARATE storage, offline mode switches to THIS store, which
// lives in its own file (offline-chats.json in userData) and starts fresh. Online mode
// always keeps using the original store either way, so nothing the user already has can
// ever be lost by flipping the toggle.
//
// The API surface exactly mirrors what main.js calls on lib/memory.js:
//   init(), all(), add(role, content), recent(n), clear(),
//   newChat(), listChats(), switchChat(id), deleteChat(id), deleteMessage(index)

const fs = require('fs');
const path = require('path');

class OfflineMemory {
  constructor(filePath) {
    this.file = filePath;
    this.data = { activeId: null, chats: [] };
    this._load();
    if (!this.data.chats.length) this._createChat();
    if (!this._active()) this.data.activeId = this.data.chats[0].id;
  }

  // ---------- persistence ----------
  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (raw && Array.isArray(raw.chats)) {
          this.data = { activeId: raw.activeId || null, chats: raw.chats };
        }
      }
    } catch (e) {
      console.warn('[offline-memory] could not load ' + this.file + ': ' + ((e && e.message) || e));
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.warn('[offline-memory] could not save: ' + ((e && e.message) || e));
    }
  }

  _active() {
    return this.data.chats.find((c) => c.id === this.data.activeId) || null;
  }

  _createChat() {
    const chat = {
      id: 'off_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
      title: 'New chat',
      created: Date.now(),
      messages: []
    };
    this.data.chats.unshift(chat);
    this.data.activeId = chat.id;
    this._save();
    return chat;
  }

  // ---------- API (mirrors lib/memory.js) ----------
  init() { /* constructor already loaded from disk */ }

  all() {
    const c = this._active();
    return c ? c.messages.slice() : [];
  }

  add(role, content) {
    let c = this._active();
    if (!c) c = this._createChat();
    c.messages.push({ role, content: String(content == null ? '' : content), ts: Date.now() });
    // First user message names the chat, same convention chat apps use.
    if (role === 'user' && (!c.title || c.title === 'New chat')) {
      c.title = String(content).slice(0, 40) || 'New chat';
    }
    this._save();
    return true;
  }

  recent(n) {
    const msgs = this.all();
    const k = Math.max(0, Number(n) || 0);
    return k ? msgs.slice(-k) : msgs;
  }

  clear() {
    const c = this._active();
    if (c) { c.messages = []; this._save(); }
    return true;
  }

  newChat() {
    this._createChat();
    return { ok: true };
  }

  listChats() {
    // Generous shape: id/title/name/created/ts/count/active all provided so the
    // renderer finds whichever field names it already renders with.
    return this.data.chats.map((c) => ({
      id: c.id,
      title: c.title || 'New chat',
      name: c.title || 'New chat',
      created: c.created,
      ts: (c.messages.length ? c.messages[c.messages.length - 1].ts : c.created),
      count: c.messages.length,
      active: c.id === this.data.activeId
    }));
  }

  switchChat(id) {
    const found = this.data.chats.find((c) => c.id === id);
    if (!found) return false;
    this.data.activeId = id;
    this._save();
    return true;
  }

  deleteChat(id) {
    const idx = this.data.chats.findIndex((c) => c.id === id);
    if (idx < 0) return false;
    this.data.chats.splice(idx, 1);
    if (this.data.activeId === id) {
      if (this.data.chats.length) this.data.activeId = this.data.chats[0].id;
      else this._createChat();
    }
    this._save();
    return true;
  }

  deleteMessage(index) {
    const c = this._active();
    const i = Number(index);
    if (!c || !Number.isInteger(i) || i < 0 || i >= c.messages.length) return false;
    c.messages.splice(i, 1);
    this._save();
    return true;
  }
}

module.exports = OfflineMemory;
