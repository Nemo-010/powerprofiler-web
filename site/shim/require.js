/*
 * window.require — resolves the 31 node/electron modules the bundled app
 * asks for (the bundle's external-require helper calls require(name)).
 */
(function () {
    'use strict';

    const registry = {
        buffer: () => window.__bufferPolyfill,
        events: () => window.__eventsShim,
        path: () => window.__pathShim,
        os: () => window.__osShim,
        util: () => window.__utilShim,
        stream: () => window.__streamShimModule,
        'stream/promises': () => window.__streamPromisesShimModule,
        fs: () => window.__fsShim,
        'fs/promises': () => window.__fsShim.promises,
        'original-fs': () => window.__fsShim,
        zlib: () => window.__zlibShim,
        child_process: () => window.__childProcessShim,
        electron: () => window.__electronShim,
        '@electron/remote': () => window.__remoteShim,
        archiver: () => window.__archiverShim,
        string_decoder: () => window.__stringDecoderShimModule,
        'string_decoder/': () => window.__stringDecoderShimModule,
        url: () => window.__urlShim,
        assert: () => window.__assertShim,
        crypto: () => window.__cryptoShim,
        net: () => window.__netShim,
        dns: () => window.__dnsShim,
        http: () => window.__httpShim,
        https: () => window.__httpsShim,
        timers: () => window.__timersShim,
        'timers/promises': () => ({
            setTimeout: (ms, ...args) => new Promise(r => setTimeout(r, ms, ...args)),
            setImmediate: (...args) => new Promise(r => setTimeout(r, 0, ...args)),
            setInterval,
            clearInterval,
        }),
        constants: () => window.__constantsShim,
        async_hooks: () => window.__asyncHooksShim,
        module: () => window.ModuleShim,
        console: () => window.__consoleShim,
        process: () => window.process,
        // optional native addons probed by bundled libraries: must throw
    };

    const cache = new Map();

    const requireShim = name => {
        if (cache.has(name)) return cache.get(name);
        if (name === 'osx-temperature-sensor' || name === 'applicationinsights-native-metrics') {
            throw new Error(`Cannot find module '${name}'`);
        }
        const factory = registry[name];
        if (!factory) {
            throw new Error(`Cannot find module '${name}' (not shimmed for the browser build)`);
        }
        const value = factory();
        cache.set(name, value);
        return value;
    };

    window.require = requireShim;
    window.module = { paths: [], exports: {} };
    window.ModuleShim = { _resolveFilename: name => name, prototype: { require: () => undefined } };
    // applicationinsights (bundled, telemetry) reads its config relative to
    // __dirname; telemetry is dead in this build, but the module still loads
    window.__dirname = '/app';
    window.__filename = '/app/bundle.js';
    window.__requireShimReady = true;
})();
