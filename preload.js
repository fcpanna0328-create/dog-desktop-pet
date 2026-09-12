const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dogAPI', {
  moveWindowBy: (dx) => ipcRenderer.send('move-window-by', dx),
  getScreenInfo: () => ipcRenderer.invoke('get-screen-info'),
  onCursorStatus: (callback) => ipcRenderer.on('cursor-status', (_event, data) => callback(data)),
  // Manual window dragging (replaces -webkit-app-region: drag, which on
  // macOS forces the default arrow cursor inside the drag region and
  // ignores any custom CSS cursor -- doing the drag in JS instead lets the
  // hand/grab cursor actually render).
  getWindowBoundsSync: () => ipcRenderer.sendSync('get-window-bounds-sync'),
  moveWindowTo: (x, y) => ipcRenderer.send('move-window-to', { x, y }),
});
