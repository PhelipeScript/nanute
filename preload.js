'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Whitelist of channels the renderer is allowed to send
const SEND_CHANNELS = new Set([
  'mouse:capture',
  'mouse:ignore',
  'overlay:expand',
  'overlay:compact',
  'overlay:hide',
]);

// Whitelist of channels renderer can listen to
const RECV_CHANNELS = new Set([
  'command',
]);

contextBridge.exposeInMainWorld('bridge', {
  /**
   * Send a message to the main process.
   * @param {string} channel
   * @param {...any} args
   */
  send(channel, ...args) {
    if (SEND_CHANNELS.has(channel)) {
      ipcRenderer.send(channel, ...args);
    }
  },

  /**
   * Listen to a message from the main process.
   * Returns an unsubscribe function.
   * @param {string} channel
   * @param {Function} callback
   * @returns {Function} unsubscribe
   */
  on(channel, callback) {
    if (!RECV_CHANNELS.has(channel)) return () => {};
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
