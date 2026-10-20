# Стадия проекта и сверка документации

Актуально на 2026-10-20. Основание: исходный код, сборки и тесты текущей сессии. Подробные находки: [08 — аудит](08-UX-TECHNICAL-AUDIT.md). Текущий журнал: [07 — прогресс](07-UI-PROGRESS.md).

## Стадия

**Early alpha / pre-MVP.** UI-прототип переходит к частичной интеграции с Kubernetes. Базовый desktop цикл connect → watch → inspect → real logs/exec → cleanup подключён. До рабочего аналога Lens остаются native/live приёмка этого цикла и port-forward, общий mutation pipeline, dynamic discovery и производительность больших наборов.

Архитектурные заготовки Rust не эквивалентны готовому приложению. Наличие пакета в `package.json` не доказывает интеграцию: dockview и TanStack Table/Virtual установлены, но текущая рабочая область/таблицы их не используют.

## Соответствие основному roadmap (04)

| Фаза | Реальное состояние |
|---|---|
| 0. Окружение и CI | Tauri/React, зависимости, сборка есть; CI, генерация IPC типов и release pipeline отсутствуют |
| 1. Core/Kubeconfig | Сервисы и CLI есть; клиентский пул и базовый health; полноценный multi-cluster session lifecycle не завершён |
| 2. IDE shell | Дерево/табы/split/inspector/dock есть; только dark, полноценный dockview не интегрирован |
| 3. Watch/таблицы | Desktop watch подключён через Tauri Channels; atomic relist, bounded batching, reconnect/stale, lifecycle и context isolation покрыты локальным HTTP/API и browser IPC tests. Browser — snapshots; namespace-scoped UI и ручной ввод при RBAC подключены; native/live QA, lazy subscriptions и virtualization ещё открыты |
| 4. Pod Ops | Desktop Pod exec подключён (WebSocket/Tauri/xterm, ввод/resize/exit/cleanup), backend проверен на живом Pod; полная native GUI QA ещё открыта. Desktop logs подключены потоком с tail/since/previous/cancel/reconnect; browser logs пока snapshots. Host PTY подключён (portable-pty/Tauri/xterm, реальные Linux PTY tests); Node debug подключён (privileged helper/host chroot/UID cleanup/retry), live/native QA остаётся; Pod/Service PF подключён с UID/context/listener cleanup и IPC/protocol tests; native PF QA остаётся |
| 5. Config/Network/Storage/RBAC | Фиксированные списки и детали; ServiceAccount/Role/RoleBinding/ClusterRole/ClusterRoleBinding доступны read-only в Explorer через общий resource API. Построчное live редактирование Secret data с Text/Base64 и UID/resourceVersion подключено. RBAC graph links и cluster dependencies подключены; NetworkPolicy, quotas/HPA/EndpointSlice и live/native QA остаются |
| 6. YAML/CRD | Monaco, просмотр/экспорт и demo edit; live apply/diff/schema и dynamic CRD explorer отсутствуют |
| 7. Helm | Read-only UI/IPC/browser bridge подключены: paged releases, context/namespace, overview/history/values/manifest/notes и локальные repositories. Explicit context/revision, ошибки/лимиты и late responses покрыты тестами; Основные desktop mutations через backend consent и связанные K8s-объекты/диаграммы подключены; native/live/Helm 4 QA и расширенные сценарии остаются. См. [24](24-HELM-OPERATIONS-AND-RBAC.md). См. [23](23-HELM.md) |
| 8. Метрики | Metrics API подключён в desktop/browser Overview: CPU/RAM usage, configured requests/limits, capacity/allocatable, bounded SVG history/gauges и consumers/containers. Prometheus/history backfill/quotas/native QA остаются |
| 9. Production | Некоторые настройки/палитра; плагины, release QA, CI, cross-platform tests не завершены |

Фазы не завершались последовательно. Корректнее говорить «части фаз 0–6 реализованы», чем «сейчас фаза 6, осталось 7–9».

Events уже включён в общий каталог и Explorer: Cluster → Events (ресурсный список), а сводный поток доступен в нижней панели. Его также можно открыть через поиск дерева, если группа Cluster свёрнута. В этой итерации добавлены пять основных RBAC kinds; см. задачи DOMAIN-01A/B и DOMAIN-02C1–C3 в [10](10-IMPLEMENTATION-TASKS.md).

Последний UX-блок: цветные kind badges, построчные annotations/last-applied, общие warning indicators, восстановленный Namespace Related с поиском и порциями по 50. Диаграммы открываются с выбором области; cluster summary — counts only. Namespace/resource графы проверяют бюджеты до layout (250 узлов / 1000 рёбер), worker ограничен 10 секундами. Агрегированные многоуровневые диаграммы пока остаются в плане. YAML использует Monaco напрямую, с cleanup моделей и fallback; точный заявленный React dispatcher crash в Chromium не воспроизведён, подтверждение в desktop/WebKit ещё требуется.

