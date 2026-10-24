# Internal tab metrics

Kubiki resource details, the extension manager, Redis and Kafka use the same
dimensions. Workspace document tabs are a separate navigation level.

The application owns these unscaled theme tokens in `src/App.css` and passes
them into SDK panels through `extensionTheme()`:

| Token | Default |
| --- | --- |
| `--tool-tab-height` | 28px |
| `--tool-tab-font-size` | 12px |
| `--tool-tab-line-height` | 16px |
| `--tool-tab-icon-size` | 13px |
| `--tool-tab-gap` | 5px |
| `--tool-tab-padding` | 12px |

Consumers multiply these lengths by `--ui-factor` exactly once. Set explicit
height, line height and padding so ordinary button styles, inherited fonts or
coarse-pointer rules cannot change tab dimensions. Labels determine tab width.
The strip adds 4 scaled pixels above the buttons and one unscaled border pixel.
Horizontal overflow scrolls without changing the strip height.

Application classes: `.kub-tool-tabs` and `.kub-tool-tab`. Independent extensions
use matching `.kub-tabs` and `.kub-tabs__btn` rules with the same fallback values,
so packages also work with earlier SDK hosts.

The Kafka cross-project Playwright test measures the actual application and
extension styles at 100%, the default Kubiki scale and 135%, on desktop and
coarse-pointer contexts:

```sh
cd ../kubiki-kafka
KUBIKI_TEST_APP_ROOT=../kubiki KUBIKI_TEST_REDIS_ROOT=../kubiki-redis npx playwright test tests/tab-parity.spec.mjs
```
