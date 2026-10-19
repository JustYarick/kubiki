# UI Build Progress — Kubiki

> Журнал прогресса разработки UI по плану `06-UI-BUILD-PLAN.md` (фазы UI-0 … UI-11).
> Агент обязан читать этот файл и обновлять его после каждого рабочего блока.
> Статусы: ✅ готово · 🟡 частично · ⬜ не начато.

---

## 2026-10-20: лицензия и ветка разработки

- **Готово:** по выбору владельца добавлен официальный текст Apache License 2.0 в `LICENSE`; SPDX `Apache-2.0` указан в npm/Rust manifests, README содержит ссылку на лицензию.
- **Готово:** существующий `.gitignore` дополнен правилами для локальных `.env`, `.kube` и корневого kubeconfig; шаблоны `.env.example` / `.env.sample` разрешены.
- **Готово:** создана локальная ветка `dev`, настроен `origin` на `git@github.com:JustYarick/kubiki.git`. Отправка и результат проверяются отдельно через Git.

---

## Последний блок — 2026-10-20: Events island, Namespace containers, фильтры и откат graphics

- **GRAPH-EVENTS — готово:** Event не попадает в узлы, лимиты или ELK. Справа отдельный сворачиваемый прямоугольный остров: последние 10 событий выбранной области, Warning/reason/message/count/time; переход к Events ресурса. Поддерживаются involvedObject и regarding/series; UID защищает от перехода к пересозданному объекту. Обновление только Events не перезапускает layout и не сбрасывает ручные позиции/viewport.
- **GRAPH-NS — готово:** Namespace показан рамкой с ресурсами внутри. ELK compound layout + React Flow parentId, Node/PV/StorageClass снаружи; child extent удерживает ресурсы внутри. Проверены RIGHT/DOWN, относительные координаты, внешний Node и переходы. Namespace scope остаётся плоским по workload — их subgroups ещё TODO.
- **UX-06 — готово:** health/status/search/namespace фильтруются совместно; порядок «проблемные первыми» использует общую diagnostics (errors → warnings → healthy), новые/старые — настоящие timestamps с unknown в конце; имя A–Z/Z–A и сортировка колонок сохранены. Поиск на полную ширину, фильтры отдельной строкой слева. Высота toolbar стабильна: открытие inspector больше не сдвигает строку между кликами double-click.
- **UX-05 уточнён:** глобальный namespace picker с поиском остался только рядом с кластером. Табличный и breadcrumb picker убраны; breadcrumbs показывают scope текстом. Diagram scope — отдельная локальная настройка диаграммы.
- Неполные API references больше не передаются в ELK как рёбра с отсутствующими узлами; в Related незагруженные ссылки сохраняются.
- **GRAPH-PERF/NATIVE-01 — отложено владельцем.** Исследование подтвердило browser/native различие и влияние forced DMABUF disable в двух точках запуска. Native A/B дал 18,72 / 60,38 FPS, но владелец сообщил о размытости и попросил вернуть прежнюю отрисовку. Canvas2D connections и LOD/culling/CSS-эксперименты удалены, SVG и оба прежних Linux flags восстановлены. Проверено окружение уже перезапущенного WebKitWebProcess: оба flags снова `1`. Низкая частота native pan остаётся открытой; новых performance-экспериментов после отмены не проводилось. Подробности и ручные harness: [11](11-TOPOLOGY-PERFORMANCE.md).
- **Custom resources:** загружаются определения CRD, не произвольные custom instances. Discovery/динамические GVK и соответствующие связи выделены в DOMAIN-03; задача не объявлена выполненной.

Проверки финального состояния:

- `pnpm test`: **45 тестов**, 7 файлов.
- `pnpm build`: пройден; предупреждение о больших Monaco/main chunks сохраняется.
- **19 browser scenarios на production preview — пройдены** (26,7 с). На dev первичный прогон выявил сдвиг toolbar при double-click; исправление проверено отдельным dev-сценарием и полным production-прогоном.
- `cargo check --manifest-path src-tauri/Cargo.toml --offline`, `git diff --check`: пройдены.
- Native GI/WebKit harness проверял графический путь на подставленных данных, а не полноценный Tauri/Kubernetes цикл. Desktop clarity после отката требует субъективной проверки владельца; точный старый YAML dispatcher crash по-прежнему не подтверждён исправленным в desktop.

---

## Предыдущий блок — 2026-10-20: подробности, YAML, warnings и безопасная топология

