# README recordings

The README embeds five looping GIFs captured from the actual interface in the
built-in demo cluster: overview, Pod diagnostics, YAML, topology, and Helm.
Matching PNGs provide static alternatives. All files live in `docs/media/`.

## Regenerate

Install the project dependencies, a Playwright Chromium browser, and FFmpeg
(`ffmpeg` must be on `PATH`). If Chrome is installed at `/usr/bin/google-chrome`,
the script uses it automatically. Otherwise install Chromium with:

```sh
pnpm exec playwright install chromium
```

From the repository root, run:

```sh
pnpm docs:media
```

Record only selected scenes when iterating:

```sh
pnpm docs:media --scene resources --scene yaml
```

Other scene names are `overview`, `topology`, and `helm`. Set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to use a different Chromium executable.

The script starts its own Vite server on `127.0.0.1:1431` with an empty
kubeconfig and opens `?demo=1` in fresh browser contexts. It rejects Kubernetes
bridge requests. An occupied port fails the run instead of reusing another
server. It closes the browser and server after capture.

## Capture format

- 1440 × 900 pixels, dark theme, 100% interface scale, English labels.
- Actual mouse and keyboard interactions, with a visible cursor overlay.
- PNG frames sampled at approximately eight frames per second; GIF playback
  follows the measured recording duration.
- A shared 256-color palette per clip, no dithering on text and flat surfaces,
  and infinite loops.
- Overview waits for the built-in demo metrics history before capture.

The workflow checks the visible states it records and fails on uncaught browser
errors. Intermediate frames stay in a temporary directory on failure; its path
is printed for investigation. Successful runs remove those temporary files.

After recording, inspect the GIFs and their PNG alternatives for readable text,
clipping, loading states, and useful pacing. Keep clips short and check their
file sizes before committing. These browser recordings demonstrate interface
interactions; native Kubernetes operations require the desktop application.
