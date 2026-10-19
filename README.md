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

Обычный режим читает локальный kubeconfig. Для browser dev bridge нужен `kubectl` в PATH; desktop snapshots/scale/logs также пока используют kubectl. Browser preview без dev bridge показывает явную ошибку подключения.

Демо доступно отдельно: `http://localhost:1420/?demo=1`. Демо-сессии и ресурсы обозначены явно; ошибка реального API не переключает приложение на демо.

## Поведение

Клик по строке → подробности справа. Действия над объектом, включая scale Deployment/StatefulSet, → ПКМ. Внутри строк таблицы кнопок действий нет. Inspector содержит Overview / Related / Events / YAML; ссылки ведут по ownerReferences и другим API references, Namespace показывает свои ресурсы. Типы ресурсов отмечены цветными badges, причины проблем доступны при наведении или фокусе warning-значка. Annotations отображаются отдельными полями с раскрываемым исходным значением.

Откройте **Cluster topology** на левой служебной панели или **Topology** в подробностях ресурса. Общая вкладка предлагает выбрать namespace; целевой ресурс открывает своё окружение. Весь кластер автоматически не раскрывается: Cluster summary показывает счётчики namespace. Лимиты — 250 ресурсов / 1000 связей / 10 секунд раскладки; при превышении нужно сузить область. В выборе namespace/области есть поиск по имени, Related показывает связи порциями по 50. План дальнейших уровней и группировки — [задачи GRAPH-00…12](docs/10-IMPLEMENTATION-TASKS.md).

Ctrl/⌘ K — поиск, B — дерево, J — нижняя панель. Нижняя панель сохраняет состояние посещённых сессий при переключении и сворачивании.

В таблицах есть широкий поиск, фильтры проблем/статуса и сортировка: ошибки первыми, новые/старые, имя или колонка. Общий namespace выбирается один раз рядом с кластером. На диаграммах Namespace — рамка с ресурсами внутри, Events — отдельный компактный список сбоку. Произвольные custom resources пока не загружаются, доступны определения CRD.

Реальные логи пока читаются как tail 500 строк с обновлением раз в 3 с. Live exec/host/node shell, port-forward, apply/delete/restart/create ещё не подключены; UI обозначает ограничения. В реальном режиме YAML доступен для просмотра/копирования/скачивания. Наличие Rust API для подсистемы не означает завершённую интеграцию.

## Проверки

```sh
pnpm build
pnpm test
# Запустить pnpm dev перед browser tests
pnpm test:e2e
cargo test --manifest-path crates/kubiki-core/Cargo.toml --offline
cargo check --manifest-path src-tauri/Cargo.toml --offline
```

Playwright автоматически использует `/usr/bin/google-chrome`, если он установлен. Другой путь задаётся через `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`; при отсутствии системного Chrome используется стандартный браузер Playwright (`pnpm exec playwright install chromium`). Тесты работают в изолированном demo mode и с подставленными ошибками API; они не заменяют live cluster integration.