Дополнено: Namespace frames с ресурсами внутри, отдельный Events island (Event исключён из графа); Event также исключён из Related, включая Namespace membership. Вкладка Events показывает уведомления самого объекта по UID/kind/group/namespace/name, с поиском, последним временем, счётчиком повторов и порциями по 50. Реализованы совместимые health/status/search фильтры и сортировка проблем/даты/имени. Глобальный namespace picker один, рядом с кластером. Произвольные экземпляры CRD не загружаются (DOMAIN-03). По новому запросу владельца native graphics исследование возобновлено: убраны дублирующие forced DMABUF-disable, введены auto/compatibility/system профили. Текущий SVG в полном Tauri debug: 10.84 → 56.75 rAF FPS (synthetic fixture). Чёткость на fractional DPI и физические live-нагрузки остаются QA; SVG/CSS/масштаб не менялись. См. [11](11-TOPOLOGY-PERFORMANCE.md).

## Сверка документов

Дополнено (DATA-01A/B, UX-07/08, YAML-03): общий каталог GVK и типизированные ошибки HTTP/Tauri, подсказки RBAC/timeout и stale snapshot/Retry; group/UID identity защищает вкладки от пересоздания объекта. Масштаб UI 80–200% с default 110%, независимые editor/terminal fonts и persistence подключены. Поиск/фильтры адаптивны и занимают одну строку; на узкой панели фильтры в меню. Воспроизведённая потеря символов Monaco исправлена. DATA-01 целиком остаётся PARTIAL: named operations ещё требуют миграции на ResourceRef/preconditions. DATA-02/03A завершены: desktop watch/relist подключены. DATA-03B2/3 и DATA-03C (lazy subscriptions, native/live QA и browser watch) ещё открыты. Desktop logs/Pod exec streams подключены; browser logs и native/cross-platform приёмка остаются открыты. Подробности — [12](12-DATA-CONTRACT-AND-APPEARANCE.md).

| Файл | Что это на самом деле | Расхождения и исправления |
|---|---|---|
| `README.md` | Был неизменённый Tauri template | Заменён описанием реального запуска, demo/live и ограничений |
| `01-RESEARCH-ANALYSIS.md` | Исследование и продуктовые ориентиры | Количества stars, состояния сторонних проектов и оценки RAM привязаны ко времени; не результаты измерения Kubiki. Не использовать как свидетельство готовности |
| `02-ARCHITECTURE-AND-DESIGN.md` | Целевая архитектура | Показаны несуществующие директории `src-tauri/src/terminal`, `ipc`, `plugin`; домен находится в `crates/kubiki-core`, IPC команды в `src-tauri/src/k8s_commands.rs`, регистрация в `lib.rs`. Общие query/error contracts добавлены, но генерация IPC типов/no-polling/10–15× RAM ещё не выполнены/не измерены |
| `03-KUBERNETES-SPECIFICATION.md` | Целевой каталог функциональности | Фраза «покрывает 100%» неверна для реализации: RBAC/HPA/NetworkPolicy/EndpointSlice и операции отсутствуют. Добавлено явное указание, что это план |
| `04-ROADMAP.md` | Порядок работ и задачи | Нет фактических статусов; таблица выше сопоставляет фазы с кодом. Дополнена ссылкой на status report |
| `05-HEADLESS-CORE-API.md` | API существующих сервисов | «100% готов, протестирован» завышено: исходно 2 unit + 3 integration tests, причём integration проверяют bus/store/serialization, не кластер. Exec default был заведомо невалиден для TTY; PF/watch/Helm имеют открытые lifecycle/context риски |
| `06-UI-BUILD-PLAN.md` | Основной целевой UI-план | Initial-state устарел. Его `UI-2=docking`, `UI-5=Pod Ops`, `UI-8=metrics`, `UI-9=Helm`, `UI-11=light` расходились с нумерацией журнала 07. Каноническая нумерация — в 06; критерии приёмки не считаются пройденными по одному наличию компонента |
| `07-UI-PROGRESS.md` | Журнал сессий | Ранее «2 команды IPC, mock only, tabs в очереди» уже расходилось с 6 командами и частичной kubectl интеграцией. Новый актуальный блок отделён от исторических записей |
| `08-UX-TECHNICAL-AUDIT.md` | Новый аудит | P0–P2, внесённые исправления, открытые риски, UX спецификация и выбор движка диаграмм |
| `09-PROJECT-STATUS.md` | Этот status report | Краткий фактический источник для решения, что делать дальше |
| `10-IMPLEMENTATION-TASKS.md` | Исполняемый backlog | Статусы UX/YAML/QA, безопасные scopes и дальнейшие диаграммы cluster → namespace → workload → Pod/Node; acceptance criteria и зависимости |