Стадия остаётся **early alpha / pre-MVP**. Исполняемый backlog с отдельными статусами: [10](10-IMPLEMENTATION-TASKS.md). Следующий раздел фиксирует предыдущий аудит; его количества проверок относятся к тому проходу.

### Реализовано

- `UX-01/02`: яркие kind badges с текстом и иконкой в Related и на схеме; annotations отображаются построчно. Для JSON — раскрываемые пути/поля, для last-applied — сводка kind/name/namespace/replicas/images; исходный текст доступен отдельно и копируется без изменения. Ограничены размер, глубина и число полей preview.
- `YAML-02`: удалена `@monaco-editor/react`, редактор подключает native Monaco API. Каждое окно владеет своей моделью/instance/disposables, lazy mount защищён от отмены/StrictMode; save action использует актуальный draft. При сбое загрузки Monaco остаётся textarea с тем же draft и повтор загрузки. Чистый документ обновляется из snapshot, несохранённый draft сохраняется.
- `UX-03`: общая `resourceIssues` для таблицы, Related, Overview и topology. Причины берутся из conditions/reason/message и состояния контейнеров/реплик/Node/Job/storage/Service/Namespace/CRD. Hover и keyboard focus показывают tooltip; значки не являются кнопками действий в строках. Completed, intentional replicas=0 и обычный старт не объявляются поломкой. Проверка Service selector выполняется только при доступном Pod snapshot. Это диагностика доступных данных, без заявления о покрытии всех неисправностей.
- `UX-04`: причина пустого Namespace Related — фильтрация рёбер `contains`; фильтр снят. Показываются загруженные ресурсы namespace, есть поиск по имени/kind/namespace/типу связи, первые 50 строк и следующие порции по 50. Связи строятся при открытии Related, а не при каждом Overview.
- `GRAPH-SAFE`: общая Topology больше не выбирает весь кластер. Сначала выбор области, либо уже выбранный namespace; из подробностей ресурса — его окружение. Cluster summary показывает только counts по namespace и переходы. Поиск по имени есть и на экране выбора, и в меню области.
- До расчёта layout проверяются бюджеты **250 ресурсов / 1000 связей**; переполнение показывает причину и предлагает сузить область, без скрытого усечения. Namespace предварительно отбирается до selector joins. Resource scope строится по соседям; общие Node/Namespace/ConfigMap/Secret/StorageClass не расширяются на всех потребителей, если это не сам корневой kind. Для Service используется индекс Pod labels. Worker отменяется при смене области/закрытии и после 10 секунд, освобождается по завершении/ошибке; прошлый граф убирается при новой раскладке.
- `UX-05`: общий поиск namespace без учёта регистра в верхней панели, фильтре таблицы, breadcrumbs и выборе диаграммы. Меню монтирует первые 50 результатов, следующие — по запросу; есть empty state, Enter/стрелки/Escape. Внутренняя прокрутка Popover больше не закрывает меню.
- В [roadmap 04](04-ROADMAP.md) и [задачах 10](10-IMPLEMENTATION-TASKS.md) отдельно расписаны cluster/namespace/workload/Pod/Node/network/storage diagrams, группировка, IDE navigation, incremental layout, большие кластеры/RBAC и экспорт. Агрегированная диаграмма кластера пока **не реализована**.

### Проверки и ограничения

- `pnpm test`: **35 тестов**, 4 файла. Добавлены annotations, diagnostics, бюджеты графа и namespace membership.
- Chromium dev: **16 browser tests**, включая настоящий DOM Monaco при многократном открытии, независимые модели и latest-draft save, fallback при сбое импорта, badges/annotations/warnings, Namespace Related 121 объект с пагинацией, 5000 ресурсов без автоматического layout, выбор среди 130 namespace с поиском/клавиатурой/прокруткой.
- Production build: пройден. Финальные **16 browser tests на production preview пройдены** (22,4 с); дополнительно после подключения всех четырёх selectors повторён dev-сценарий поиска namespace. `git diff --check` — без ошибок. Предупреждение Vite о крупных Monaco/main chunks остаётся открытым performance-пунктом.
- `YAML-01` остаётся **IN PROGRESS**: точный `resolveDispatcher().useState` crash в Chromium не воспроизведён даже до изменения; установленная React одна, добавлен Vite dedupe. Снята React-обёртка редактора и укреплён lifecycle, но это не доказанная первопричина заявленного desktop crash. Нужен smoke в Tauri/WebKit пользователя.
- Playwright WebKit скачан в `/tmp/kubiki-playwright`; запуск не состоялся: openSUSE не имеет требуемых библиотек ICU74/libxml2/flite/GStreamer. Успех Chromium не считается проверкой WebKit; системные зависимости не менялись.
- Проверки используют demo/подставленный HTTP API. Тест 5000 объектов проверяет защиту графа, а не нагрузочную готовность всего приложения: таблица ещё без virtualization, Related хранит полный список найденных ссылок, loaded resource snapshots индексируются в основном потоке. Группировка/lazy loading и реальные нагрузочные бюджеты остаются TODO.
- Новых изменений Rust в этом блоке нет; результат предыдущего прохода — 6 Rust tests и offline cargo check, без повторного утверждения live cluster integration.

