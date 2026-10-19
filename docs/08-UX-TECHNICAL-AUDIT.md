# Аудит Kubiki: UX, Kubernetes и техническая готовность

Дата: 20 октября 2026. Проверено исходное состояние репозитория и изменения текущей сессии. Это аудит реализации; документы 01–06 описывают в основном целевой продукт.

## Вывод и стадия

**Ранняя alpha, до завершения MVP.** Есть работоспособная оболочка desktop IDE, таблицы и отдельные Rust-сервисы. Подключение Kubernetes — частичное: чтение снимков через kubectl, health/namespaces через kube-rs в Tauri, отдельная команда scale. Полноценной цепочки watch → IPC → UI и менеджера интерактивных сессий пока нет.

Говорить «почти Lens, осталось поправить CSS» неверно: основная проблема — непоследовательное поведение и расхождение между отображением и фактическими действиями. Процент общей готовности без согласованного объёма MVP был бы произвольным. Нужна матрица функций и проверяемые критерии приёмки.

## Что уже было сделано хорошо

- React 19, TypeScript strict, Tauri 2; доменные сервисы выделены в отдельный headless Rust-крейт.
- Локальные Inter/JetBrains Mono, CSS-токены, единый набор иконок, тёмная палитра, похожая на JetBrains New UI.
- Дерево ресурсов, фильтры, сортировка, изменение ширины и видимости колонок, контекстные меню, палитра, сохранение настроек.
- Monaco и worker загружаются локально; YAML-редактор вынесен из стартового кода.
- Панельная структура уже соответствует IDE: navigation → editor → inspector, внизу инструменты.
- В ядре есть kubeconfig, клиентский пул, watcher/store/event bus, сервисы logs/exec/port-forward, discovery, metrics и Helm CLI wrapper.

Это хорошая основа. Полностью менять стек или начинать UI заново не требуется.

## Фактическая готовность после текущих исправлений

| Подсистема | Есть сейчас | Чего не хватает до MVP |
|---|---|---|
| Оболочка, навигация | Дерево, вкладки, ручной split, inspector, dock, resize, палитра | Перетаскиваемый docking, история workspace, завершённая клавиатурная навигация |
| Таблицы | Снимки 18 фиксированных kinds, фильтры/сортировка/колонки | Виртуализация, постраничная загрузка, раздельное состояние поиска на вкладках |
| Строки таблиц | Обычные данные, клик открывает подробности; действия через ПКМ | Полноценное доступное с клавиатуры контекстное меню |
| Подключение | Явные ошибки; демо только через `?demo=1`; защита от поздних ответов предыдущего контекста | Подписки, reconnect/backoff, first-sync/stale статусы, auth/RBAC UX |
| Просмотр ресурса | Overview/Related/Events/YAML в inspector и detail tab; metadata, containers, probes, limits, conditions, labels, annotations, volumes | Специализированные подробности всех kinds, init/ephemeral container actions, метрики |
| Связи | UID ownerReferences, Pod–Node, Service selector, Ingress backend, env/volume refs, PVC/PV/SC, Namespace | EndpointSlice, ServiceAccount/RBAC, HPA, admission/CRD-specific ссылки; загрузка отсутствующего объекта по ссылке |
| Диаграммы | React Flow + ELK worker; cluster/namespace/resource scopes, depth 1–3, auto-layout, pan/zoom/minimap, переход в inspector | Группировка namespace/workload, агрегаты для больших кластеров, экспорт, сохранение ручных позиций, фильтры типов связей |
| Логи | Реальный tail 500 строк через kubectl, выбор контейнера, обновление каждые 3 с, pause/filter/export | Push streaming, previous/follow/since/tail options, несколько источников, корректный reconnect |
| Терминалы Pod/Node/host | Выбор цели и UI сессии; симулятор только в демо | Реальные start/write/resize/close IPC, PTY, exec lifecycle; live UI честно сообщает, что transport не подключён |
| Port-forward | Демонстрационный менеджер; live создание заблокировано | Подключение Rust manager к UI, корректные Starting/Failed/Stopped, Service target, очистка дочерних соединений |
| Events | Реальные snapshots и связь с выбранным ресурсом | Watch, агрегация/сортировка по времени, переходы из глобальной ленты |
| YAML | Полный реальный манифест, просмотр/копирование/скачивание; demo edits | Schema validation, dry-run, diff, apply/patch с resourceVersion conflict handling |
| Scale | Deployment/StatefulSet через IPC/dev endpoint; успех только после ответа | Согласованное ожидание rollout; RBAC capability checks |
| Create/Delete/Restart/Rerun | Демонстрационные операции либо явная недоступность | Реальные команды и единый mutation pipeline |
| Helm/метрики/dynamic CRD/RBAC | Часть сервисов Rust; UI для многих разделов отсутствует | IPC, представления и live integration tests |
| Тестирование | Frontend regressions + browser scenarios; Rust unit/integration tests | Настоящий kind/k3d cluster, smoke desktop WebKit, длительные session/load тесты и CI |

