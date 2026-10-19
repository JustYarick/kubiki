# Задачи реализации Kubiki

Обновлено: 2026-10-20. Источник текущей стадии — [09](09-PROJECT-STATUS.md), аудит — [08](08-UX-TECHNICAL-AUDIT.md), журнал проверок — [07](07-UI-PROGRESS.md). Этапы связаны с roadmap 04 и каноническими UI-фазами 06.

Статусы: `TODO` — не начато, `IN PROGRESS` — выполняется, `PARTIAL` — реализована часть, `DONE` — реализовано и проверено, `DEFERRED` — отложено по запросу владельца. Наличие backend/UI само по себе не закрывает сквозной сценарий.

## Текущий блок: подробности, YAML и безопасные диаграммы

| ID | Приоритет | Задача | Статус | Критерий приёмки |
|---|---|---|---|---|
| UX-01 | P1 | Яркие типизированные badges в Related | DONE | Цвет, иконка и текст для kinds, в том числе незагруженных ссылок; переходы проверены |
| UX-02 | P1 | Построчное отображение annotations | DONE | JSON как поля, last-applied summary, раскрытие и копирование исходного значения; ограничены размер и глубина preview |
| YAML-01 | P0 | Воспроизвести и исправить null React dispatcher при открытии YAML | IN PROGRESS | Убрана React-обёртка Monaco, включён dedupe React; повторные открытия настоящего Monaco в inspector/tab/split проходят в Chromium. Исходный crash не воспроизведён; desktop/WebKit-подтверждение остаётся открытым (системных библиотек для WebKit нет) |
| YAML-02 | P1 | Lifecycle моделей/подписок редактора и изоляция ошибок | DONE | Независимые модели, cleanup instance/model/subscriptions; Ctrl/⌘S читает текущий draft; при ошибке загрузки модуля доступен textarea fallback с повтором загрузки |
| UX-03 | P1 | Индикаторы проблем ресурсов с причиной при наведении/фокусе | DONE | Общие правила в таблице/Related/inspector/topology; conditions/reason/message; проверены Completed, replicas=0 и обычный запуск. Полнота зависит от доступного snapshot, это не диагностика всех возможных неисправностей |
| UX-04 | P1 | Namespace Related и большие списки связей | DONE | Восстановлены contains-связи; построение только при открытии Related; поиск по имени/kind/namespace/типу связи; первые 50 и следующие порции по 50 |
| UX-05 | P1 | Единый глобальный выбор namespace с поиском | DONE | По последнему запросу выбор только рядом с кластером; в таблице и breadcrumbs дубли убраны. Поиск без учёта регистра, keyboard selection, порции по 50. Diagram scope остаётся локальной областью диаграммы |
| UX-06 | P1 | Фильтры, порядок и широкий поиск ресурсов | DONE | Health/status/search + глобальный namespace совместимы; ошибки → предупреждения → здоровые, newest/oldest по timestamp, name A–Z/Z–A, column sort. Неизвестные даты в конце. Широкий поиск, фильтры слева; высота панели стабильна при открытии inspector |
| GRAPH-SAFE | P0 | Безопасный выбор области и бюджеты диаграммы | DONE | Нет автоматического графа всего кластера; namespace/resource scope; cluster summary только counts. До layout проверяются 250 узлов / 1000 рёбер; worker отменяется через 10 с и освобождается; Pod не расширяется через общий Node/ConfigMap на всех потребителей; тест 5000 ресурсов |
| GRAPH-EVENTS | P1 | Отдельный остров событий вместо узлов Event | DONE | Event исключён до бюджетов и layout; последние 10 событий области, Warning/count/time, collapse, переход к ресурсу; события не сбрасывают позиции |
| GRAPH-NS | P1 | Namespace как контейнер | DONE | Compound ELK layout и React Flow parentId: namespaced ресурсы внутри рамки, Node/PV/StorageClass снаружи; оба направления, drag остаётся внутри |
| GRAPH-PERF | P0 | Устранить задержки pan/drag | DEFERRED | По запросу владельца из-за размытости восстановлены SVG, полные детали и прежние graphics settings; Canvas2D/LOD/culling эксперименты сняты. Исследование и harness сохранены в 11; проблема native pan остаётся открытой |
| NATIVE-01 | P0 | WebKitGTK/NVIDIA renderer | DEFERRED | A/B системного WebKit показал ~19 → ~60 FPS при отказе от forced DMABUF disable, но владелец предпочёл прежнюю чёткость и потребовал откат. Оба старых назначения flags восстановлены. Не продолжать без нового запроса; см. 11 |
| QA-01 | P1 | Регрессии и документация этого блока | DONE | 35 unit и 16 browser tests на dev/production пройдены; production build и diff check пройдены. WebKit не запустился из-за системных зависимостей; YAML-01 остаётся открытым, подробности в 07 |
| QA-02 | P1 | Приёмка Events/Namespace/filters и отката graphics | DONE | 45 unit, 19 production browser tests, build/offline cargo check/diff check пройдены. Native A/B и откат отдельно записаны в 11; performance-задачи не закрыты |

