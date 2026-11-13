/*
 * `electron` and `@electron/remote` shims.
 *
 * Surface used by the renderer (see NOTES.md):
 * - ipcRenderer.sendSync('get-config') / ('electron-store-get-data')
 * - ipcRenderer.invoke(...) for the channels the app fires
 * - @electron/remote getCurrentWindow() + dialog (File System Access API)
 */
(function () {
    'use strict';

    const APP_VERSION = window.__appVersion || '4.4.1';
    const EE = window.__eventsShim;

    /* ------------------------- ipcRenderer ------------------------- */

    const invokers = {
        'get-app-details': async () => ({
            name: 'power-profiler',
            displayName: 'Power Profiler',
            description: 'Power Profiler (web build)',
            version: APP_VERSION,
            currentVersion: APP_VERSION,
            official: true,
            source: 'official',
            coreVersion: '8.1.1',
            corePath: '/app',
            homeDir: '/home/web',
            tmpDir: '/tmp',
            bundledJlink: '',
            path: '/app',
            engineVersion: '8.1.1',
            installed: { publishTimestamp: '0', path: '/app' },
        }),
        'apps:get-downloadable-apps': async () => [],
        'apps:install-downloadable-app': async () => undefined,
        'memoryUsage': async () => ({ rss: 0, heapUsed: 0 }),
        'open:file': async () => undefined,
        'open:file-location': async () => undefined,
        'open:app': async () => undefined,
        'prevent-sleep:start': async () => {
            try {
                if (navigator.wakeLock) {
                    const sentinel = await navigator.wakeLock.request('screen');
                    return sentinel;
                }
            } catch (e) { /* not granted */ }
            return undefined;
        },
        'prevent-sleep:end': async () => undefined,
    };

    // serialport:* channels are answered by the WebSerial manager
    const serialIpc = window.__serialIpcShim;

    const ipcRenderer = {
        on(ch, cb) {
            if (serialIpc && serialIpc.handleOn(ch, cb)) return ipcRenderer;
            if (ch === 'auth:on-state-changed' || ch === 'log:forward') {
                // never fires in the browser build
            }
            return ipcRenderer;
        },
        off(ch, cb) {
            if (serialIpc) serialIpc.handleOff(ch, cb);
            return ipcRenderer;
        },
        removeListener(ch, cb) { return ipcRenderer.off(ch, cb); },
        removeAllListeners() { return ipcRenderer; },
        once(ch, cb) {
            if (serialIpc && serialIpc.handleOnce(ch, cb)) return ipcRenderer;
            return ipcRenderer;
        },
        send(ch, ...args) {
            if (serialIpc) serialIpc.handleSend(ch, args);
            // other sends (window state) are no-ops in the browser build
        },
        sendSync(ch) {
            if (ch === 'get-config') {
                return {
                    isRunningLauncherFromSource: false,
                    launcherVersion: 'web',
                    userDataDir: '/data',
                };
            }
            if (ch === 'electron-store-get-data') {
                return {
                    defaultCwd: '/config',
                    appVersion: APP_VERSION,
                };
            }
            return undefined;
        },
        async invoke(ch, ...args) {
            if (serialIpc && serialIpc.handleInvoke(ch, args) !== undefined) {
                return serialIpc.handleInvoke(ch, args);
            }
            if (ch === 'open:url') {
                window.open(args[0], '_blank', 'noopener');
                return undefined;
            }
            if (invokers[ch]) {
                return invokers[ch](...args);
            }
            return undefined;
        },
        invokeSync: undefined,
    };

    /* --------------------- @electron/remote ------------------------ */

    class BrowserWindowStub extends EE {
        constructor() {
            super();
            this.__title = 'Power Profiler';
        }
        getTitle() { return this.__title || document.title; }
        setTitle(t) {
            this.__title = t;
            document.title = t;
        }
        close() { window.close(); }
        reload() { window.location.reload(); }
        isFullScreen() { return false; }
        setFullScreen() {}
        isMaximized() { return false; }
        maximize() {}
        unmaximize() {}
        isMinimized() { return false; }
        minimize() {}
        restore() {}
        isFocused() { return document.hasFocus(); }
        focus() { window.focus(); }
        blur() {}
        on(name, fn) {
            if (name === 'focus' || name === 'blur') {
                window.addEventListener(name, fn);
                return this;
            }
            super.on(name, fn);
            return this;
        }
        off(name, fn) {
            if (name === 'focus' || name === 'blur') {
                window.removeEventListener(name, fn);
                return this;
            }
            super.off(name, fn);
            return this;
        }
        webContents() { return undefined; }
    }

    const theWindow = new BrowserWindowStub();

    const showSaveDialog = async options => {
        if (!window.showSaveFilePicker) {
            return { canceled: true, filePath: undefined };
        }
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: options && options.defaultPath
                    ? options.defaultPath.split('/').pop()
                    : 'export.ppk2',
                types: [{
                    description: 'Power Profiler session',
                    accept: { 'application/octet-stream': ['.ppk2', '.ppk'] },
                }],
            });
            const path = window.__vfs.registerPicked(handle.name, handle, null);
            window.__pickedHandles = window.__pickedHandles || {};
            window.__pickedHandles[path] = handle;
            return { canceled: false, filePath: path, bookmark: undefined };
        } catch (err) {
            return { canceled: true, filePath: undefined };
        }
    };

    const showOpenDialog = async options => {
        if (!window.showOpenFilePicker) {
            return { canceled: true, filePaths: [] };
        }
        try {
            const handles = await window.showOpenFilePicker({
                multiple: false,
                types: [{
                    description: 'Power Profiler session',
                    accept: { 'application/octet-stream': ['.ppk', '.ppk2'] },
                }],
            });
            const filePaths = [];
            for (const handle of handles) {
                const file = await handle.getFile();
                const path = window.__vfs.registerPicked(handle.name, handle, file);
                filePaths.push(path);
            }
            return { canceled: false, filePaths, bookmarks: [] };
        } catch (err) {
            return { canceled: true, filePaths: [] };
        }
    };

    window.__remoteShim = {
        getCurrentWindow: () => theWindow,
        getGlobal: name => undefined,
        dialog: { showSaveDialog, showOpenDialog },
        app: {
            getVersion: () => APP_VERSION,
            getPath: name => '/config',
            getName: () => 'nRF Connect for Desktop',
        },
        webFrame: { setZoomFactor() {}, getZoomFactor: () => 1 },
        require: mod => window.require(mod),
    };

    /* ------------------------- electron ---------------------------- */

    window.__electronShim = {
        ipcRenderer,
        contextBridge: {
            exposeInMainWorld: (key, api) => {
                window[key] = api;
            },
        },
        webFrame: window.__remoteShim.webFrame,
    };
})();
