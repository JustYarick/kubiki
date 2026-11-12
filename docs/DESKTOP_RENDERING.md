# Desktop rendering

Kubiki uses Tauri's platform WebView: WebKitGTK on Linux, WebView2 on Windows and
WKWebView on macOS. Platform overrides live in
`src-tauri/tauri.{linux,windows,macos}.conf.json`.

## Graphics settings

Linux startup policy is implemented in `src-tauri/src/graphics.rs`:

| Mode | Behavior |
| --- | --- |
| `auto` | Keeps DMA-BUF; on detected NVIDIA + Wayland adds `__NV_DISABLE_EXPLICIT_SYNC=1` unless already supplied. |
| `compatibility` | Sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` and applies the NVIDIA/Wayland workaround where applicable. |
| `system` | Adds no application graphics overrides; inherited variables still apply. |

Select a mode with `--graphics=auto`, `--graphics=compatibility` or
`--graphics=system`, or set `KUBIKI_GRAPHICS_MODE`. The command-line option wins.
`kubiki --graphics-info` prints startup policy without opening the application;
it does not identify the renderer actually selected by the WebView.

The application does not force X11, `GDK_SCALE`, software rendering or a WebView
rasterization scale. UI scale changes CSS sizes through `--ui-factor`. Topology
uses React Flow's diagram zoom and mounts visible elements while retaining the
complete graph data. Resource updates preserve the camera.

Terminal rendering and its Linux DOM fallback are described in [Terminal](TERMINAL.md).

## Platform builds

Windows builds target x64 MSVC. NSIS/MSI installers embed the Evergreen WebView2
bootstrapper; initial runtime installation requires internet access.

macOS builds target Apple Silicon and Intel separately, with minimum macOS 13.5.
The bundled Node runtime must match the application architecture. Universal
runtime preparation is not supported.

On Linux, use `pnpm desktop:build:linux`. The build wrapper sets
`OPENSSL_CONF=/dev/null` for packaging-tool compatibility; this is not an
application runtime setting. Packages include DEB, RPM and AppImage.
See [Releasing](RELEASING.md) for the build matrix and artifact verification.

## Troubleshooting

For rendering or scaling problems, record the OS, WebView version, GPU/driver,
display server, system scale, application scale and graphics mode. Compare the
normal interface and topology separately, including resize and monitor changes.
A browser screenshot or scheduling measurement does not establish native
compositor output, physical frame rate or cross-platform behavior.

## Rendering probes

Build the frontend and run a production preview in a separate terminal:

```sh
pnpm build
pnpm exec vite preview --host 127.0.0.1 --port 1422 --strictPort
```

Run the browser probe from the repository root. It intercepts API reads with the synthetic fixture:

```sh
BENCH_URL=http://127.0.0.1:1422 node tests/perf/renderer.mjs
BENCH_HEADED=1 BENCH_BROWSER_ARGS='["--ozone-platform=wayland"]' \
  BENCH_URL=http://127.0.0.1:1422 node tests/perf/renderer.mjs
```

Run the Linux GTK probe with system Python, PyGObject, GTK 3 and WebKit2 API 4.1 installed:

```sh
GDK_BACKEND=wayland __NV_DISABLE_EXPLICIT_SYNC=1 \
  BENCH_URL=http://127.0.0.1:1422 python3 tests/perf/native_webkit.py
GDK_BACKEND=wayland __NV_DISABLE_EXPLICIT_SYNC=1 \
  WEBKIT_DISABLE_DMABUF_RENDERER=1 BENCH_URL=http://127.0.0.1:1422 \
  python3 tests/perf/native_webkit.py
GDK_BACKEND=wayland __NV_DISABLE_EXPLICIT_SYNC=1 BENCH_MODE=gpu \
  python3 tests/perf/native_webkit.py
```

For development comparison, serve Vite on a separate loopback port and change `BENCH_URL`. For full Tauri, build `cargo build --manifest-path src-tauri/Cargo.toml --example graphics_probe --locked`, write the fixture with `python3 tests/perf/topology_fixture.py`, and pass its path through `BENCH_FIXTURE` to the example. The example exposes only synthetic reads and its result command; it is not registered in the real application.