---

## Актуальное состояние — 2026-10-20, аудит и исправления

**Стадия:** early alpha / pre-MVP. Подробности: [08 — аудит](08-UX-TECHNICAL-AUDIT.md), [09 — сверка стадии и документации](09-PROJECT-STATUS.md).

Реальный режим больше не подменяет ошибки API демо-данными. Демо запускается явно через `?demo=1`. В Tauri зарегистрированы 7 команд: contexts/current-context/health/namespaces/resources/scale/pod-logs. Списки — snapshots через kubectl, а не подключённый informer stream. Логи — tail 500 с polling 3 с, а не follow stream. Поддерживается фиксированный набор 18 kinds, включая ReplicaSet/Event/CRD.

### Что сделано в этом проходе

- Исправлены ложный Connected, смешивание live/mock, поздние ответы предыдущего контекста, фиктивные refresh/auto-sync и преждевременный успех scale.
- Vite bridge переведён с shell interpolation на `execFile` с argv; неизвестные kinds возвращают ошибку.
- Один dock store для всех элементов управления; посещённые сессии сохраняются при переключении и сворачивании. Ошибки логов видны, polling скрытых сессий остановлен.
- Из строк таблицы убраны **все кнопки действий, включая +/− scale и hover toolbar**. Действия — в меню ПКМ; обычный клик открывает inspector.
- Общие подробности ресурса для inspector и editor tab: Overview / Related / Events / YAML, conditions, containers, requests/limits/probes, volumes, реальные Secret data и annotations. У inspector и detail tab независимый выбранный раздел.
- Связи по owner UID, селекторам и ссылкам API; Pod → ReplicaSet → Deployment с переходами назад. Незагруженные targets помечаются отдельно.
- React Flow + ELK: отдельная вкладка Topology, scopes cluster/namespace/resource, глубина 1–3, направление, Arrange, pan/zoom/minimap и inspector по клику. Layout в локальном worker. Лимит прототипа — 250 узлов, без скрытого усечения.
- Идентичность вкладок и сессий учитывает context/namespace/container; детали синхронизируются с обновлениями store.
- Реальные YAML восстанавливаются из raw API JSON. Live editor read-only до появления dry-run/diff/apply. Демонстрационные edits парсятся и обновляют модель.
- На 900×600 inspector оставляет рабочую центральную область; добавлен keyboard resize и cleanup pointer cancel.
- Исправлены несовместимые `tty=true + stderr=true` в Rust PodExec default/attach; регрессионный тест.
- README и документация 01–06 снабжены фактическим статусом. Исторические записи ниже не являются текущей матрицей готовности.

### Проверки

- `pnpm test`: 11 frontend regression tests.
- `pnpm test:e2e`: 7 browser scenarios (успешно на dev и production build): строки без действий; ПКМ scale; owner navigation; сохранение состояния дока; cluster/namespace/resource topology; реальные контракты logs/YAML на подставленном API; ошибка подключения; поздние ответы context A; окно 900×600.
- `cargo test --manifest-path crates/kubiki-core/Cargo.toml --offline`: 3 unit + 3 integration tests.
- `pnpm build`, `cargo check --manifest-path src-tauri/Cargo.toml --offline`: успешно после финальных изменений. Monaco даёт предупреждение о крупных chunks; production performance budget ещё не подтверждён.
- Browser tests выполняются в изолированном demo mode/с подставленным API. Live exec/PF/watch и настоящие Kubernetes mutations ими не проверяются.

### Матрица по каноническим фазам документа 06

