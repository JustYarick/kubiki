# Kubiki

Desktop IDE для Kubernetes: Tauri 2, Rust (`kubiki-core`), React 19 / TypeScript, Monaco, xterm.js. Дизайн ориентирован на Lens и JetBrains/VS Code.

**Стадия: early alpha / pre-MVP.** [Фактический статус](docs/09-PROJECT-STATUS.md), [UX и технический аудит](docs/08-UX-TECHNICAL-AUDIT.md), [документация](docs/README.md).

## Запуск

```sh
pnpm install
pnpm dev
# Desktop: нужны Rust и системные зависимости Tauri
pnpm tauri dev
```

Обычный режим читает локальный kubeconfig. Для browser dev bridge нужен `kubectl` в PATH; desktop списки ресурсов используют kube-rs watch через Tauri Channels, desktop logs/exec используют kube-rs; scale и browser logs пока используют kubectl. В browser dev списки остаются snapshots с ручным Sync. Browser preview без dev bridge показывает явную ошибку подключения.

Демо доступно отдельно: `http://localhost:1420/?demo=1`. Демо-сессии и ресурсы обозначены явно; ошибка реального API не переключает приложение на демо.

## Поведение

Клик по строке → подробности справа. Действия над объектом, включая scale Deployment/StatefulSet, → ПКМ. Внутри строк таблицы кнопок действий нет. Inspector содержит Overview / Related / Events / YAML; ссылки ведут по ownerReferences и другим API references, Namespace показывает свои ресурсы. Events исключены из Related: уведомления только выбранного объекта доступны в его вкладке **Events** (причина, сообщение, Warning/Normal, время, повторы и поиск). Типы ресурсов отмечены цветными badges, причины проблем доступны при наведении или фокусе warning-значка. Annotations отображаются отдельными полями с раскрываемым исходным значением.

Откройте **Cluster topology** на левой служебной панели или **Topology** в подробностях ресурса. Общая вкладка предлагает выбрать namespace; целевой ресурс открывает своё окружение. Весь кластер автоматически не раскрывается: Cluster summary показывает счётчики namespace. Лимиты — 250 ресурсов / 1000 связей / 10 секунд раскладки; при превышении нужно сузить область. В выборе namespace/области есть поиск по имени, Related показывает связи порциями по 50. План дальнейших уровней и группировки — [задачи GRAPH-00…12](docs/10-IMPLEMENTATION-TASKS.md).

Ctrl/⌘ K — поиск, B — дерево, J — нижняя панель. Нижняя панель сохраняет состояние посещённых сессий при переключении и сворачивании.

Settings → Appearance: масштаб интерфейса **80–200%** (по умолчанию **110%**, базовый UI-шрифт 13 CSS px при 100%), отдельно размер YAML и терминала **10–24 px** (по умолчанию 14 px). Изменения применяются сразу и сохраняются. Ctrl/⌘ `+` / `−` меняют масштаб, `0` восстанавливает стандартный, `,` открывает настройки. Собственный zoom диаграммы управляется на холсте.

В desktop таблицы и подробности обновляются по live watch; status bar показывает синхронизацию и переподключение. Relist атомарно заменяет полный список; Sync/Retry пересоздают подписки. Ошибки чтения ресурсов показывают причину и подсказку для RBAC/auth/timeout. Ошибка refresh сохраняет последний snapshot с отметкой об устаревании; Retry повторяет запрос. Вкладка подробностей/YAML не переключается на новый объект после пересоздания ресурса с тем же именем. Контракты и ограничения — [12](docs/12-DATA-CONTRACT-AND-APPEARANCE.md).

В таблицах поиск и фильтры стоят в одной строке: проблемы/статус и сортировка (ошибки первыми, новые/старые, имя или колонка). В узкой панели фильтры доступны через `Filters`, поиск сохраняет доступную ширину. Общий namespace выбирается один раз рядом с кластером. В desktop это также область live watch: ресурсы другого namespace выгружаются, кластерные остаются. Если список namespaces запрещён RBAC, введите имя в поиске picker и выберите `Use namespace: …`. Открытые вкладки и диаграммы вне области предлагают `Load namespace …`, не объявляя ресурс удалённым. На диаграммах Namespace — рамка с ресурсами внутри, Events — отдельный компактный список сбоку. Произвольные custom resources пока не загружаются, доступны определения CRD.

В desktop логи идут настоящим потоком: Pod → Logs → Log options для выбора tail/периода/Previous container и Reconnect. Pause останавливает чтение, Resume заново загружает tail; история ограничена. В browser dev пока tail 500 строк раз в 3 с. Desktop Pod shell подключён через kube-rs/Tauri/xterm: ввод, resize, exit/error, явный reconnect и cleanup. В логах и shell есть выбор обычных/init/sidecar/ephemeral контейнеров со статусами; toolbar логов адаптивен. Подробности — [13](docs/13-POD-SESSIONS.md), [14: поток логов](docs/14-POD-LOG-STREAMS.md). Локальный host terminal подключён: нижняя панель → Open Local Terminal (Host PC), либо `+` → Local Terminal; системный shell и домашняя папка, ввод/Ctrl-C/resize/exit, явный reconnect и cleanup. Работает в desktop без подключения к кластеру; в browser показано требование desktop. См. [15](docs/15-HOST-TERMINAL.md). Node shell подключён: Nodes → Node shell → namespace/image → Start; privileged helper автоматически удаляется при завершении, ошибки cleanup доступны для повтора. См. [16](docs/16-NODE-SHELL.md). Secret → Overview → Edit data: отдельные строки ключей, Text/Base64, автоматическое кодирование и live save с UID/resourceVersion; см. [17](docs/17-SECRET-EDITOR.md). Port-forward, YAML apply/delete/restart/create ещё не подключены; UI обозначает ограничения. В реальном режиме YAML доступен для просмотра/копирования/скачивания. Наличие Rust API для подсистемы не означает завершённую интеграцию.

## Проверки

```sh
pnpm build
pnpm typecheck
pnpm test
# Запустить pnpm dev перед browser tests
pnpm test:e2e
cargo test --manifest-path crates/kubiki-core/Cargo.toml --offline
cargo check --manifest-path src-tauri/Cargo.toml --offline
```

Playwright автоматически использует `/usr/bin/google-chrome`, если он установлен. Другой путь задаётся через `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`; при отсутствии системного Chrome используется стандартный браузер Playwright (`pnpm exec playwright install chromium`). Тесты работают в изолированном demo mode, с подставленными ошибками API и Tauri IPC; Rust tests проверяют kube-rs watcher и exec через локальный HTTP/WebSocket API; они не заменяют live cluster integration.

## Лицензия

Kubiki распространяется под [Apache License 2.0](LICENSE). Лицензии сторонних зависимостей сохраняются за их правообладателями.


Общая статистика: **Overview** в левом Cluster Explorer (или «+» у вкладок). При All Namespaces — сводка кластера, при выбранном namespace — только его ресурсы. Counts, Pod phases, restarts, проблемы и переходы к объектам используют текущие watch/snapshots; недоступные данные отмечены отдельно. CPU/RAM подключены через Metrics API: history/gauges, requests/limits, node capacity/allocatable, consumers и контейнеры; требуется доступ к metrics.k8s.io. История накапливается во время наблюдения; см. [19](docs/19-OVERVIEW-TELEMETRY.md). См. [18](docs/18-OVERVIEW.md).
