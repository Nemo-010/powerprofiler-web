/*
 * serialport:* IPC channels (shared/src/ipc/serialPort.ts). The PPK app does
 * not route device traffic through these (it uses the forked worker), so
 * registration is accepted and nothing ever fires; open/close/write invoke
 * fail loudly in case an app ever routes through them.
 */
(function () {
    'use strict';

    const PREFIX = 'serialport:';

    const noop = () => undefined;

    const handleOn = (ch, cb) => {
        if (typeof ch === 'string' && ch.startsWith(PREFIX)) return true;
        return false;
    };

    const handleOnce = (ch, cb) => handleOn(ch, cb);
    const handleOff = noop;
    const handleSend = noop;

    const handleInvoke = (ch, args) => {
        if (typeof ch === 'string' && ch.startsWith(PREFIX)) {
            return Promise.reject(new Error('serialport IPC is not supported in the browser build'));
        }
        return undefined;
    };

    window.__serialIpcShim = { handleOn, handleOnce, handleOff, handleSend, handleInvoke };
})();