| Фаза | Статус |
|---|---|
| UI-0: Foundation | 🟡 Токены/примитивы/ErrorBoundary есть; styleguide и полный a11y review нет |
| UI-1: Providers | 🟡 Реальные snapshots и явный demo mode; нет полного typed provider/IPC contracts |
| UI-2: Docking shell | 🟡 Ручные tabs/split/панели; dockview не подключён |
| UI-3: Explorer/details | 🟡 Таблицы/подробности/связи есть; virtualization/все критерии нагрузки нет |
| UI-4: Watch | ⬜ Informer → IPC → UI не подключён; snapshots не считаются watch |
| UI-5: Pod Ops | 🟡 Logs tail; live exec/node/local/PF пока нет |
| UI-6: YAML | 🟡 Monaco view/export/demo edit; schema/diff/live apply нет |
| UI-7: Domains | 🟡 Часть Config/Network/Storage/Events; RBAC/dynamic CRD не завершены |
| UI-8: Metrics | ⬜ Rust service без UI integration |
| UI-9: Helm | ⬜ Rust wrapper без UI/IPC; перед включением нужен explicit context |
| UI-10: Polish | 🟡 Палитра/settings/часть клавиш; не полная приёмка |
| UI-11: Light/release QA | ⬜ |

**Следующий приоритет:** typed/lazy resource loading + watch/relist/reconnect; затем реальные sessions с cleanup, live YAML mutation workflow, virtualization и topology grouping. Не начинать с косметической замены shell или перехода на новый стек.

---

## Исторический журнал до аудита 2026-10-20

Следующие записи сохранены для истории. Их статусы и нумерация фаз местами устарели; актуальная матрица выше использует нумерацию документа 06.

## Текущее состояние (обновлено: 2026-10-19, сессия 2)

**Сборка:** `tsc && vite build` — зелёная (main-чанк 716 KB / gzip 199 KB; Monaco вынесен в ленивый чанк).
**Данные:** мок-кластер (`src/providers/mock/mock_resources.ts`), 16 видов ресурсов с генерируемым YAML.
**Режим деталей:** только `pane` (правый Inspector); режим `tabs` (dockview) — в очереди.
**Реальный кластер:** не подключён (IPC ещё не сплетён с `kubiki-core`) — запланировано в UI-4.

---

## UI-0 — Дизайн-система и фундамент ✅ (частично)

- [x] Тёмная тема, токены JetBrains-стиля в `src/App.css` (палитра, бордеры, статусы, тени, шрифтовые переменные)
- [x] Локальные шрифты: Inter Variable + JetBrains Mono Variable (`@fontsource-variable/*`), ни CDN
- [x] Макро-анимации без плагина: `kub-pop`, `kub-toast`, `kub-fade`
- [x] UI-кит: `Button`, `IconButton`, `Tooltip`, `Popover`/`MenuList`/`FixedMenu` (порталы, клик-аутсайд, Esc, scroll-close), `Modal`, `Input`/`SearchInput`/`Label`, `StatusBadge` (v2), `Toasts`
- [x] Утилиты: `cx` (clsx+twMerge), `fuzzy`, `fmt` (bytes/uptime), `Resizer` (pointer-capture сплиттер)
- [ ] Страница `/styleguide` — ⬜ (UI-кит готов, витрина не собрана)
- [ ] Контракт таблицы ключевых биндингов (⌘K/⌘B/⌘J работают глобально; отдельный экран клавиш — ⬜)
- [ ] GlobalErrorBoundary — ⬜

## UI-1 — Слой данных ⬜ → вместо него временный провайдер

- [x] Мок-провайдер с богатыми данными + YAML на каждый объект (Pod, Deployment, STS, DS, Job, CronJob, Service, Ingress, ConfigMap, Secret, PVC, PV, SC, Node, Namespace)
- [ ] `DataProvider` интерфейс (mock | tauri) — ⬜
- [ ] Tauri IPC контракт + `invoke`-обёртки — ⬜

## UI-2 — Каркас оболочки ✅

- [x] `TitleBar`: кастомные дропдауны контекста и namespace (не нативные select), кнопка палитры ⌘K, статус соединения, «Reconnect», настройки
- [x] `ActivityBar`: 8 перспектив (Workloads/Config/Network/Storage/Access/Helm/CRD/Cluster), активный индикатор, тултипы, нижние тумблеры (сайдбар, док, настройки); `core/perspectives.ts` — единый реестр
- [x] `Sidebar`: поиск по видам, персистентные свёрнутые группы, счётчики с учётом ns-фильтра, футер (ns + метка «mock»)
- [x] `StatusBar` (новый): контекст, ns, watching-kind, shells/pf/events счётчики-кнопки, версия
- [x] Ресайз панелей: сайдбар 200–420 px, инспектор 300–560 px, док 140–560 px; всё персистится (`zustand persist`, key `kubiki.settings.v1`); сворачивание сайдбара/инспектора/дока; сброс размера в Settings
- [x] Хоткеи: ⌘K палитра, ⌘B сайдбар, ⌘J док

