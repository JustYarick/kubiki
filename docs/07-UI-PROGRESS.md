# UI Build Progress — Kubiki

> Журнал прогресса разработки UI по плану `06-UI-BUILD-PLAN.md` (фазы UI-0 … UI-11).
> Агент обязан читать этот файл и обновлять его после каждого рабочего блока.
> Статусы: ✅ готово · 🟡 частично · ⬜ не начато.

---

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