## Как учитывать готовность дальше

Для каждой функции отдельно хранить: **UI / backend / IPC / live integration test / release QA**. Статус «готово» допустим после проверки всего пользовательского сценария. Демонстрационный сценарий отмечается demo, снимок — snapshot, полноценный поток — stream. Не закрывать фазу по зелёной TypeScript сборке.

Ближайший релизный milestone: один реальный тестовый кластер, корректный watch/relist, подробности и ownership navigation, поток логов, exec с resize и cleanup, работающий PF, ошибки RBAC/timeout/reconnect. Затем YAML mutations с dry-run/diff/conflict и production-эргономика. Диаграммы могут развиваться параллельно после стабилизации общей модели ссылок, не заменяя интеграцию.

Pod-сессии дополнены: [13](13-POD-SESSIONS.md). Общая модель normal/init/native-sidecar/ephemeral, status icons и общий picker в логах/shell; toolbar логов адаптивен. Контекстное меню исправлено; terminal/log вкладки сохраняются при навигации. DATA-01C остаётся PARTIAL: exec и desktop logs проверяют UID перед открытием транспорта, остальные named operations и атомарные preconditions ещё не завершены.

Desktop log stream (OPS-01A) подключён: follow/tail/since/previous, остановка и явный reconnect, bounded UTF-8/history/IPC, общий container picker; [14](14-POD-LOG-STREAMS.md). OPS-01 остаётся PARTIAL: browser stream и native GUI/длительная QA ещё открыты.

Host terminal (OPS-02B) подключён: без kubeconfig/кластера, доступные системные shell, home directory, stdin/UTF-8/Ctrl-C/TTY resize/exit, независимые сессии и cleanup; [15](15-HOST-TERMINAL.md). OPS-02 остаётся PARTIAL: нативная GUI/длительная/cross-platform приёмка OPS-02C ещё открыта.


Последний блок: завершившиеся контейнеры серые, Pending синий, Warning жёлтый; переключатель интервалов синхронизации удалён, ручной Sync сохранён. Меню Columns действительно переключает видимость; Name обязателен, колонка номеров имеет сохраняемую ширину/resize/reset. В Secret data общий работающий Text/Base64 рядом с Reveal; строки редактируются/добавляются/удаляются, ошибки и обновления watch сохраняют draft. Детали контрактов и границ: [16 — Node shell](16-NODE-SHELL.md), [17 — Secret editor](17-SECRET-EDITOR.md).


Overview кластера/namespace подключён (UX-17): следует глобальному scope/context, агрегирует counts/Pod phases/restarts/diagnostics из текущих snapshots, выделяет partial/stale и позволяет открыть списки/объекты. Cluster-scoped ресурсы не попадают в namespace summary; Event не входит в общий object count. Дополнительных watches нет. Usage metrics и короткая история наблюдений подключены DOMAIN-02A; Prometheus/history backfill, quotas и native metrics QA остаются TODO, DOMAIN-02 PARTIAL. См. [19](19-OVERVIEW-TELEMETRY.md). См. [18](18-OVERVIEW.md).


Защита записи WRITE-GUARD-01: backend prepared mutation, точный diff, системное подтверждение, повторный GET и Kubernetes preconditions; 120-секундный одноразовый review, без автоматического retry. Node helper создаётся только после подтверждения privileged manifest; создание также разрешает UID-scoped cleanup этого временного Pod. Осиротевший helper требует отдельного подтверждения при ручном удалении. HTTP mutation endpoints отклоняются. Автоматические Rust/TS/browser-тесты проходят; native dialog acceptance на других ОС и live QA отдельны. См. [22](22-MUTATION-SAFETY.md).


Актуальная очередь замечаний от 2026-10-20 реализована: RBAC/Helm relationships, compact Types popover (без потери ширины/позиций холста), единое название Topology, Node auto-connect через guarded helper, компактный adaptive Overview + Critical/Warning Problems, table fit по текущему pane и обязательный выбор контейнера перед Logs/Shell у multi-container Pod. 214 unit, 70 Rust, полный production browser suite 92/92; дополнительные targeted проверки после финальных уточнений — в [07](07-UI-PROGRESS.md). Native/live/Helm 4 QA и произвольные CR instances остаются открытыми; стадия проекта не повышается до release-ready.