## UI-3 — Таблица + панель деталей ✅ (pane-режим)

- [x] `ResourceView`: тулбар (иконка+счётчик, поиск, ns-фильтр, плотность, меню колонок с персистом на вид, refresh, New)
- [x] Таблица: сортировка кликом по заголовку (asc/desc/none), sticky header, hover-действия (Logs/Terminal/PF/YAML/More), ПКМ-контекстное меню, цветные Ready/Restarts/Status, единый рендер ячеек
- [x] Контекстные действия: Details, Edit YAML, Logs, Terminal, Port-forward…, Scale…, Restart rollout, Rerun, Copy name, Delete… (с подтверждением)
- [x] Диалоги: `PFDialog` (remote/local порт, open browser, валидация), `ScaleDialog` (± и пресеты, warning на 0), `RestartDialog`, `ConfirmDialog`, `NewResourceDialog` (шаблон YAML по виду)
- [x] Пустые состояния («нет объектов» / «фильтры скрывают» с кнопками)
- [x] `InspectorPanel` (pane-режим): хедер (kind/name/ns, copy YAML, delete, close), табы Overview | YAML
- [x] Overview: статус-строка с быстрыми действиями, Metadata-грид, Containers (по контейнеру: готовность, порт, рестарты), лейблы-чипы, Secret с reveal
- [x] Плотность строк compact/comfortable

## Редактор YAML (вне фаз, сделан раньше срока из-за запроса «как в Lens») ✅

- [x] Monaco локально (0.57, тема `kubiki-dark`, воркер забандлен — без CDN; обход rolldown через `editor_worker.ts` + `new URL`)
- [x] Кнопки: Copy, Download .yaml, Revert, Apply (⌘S) + индикатор «unsaved/in sync»
- [x] Лениво загружается (`React.lazy`), отдельный чанк + воркер-чанки
- [ ] Проверка синтаксиса YAML (diag) — ⬜ (базовая подсветка есть)

## Нижний док ✅

- [x] Вкладки Terminal / Logs / Ports / Events; панели живут при переключении (keep-mounted), collapse-полоса высотой 30px
- [x] Terminal: xterm поверх mock-shell — `kubectl get pods/deployments/services/configmaps/secrets [-n ns]`, `kubectl version`, `get-contexts`, `help`, `clear`, editing (backspace/↑ввод), выбор цели «host shell / конкретный pod», Restart session, Clear
- [x] Logs: поток ~1.5 строки/с, пауза/возобновление, wrap, фильтр, скачивание tail, clear; уровни info/warn/error с цветом
- [x] Ports: сессии PF (адрес, ↓in/↑out трафик live, uptime, forwarding-badge), Stop кнопкой, «New forward»
- [x] Events: стрим Normal/Warning, колонки Reason/Message/Object/Count/Last-seen, фильтр текстом, чип «только предупреждения», пауза/clear

## Палитра и настройки ✅

- [x] ⌘K палитра: команды (перспективы, виды по активной перспективе, тумблеры панелей, плотность, режим деталей, сброс лэйаута), действия над выбранным ресурсом (Edit YAML), поиск ресурсов по всем видам с подсветкой совпадений; секции, ↑↓/↵/Esc
- [x] `SettingsDialog`: плотность (segmented), тема (Dark — активная, Light — заглушка UI-10), Reset layout, инфо о контексте/версии/kubeconfig/About

## UI-4 — Реальный кластер через Tauri + kubiki-core ⬜ **(следующий шаг)**
## UI-5 — dockview: центральные табы и докинг панелей ⬜ (второй режим деталей `tabs`)
## UI-6 — Потоки: реальные логи/exec-терминалы ⬜
## UI-7 — Port-forward/events/metrics на реальных данных ⬜
## UI-8 — Helm ⬜
## UI-9 — Полировка палитры/настроек ⬜
## UI-10 — Светлая тема ⬜
## UI-11 — Производительность: TanStack Table/Virtual, виртуализация строк ⬜

---

## Очередь (агент, начни отсюда)