## Следующий milestone: живой диагностический MVP

| ID | Связь с планом | Задача | Статус | Зависимости / приёмка |
|---|---|---|---|---|
| DATA-01 | UI-1/4 | Typed ResourceRef/GVK и IPC ошибки | TODO | Явные context/group/version/kind/namespace/uid, 403/404/timeout, общий provider contract |
| DATA-02 | UI-4 | Исправить atomic snapshot/relist в Rust informer | TODO | DATA-01; удалённые во время disconnect объекты не остаются; namespace watchers не стирают соседние snapshots |
| DATA-03 | UI-4 | Watch/unwatch IPC и batching в UI | TODO | DATA-02; reconnect/backoff/first-sync/stale; context isolation |
| OPS-01 | UI-5 | Настоящий log stream | TODO | DATA-01; follow/tail/previous/since, контейнеры, cancel/reconnect |
| OPS-02 | UI-5 | Pod exec + host PTY: start/write/resize/close | TODO | DATA-01; многосессионность, exit/error, освобождение backend при закрытии |
| OPS-03 | UI-5 | Управляемый Node debug shell | TODO | OPS-02; создание/debug permissions, attach, cleanup и удаление orphan debug pod |
| OPS-04 | UI-5 | Доработать PF lifecycle и подключить UI | TODO | Отмена listener и дочерних соединений; Starting/Active/Failed; context и Service resolution |
| MUT-01 | UI-6 | YAML schema, dry-run, diff и live apply | TODO | DATA-01; 403/409/timeout не объявляются успехом; точная цель и conflict handling |
| MUT-02 | UI-7 | Реальные create/delete/restart через единый action pipeline | TODO | MUT-01; context/ns/name и подтверждение операции; строки таблицы остаются без action buttons |
| PERF-01 | UI-3/10 | Виртуализация таблиц и фильтры по вкладкам | TODO | Измерение 10k строк; отсутствие перехвата клавиатуры чужих панелей |
| GRAPH-00…12 | UI-3/7/10 | Многоуровневая интерактивная топология | PARTIAL | Подробные задачи и критерии ниже; базовые scopes уже реализованы |
| DOMAIN-01 | UI-7 | EndpointSlice/ServiceAccount/RBAC/HPA relationships | TODO | DATA-01; проверка ссылок и namespace/group, capability-aware UI |
| DOMAIN-03 | UI-7 | Dynamic discovery и экземпляры CRD на диаграммах | TODO | API discovery, typed GVK identity, загрузка произвольных resource plural/version/scope, RBAC/partial data, ownerReferences между custom и built-in объектами. Сейчас отображается только CustomResourceDefinition, произвольных custom instances нет |
| DOMAIN-02 | UI-8/9 | Metrics и Helm с явным context | TODO | Отдельные IPC/UI/live tests, отсутствие фиктивной телеметрии |
| RELEASE-01 | UI-11 | CI, desktop smoke, нагрузка и длительные сессии | TODO | Все MVP сценарии; Linux WebKit + macOS/Windows; измеренные бюджеты |

Порядок исполнения: текущий блок → DATA-01…03 → OPS-01/02/04 → OPS-03 и MUT-01/02 → PERF/GRAPH/DOMAIN → release QA. Для каждого рабочего блока в 07 записываются изменения, выполненные проверки и незавершённые пункты. Демо/подставленный API и настоящий кластер учитываются отдельно.

## Диаграммы: отдельный план по уровням

Продуктовая цель из запросов владельца: автоматически строить диаграммы Kubernetes на разных уровнях и исследовать их как диаграммы JetBrains IDE. Общая модель связей используется и в Related, и на холсте. Это топология конфигурации и зависимостей; временные графики CPU/RAM относятся к DOMAIN-02, а не подменяют этот план.

