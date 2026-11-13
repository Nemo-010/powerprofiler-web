# Power Profiler for the browser

nRF Connect for Desktop's **Power Profiler** app (PPK / PPK2) running entirely
in a web browser. The official Electron app is loaded unmodified from Nordic's
published tarball; a platform shim layer replaces the Electron/Node runtime
with Web APIs. No app code is patched.

The PPK2 is a plain CDC-ACM USB serial device, so **Web Serial** replaces both
the `serialport` native module and the forked nrfutil worker. Zero WASM, zero
native code. (J-Link-based probes cannot be supported: the J-Link host
library is closed and does not exist for the browser.)

## Use it

1. Serve this directory over HTTPS (Web Serial requires a secure context).
   For local use:

   ```sh
   python -m http.server 8000
   # open http://localhost:8000
   ```

2. Click **Connect PPK2** (bottom right) and pick the PPK2 from the browser's
   device chooser. The button hides once a port is paired.
3. Use the app exactly as on the desktop: Data Logger, Scope, real-time
   sampling, and `.ppk2` export all work. PPK2 sampling runs through the
   browser's USB serial stream; the nrfutil device layer is emulated in
   `site/shim/nrfutil.js`.

Known limits:

- **PPK1** (the original, mbed-based stick) is not supported yet: it needs the
  Nordic DFU/UART boot protocol that the desktop app drives through a
  different code path.
- Config persistence uses `localStorage` under the hood; it follows the
  browser profile, not a file on disk.

## Layout

```
site/index.html          loader: fetches manifest.json, runs shims, then the app bundle
site/manifest.json       {version, app} — which app dir to load
site/app/<name>/         the published app's dist/ (bundle.js), extracted flat
site/shim/*.js           the platform shim layer (see below)
site/fonts/              vendored @mdi/font (icon font), no CDN
tools/update-app.py      fetch the latest published app and refresh site/app
tools/loadtest.mjs       Node/jsdom smoke test: runs shims + bundle headless
.github/workflows/update.yml  daily update check + GitHub Pages deploy
```

### Shim layer

The app bundle is built for Electron and calls `require()` on ~31 Node and
Electron modules. `site/shim/require.js` resolves each to a browser
implementation:

| module | replacement |
| --- | --- |
| `fs`, `fs/promises` | in-memory VFS; config file in `localStorage` |
| `child_process` | `nrfutil` NDJSON emulator (device list, device-info, hotplug) |
| `serialport` (IPC) | Web Serial (`navigator.serial`) |
| `archiver` | stored-method ZIP writer (`.ppk2` export) |
| `electron` | minimal `ipcRenderer`/`app`/`remote` surface the app actually uses |
| `buffer`, `events`, `path`, `stream`, `zlib`, `util`, ... | pure-JS polyfills |

Telemetry is dead by construction: the app's Application Insights endpoint is
blocked by the site's Content Security Policy (`connect-src 'self'`) without
touching any app code.

The shims only replace the platform layer, so when Nordic publishes a new
app version, `tools/update-app.py` swaps the bundle and everything keeps
working — no fork, no rebase.

## Updating the app

```sh
python3 tools/update-app.py          # fetch latest, verify sha1, install
python3 tools/update-app.py --check  # report only
```

`update-app.py` is Python stdlib-only. It reads Nordic's official
`source.json`, verifies the published sha1, extracts `dist/`, writes
`site/manifest.json`, and prunes all but the two most recent versions.

CI runs the same script daily and deploys to GitHub Pages (see
`.github/workflows/update.yml`).

## Development

```sh
node tools/loadtest.mjs   # headless smoke test (jsdom): must exit 0 with the app UI rendered
```

The loadtest stubs `navigator.serial`, `ResizeObserver`, `IntersectionObserver`,
`scrollIntoView`, `DecompressionStream` and a fake 2D canvas context — things
jsdom lacks but every real browser ships. Real-browser verification (render,
serial connect, sampling) is a manual step.

## Provenance

- App: [pc-nrfconnect-ppk](https://github.com/NordicSemiconductor/pc-nrfconnect-ppk),
  published tarball from Nordic's artifactory (sha1-verified).
- Platform layer: original work in `site/shim/`.
