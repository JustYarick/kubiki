# Desktop rendering investigation

Investigated on 2026-10-24. The reported problem is Linux development mode (`pnpm tauri dev`). Windows and macOS were reviewed through project configuration and current primary documentation; they were not tested on hardware during this investigation.

## Applied settings

| Area | Implemented behavior | Evidence / limitation |
| --- | --- | --- |
| Topology | `onlyRenderVisibleElements` mounts the visible graph region; all objects and relationships remain in the graph. Resource updates preserve the camera, and background graph updates do not show a loading indicator. | The configured production frontend in local WebKitGTK measured 17.40 ms mean / 19 ms p95 callback intervals, versus 35.07 / 46 ms before culling. DOM elements fell from 10,875 to 2,398. These are synthetic scheduling measurements, not displayed FPS. |
| Linux | Retains the measured `auto` policy with DMA-BUF and the NVIDIA/Wayland explicit-sync workaround. DEB, RPM and AppImage targets are explicit. | The native Linux release binary built successfully with the locked dependency graph. A full Tauri release probe measured 17.27 ms mean / 18 ms p95. Disabling DMA-BUF measured 70.30 ms and is reserved for compatibility mode. Installed-package portability still needs distribution testing. |
| Windows | Explicit x64 MSVC target; NSIS and MSI embed the Evergreen WebView2 bootstrapper. | Based on Microsoft/Tauri guidance. Initial runtime installation needs internet. No Windows hardware test was performed. |
| macOS | Separate Apple Silicon and Intel builds; minimum macOS 13.5 and hardened runtime. | Minimum matches the bundled official Node 24 binaries. No macOS hardware test was performed. |
| Runtime / CI | Bundled Node follows Tauri's target triple; CI rejects conflicting targets and verifies runtime selection. Release builds use locked Rust dependencies. | Unit tests cover native fallback, all supported runtime triples and rejected mismatches. Release runner labels are listed in [GitHub's runner image documentation](https://github.com/actions/runner-images). |
| Linux packaging tool | `pnpm desktop:build:linux` and the Linux release job set `OPENSSL_CONF=/dev/null` for the build process. | The downloaded static `appimagetool` hung while fetching its runtime with the host OpenSSL configuration. An isolated configuration let AppImage packaging complete. This setting is not stored in the application runtime. |
| Native window | Explicit opaque background, OS-controlled display scaling, browser zoom hotkeys disabled. Release devtools are opt-in through the `desktop-devtools` Cargo feature. | No forced rasterization scale, software rendering or global CSS scaling was added. Whole-window blur remains unverified. |

Platform overrides are automatically merged by Tauri from `src-tauri/tauri.{linux,windows,macos}.conf.json`; all three merged configurations were checked against the installed Tauri JSON schema. See [Tauri's configuration reference](https://v2.tauri.app/reference/config/).

```sh
# Development; the topology optimization applies here too.
pnpm tauri dev

# Build this host's production application and configured installers.
pnpm tauri build -- --locked

# Linux: includes the locally verified AppImage tooling workaround.
pnpm desktop:build:linux

# Compile the native Linux application without packaging installers.
pnpm tauri build --no-bundle -- --locked
./src-tauri/target/release/kubiki --graphics-info
```

The local release binary and DEB/RPM/AppImage were built on openSUSE; use the Ubuntu 22.04 release job to produce Linux distribution artifacts with the older glibc baseline. The Windows and macOS jobs must run on their respective GitHub runners before their artifacts can be considered build-verified. Signing/notarization credentials are not configured by this change.

Validation completed: 32 topology/relationship unit tests, 3 desktop target-selection tests, 4 graphics-policy tests, and the 31 relevant browser scenarios (30 in the final production-frontend batch, followed by the remaining scenario after fixing its missing wait for asynchronous subscriptions). These checks cover camera retention during updates, continuous graph updates, outdated scope results, dragging, resizing, arrow controls and navigating to an offscreen resource in a 301-object graph. The native Linux binary was built with `pnpm tauri build --no-bundle -- --locked`; the resulting binary was packaged into DEB, RPM and AppImage.

## Findings

The Linux slowdown is reproducible without a Kubernetes cluster. Production JavaScript does not eliminate it. Keeping all topology objects mounted is a substantial contributor: viewport culling approximately halves the measured animation callback interval, first in an isolated bundle and then in the configured application frontend. Disabling DMA-BUF is an expensive compatibility fallback on this machine. A universal fix for blurry text has not been established.

These results distinguish four separate concerns:

1. Building the Rust application and packaging its native dependencies.
2. JavaScript and React work during resource updates and graph gestures.
3. WebView rasterization, compositing, and animation scheduling.
4. OS scaling, display selection, and window-manager presentation.

A successful build validates only part of this chain. A fast Chrome session does not validate the Linux or macOS WebView.

## Runtime and local environment

Tauri 2 uses WebKitGTK on Linux, WebView2 on Windows, and WKWebView on macOS. The latter two WebKit integrations are separate ports, with different platform graphics paths. Installing Chrome does not replace the Linux application's renderer. See the [Tauri engine reference](https://v2.tauri.app/reference/webview-versions/).

| Component | Observed value |
| --- | --- |
| OS / desktop | openSUSE Tumbleweed 20261014, Hyprland, native Wayland |
| GPU / driver | NVIDIA GeForce RTX 5070, 595.104.02 |
| Displays | DP-1: 3440×1440 at 180 Hz; HDMI-A-1: 1920×1080 at 60 Hz |
| Desktop scale | 1 on both displays |
| GTK / WebKitGTK | 3.24.53 / 2.54.1, API 4.1 |
| Rust dependencies in Cargo.lock | Tauri 2.12.4, tauri-runtime-wry 2.12.2, Wry 0.57.0, Tao 0.37.1 |
| Browser baseline | Chrome 155.0.8059.84, headed, native Wayland |
| Application appearance | UI scale 110%; graph's `--ui-factor` is 1 |

The separate `webkit://gpu` probe identified the actual NVIDIA OpenGL renderer, DMA-BUF presentation, `Policy: always`, and `Device scale: 1`. This is stronger evidence than inferring acceleration from an environment variable or WebGL context creation alone. It reported `VBlank type: Timer` and `60Hz`; the graph benchmark's idle callbacks were also approximately 16 ms apart. Hyprland separately identified the benchmark window as native Wayland, floating, on DP-1 at 180 Hz. This points to an additional pacing limitation worth investigating, but does not establish the exact upstream cause or physical presentation rate.

The [upstream VBlank monitor factory](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/glib/DisplayVBlankMonitor.cpp) falls back to a timer when the native monitor cannot be created, and also supports an explicit timer override. That override was unset in the investigation environment. The selected fallback should be diagnosed separately from GPU rasterization; an accelerated renderer can still have limited callback pacing.

There is no evidence that fractional desktop scaling causes the current local problem. Fractional scaling remains part of the release test matrix for other machines.

## Controlled topology measurements

All final comparison runs used a 1280×800 WebView, DPR 1, the same fixture, and the same JavaScript gesture. The fixture contains 229 graph objects and 730 relationships. All resource types were enabled, layout was completed before measurement, fonts were loaded, and the diagram was zoomed to approximately 0.249. No live cluster reads or mutations were available to the probes.

The gesture dispatches synthetic DOM mouse events once per animation callback and records 180 callback intervals after an idle baseline. These are **requestAnimationFrame scheduling measurements**, not physical presented-frame FPS, real input latency, or GPU timing. Callback pacing differs between engines, so the table measures the whole tested renderer configuration rather than isolated JavaScript CPU cost.

| Configuration | Mean interval | p95 interval | Mounted DOM elements |
| --- | ---: | ---: | ---: |
| Chrome, production frontend | 24.74 ms | 27.9 ms | 10,875 |
| WebKitGTK, production frontend, DMA-BUF | 35.07 ms | 46 ms | 10,875 |
| WebKitGTK, development frontend, DMA-BUF | 34.91 ms | 45 ms | 10,881 |
| WebKitGTK, production, `WEBKIT_DISABLE_DMABUF_RENDERER=1` | 70.30 ms | 76 ms | 10,875 |
| Full Tauri probe, production frontend, DMA-BUF | 34.52 ms | 44 ms | 10,878 |
| WebKitGTK, production, experimental viewport culling | 17.85 ms | 28 ms | 2,398 |
| WebKitGTK, configured production frontend with culling | 17.40 ms | 19 ms | 2,398 |
| Full Tauri release probe, configured production frontend | 17.27 ms | 18 ms | 2,401 |

The full Tauri probe was compiled in Rust's debug profile and loaded the production frontend. It isolates the native host and synthetic IPC; it is **not** a packaged release build or a benchmark of real Kubernetes watch traffic. Its native inner size and JavaScript viewport both measured 1280×800. Initial pilot runs with tiling-induced size differences were excluded from the final comparison.

The configured full Tauri probe was additionally compiled with `cargo build --manifest-path src-tauri/Cargo.toml --release --example graphics_probe --locked`. It used the optimized native host, production frontend, the same synthetic IPC fixture and the same 1280×800 / DPR 1 viewport. Its 17.27 ms mean / 18 ms p95 result confirms the improvement in a release-profile Tauri host. This example still loads the production preview over loopback; it does not validate installation, real watch traffic or compositor-level sharpness. Each recorded configuration is a single illustrative run.

The initial culling experiment changed only the generated `<ReactFlow>` props in a copied `/tmp` production bundle, adding `onlyRenderVisibleElements: true`. After this measurement, the option was enabled in `src/views/TopologyCanvas.tsx` and the production frontend was rebuilt and remeasured. The graph data stayed at 229 resources / 730 relationships; the final visible region mounted 6 node containers and 173 edge containers. Dynamic mounted counts naturally depend on the pan position. The configured frontend's mean interval improved by approximately 2.02× relative to the final WebKit baseline. This is an illustrative local result, not a cross-platform performance guarantee.

React Flow documents both the option's potential benefit and additional overhead. The interface regression scenarios cover compound namespace nodes, dragging, edge labels, route editing and automatic arrangement. The large-cluster scenario checks that all 301 objects remain in the summary/minimap and that offscreen resources mount when navigated into view. See the [ReactFlow component API](https://reactflow.dev/api-reference/react-flow) and [performance guidance](https://reactflow.dev/learn/advanced-use/performance).

CSS-only suppression of node shadows or edge-label painting did not materially improve an earlier pilot. Those experiments left the React elements mounted, so they do not rule out expensive React work or the benefit of removing offscreen elements.

## Linux graphics policy

`src-tauri/src/graphics.rs` already provides three modes:

| Mode | Application policy |
| --- | --- |
| `auto` | Keeps DMA-BUF; on detected NVIDIA + Wayland adds `__NV_DISABLE_EXPLICIT_SYNC=1` unless that variable was supplied already. |
| `compatibility` | Sets `WEBKIT_DISABLE_DMABUF_RENDERER=1`, plus the applicable explicit-sync workaround. |
| `system` | Adds no application graphics overrides; inherited environment variables still apply. |

It does not globally set `GDK_SCALE`, force X11, or disable compositing. `--graphics-info` describes startup policy, not the actual selected renderer.

A release-probe control with inherited `__NV_DISABLE_EXPLICIT_SYNC` and `WEBKIT_DISABLE_DMABUF_RENDERER` unset confirmed that `auto` completed successfully. Under the same conditions, `--graphics=system` terminated with `Gdk-Message: Error 71 (Protocol error) dispatching to Wayland display`; a preceding system-mode attempt failed the same way. This supports retaining the existing NVIDIA/Wayland workaround on this machine. The observation does not imply that every NVIDIA driver or compositor needs it.

In the tested WebKitGTK 2.54.1 build, disabling DMA-BUF also changed the reported hardware policy from `always` to `never`, and approximately doubled the callback interval. This observation is version/environment specific: DMA-BUF transport, GPU rasterization, and accelerated compositing are distinct mechanisms. Do not assume that every WebKit version implements this variable identically.

Tauri's [current Linux graphics guide](https://v2.tauri.app/develop/debug/linux-graphics/) recommends trying the narrower NVIDIA sync workaround before disabling DMA-BUF; disabling compositing is a last resort. NVIDIA separately documents the [explicit-sync compatibility switch](https://github.com/NVIDIA/egl-wayland2). These switches should stay local to a process during diagnosis.

On 2026-09-16, WebKitGTK 2.54 switched its web-process compositor from TextureMapper to Skia. Version 2.54.2 was released on 2026-10-23 and includes a backdrop-filter composition performance fix and other rendering fixes. The current application does not use backdrop filters in its source, so that named fix is not evidence that upgrading resolves this case. An update through the distribution should be followed by the same measurements. Sources: [2.54.0 release](https://webkitgtk.org/2026/09/16/webkitgtk2.54.0-released.html), [2.54.2 release](https://webkitgtk.org/2026/10/23/webkitgtk2.54.2-released.html).

## Blurry text: what is established

The project does not apply a global `transform: scale()` or WebView zoom for interface scaling. `src/core/appearance.ts` changes CSS sizes through `--ui-factor`; at 110% the factor is approximately 1.1917. This can produce fractional text and layout coordinates, but fractional CSS values alone are not proof of a bug. The graph explicitly resets its local UI factor to 1 and uses React Flow transforms for diagram zoom.

At the benchmark's 0.249 graph zoom, a 12 CSS pixel node title occupies approximately 3 physical pixels at DPR 1. Readable text at that scale is not a reasonable expectation in any engine. A useful graph design would use level-of-detail presentation and reveal labels when sufficiently zoomed in. That does not explain a blurry sidebar or toolbar at normal size.

There are relevant upstream reports, with different confidence levels:

- [Wry #1727](https://github.com/tauri-apps/wry/issues/1727) reports blur after Wayland window resizing under Hyprland, including at scale 1. Its reproduction uses transparent, undecorated windows; this project's main window does not request those settings. The issue's causal analysis is not established for this application. Its claim that WebKitGTK API 4.1 means GTK 4 is incorrect: API 4.1 uses GTK 3, and GTK 4 uses API 6.0, as explained by a [WebKitGTK maintainer](https://blogs.gnome.org/mcatanzaro/2023/03/21/webkitgtk-api-for-gtk-4-is-now-stable/).
- [WebKit #27684](https://bugs.webkit.org/show_bug.cgi?id=27684) tracks blurred or pixelated composited content under scale transforms. A related [WKWebView scrolling case](https://bugs.webkit.org/show_bug.cgi?id=227284) shows why this can persist after a transform. These are relevant to the graph, but are not proof that the entire local window has the same defect.
- [GTK's fractional-scaling explanation](https://blogs.gnome.org/gtk/2024/03/07/on-fractional-scales-fonts-and-hinting/) distinguishes pixel alignment, hinting and antialiasing. Its GTK 4 improvements do not automatically apply to this application's GTK 3 runtime. [Hyprland's XWayland guidance](https://wiki.hypr.land/configuring/extra/xwayland/) explains another resampling path on scaled displays; the observed application is native Wayland at scale 1.

`-webkit-font-smoothing: antialiased` is a nonstandard font-rendering preference, not a remedy for incorrect backing-store scale or rasterized textures. See [MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/font-smooth).

A general blur fix remains unverified. A targeted reproduction should compare normal-size shell text and graph text separately, before/after resize and monitor changes, while recording native inner size, JavaScript viewport, DPR, actual renderer and compositor screenshots. A WebKit page snapshot alone cannot prove what the Wayland compositor presented.

## Windows build and rendering requirements

The release matrix builds Windows x64 on `windows-2022`. `tauri.windows.conf.json` selects NSIS/MSI and `embedBootstrapper` with silent runtime installation. It does not configure custom browser arguments, rasterization scale or forced software rendering.

Use an explicitly supported Windows x64 target, an installer that ensures the WebView2 runtime is available, and an Evergreen runtime unless offline deployment requires a maintained fixed distribution. WebView2 is a separately serviced runtime, not simply the installed Edge browser. Sources: [Microsoft distribution guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution), [performance guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance).

Test 100%, 125%, 150% and 200% system scale, movement between monitors with different DPI, initial launch on each monitor, graph pan/zoom, and terminal/editor resizing. WebView2 distinguishes content `ZoomFactor` from DPI-related `RasterizationScale`; its monitor-change tracking must not be defeated by a hardcoded scale. See [Microsoft's API overview](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/overview-features-apis?tabs=win32cpp) and [monitor tracking](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2controller.shoulddetectmonitorscalechanges).

No Windows performance or clarity result was measured here. Chrome on Linux cannot certify the Windows WebView2 host, DPI integration, or packaged installation.

## macOS build and rendering requirements

The release workflow now builds `aarch64-apple-darwin` on `macos-15` and `x86_64-apple-darwin` on `macos-15-intel`. Separate artifacts ensure that the application, standalone CLI and bundled Node runtime have matching architectures. A universal target is rejected by the runtime preparation helper because merging only the Rust executable would leave an incompatible runtime.

`scripts/prepare-extension-runtime.mjs` selects its Node binary through `extension-runtime-target.mjs`. Tauri's `TAURI_ENV_TARGET_TRIPLE` determines the archive; CI also supplies `KUBIKI_BUILD_TARGET` for standalone preparation, with an error if the two disagree. Native host detection is retained only when neither target is supplied. Cached runtime hashes are still checked, and stale executables from the opposite OS are removed before packaging.

That script bundles Node 24.22.1. Official Node 24 macOS binaries require macOS 13.5 or newer. `bundle.macOS.minimumSystemVersion` and the release job's `MACOSX_DEPLOYMENT_TARGET` are now both `13.5`. This addresses packaging compatibility; it is not a cause of Linux UI lag. See [Node's platform support notes](https://nodejs.org/en/blog/migrations/v22-to-v24).

WKWebView depends on the OS-provided WebKit. A newer Rust binary does not ship a replacement browser engine. Test Retina and non-Retina displays, cross-display moves, resizing, diagram transforms, and the oldest supported macOS. Keep native backing-store scale separate from CSS layout dimensions; see [Apple's high-resolution guidance](https://developer.apple.com/library/archive/documentation/GraphicsAnimation/Conceptual/HighResolutionOSX/Explained/Explained.html). Treat signing, notarization and minimum-system-version configuration as separate release requirements; see [Tauri's macOS bundle guide](https://v2.tauri.app/distribute/macos-application-bundle/).

No macOS performance or clarity result was measured here.

## Linux packaging and CI gaps

The release build uses Ubuntu 22.04, which is an appropriate old-baseline strategy for glibc compatibility. Updating the build machine indiscriminately can raise the runtime glibc requirement. Native DEB/RPM installations and AppImage bundles need separate validation: the latter can carry graphics libraries different from those used in local development. Inspect the actual packaged library versions rather than assuming the host upgrade updates every bundle. See [Tauri's AppImage documentation](https://v2.tauri.app/distribute/appimage/).

Local packaging produced `kubiki_0.1.0_amd64.deb` (53.27 MiB), `kubiki-0.1.0-1.x86_64.rpm` (53.26 MiB), and `kubiki_0.1.0_amd64.AppImage` (136.04 MiB) under `src-tauri/target/release/bundle/`. The RPM file list contains the extension host, extension archive, Linux Node executable and runtime licenses.

The first AppImage packaging attempt stalled in the downloaded `appimagetool` (git `8c8c91f`, build 295, 2025-12-04). Running the extracted tool as a GDB child reproduced the stall: its stack blocked in OpenSSL's `CRYPTO_THREAD_read_lock` / `ossl_rand_get0_seed_noncreating`, through libcurl's TLS initialization while downloading the AppImage runtime. Repeating with only `OPENSSL_CONF=/dev/null` added succeeded, and then `OPENSSL_CONF=/dev/null pnpm tauri bundle --bundles appimage --ci` succeeded as well. The Linux build command and CI now use this process-local build environment. This is an observed packaging-tool compatibility workaround, not a change to application TLS validation or GPU policy.

CI currently runs interface tests in Chromium on Ubuntu. Rust checks on all three OSes do not exercise their WebViews. The Playwright configuration can select WebKit, but the CI browser installation and test command currently select Chromium only. Add production-frontend browser tests and native-host smoke tests; retain a physical-GPU matrix for frame pacing and clarity.

Current Tauri documentation recommends [WebdriverIO with `@wdio/tauri-service`](https://v2.tauri.app/develop/tests/webdriver/). Its embedded driver can cover Windows, Linux and macOS. Direct `tauri-driver` still has different platform coverage; do not assume the old macOS restriction applies to every modern testing route. Keep testing plugins out of production artifacts.

## Remaining validation

1. Test installed Windows/macOS packages on physical machines, including fractional scaling, mixed-DPI displays, graph interactions and the oldest supported macOS.
2. Reproduce the remaining whole-window blur independently of graph zoom. Test resize and cross-display movement while recording actual renderer and native/JavaScript dimensions.
3. Compare an updated distribution WebKitGTK against the current 2.54.1 baseline. Record exact library/driver versions and preserve the same workload.
4. Test Linux DEB/RPM/AppImage installations on the supported distributions, including the libraries actually loaded by AppImage.
5. Add a native renderer test matrix and a repeatable performance budget. Separate scheduling, real input latency, physical presentation, and visual sharpness.

Tauri 3's CEF runtime is an alternative experiment if a common Chromium engine becomes a product requirement. On this investigation date it is explicitly an alpha: the official migration guide advises keeping production applications on 2.x. It also changes dependencies, plugins, bundling and update responsibility, rather than being a Tauri 2 configuration toggle. See [the migration status](https://v3.tauri.app/start/migrate/from-tauri-2/) and [runtime comparison](https://v3.tauri.app/develop/webview-runtime/).

## Reproducing the measurements

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

Raw baseline results and limitations are archived in [desktop-rendering-2026-10-24.json](diagnostics/desktop-rendering-2026-10-24.json); the configured frontend's repeat measurement is in [desktop-rendering-configured-2026-10-24.json](diagnostics/desktop-rendering-configured-2026-10-24.json). Local screenshots and exploratory logs were saved under `/tmp/kubiki-rendering-2026-10-24/`. They are diagnostic artifacts, not release approval evidence.