1. **dockview-центр**: внедрить dockview как движок центральной зоны; режим деталей `tabs` (вкладки в центре), переключатель pane/tabs, персист layout. Все панели уже затачены под «плавающие» зоны.
2. **DataProvider + реальный IPC**: интерфейс провайдера, `tauri`-реализация поверх 2 существующих команд (`get_kube_contexts`, `get_current_context`) + генерация остальных команд из `kubiki-core` (контексты, watch-списки, логи, exec, PF). Проверка на локальном кластере (context `default`).
3. ErrorBoundary + окно «Биндинги клавиш» (UI-0 хвосты).
4. Виртуализация таблицы (TanStack Virtual) — включить, когда данные перестанут быть моком.

## Известные технические заметки (для следующих агентов)

---

## Сессия 2 (2026-10-19) — разгон по отзыву пользователя

**Жалобы:** списки контекста/ns не выпадают; терминал/логи стартуют сами; сайдбар «блоками», а не Lens-дерево; типографика не JetBrains; кустарность.

- [x] **FIX бага Popover**: double-toggle (триггер сам вызывал `toggle`, клон Popover добавлял второй) → меню открывалось и мгновенно закрывалось. Теперь toggle ровно один — у Popover; триггеры не вызывают его сами (`TitleBar`).
- [x] **Sidebar — единое Lens-дерево**: категории → группы → виды (Workloads → Workloads/Jobs; подгруппа Jobs → Jobs/CronJobs), все разделы видны всегда (Workloads, Configuration, Network, Storage, Access Control, CRDs, Helm, Cluster), плейсхолдеры будущих разделов с замком.
- [x] **ActivityBar** упрощён до служебной рейки: Explorer (⌘B), палитра (⌘K); внизу — инспектор, док, настройки. Перспективы больше не скрывают части дерева.
- [x] **Док**: скрыт при запуске (persist v2), вкладки монтируются лениво при первом открытии, стримы Logs/Events гоняются ТОЛЬКО пока вкладка активна; терминал создаётся только когда его открыли. Default вкладка — Logs с подсказкой, как запустить.
- [x] **Джборей-тайпографика**: база 12px, TitleBar/тулбары 36px, палитра — строки 28px/шрифт 12, компактная рейка 40px.
- [x] Глобальный поиск (⌘K) ищет по ВСЕМ видам кластера+команды; поиск в сайдбаре фильтрует дерево с автораскрытием родителей.

- [x] **FIX панель деталей**: по умолчанию закрыта и открывается кликом по строке; пустое состояние теперь в той же рамке с хедером и крестиком («Закрыть») — закрыть можно всегда; индикаторы на рейке подсвечивают ВКЛЮЧЁННЫЕ панели (Explorer/Inspector/Dock), persist поднят до `kubiki.settings.v3`.

- [x] **FIX креш эдитора в dev**: monaco-editor 0.57 имеет exports-мапу `"./*": "./esm/vs/*.js"` — путь `monaco-editor/esm/vs/...` в dev резолвится как `./esm/vs/esm/vs/...` (несуществующий) → «Failed to resolve import» и белый экран воркспейса. Правильный спесификатор: `monaco-editor/editor/editor.worker.js` (`src/views/editor_worker.ts`); prod-сборка была терпима к fs-пути, dev — нет. Smoke-test: все ключевые модули отдаются dev-сервером кодом 200.
- [x] **Lens-колонки таблицы**: ресайз за правый край заголовка (pointer capture, clamp 56–520px, живой persist в `ui_store.columnWidths` ключ `kind:colId`), double-click по ручке — сброс колонки к дефолту; ПКМ по заголовку → Sort asc/desc/clear + Hide column (Name защищён) + Reset widths; фикс-таблица `table-layout: fixed`; в меню Columns добавлены Reset visibility/widths и подсказка. Дефолтные ширины — `DEFAULT_COL_SIZE` в ResourceView.
- [x] **FIX остаток double-toggle**: ns-чек в тулбаре ResourceView всё ещё сам вызывал `toggle` → тот же баг «не выпадает», что и в TitleBar. Убран — toggle только у Popover.

**Очередь (unchanged):** dockview `tabs`-режим → DataProvider + реальный IPC → ErrorBoundary/биндинги → виртуализация.

- `selectedNamespace` — единый источник **в `cluster_store`**; `resource_store.getActiveResources` читает оттуда, но реактивные компоненты должны подписываться сами (см. `ResourceView`).
- Воркер Monaco: бандлить через локальный шим `src/views/editor_worker.ts` (`?worker` из node_modules rolldown не берёт).
- Строу правила именования: компоненты `.tsx` в PascalCase, остальное snake_case.
- Не добавляй CDN-ресурсы: десктоп должен работать локально (шрифты, Monaco — уже локальные).