## Критические находки в исходном коде

| Приоритет | Находка и последствие | Где | Состояние |
|---|---|---|---|
| P0 | Ошибка API превращалась в успешный Connected и вымышленные объекты | `k8s_provider.ts`, `App.tsx`, `vite.config.ts` | Исправлено: live ошибки не подменяются демо |
| P0 | Mock watcher запускался для реального кластера и менял отображаемые Pod статусы | `App.tsx`, `mock_watch_engine.ts` | Ограничен явным demo mode |
| P0 | Vite bridge интерполировал context/name/ns/replicas в shell-команды | `vite.config.ts` | `execFile` с argv, whitelist kinds, проверка scale; никаких shell-строк |
| P1 | Два независимых dock state: панели/кнопки переключали разные состояния | `ui_store.ts`, `dock_store.ts`, layout и PF dialog | Один dock store для всех точек входа |
| P1 | Resource-detail/logs/terminal tabs показывали таблицу по умолчанию | `WorkspaceArea.tsx` | Отдельные обработчики содержимого; общий контент подробностей |
| P1 | Идентичность вкладок/сессий не учитывала namespace и context | `workspace_store.ts`, `dock_store.ts` | Ключ включает context/kind/namespace/name/container |
| P1 | Старые ответы загрузки могли попасть в новый контекст | `App.tsx`, breadcrumb context switch, refresh actions | Generation guard + очистка ресурсов/selection/сессий |
| P1 | Scale сначала рисовал успех и Ready=N/N, игнорируя ошибку сервера | `ResourceView.tsx` | Сначала ответ API, затем refresh; готовность не выдумывается |
| P1 | Отсутствующий kind молча запрашивал Pods | Tauri и Vite bridge | Явная ошибка, добавлены ReplicaSet/Event/CRD |
| P1 | Подробности не обновлялись после watch delta/snapshot/delete | `resource_store.ts` | Selection синхронизируется со store |
| P1 | `tty=true` и `stderr=true` в default exec запрещены kube-rs | `crates/kubiki-core/src/pod_ops/exec.rs` | Исправлены default и attach; добавлен regression test |
| P2 | Док пересоздавал терминал/логи при переключении и сворачивании | `App.tsx`, `BottomDock.tsx` | Посещённые сессии сохраняют компоненты; скрытый log polling остановлен |
| P2 | Pause логов заново генерировал исходный tail | `BottomDock.tsx` | Отдельные reset и polling effects |
| P2 | Refresh таблицы и Auto Sync имитировали работу | `ResourceView.tsx`, `TitleBar.tsx` | Настоящие запросы; auto-sync действует |
| P2 | Глобальные обработчики стрелок/Enter перехватывали ввод из других панелей | `ResourceView.tsx` | Навигация ограничена фокусом таблицы |
| P2 | Реальный YAML всегда был пуст, Secret показывал константный «пароль» | mapper, inspector | Сохранён raw manifest; показ реальных data keys, masking + base64 decoding |
| P2 | Глобальный поиск смотрел первые 12 объектов каждого kind | `CommandPalette.tsx` | Поиск по всем загруженным объектам |
| P2 | Переключатель/статус дока и CPU/RAM были фиктивными | `StatusBar.tsx` | Реальные счётчики UI; фиктивная телеметрия убрана |
| P2 | Малое окно + inspector выдавливали центральную часть | `App.tsx` | На узком окне explorer временно скрывается, inspector ограничивается доступной шириной |