| ID | Уровень / функция | Статус | Реализовано / критерий приёмки |
|---|---|---|---|
| GRAPH-00 | Базовый интерактивный холст | DONE | React Flow + ELK worker, auto-layout, горизонтальное/вертикальное направление, Arrange/Fit/zoom/pan/minimap; клик → inspector; namespace/resource scopes и безопасный выбор области; см. GRAPH-SAFE |
| GRAPH-01 | Обзор кластера | TODO | Агрегаты Namespace/Node/Workload; число и состояние Pod; свёрнутые группы; переход в namespace/Node. Не рисовать все Pod кластера при первом открытии. Сейчас cluster summary показывает только counts по namespace и переходы, агрегированного графа ещё нет |
| GRAPH-02 | Диаграмма namespace | PARTIAL | Рамка namespace с ресурсами внутри, внешние Node/storage снаружи и compound layout реализованы (GRAPH-NS). Workload subgroups, network paths, раскрытие групп и приглушение внешних зависимостей ещё TODO |
| GRAPH-03 | Workload: Deployment/StatefulSet/DaemonSet/Job | TODO | Deployment → ReplicaSet → Pod; различение ревизий и ready/failed; StatefulSet → Pod/PVC; DaemonSet → Pod/Node; Job/CronJob ownership. Базовые owner-reference рёбра уже строятся |
| GRAPH-04 | Окружение Pod | TODO | Owner chain, Node, Services/EndpointSlices, ConfigMap/Secret, PVC/PV/SC, ServiceAccount. Init/sidecar/ephemeral containers как раскрываемые внутренние узлы. Базовый resource scope с глубиной 1–3 и остановка расширения через общие Node/ConfigMap/Secret/StorageClass уже есть |
| GRAPH-05 | Размещение на Node | TODO | Node → namespaces/workloads/Pods; pressure/readiness и выделение проблем; capacity/allocatable/requests/limits/usage раздельно. Базовое schedules-ребро уже есть; сравнение нагрузок требует DOMAIN-02 |
| GRAPH-06 | Сетевой путь | TODO | Ingress → Service → EndpointSlice → Pod, порт/targetPort, ready/not-ready endpoints; учитывать selectorless Service и ExternalName. Конфигурационный путь не объявляется доказанным сетевым трафиком |
| GRAPH-07 | Хранилище и конфигурация | TODO | Pod → PVC → PV → StorageClass; mounted volumes/env/envFrom/projected refs; обратные consumers; причины Pending и WaitForFirstConsumer. Для Secret — только reference/key metadata, без значений |
| GRAPH-08 | Исследование графа в стиле IDE | TODO | Контекстные Open details/YAML/logs/shell; раскрыть соседей, свернуть группу, focus/back, поиск, фильтры kinds/edge types, legend; клавиатурная навигация. На каждом узле цветной kind badge и общий warning tooltip |
| GRAPH-09 | Инкрементальная раскладка | TODO | Сохранять ручные позиции и viewport; перестраивать затронутую часть; отменять устаревший worker; Arrange — явное полное переупорядочивание. Сейчас при обновлении snapshot раскладка может сбрасываться |
| GRAPH-10 | Большие кластеры и неполные права | TODO | Lazy expansion, агрегированные узлы, уровни детализации по zoom; loaded/forbidden/not-found состояния; не трактовать неполную загрузку как отсутствие связей. Предварительные бюджеты, отмена layout, счётчики namespace и общее предупреждение о недоступных kinds уже есть (GRAPH-SAFE); настоящая нагрузочная приёмка и группировка ещё нет |
| GRAPH-11 | Сохранение и экспорт | TODO | Layout по context/scope, экспорт SVG/PNG/JSON, имя/context/ns/время и легенда; секретные данные не попадают в экспорт |
| GRAPH-12 | Приёмка всех уровней | TODO | Seed namespace с owner/network/storage цепочками; браузерные переходы cluster → namespace → workload → Pod → Node; RBAC partial data; reconnect/delta; измерение больших графов, WebKit и production bundle |

Порядок: GRAPH-00 (готов) → GRAPH-01/02/03/04 (первый удобный обзор) → GRAPH-05/06/07 → GRAPH-08/09/10 → GRAPH-11/12. DATA-01/03 и DOMAIN-01 обеспечивают полноту и актуальность данных; первый UX-проход группировки может использовать уже загруженные snapshots, не объявляя live watch готовым.