## Открытые технические риски

1. **Watcher relist:** `Init/InitDone` только логируются; `InitApply` отправляется как Applied. После потери watch удалённые объекты могут оставаться в cache. Нужна атомарная замена snapshot с учётом namespace и unit tests re-list/reconnect. Одновременно несколько namespace-watch используют один kind store: нельзя исправлять простым безусловным clear.
2. **Port-forward lifecycle:** stop abort-ит listener task, а `tokio::spawn` для уже принятых соединений остаются отдельными задачами. Байты начисляются после завершения copy; ошибки portforward не доходят до session status; session key не включает context. Не подключать UI к этому manager без доработки.
3. **Helm context:** методы не принимают context и могут действовать на текущий context внешнего helm, отличный от выбранного в UI. Исправить контракт до включения mutation actions.
4. **Cluster client pool:** read/build/write может создать несколько клиентов на один context при параллельном старте; в Tauri пул теперь общий, но single-flight создания ещё нужен.
5. **Крупные компоненты:** BottomDock и ResourceView совмещают model/controller/render. Выделить panes, columns, action registry, stream lifecycle hooks. Это целевая следующая работа, а не повод одновременно переписывать весь проект.
6. **Нет генерируемого IPC контракта:** `any` в mapper/raw и строковые команды требуют типизированных границ и runtime validation. Raw JSON нормален как граница, но не должен растекаться по логике.
7. **Предварительная загрузка всех kinds:** упрощает первую топологию, но дорога и часто запрещена RBAC; нужны lazy queries, loaded/loading/forbidden состояния, namespace fallback и graph completeness indicator. Namespace discovery может быть запрещён отдельно от доступа к Pod.
8. **Таблицы без виртуализации.** Установленные TanStack зависимости ещё не означают использование. Тысячи строк и 18 одновременных list-запросов требуют измерения и пересмотра.
9. **Workspace/YAML lifecycle:** персистентность вкладок есть, но draft persistence и предупреждение о закрытии несохранённого demo draft ещё не завершены; live editor оставлен read-only до правильного mutation pipeline.
10. **Граф отображает конфигурацию, а не фактический трафик:** Service selector не доказывает ready endpoint или сетевую доступность. NetworkPolicy/CNI/mesh/DNS и actual traffic требуют отдельной модели.
11. **Безопасность desktop-релиза:** CSP сейчас выключена; kubeconfig/Secrets в памяти требуют отдельного review, исключения чувствительных данных из persisted state/логов и согласованного управления привилегированным Node debug lifecycle.
12. **Нет CI и live coverage.** Успешные unit tests не доказывают работу exec, port-forward, авторизации или Kubernetes watch.

## Предлагаемый UX

### Рабочая область

Сохранить спокойный IDE-интерфейс: насыщенные цвета только у статусов и активного элемента; Inter для текста, mono для имён/значений. Основной текст 12–13 px, вспомогательный 11–12 px; не строить смысловую иерархию на 9 px. В таблице — данные без кнопок действий на строках. Клик открывает inspector, ПКМ показывает доступные операции. Учитывать контекст, namespace и контейнер во всех заголовках и подтверждениях.

Левое дерево показывает все разделы; не дублировать его ещё одним рядом перспектив. Центральные вкладки хранят рабочий контекст. Правая панель — быстрый просмотр, кнопка «Open in tab» закрепляет ресурс для сравнения. В малом окне отдавать место основному содержимому; перенос детали в editor tab — следующий шаг адаптивности.

### Подробности ресурса

Единый компонент и renderer по GVK. Порядок: состояние и диагностический summary → ключевые связи → специфические данные → metadata. Базовые вкладки Overview / Related / Events / YAML; метрики добавлять только при доступном источнике.

Для Pod нужны: readiness/conditions и причина unhealthy, обычные/init/ephemeral контейнеры, image/imageID, restart/last termination/exit code, probes, requests/limits, env (Secret refs с маскированием), volumes/mounts, tolerations/affinity, owner chain, Node, Pod/host IP, QoS, ServiceAccount и связанные Services/PVC. Большие списки сворачивать, важную ошибку показывать сразу. Для Deployment — strategy, desired/updated/available, revisions, условия Progressing/Available, цепочка ReplicaSets→Pods и причины недоступности. Node — capacity/allocatable/requests/usage как разные значения, условия/taints/addresses/system info, размещённые Pods и операции drain/cordon с отдельным workflow.

Ссылки должны быть обратимыми: Pod → ReplicaSet → Deployment; Deployment → ReplicaSets → Pods; Ingress → Service → EndpointSlice/Pod; Pod → ConfigMap/Secret/PVC → PV → StorageClass. Не угадывать владельца по имени Pod. Незагруженный target показывать как unavailable/forbidden/not found, а не «связей нет».

### Нижняя панель

Рекомендуемая конечная структура: **Logs / Terminal / Ports / Events** как группы инструментов, внутри — короткие вкладки сессий. Заголовок сессии: context → namespace → resource → container; отдельные состояния connecting/running/ended/error. Смена namespace не меняет цель уже открытой сессии. Смена context должна либо явно завершать сессии, либо сохранять их с явной принадлежностью; в текущем проходе выбрано завершение.

Логи: tail 100/500/1000, timestamps, follow/pause, previous, since, поиск, wrap, export, кнопка scroll-to-bottom, ограниченный ring buffer. Подмена контейнера должна открывать/фокусировать корректно идентифицированную сессию. Terminal: stdin/stdout/resize, выбор shell, exit code, reconnect; вкладка не должна объявлять Connected до handshake. Для Node shell нужен управляемый debug pod: создание, права, имя/image, удаление и orphan cleanup.

Ports: реальный bind и port availability, target Pod/Service, local/remote port, state/error, uptime, URL и stop. Events: ресурсные ссылки, namespace, type/reason/message, count, first/last seen; Warning не означает автоматически неисправность всего ресурса.

## Движки диаграмм и решение

| Вариант | Сильные стороны | Ограничения и применение |
|---|---|---|
| **React Flow + ELK** | React-компоненты карточек, выбор/drag/pan/zoom, nested graph support; ELK даёт layered layout/ports и вычисления в worker | Две отдельные библиотеки; нужно проектировать graph model и производительность DOM. Выбран для текущего React-приложения |
| Cytoscape.js | Графовая модель, compound nodes, алгоритмы анализа, Canvas-рендер | React-карточки и привычный inspector UI интегрировать менее удобно. Кандидат для больших обзорных графов после измерений |
| yFiles for HTML | Богатая готовая визуализация и алгоритмы раскладки | Коммерческий продукт; отдельное решение по бюджету и лицензии. Нет необходимости покупать для первого MVP |
| Dagre | Простой layout ориентированных графов | Ограничения sub-flow при внешних связях; для многоуровневой K8s топологии ELK уместнее |
| Mermaid | Удобный текстовый экспорт и документация | Не основной интерактивный UI для тысяч меняющихся объектов |

Основания: [React Flow: сравнение layout engines](https://reactflow.dev/learn/layouting/layouting), [nested graphs](https://reactflow.dev/learn/layouting/sub-flows), [ELK JS](https://github.com/kieler/elkjs), [Cytoscape.js](https://js.cytoscape.org/), [yFiles for HTML](https://www.yfiles.com/the-yfiles-sdk/web/yfiles-for-html). React Flow — MIT; ELK JS — EPL-2.0 с указанной проектом альтернативой GPL-3.0-or-later. Перед распространением включить notices зависимостей. Встраивать Java-библиотеку JetBrains в Tauri не требуется.

Полезные UX-референсы JetBrains — выбор области, направление, Arrange/Fit, управление видимостью связей и переход к объекту. Это документированные приёмы, не утверждение, что в Kubiki используется тот же внутренний движок: [панель и меню диаграмм IntelliJ](https://www.jetbrains.com/help/idea/class-diagram-toolbar-and-context-menu.html).

### Модель топологии

Один граф для Related и canvas: `ResourceRef(context, group, version, kind, namespace, uid)`; ребро содержит relation type, источник доказательства и capability/loaded state. В текущем фиксированном наборе kinds индекс использует kind/ns/name и UID владельца; расширение на произвольные GVK требует включить group/version в индекс. Изменение label не должно превращать selector-связь в ownership.

Уровни конечного продукта:

1. **Cluster:** агрегаты Namespace/Node/Workload и summary проблем. По умолчанию не рисовать каждый Pod.
2. **Namespace:** Ingress/Service → Workload → ReplicaSet/Pod → config/storage; внешние зависимости показывать приглушёнными.
3. **Workload/Pod:** фокус + 1–3 перехода по рёбрам, раскрытие соседей по запросу, скрытые групповые узлы.
4. **Node:** размещение Pods, allocatable vs requests/limits, pressure и проблемные workload.

Первая реализация строит namespace/resource scopes по загруженным объектам. Общая вкладка начинает с выбора области; cluster summary показывает только счётчики namespace, без построения графа всего кластера. Это пока плоская топология: агрегация и compound groups — следующий этап. До layout проверяются 250 узлов / 1000 рёбер, раскладка отменяется через 10 секунд. Для resource scope построение ограничено соседями и не расширяет Pod через общий Node/ConfigMap/Secret/StorageClass на всех остальных потребителей. Service selectors используют индекс labels. Эти лимиты — защитная политика прототипа, не результат нагрузочного бенчмарка. Layout работает в локальном worker; данные Secrets в worker не отправляются — только id/размеры узлов и рёбра. Реализация и дальнейшие уровни разделены в [10](10-IMPLEMENTATION-TASKS.md).

Обязательные дальнейшие свойства: сохранение пользовательских позиций между delta, отмена устаревшего layout, индикатор неполных прав/данных, типизированные фильтры рёбер, экспорт SVG/PNG/JSON, стабильная сортировка, zoom-level aggregation. View topology не должен создавать или редактировать Kubernetes-связи перетаскиванием.

Семантика ownership сверена с [Kubernetes: Owners and Dependents](https://kubernetes.io/docs/concepts/overview/working-with-objects/owners-dependents/).

## Порядок дальнейших работ

| Этап | Работы | Приёмка |
|---|---|---|
| A. Достоверное чтение | Typed provider/IPC, discovery, lazy queries, RBAC states; watch с relist/reconnect | Контекст A→B во время загрузки не смешивает объекты; 403/timeout видны; delete/relist не оставляют phantom rows |
| B. Диагностика и сессии | Реальный streaming logs, exec/PTY и resize/close; менеджер PF с child cancellation; Node debug lifecycle | Несколько containers/contexts; сворачивание сохраняет сессию; закрытие освобождает backend; disconnect/reconnect и exit code |
| C. Безопасные изменения | Dry-run/diff/apply, conflict handling, delete/restart/scale через один action pipeline | Нет оптимистического «успеха» при 403/409/timeout; подтверждение содержит точный context/ns/name |
| D. IDE-эргономика | Виртуализация, component split, tab-scoped filters/drafts, docking после стабилизации session model | 10k строк по согласованному бюджету; 900×600 и 4K; keyboard/accessibility; отсутствуют console errors |
| E. Топология v2 | Namespace/workload grouping, агрегаты, фильтры/экспорт, инкрементальная раскладка | Граф не скачет при watch; отсутствующие права не трактуются как отсутствие объектов |
| F. Расширение доменов | Dynamic CRD, Helm с явным context, HPA/RBAC, metrics | Live integration tests и UI для каждого включённого действия |

Следующий основной milestone — **живой диагностический MVP**, а не ещё одна смена цветов: подключиться → найти проблемный Pod → увидеть причину и владельца → открыть реальные логи/exec → завершить сессию без утечки. До beta нужны тестовый кластер и desktop smoke tests.

## Проверки и пределы достоверности

Проверки текущей сессии перечислены в `07-UI-PROGRESS.md`. Browser tests используют изолированный demo mode и подставленные ошибки API; это проверка UX, а не взаимодействия с production cluster. Команды изменения объектов к реальному кластеру в рамках аудита не выполнялись. Платформенные smoke tests macOS/Windows и фактический бюджет RAM/CPU не проведены. Поэтому прежние обещания «10–15× меньше памяти» и «100% готово» нельзя считать измеренными характеристиками.
