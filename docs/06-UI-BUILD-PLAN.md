# План разработки UI Kubiki (UI Build Plan)

> **Назначение:** полное руководство по построению интерфейса приложения Kubiki для UI-разработчиков и автономных ИИ-агентов.
> **Стек UI:** React 19 + TypeScript + Vite + Tailwind 4 + Zustand + dockview + TanStack Table/Virtual + Monaco + xterm.js + lucide-react
> **Бэкенд:** `crates/kubiki-core` (100% готов) через Tauri 2 IPC (`src-tauri`)
> **Референсы стиля:** JetBrains IDE (New UI / Fleet) и современный VS Code (Dark Modern)
> **Статус документа:** утверждён. Обновляется по факту реализации (метки ✅ в чек-листах фаз).

---

## 0. Резюме и правила использования документа

**Что строим:** десктопную Kubernetes-IDE в окне Tauri. Каркас: кастомный TitleBar → Activity Bar → Contextual Sidebar → Dockable Editor Area (dockview) → Bottom Dock → Status Bar. Данные приходят с реального кластера через IPC-события watch-стримов; для офлайн-разработки предусмотрен Mock-провайдер с тем же интерфейсом.

**Как использовать агентом:**
1. Прочитать разделы 1–9 (решения и спецификации) один раз.
2. Выполнять фазы раздела 10 строго по порядку — более поздние зависят от ранних.
3. Каждая задача имеет критерии приёмки (✅) — не переходить к следующей фазе, пока чек-лист не закрыт.
4. Ничего не изобретать за рамками этого документа: новые компоненты попадают в инвентарь (4.8), новые зависимости — только через решение в разделе 3.

**Главные продуктовые решения (принято с владельцем проекта):**
- Деталь ресурса открывается в **двух переключаемых режимах**: `pane` (правая панель, «как Lens») и `tabs` (вкладка в центре, «как VS Code»). Переключение мгновенное, режим запоминается в настройках.
- dockview интегрируется полностью: перетаскиваемые панели, сплиты, сохранение раскладки.
- Сначала только тёмная тема (JetBrains Dark); светлая — поздний полирующий проход поверх готовых токенов.
- IPC-слой (Tauri) встраивается в план и валидируется на реальном локальном кластере (запущен на ПК разработчика, доступен `kubectl`).
- MVP = полный состав: таблицы, деталь ресурса, YAML, логи, терминалы, port-forward, events, метрики, command palette, Helm, настройки. Язык интерфейса — только English.

---

## 1. Исходное состояние проекта

### 1.1. Что уже есть

| Область | Состояние | Файлы |
|---|---|---|
| Rust-ядро kubiki-core | ✅ Готово на 100%: contexts, client pool, InformerManager + ResourceStore (watch-дельты), PodLogService, PodExecService, PortForwardManager, CrdDiscovery, HelmClient, MetricsService | `crates/kubiki-core/src/**` |
| Tauri-шелл | ⚠️ Минимальный: окно 1280×800, всего 2 команды (`get_kube_contexts`, `get_current_context`) | `src-tauri/src/lib.rs` |
| Frontend-каркас (моки) | ⚠️ Статичный скелет: TitleBar, ActivityBar, Sidebar, ResourceTable, InspectorDrawer, BottomDock, StatusBadge | `src/components/**`, `src/App.tsx` |
| Состояние | ⚠️ `cluster_store`, `resource_store` (Zustand) с дельтами Applied/Deleted/Restarted — каркас пригоден | `src/state/**` |
| Типы K8s | ⚠️ Нормализованный `ResourceItem` | `src/types/k8s.ts` |
| Дизайн-токены | ⚠️ CSS-переменные Darcula в `App.css`; dockview CSS импортирован, но dockview не подключён | `src/App.css` |
| Зависимости UI | ✅ Установлены: dockview 8, @tanstack/react-table 9, @tanstack/react-virtual 3, @monaco-editor/react 4.7, @xterm 6 (+fit/search/web-links), zustand 5, lucide-react, clsx, tailwind-merge, Tailwind 4 | `package.json` |

### 1.2. Главные пробелы (то, ради чего этот план)

1. dockview установлен, но не использован — центральная область статична.
2. TanStack Table/Virtual, Monaco, xterm — установлены, не использованы; таблица — «голый» `<table>`.
3. Нет IPC для остального ядра (watch, логи, exec, PF, Helm, метрики, CRD).
4. Нет детали ресурса (есть только заготовка InspectorDrawer), нет YAML-вьюера/редактора, нет реальных логов/терминалов.
5. Нет command palette, настроек, хоткеев, toast/диалогов, пустых и ошибочных состояний.
6. Нет UI-примитивов (Select — нативный; нет Menu/Tooltip/Dialog), нет виртуализации.

**Правило эволюции кода:** существующие компоненты layout переписываются по спецификациям ниже (файлы/имена сохраняются), тип `ResourceItem` и сторы расширяются, а не выбрасываются. Именование: файлы компонентов — PascalCase.tsx (как заведено), остальное — snake_case.

---

## 2. Принципы продукта (Design Principles)

1. **Data-first, спокойный интерфейс.** Цветом говорим только о статусе и действии. Хром — оттенки серого и 1px-разделители. Ничего вычурного: без градиентов в chrome, скругления 4–6px, тени только у поповеров/модалок.
2. **Плотность IDE без каши.** Шрифты 11–13px, строки таблицы 28px, панели 40/48/26px. Whitespace дозируется: плотный режим по умолчанию, комфортный — переключатель.
3. **Все объекты кликабельны и содержательны.** Каждый элемент дорожит кликом и контекстным меню: строка → деталь; бейдж статуса → подсказка с причиной; IP → копирование; порт-форвард → кнопка браузера.
4. **Ничего не блокирует.** Реактивные списки обновляются без reload; операции (delete, apply, rollback) — асинхронные с toast-статусом; долгие — с прогрессом. Никаких полноэкранных спиннеров вне первичной загрузки.
5. **Прогрессивное раскрытие.** Простые действия — один клик (Logs, Terminal, PF). Сложные — за меню/диалогом (Edit YAML, Scale, Delete). Деструктивные — всегда с подтверждением и точным именем объекта.
6. **Клавиатура — гражданин первого класса.** Полный набор хоткеев (раздел 8), command palette, focus-visible везде, ARIA на меню/диалогах.
7. **Данные не врут.** Состояние соединения и staleness видно всегда (Status Bar + бейдж). Если watch отстал — показываем индикатор, а не молчаливо устаревшую таблицу.
8. **Быстрее реальности.** Виртуализация на 10k строк, дельты батчами, бюджеты рендера — раздел 11.
9. **Гибкая раскладка.** dockview: draggable-панели, сплиты, persistence. Двухрежимное открытие деталей (pane/tabs) — визитная карточка продукта.
10. **Токены, не хардкод.** Ни одного литерального hex в компонентах (кроме особых исключений); всё через CSS-переменные Tailwind-темы.

---

## 3. Архитектурные решения UI

| ID | Решение | Почему | Альтернативы (отклонены) |
|---|---|---|---|
| A-01 | **Tailwind 4 + CSS-переменные токены** (уже есть). `App.css` → `design/tokens.css` + `@theme`-маппинг | 0 runtime, простая темизация, уже в проекте | CSS-in-JS (stitches/panda), CSS-модули |
| A-02 | **dockview — единственный докинговый движок** центра и дока (нижние/правые панели) | Раскрывает «гибкий дизайн»: сплиты, drag-and-drop, persistence из коробки; уже в deps | самодельный splitter, Golden-Layout |
| A-03 | **TanStack Table v9 (headless) + TanStack Virtual** для всех таблиц ресурсов | Сортировка/виртуализация без DOM-оков; оба в deps | AG Grid (тяжёлый), ручная таблица (текущая) |
| A-04 | **Radix Primitives** для диалогов/меню/тултипов/select/popover | Доступная модальность, фокус-ловушки, позиционирование | рукописные попапы (ненадёжны), MUI (тяжёлый) |
| A-05 | **Zustand 5 с сущностными сторами** (список — 9.3) | Уже в проекте, дешёвые селекторные подписки | Redux Toolkit, Jotai, Recoil |
| A-06 | **DataProvider-абстракция: `mock` + `tauri`** реализации за едиными интерфейсами | UI-этапы живут на моках/фич-флаге; реальный кластер подключается по мере готовности команд | прямые `invoke()` из компонентов |
| A-07 | **Без роутера.** Перспектива/панели = состояние (`ui_store` + dockview model) | SPA-workspace без URL; сохранение через localStorage | react-router (лишний) |
| A-08 | **Шрифты локально (woff2):** Inter (UI) + JetBrains Mono (данные) через @fontsource | Десктоп-автономность, точная метафора JetBrains | системные шрифты (остаются fallback) |
| A-09 | **Локальный shell-терминал через portable-pty IPC**, exec-терминал — через kube WS | Локальный shell уже в ядре; exec — тоже | — |
| A-10 | **Monaco lazy-loaded** (dynamic import) только когда открыт YAML | Бандл ~2MB — не тащим в старт | eager import |
| A-11 | **Watch через Tauri events** (Rust → JS) с батчингом 50 мс на Rust-стороне; дельты применяются в `resource_store.applyDelta` | Согласовано с roadmap 3.1.1 и ядром | polling/HTTP-снимки |
| A-12 | **Собственный toast-центр + ConfirmDialog** на базе Radix AlertDialog | Простой контролируемый UX | Radix Toast (нет в core) |
| A-13 | **Custom TitleBar (decorations:false)** с drag-region и кастомными min/close/max; graceful fallback — флаг `prefs.customTitlebar` | Целостный вид IDE без рамок ОС | оставлять нативную рамку |
| A-14 | **Fuzzy-search в палитре — собственный скорер (~80 строк)**, без новых deps | Полный контроль, ноль зависимостей | Fuse.js |

**Добавляемые зависимости (единый список):**

```
@fontsource-variable/inter  @fontsource-variable/jetbrains-mono
@radix-ui/react-dialog  @radix-ui/react-alert-dialog  @radix-ui/react-dropdown-menu
@radix-ui/react-context-menu  @radix-ui/react-tooltip  @radix-ui/react-select
@radix-ui/react-checkbox  @radix-ui/react-switch  @radix-ui/react-popover
monaco-yaml  (+ monaco-editor как peer-зависимость)
```

> Radix Tabs, вероятно, не нужны (табы даёт dockview) — решаем по факту. `monaco-yaml` даёт YAML-языковой сервис со schema-валидацией (задача 6.1 roadmap).

---

## 4. Дизайн-система Kubiki DS v1

### 4.1. Токены (тёмная тема — базовая)

Тема включается атрибутом `[data-theme="dark"]` на `<html>`. Светлая тема — отдельный блок `[data-theme="light"]` (фаза UI-11; значения появятся потом, но **все компоненты обязаны использовать только эти токены с самого начала**).

```css
/* ============ Фон и поверхности ============ */
--bg-canvas:      #1e1f22;  /* самый глубокий фон: редактор, таблицы */
--bg-chrome:      #25272a;  /* TitleBar, StatusBar, Activity Bar */
--bg-panel:       #2b2d30;  /* Sidebar, Bottom Dock, таб-стрипсы */
--bg-surface:     #313438;  /* карточки, инлайн-панели, инспектор */
--bg-elevated:    #3a3d42;  /* чуть светлее surface: hover поверх карточек */
--bg-overlay:     #313438;  /* диалоги/меню/поповеры — верхний слой */
--bg-hover:       #393b40;  /* hover на канве/панелях */
--bg-selected:    rgba(53,116,240,.18);    /* выделение строки/дерева */
--bg-selected-strong: rgba(53,116,240,.30); /* выделение + фокус */
--bg-accent:      #3574f0;  /* primary-кнопки, активные элементы */
--bg-dim:         rgba(255,255,255,.04);   /* едва заметные зоны */

/* ============ Границы ============ */
--border-default: #393b40;  /* основные 1px-разделители */
--border-subtle:  #2e3034;  /* тонкие: строки таблиц, внутри карточек */
--border-strong:  #4a4d54;  /* hover-границы, поля ввода */
--border-accent:  #3574f0;  /* активная вкладка, выделение */

/* ============ Текст ============ */
--text-primary:   #dfe1e5;
--text-secondary: #9da0a8;
--text-muted:     #6f737a;
--text-disabled:  #565a61;
--text-accent:    #5b8def;  /* ссылки, акцентный текст */
--text-on-accent: #ffffff;

/* ============ Статусы (k8s-семантика) ============ */
--status-ok:      #59a869;   /* Running, Ready, Bound, Succeeded */
--status-warn:    #e5b742;   /* Pending, Creating, Terminating */
--status-danger:  #e05555;   /* CrashLoop, Failed, Error, Evicted */
--status-neutral: #8c9099;   /* Unknown, Terminated */
--status-info:    #3574f0;   /* сервисные события (info, applied) */

/* фоновые подложки бейджей: --status-*-bg: rgba(...,.12) — для 4 статусов */

/* ============ Спец ============ */
--focus-ring:     rgba(91,141,239,.55);
--scrollbar:      #3e4249;
--scrollbar-hover:#50555e;
--shadow-popup:   0 8px 24px rgba(0,0,0,.45);
--shadow-dialog:  0 16px 48px rgba(0,0,0,.55);
```

**Правило бейджа:** цветной текст + точка + прозрачная подложка 12% + 1px-граница 35% — как уже сделано в `StatusBadge.tsx` (паттерн сохраняется, цвета переходят на токены).

### 4.2. Типографика

| Роль | Шрифт | Размер | Вес | Где применяется |
|---|---|---|---|---|
| UI base | Inter Variable | 13px | 400 | панели, диалоги, формы |
| UI small | Inter Variable | 12px | 400 | вторичный текст, тултипы |
| UI label | Inter Variable | 11px | 500/600 | caps-лейблы секций, status bar |
| Data | JetBrains Mono Variable | 12px | 400 | имена ресурсов, YAML, логи, числа |
| Data em | JetBrains Mono Variable | 12px | 500 | выделенные имена, заголовки колонок |

- Section caps-label: 10px, 600, `text-transform: uppercase; letter-spacing: .06em`, цвет `--text-muted`.
- Заголовки диалогов: 14px/600; заголовок панели ресурса — mono 13/500.
- line-height: базовый 1.45; mono — 1.5 (логи — 1.55).

### 4.3. Сетка и размеры

```
Spacing scale: 4 8 12 16 24 (основные), 2 6 10 (точные) — кратность 2px
Radius: sm 3px (бейджи), md 4px (кнопки, инпуты, табы), lg 6px (карточки), xl 8px (диалоги)
Radius поповеров — всегда lg; кнопок — md; не смешивать в одном контексте.
Обязательные высоты:
  TitleBar 40px | ActivityBar 48px | StatusBar 26px
  Panel header (заголовок секции sidebar/дока) 32px
  Table row: 28px (compact) / 34px (comfortable — настройка)
  Table header row: 30px, sticky
  Tab strip (dockview): 35px
  Кнопка базовая: 26px (sm 22px)
  Input: 26px; Select: 26px; пункт контекстного меню: 24px
```

### 4.4. Статусы и их семантика (маппинг K8s)

| Класс | Значения (по status/conditions/events) | Цвет | Доп. поведение |
|---|---|---|---|
| ok | Running, Ready, Bound, Succeeded, Completed, Available, Active, Provisioned | `--status-ok` | точка сплошная |
| warn | Pending, ContainerCreating, Terminating, Waiting, ScalingUp | `--status-warn` | точка `animate-pulse` |
| danger | CrashLoopBackOff, Error, Failed, FailedScheduling, Evicted, ErrImagePull, ImagePullBackOff, OOMKilled | `--status-danger` | точка сплошная; счётчик рестартов может подсвечиваться красным |
| neutral | Terminated, Unknown, Idle | `--status-neutral` | точка сплошная |

- **Restarts:** `0` → muted; `1–4` → warn; `≥5` → danger (в колонке — число, а не бейдж).
- Статус бейджа при наличии raw-данных вычисляется по conditions, а не по строке (fallback — строка).

### 4.5. Состояния интерактивных элементов

| State | Правило |
|---|---|
| hover | фон `--bg-hover`, 90ms ease-out |
| active/pressed | фон чуть темнее hover (~#41444b), 40ms |
| focus-visible | `outline: 1px solid var(--focus-ring); outline-offset: 1px` — не box-shadow |
| selected | фон `--bg-selected`; для деревьев + 2px-полоса `--border-accent` слева; для таблиц — без полосы |
| selected+focus | `--bg-selected-strong` |
| disabled | opacity .45 + `cursor: not-allowed` |
| loading | скелетон (пульс opacity до 0.4), не спиннеры в таблицах |

Все переходы: `transition: background-color 90ms ease-out, color 90ms ease-out, border-color 90ms`. Модалки/меню — fade + scale .98→1, 120ms. Никаких bounce/spring.

### 4.6. Elevation и правила наложения

- Popup menu/tooltip/popover: `--bg-overlay` + `--shadow-popup` + 1px `--border-default`.
- Диалог: затемнение `rgba(0,0,0,.45)`, панель `--bg-overlay` + `--shadow-dialog`.
- Тултип: фон `--bg-overlay`, текст 11px/400, radius md, delay 500ms; в деревьях/таблицах — с данными (IP, image, uid).
- Скроллбары: 8px, прозрачный трек, thumb `--scrollbar` → hover `--scrollbar-hover`; авто-скрытие при неактивности.

### 4.7. Иконки

- Пакет: **lucide-react** только. Эмодзи в UI не используются (кроме логотипа ⎈ в TitleBar/About).
- Размеры: 16px — строки таблиц/деревья/меню; 20px — Activity Bar; 14px — внутри бейджей/кнопок sm.
- stroke-width: 1.75 (общий), 2 (activity bar).
- Kind-иконки ресурсов: стабильный маппинг `kind → lucide icon + цвет` в `resourceIcons.ts`: Pod=Dot, Deployment=Boxes, StatefulSet=Database, DaemonSet=Server, Job=Clock, CronJob=Timer, Service=Network, Ingress=Globe, ConfigMap=FileCode, Secret=Key, PVC/PV=HardDrive, StorageClass=Braces, Node=Cpu, Namespace=Layers, Event=Bell, CRD=Puzzle, Helm=Anchor, ServiceAccount=IdCard, Role=Shield.

### 4.8. Инвентарь базовых UI-компонентов (`components/ui/`)

| Компонент | Ключевые пропсы | Notes |
|---|---|---|
| `Button` | variant: primary/secondary/ghost/danger; size: sm/md; loading | secondary = поверхность с бордером |
| `IconButton` | icon, tooltip, variant | 28×28 (sm 24×24) |
| `Input` | size, icon?, invalid | mono-режим для поисков |
| `SearchInput` | placeholder, onClear | с Esc и фокусом по ⌘F |
| `Select` (Radix) | items, value, onChange | НЕ нативный `<select>` |
| `Combobox` | items, filterFn | Select с поиском (namespace) |
| `DropdownMenu` (Radix) | items с разделителями, чекмарки | база всех меню |
| `ContextMenu` (Radix) | items | то же по ПКМ |
| `Tooltip` (Radix) | content, delay 500 | 1px-граница |
| `Dialog` / `ConfirmDialog` (Radix) | danger?, confirmByText? | ConfirmDialog может требовать ввод имени объекта |
| `Toast` + `toastCenter()` | variant: info/success/warn/error; action?; timeout 4s | стек справа-внизу; error — держится до закрытия |
| `Tabs` (underlined, JetBrains-стиль) | value | underline 2px accent (внутренние секции) |
| `Badge` / `StatusDot` / `StatusBadge` | status → §4.4 | StatusBadge уже есть → перевести на токены |
| `Kbd` | children | 11px, mono, низкоконтрастный |
| `Checkbox` / `Switch` (Radix) | — | — |
| `Spinner` | size 12/16 | только глобальные/кнопки |
| `Skeleton` | variant: row/panel | для первого sync |
| `EmptyState` | icon, title, description, action? | стандартизирован везде |
| `ErrorState` | error, retry | для панелей/страниц |
| `PanelHeader` | collapsible, actions | база заголовков sidebar/дока |
| `Resizer` | onDelta | ручные ресайзы (ширина aside) |
| `CodeBlock` | code, lang?, maxHeight | read-only подсветка |
| `LabelChips` | labels map | kubectl-стиль чипсы |

> Каждое имя из инвентаря к использованию обязательно, дубли не создавать. Дерево файлов — раздел 12.

---

## 5. Макет окна (Layout)

### 5.1. Схема

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│ TitleBar (40)                                                                     │
│ [⎈ Kubiki] [context ▾] [namespace ▾]        Search ⌘K           ● Ready v1.31.2  │
│ (зона под OS traffic lights на macOS; window-кнопки справа на Win/Linux)          │
├──┬──────────────────────┬──────────────────────────────────────────┬──────────────┤
│A │ Sidebar (220–320)    │ Editor Area (dockview)                   │ Inspector    │
│c │ ─ Cluster Explorer   │ tabs: [Explorer·Pods] [po/api-gw … ] [+] │ (0–380)      │
│t │  ▾ Workloads         │ ──────────────────────────────────────── │ tabs:        │
│i │    ● Pods (42)       │ ResourceToolbar                          │ Summary      │
│v │    ○ Deployments     │ filter · ns:[all ▾] · refresh · Apply   │ YAML         │
│  │    …                 │ [Virtualized ResourceTable 28px rows]    │ (реж. pane)  │
│B │  ▾ Config            │                                          │              │
│a │  ▾ Network           ├──────────────────────────────────────────┴──────────────┤
│r │  ▾ Storage           │ Bottom Dock (0–420, default 240; dockview)              │
│  │  ▾ Access            │ [>_ Terminal] [Logs] [Ports (2)] [Events]               │
│  │  ▾ Helm              ├─────────────────────────────────────────────────────────┤
│  │                      │ StatusBar (26)                                          │
└──┴──────────────────────┴─────────────────────────────────────────────────────────┘
   conn: minikube · ns: default · pf: 2 · shells: 1 · events (3) · watching: 12 kinds
```

Размеры: ActivityBar 48; Sidebar default 240 (min 200, max 360, resizable); Inspector default 340 (min 280, max 480; **в режиме `tabs` отсутствует**); Bottom Dock default 260 (min 120, max 60% высоты). Всё ресайзится и сохраняется.

### 5.2. Поведение зон

- **Editor Area = dockview-группа `main`.** Первая панель — «Explorer · Pods» (список активного `activeKind`), id `explorer:<kind>`. Детали открываются как панели `resource:<kind>:<ns>:<name>` **или** в правой группе `inspector` (см. 5.3).
- **Bottom Dock = dockview-группа `dock` в позиции bottom** — панели `terminal`, `logs`, `ports`, `events` (каждая со своими внутренними вкладками сессий). Сворачивание — `⌘J`.
- **Inspector** — отдельная dockview-группа `inspector` справа (режим `pane`). Внутри тот же `ResourceDetail`; ширина ресайзится; в заголовке — переключатель режима (`↔ Tabs`).
- Переключатель режимов деталей `resourceOpenMode: 'pane' | 'tabs'` (настройка + кнопка в заголовке Inspector/таба + команда палитры). Он **не меняет содержимое**, только место укладки панели: одна и та же панель `resource:X` добавляется либо в `main`, либо закрепляется в `inspector`.
- **Sidebar** — за пределами dockview (контекстное дерево). Всегда сворачиваемо (`⌘B`).
- **Пустое состояние editor area:** когда нет ни одной панели — dockview watermark: логотип Kubiki + приветствие + кнопки «Open Pods», «Command Palette ⌘K».

### 5.3. Матрица открытия деталей (режимы)

| Действие | В режиме `pane` (Lens-стиль) | В режиме `tabs` (VS Code-стиль) |
|---|---|---|
| клик по строке | Inspector открывается/фокусируется, внутри ресурс | новый/активный таб в main |
| двойной клик | то же | открыть в новом табе с фокусом |
| средний клик | игнорируется | открыть неактивным табом |
| Enter в таблице | то же, что клик | таб + фокус |
| Space | то же, что Enter (в v1 Space не отдельное действие) | то же |
| Esc в детали | закрыть Inspector (если не pinned) | закрыть активный таб |

> По умолчанию **`pane`** (ближе к Lens, не плодит табов). Переключение — Settings → Interface, команда палитры «View: Toggle Resource Open Mode» и кнопка в заголовке Inspector/таба (иконки PanelRight/Columns3).

### 5.4. Персистентность раскладки

- dockview model сохраняется при изменении (debounce 300ms) в `localStorage["kubiki.layout.v1"]` (JSON `api.toJSON()`); при старте восстанавливается, при несовместимости схемы — сброс.
- Размерные значения (ширина sidebar/inspector, высота dock в закрытых состояниях) — в `settings_store` с ключом `kubiki.window.v1`.

### 5.5. Минимальная ширина и адаптивность

- minWidth 900 (уже в tauri.conf). При 900–1100px: Inspector ≤ 300, Sidebar ≤ 240; табы dockview сокращаются стрелками.
- macOS: зона под traffic lights учитывается ручным отступом (decorations:false).
- Панели/таблицы не «прыгают» (layout shift) при загрузке данных — скелетоны фиксированной высоты.

---

## 6. Навигация и информационная архитектура

### 6.1. Perspectives (Activity Bar) → содержимое Sidebar и стартовый view

| Perspective | Разделы Sidebar | Стартовый kind |
|---|---|---|
| `workloads` | Pods, Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs, CronJobs | Pod |
| `config` | ConfigMaps, Secrets | ConfigMap |
| `network` | Services, Ingresses (NetworkPolicies — позже) | Service |
| `storage` | PVCs, PVs, StorageClasses | PersistentVolumeClaim |
| `access` | ServiceAccounts, Roles, ClusterRoles, RoleBindings, ClusterRoleBindings | ServiceAccount |
| `helm` | Releases, Repositories | HelmRelease (особый view) |
| `crd` | Custom Resources (динамически из CrdDiscovery) | первый CRD |
| `cluster` | Nodes, Namespaces, Events | Node (Overview) |
| `settings` (низ ActivityBar) | нет sidebar — открывает Settings | — |

- Активная perspective подсвечивается вертикальной полосой слева; переключение — клик или хоткеи (раздел 8).
- Точки для пользовательских расширений (будущие плагины) — под разделителем.

### 6.2. Cluster Tree (Sidebar)

- Заголовок панели: «Cluster Explorer». Под ним — компакт-бейджи context и namespace; строка поиска фильтрует пункты дерева, помня открытые группы.
- Пункт дерева: icon по kind, label, счётчик (live), error-dot 6px, если среди объектов есть danger-статусы.
- Группы всегда видны; счётчики — из resource_store; пустые — серым `0`.
- ПКМ по пункту: Refresh, Open in New Tab (режим tabs), Copy kubectl command (`kubectl get pods -n default`), Pin.
- Выбор пункта меняет `activeKind` → таблица в main (или активирует соответствующий Explorer-таб).

### 6.3. Табы контента

Табы-панели Editor Area: `explorer:<kind>` для списков и `resource:<kind>:<ns>:<name>` для деталей. Логи/терминалы — панели Bottom Dock, **не** встраиваются в деталь (но кнопки «Open in dock» из детали их создают).

---

## 7. Спецификации ключевых экранов

### 7.1. TitleBar

- Слева: капсула-логотип 22px (⎈ на тёмно-синей плашке) + «Kubiki» 13px/600.
- Context Picker: кнопка-капсула (bg surface, hover) с Server-иконкой и зелёной точкой + имя; выпадающий список (Radix): секции «Current» и «Other Contexts» с подзаголовком cluster/user; внизу «Open kubeconfig…» (открывает файл через plugin-opener — позже).
- Namespace Picker: Combobox с поиском: «All Namespaces» + список из `namespaces_list`.
- Центр: кнопка «Search / Command Palette» (⌘K) — капсула 260px, как в VS Code (icon + kbd-подсказка).
- Справа: индикатор соединения (dot + version), кнопка notifications (badge-счётчик), window-контролы (A-13): – □ × (hover bg #ffffff14; close — hover красный).
- Весь бар — `data-tauri-drag-region`; интерактивные элементы — нет.
- ПКМ по TitleBar: Maximize/Minimize, Settings, About, DevTools (dev).

### 7.2. ResourceTable (ядро UI)

- **TanStack Table v9**: колонки задаются картой `columnSpecs[kind]` (см. ниже); сортировка по клику (asc→desc→none), неявная вторичная сортировка по Name; сортировки: Age — по timestamp, CPU/Memory — по байтам.
- **TanStack Virtual**: overscan 12, rowHeight по плотности.
- Sticky header 30px, фон `--bg-panel`, текст 11/600 caps.
- Выделение: одиночное + shift-range; `selectedUids` set в store; фон `--bg-selected`.
- Строки без зебры; hover `--bg-hover`; доступ к accessor'ам через `columnHelper`.
- Hover-действия справа (для Pod/Service: Terminal, Logs, Port Forward) и после них «⋮» — полное контекстное меню.
- Меню строки (ПКМ): Open (деталь), Logs (pod), Terminal (pod), Port Forward (pod/svc), Edit YAML, Scale (Deployment/STS/RS), Restart (deployment/sts/daemonset), Copy name/uid/yaml, Delete (danger, с подтверждением).
- Виртуализация + `contain: strict` на контейнере.
- Фильтр: SearchInput в тулбаре; free-text по name/namespace/status/labels (chip-синтаксис `ns:`/`label:` — фаза UI-7+).
- Тулбар (36px над таблицей): слева «Pods (42)» (kind + счётчик), справа живой индикатор watch-состояния («Synced · 42» / «Syncing…» / «Stale»).

Спецификации колонок по kind:

| Kind | Колонки (после Name/Namespace) |
|---|---|
| Pod | Status (badge), Ready (1/2), Restarts, CPU, Memory, IP, Node, Age |
| Deployment | Status, Ready (2/2), Up-to-date, Available, Age |
| StatefulSet / DaemonSet / ReplicaSet | Status, Ready, Age |
| Job | Status, Completions (1/1), Duration, Age |
| CronJob | Status, Schedule, Last Schedule, Suspend, Age |
| Service | Type, ClusterIP, Ports (80:30080/TCP), Age (+ кнопка PF) |
| Ingress | Hosts, Ports, ClassName, Age |
| ConfigMap | Data (#), Age |
| Secret | Type (Opaque/TLS/…), Data (#), Age |
| PVC | Status, Volume, Capacity, StorageClass, Access Modes, Age |
| PV | Status, Claim, Capacity, StorageClass, Reclaim Policy |
| StorageClass | Provisioner, Reclaim, Volume Binding, Age |
| Node | Status (Ready/SchedulingDisabled), Roles, Version, CPU (cap), Mem (cap), Pods (#/110), Internal IP, OS/Arch |
| Namespace | Status, Labels, Age |
| Event | Severity (dot), Reason, Message (trunc), Object, Count, Last Seen |
| CRD (generic) | Name + колонки из additionalPrinterColumns (динамически), Age |

- Sparklines CPU/Mem в колонках — фаза UI-8 (SVG `<Sparkline>`); до того — текстовые значения.
- Состояния: нет объектов → EmptyState с иконкой kind («No Pods in current namespace», кнопки «All namespaces» / «Refresh»); нет соединения → ErrorState с Retry; первый sync → skeleton rows (12, один раз).

### 7.3. ResourceDetail (единый контент для pane и tabs)

Заголовок панели: breadcrumb `ns / kind-icon kind / name` (mono); справа иконки: Copy YAML, переключатель режима (в Inspector), Pin, ×.

Внутренние табы (underline):

1. **Summary** — карточки:
   - Status: бейдж + reason + время последнего перехода; conditions (LastTransitionTime).
   - Metadata: Namespace, UID (mono, copy), Created (точный возраст в тултипе), Labels (чипсы с копированием), Annotations (свернутые).
   - Owners: `OwnerReferences` кликабельны (переход к владельцу, «owners chain»).
   - Pod: карточки контейнеров (name, image, status, restarts, ports, resources; кнопки Logs/Terminal на контейнер); Volumes; Node — кликабелен.
   - Deployment/STS: стратегия, replicas, CONDITIONS.
   - Service: таблица портов, selector, ExternalIP; кнопка Port Forward.
   - Events: последние 10 событий объекта (live).
2. **YAML** — Monaco (lazy) с `monaco-yaml` и схемой (read-only в UI-3; редактирование — UI-6): line numbers, minimap off, тема kubiki на токенах; действия: Copy, Download, Reload.
3. **Logs** (только Pod) — компактный preview (tail 200) + кнопка «Open in dock».
4. **Terminal** (только Pod) — выбор контейнера и кнопки открытия.
5. **Metrics** (после фазы метрик) — графики CPU/Mem.

> В режиме `pane` заголовок Inspector компактен: только breadcrumb и ×; внутренние табы condensed.

### 7.4. Logs (док-панель `logs`)

- **Буфер:** ring buffer 10 000 строк в `log_store` (JS-side); поток из `logs_start` IPC (сервер шлёт чанками ≤512 строк).
- Тулбар: выбор контейнера (dropdown, если >1), «previous» toggle, tail (None/100/1000/all), follow (autoscroll) toggle, pause (стоп-буфер), поиск (regex, case), фильтр по уровню (INFO/WARN/ERROR chips), wrap, timestamps, download, copy all, clear.
- Рендер: виртуализированный список (TanStack Virtual), mono 12px; собственный ANSI-парсер (30–37/90–97 fg/bg, bold; blink игнорируется); уровневая окраска, ERROR — 2px красная полоса слева.
- Статусная строка панели: `streaming…` (pulse) / `paused (buffered: 243)` / `ended (exit 0)`.
- Ошибки стрима: inline banner «Stream error: EOF (pod restarted)» + Reconnect (тихие 3 попытки, затем банер).

### 7.5. Terminal (док-панель `terminal`)

- xterm.js: тема kubiki (fg/bg/16 цветов из токенов), fontSize 12 mono, fit addon на resize (ResizeObserver), search addon (⌘F), webLinks.
- Типы сессий: `exec` (в контейнер, via `exec_start` + WS) и `local` (portable-pty, «Host terminal», работает и без кластера).
- Вкладки сессий в панели: заголовок `po/api-gw · sh`; ПКМ: rename, split right, duplicate, close.
- Контекстная строка exec-сессий: `pod/ns · container · shell ▾ (bash/sh) · kill`.
- Resize → `exec_resize` (cols/rows, debounce 100ms) — обязательно.
- Кнопки: Send Ctrl+C, Clear, Reconnect.
- Idle-таймаут (5 мин) — предупреждение-банер, без прерывания.

### 7.6. Port Forward (док-панель `ports` + диалог)

- Кнопка «Port Forward» у Pod/Service → `PortForwardDialog`: target port (container/port), local port (auto=0 → фактический показывается после старта), опция «Open browser».
- Панель Ports: таблица сессий: kind/name, remote → local (mono, copy), трафик байты/с (миниграф), Uptime, Status (Active/Idle), действия: Open URL, Stop, Copy.
- Status Bar показывает `⚓ pf: N` — клик открывает панель.
- При смене контекста с активными сессиями: ConfirmDialog «N tunnel(s) will be closed».

### 7.7. Events (док-панель `events`)

- Лента live-событий кластера: severity dot + type (Normal/Warning), reason, объект (кликабелен → деталь), count, last seen, message.
- Фильтры: только errors (chip), по объекту/namespace/тексту; пауза автоскролла при hover; Clear.
- Хранилище: ring 2000 в `event_stream_store`.

### 7.8. Cluster Overview (perspective `cluster`)

- СтрокаSummary: version, API endpoint, context info, nodes ready x/y.
- Таблица Nodes (по 7.2) с capacity-полосами CPU/Mem/Pods (бары 44×4px по токенам).
- Карточки Namespaces: name, счётчики ключевых kinds, health dot.
- Дисковая ёмкость: сводный список PVC с заполненностью (used/capacity).
- Последние 10 warning-событий кластера.

### 7.9. Helm (perspective `helm`)

- **Releases:** таблица (name, namespace, chart, appVersion, status deployed/failed, revision, updated); действия: History, Rollback (диалог выбора ревизии с diff values в Monaco Diff), Upgrade (values → confirm → apply), Uninstall (confirm по вводу имени).
- Release detail (в pane/tabs как ресурс): Summary (chart/values/revision), Manifests (затронутые объекты, клик → деталь), Values (Monaco), History (таблица с действиями).
- **Repositories:** таблица (name, url, last update, count charts); действия: Refresh (bg), Edit, Remove (confirm).
- Install из чартов — задача 7.2 roadmap; фаза UI-9 включает базу: releases/history/rollback/repos.

### 7.10. Custom Resources (CRD) — generic view

- Sidebar-секция `crd` строится из `crds_list` IPC: группы по `spec.group`, пункты по `spec.names.plural`.
- Таблица CRD-ресурсов: колонки из `additionalPrinterColumns` (JSONPath → простые извлечения) + Age; fallback: Name, Namespace, Age.
- Detail: Monaco read-only; schema-aware YAML-редактирование (из `openAPIV3Schema`).
- Без выбранного CRD — EmptyState «Select a Custom Resource in the sidebar».

### 7.11. Settings (панель)

Разделы (Tabs слева):
- **General:** custom titlebar on/off, language (только English — disabled), check for updates (stub).
- **Appearance:** theme (Dark; Light/System — позже), density (Compact/Comfortable), UI font size (12/13/14), resource open mode (pane/tabs).
- **Terminal:** default shell (auto/sh/bash), scrollback (1000/5000/10000), copy-on-select.
- **Data:** kubeconfig path (поле + file picker + Reset), auto-connect on start.
- **Keybindings:** таблица хоткеев (read-only в UI-10; редактирование позже).
- **About:** версия, ссылки, лицензии.

Хранение: UI-настройки — `localStorage["kubiki.settings.v1"]`; системные (kubeconfig path) — через `settings_get/set` IPC (файл `~/.config/kubiki/config.toml`).

### 7.12. Command Palette (⌘K / ⌘⇧K)

- Overlay по центру, 560px, input с фильтром, список ≤12 результатов с секциями.
- Провайдеры: `navigate` (perspectives, views, settings), `resource` (fuzzy по watched-именам → деталь), `context`/`namespace` (переключение), `action` (Open logs/PF/Restart/Scale выбранного), `settings` (toggle theme/mode/sidebar), `kubectl` (показать соответствующую kubectl-команду контекста).
- Fuzzy: собственный скорер (A-14): подстрока без регистра → подпоследовательность → score по позициям и длине префикса; совпадения подсвечиваются жирным accent.
- Хоткеи: Enter — выполнить; Esc — закрыть; стрелки — навигация.
- Дополнительная «мета-фича»: под палитрой показывается kubectl-команда текущего действия (обучение новичков).

### 7.13. Глобальные состояния и уведомления

- **Connection banner** (вверу editor area): «Connection lost — retrying (3)…» + Retry; исчезает при восстановлении.
- **Toasts** (справа-внизу): все результаты мутаций; формат «Pod api-gw-x91 deleted»; error — с кнопкой Details (Dialog с JSON ошибки).
- **Skeleton:** первая загрузка таблицы — 12 строк, shimmer.
- **EmptyState-паттерны** — в спецификации каждого view.
- **Esc-иерархия:** palette → dialog → context menu → inspector/таб → ничего.

---

## 8. Хоткеи (единая таблица; keybinding map в `core/keybindings.ts`)

| Действие | Windows/Linux | macOS |
|---|---|---|
| Command Palette (Search) | `Ctrl+K` | `⌘K` |
| Palette (commands only) | `Ctrl+Shift+K` | `⌘⇧K` |
| Toggle Sidebar | `Ctrl+B` | `⌘B` |
| Toggle Bottom Dock | `Ctrl+J` | `⌘J` |
| Toggle Inspector | `Ctrl+Alt+I` | `⌘⌥I` |
| Resource Open Mode toggle | `Ctrl+Alt+M` | `⌘⌥M` |
| Perspectives: workloads/config/network/storage/access/helm/crd/cluster | `Ctrl+1..8` | `⌘1..8` |
| Open detail of selected row | `Enter` | `Enter` |
| Open detail in new tab | `Ctrl+Enter` | `⌘Enter` |
| Copy UID of selection | `Ctrl+Alt+C` | `⌘⌥C` |
| Delete selected (confirm) | `Delete` | `Delete` |
| Logs panel focus | `Ctrl+L` | `⌘L` |
| Terminal focus/new | `Ctrl+\`` | `⌃\`` |
| Close active tab/panel | `Ctrl+W` | `⌘W` |
| Split editor right | `Ctrl+\` | `⌘\` |
| Next/prev tab | `Ctrl+PgUp/PgDn` | `⌃PgUp/PgDn` |
| Search in table | `Ctrl+F` | `⌘F` |
| Refresh kind | `F5` | `F5` |
| Esc-иерархия | `Esc` | `Esc` |

Реализация: `core/keybindings.ts` — dispatcher (keydown → command по карте; modKey = Ctrl / Meta в зависимости от платформы). В полях ввода глобальные хоткеи не перехватываются, кроме палитры.

---

## 9. Данные и сервисный слой

### 9.1. Provider-интерфейсы (`src/core/providers/types.ts`)

```ts
export interface IClusterProvider {
  listContexts(): Promise<KubeContextInfo[]>;
  useContext(name: string): Promise<void>;
  health(): Promise<{ version: string; connected: boolean }>;
  listNamespaces(ctx: string): Promise<string[]>;
  onStatus(cb: (s: ClusterStatus) => void): Unsubscribe;
}

export interface IResourceProvider {
  watch(req: WatchRequest): Promise<WatchSession>; // { stop() }
  get(kind: string, ns: string | null, name: string): Promise<ResourceItem>;
  apply(manifest: string): Promise<ResourceItem>;
  delete(kind: string, ns: string | null, name: string): Promise<void>;
  scale(kind: string, ns: string | null, name: string, replicas: number): Promise<void>;
  restart(kind: string, ns: string | null, name: string): Promise<void>;
  deltas(cb: (batch: ResourceDelta[]) => void): Unsubscribe;
}

export interface IPodOpsProvider {
  logsStart(req: LogRequest): Promise<LogSession>;   // { buffer$, stop() }
  logsStop(id: string): Promise<void>;
  execStart(req: ExecRequest): Promise<ExecSession>; // { write(data), resize(c,r), close() }
  pfStart(req: PfRequest): Promise<PfSession>;
  pfStop(id: string): Promise<void>;
  pfList(): Promise<PfSession[]>;
}

export interface IHelmProvider { /* releases, history, rollback, repos */ }
export interface IMetricsProvider { /* nodes(), pods(), subscribe() */ }
export interface ICrdProvider { /* list(), watchCrd(gvk) */ }
export interface ISettingsProvider { /* app-level config file */ }
```

Реализации: `providers/tauri/*` (invoke/listen) и `providers/mock/*` (детерминированная фабрика: 3 кластера, поток изменений каждые 2–4 с, генератор логов с ERROR-строками, фиксированные метрики). Выбор: `mock` если `!isTauri()` или `prefs.dev.mockBackend`; иначе tauri.

### 9.2. Tauri IPC Contract (цель; реализуется в src-tauri по ходу фаз)

**Commands (snake_case):**

| Группа | Команды |
|---|---|
| cluster | `contexts_list` `context_use` `cluster_health` `namespaces_list` |
| resources | `resources_watch {kind, group, version, plural, ns}` `resources_unwatch {id}` `resource_get` `resource_apply` `resource_delete` `resource_scale` `resource_restart` |
| pods | `logs_start {ns,pod,container,tail,follow,timestamps,previous}` `logs_stop` `exec_start {ns,pod,container,shell}` `exec_write` `exec_resize` `exec_stop` |
| pf | `pf_start {ns,target_kind,target_name,remote,local}` `pf_stop {id}` `pf_list` |
| helm | `helm_releases {ns}` `helm_history` `helm_rollback` `helm_repos_list/add/remove/update` |
| metrics | `metrics_nodes` `metrics_pods {ns}` |
| crd | `crds_list` `crd_watch {gvk, ns}` |
| settings | `settings_get` `settings_set` |
| app | `app_version` `open_external {url}` |

**Events (Rust → JS):**

| Event | Payload |
|---|---|
| `kubiki://resources/delta` | `{ batch: Array<{type:'Applied'|'Deleted'|'Restarted', kind, items?/data?/uid?}> }` — батчи по 50 мс |
| `kubiki://logs/stream` | `{ sessionId, lines: string[], done?, error? }` (порции ≤512) |
| `kubiki://exec/stream` | `{ sessionId, data: base64, exit? }` |
| `kubiki://pf/stats` | `{ id, status, bytesIn, bytesOut, ts }` каждую секунду |
| `kubiki://cluster/status` | `{ context, connected, version, error? }` |
| `kubiki://events/stream` | `{ batch: K8sEvent[] }` — отдельный informer Events |

Батчинг: Rust-информеры шлют дельты; на Tauri-стороне менеджер копит 50 мс окно и эмитит одну батч-событие. Каналы логов/exec мультиплексируются по sessionId.

**Bindings:** план — подключить `tauri-specta` (roadmap 0.1.4) для генерации `src/bindings/commands.ts`; до этого — ручной typing в `core/ipc/commands.ts` (source of truth для JS-стороны).

### 9.3. Stores (Zustand) — полный список

| Store | Отвечает за | persist |
|---|---|---|
| `settings_store` | тема/плотность/режим деталей/шрифты/dev-флаги | `kubiki.settings.v1` |
| `ui_store` | active perspective, открытые диалоги, palette open, sidebar collapsed | — |
| `layout_store` | dockview model snapshot, размеры панелей | `kubiki.layout.v1` |
| `cluster_store` | contexts, current, namespaces, health (✅ существует — расширить) | — |
| `resource_store` | Map kind→uid→ResourceItem, deltas, selection, activeKind (✅ существует — расширить) | — |
| `watch_store` | активные watch-сессии (kind → syncing/synced/stale/error), lastSyncAt | — |
| `log_store` | log sessions: ring buffers, фильтры, pause/follow | — |
| `terminal_store` | терминальные сессии (exec/local) | — |
| `pf_store` | pf-сессии, байтовые счётчики | — |
| `event_stream_store` | события кластера (ring 2000) | — |
| `helm_store` | releases, repos, history | — |
| `metrics_store` | последние samples (ring 120 на target) | — |
| `crd_store` | список CRD + динамические watches | — |
| `notifications_store` | toasts | — |

Правила: селекторные подписки (`useStore(s => s.slice)`), shallow-сравнение для массивов; `persist` только у двух сторов.

### 9.4. Обработка ошибок

Все запросы через providers возвращают `Result<T, KubikiError serialized>`; UI-слой обёрнут хуком `useAsync`: loading (skeleton) / error (ErrorState + Retry) / success. Mutations → toast; ошибки watch → `watch_store.status = 'error'` + индикатор на панели.

---

## 10. План работ — фазы UI-0 … UI-11

График зависимостей:

```
UI-0 ─→ UI-1 ─→ UI-2 ─→ UI-3 ─→ UI-4 ─┬─→ UI-5 ─┬─→ UI-8
                              │        ├─→ UI-6 ─┤
                              │        ├─→ UI-7 ─┤
                              │        └─→ UI-9 ─┤
                              ├─→ UI-10 (palette, settings)
                              └────────────────→ UI-11 (light theme + polish)
```

Размеры: S (≤1 день), M (1–3 дня), L (3–7 дней) — ориентировочно для одного разработчика/агента.

---

### Фаза UI-0 — Фундамент: дизайн-токены и UI-примитивы (M)

**Цель:** чтобы все последующие фазы собирали UI из готовых кирпичей, а не изобретали.

Задачи:
- [ ] **UI-0.1** `src/design/tokens.css`: полный набор токенов §4.1 (dark) + `@theme inline`-маппинг цветов/шрифтов/radius в tailwind-утилиты; перенести содержимое `App.css` (файл удалить); `index.html` — `data-theme="dark"`.
- [ ] **UI-0.2** Шрифты локально (A-08): `@fontsource-variable/inter`, `@fontsource-variable/jetbrains-mono`; обновить `--font-sans/--font-mono`, системные — fallback.
- [ ] **UI-0.3** Установить Radix-зависимости (список из раздела 3).
- [ ] **UI-0.4** UI-kit (`components/ui/*`): Button, IconButton, Input, SearchInput, Select, Combobox, DropdownMenu, ContextMenu, Tooltip, Dialog, ConfirmDialog, Toast(+toastCenter), Checkbox, Switch, Badge, StatusBadge (факторинг на токены), StatusDot, Kbd, Spinner, Skeleton, EmptyState, ErrorState, PanelHeader, Tabs, CodeBlock, LabelChips, Resizer — пропсы по §4.8.
- [ ] **UI-0.5** `/styleguide` (dev-only): стр.-галерея всех компонентов в обеих плотностях.
- [ ] **UI-0.6** Каркас `core/keybindings.ts` + глобальный focus-visible; App shell оборачивается в `ErrorBoundary`.

Критерии приёмки:
- ✅ Styleguide открывается; все компоненты рендерятся, включая dialog/menu/tooltip с корректной a11y.
- ✅ В компонентах нет литеральных hex (кроме styleguide) — только токены.
- ✅ lint/typecheck зелёные.

---

### Фаза UI-1 — Слои данных: Provider + контексты через IPC (M)

**Цель:** отделить UI от источников данных; реальные контексты/версия/namespaces из ядра.

Задачи:
- [ ] **UI-1.1** `core/providers/types.ts` (интерфейсы §9.1) + фабрика выбора провайдера (A-06).
- [ ] **UI-1.2** `providers/tauri/cluster.ts` — обёртки существующих команд; `providers/mock/*` — mock-кластеры (2–3 контекста, детерминированные).
- [ ] **UI-1.3** `core/ipc/client.ts` (typed invoke) и `events.ts` (listen-helper).
- [ ] **UI-1.4** Расширить `cluster_store`: health polling (5s), состояния connected/error; загрузка namespaces.
- [ ] **UI-1.5** `settings_store` (persist): theme, density, `resourceOpenMode: 'pane'`, customTitlebar, dev.mockBackend.
- [ ] **UI-1.6** `notifications_store` + toastCenter в App shell.

Критерии приёмки:
- ✅ На mock: TitleBar показывает контексты/namespaces/health (версия моковая).
- ✅ На tauri (реальный кластер): список контекстов совпадает с `kubectl config get-contexts`; версия — с `kubectl version`.
- ✅ Toast при disconnect отображается.

---

### Фаза UI-2 — Dockview-скелет: области, вкладки, persistence (M)

**Цель:** настоящая IDE-оболочка.

Задачи:
- [ ] **UI-2.1** Обвязка dockerview: `EditorRegion` (main), `DockRegion` (bottom), `InspectorRegion` (right) — один корень `DockviewReact`, кастомная тема через CSS vars; кастомный заголовок таба (icon+label), watermark.
- [ ] **UI-2.2** `layout_store`: serialize/restore (onReady → onModelChange, debounce), команда reset.
- [ ] **UI-2.3** Первые панели: `explorer:Pods` (замена текущего главного экрана), `dock:terminal/logs/ports/events`, панель `inspector`.
- [ ] **UI-2.4** Activity Bar переписать по §4.7 (тултипы, активная полоса).
- [ ] **UI-2.5** TitleBar по §7.1 (Radix Select, кнопка палитры (stub), custom window controls, `decorations:false`, drag-regions).
- [ ] **UI-2.6** Status Bar (26px) по §5.1: элементы и клики (context→menu, ns→combobox, pf→панель, events→панель).
- [ ] **UI-2.7** Sidebar shell: заголовок панели + каркас дерева (данные — в UI-3).
- [ ] **UI-2.8** Хоткеи: ⌘B/⌘J/⌘W/⌘1..8 работают.

Критерии приёмки:
- ✅ Перетаскивание панелей работает (перенос terminal в right group сохраняется и восстанавливается после рестарта).
- ✅ Toggle Sidebar/Dock/Inspector запоминает состояние.
- ✅ Окно 900×600: всё живо, без срывов скролла.

---

### Фаза UI-3 — Explorer: дерево + таблица + деталь (базовая) (L)

**Цель:** главный сценарий «выбрал kind → вижу таблицу → открыл под → читаю статус/YAML».

Задачи:
- [ ] **UI-3.1** Cluster Tree по §6.2 (группы + счётчики из store), поиск по дереву, сохранение раскрытых групп.
- [ ] **UI-3.2** `ResourceTable` на TanStack Table+Virtual (§7.2): `columnSpecs`, hover-действия, контекстное меню, multi-select, sticky header, сортировка; плотности.
- [ ] **UI-3.3** `ResourceToolbar` (36px): kind+count, поиск, ns-filter (Combobox, синхронно с TitleBar), плотность, refresh.
- [ ] **UI-3.4** `ResourceDetail` (§7.3): Summary-карточки + YAML-таб (lazy Monaco, read-only) + breadcrumbs; укладка в pane/tabs по общему режиму.
- [ ] **UI-3.5** Переключение режимов pane/tabs (логика §5.3), кнопка в заголовке Inspector.
- [ ] **UI-3.6** Мок-объекты расширить: deploy/sts/ds/job/cronjob/configmap/secret/pvc/pv/sc/node/ingress/service/ns + conditions/ownerReferences.
- [ ] **UI-3.7** Skeleton/Spinner/EmptyState во всех местах.

Критерии приёмки:
- ✅ 1000 моковых подов — 60fps скролл.
- ✅ Открытие детали: pane — Inspector открывается; tabs — таб создаётся и закрывается ⌘W; переключение режимов мгновенное, состояние не теряется.
- ✅ YAML копируется/скачивается; breadcrumb — кликабельный.

---

### Фаза UI-4 — Живые данные: IPC-watch, реальные объекты (L)

**Цель:** UI живёт как Lens: изменения кластера видны мгновенно.

Задачи:
- [ ] **UI-4.1** src-tauri: команды `resources_watch/unwatch`, подключение InformerManager (ядро умеет), батчер 50ms, emit `kubiki://resources/delta`.
- [ ] **UI-4.2** `providers/tauri/resources.ts` + `watch_store`: сессии по (kind,ns), ленивый старт/стоп при переключении ns/kind (базовый набор: Pod, Deployment, Event, Node).
- [ ] **UI-4.3** `resource_store.applyDelta` — edge-cases (полный ресет на Restarted и т.п.), поддержка нескольких watch'ей.
- [ ] **UI-4.4** First-sync skeleton; статусы Synced/Syncing/Stale в тулбаре (stale после 60s без событий).
- [ ] **UI-4.5** Cluster status event → TitleBar dot + Status Bar + disconnect banner + toast.
- [ ] **UI-4.6** Обработка RBAC-запретов: forbidden → EmptyState с пояснением.
- [ ] **UI-4.7** Events informer → `event_stream_store` + счётчики в Sidebar.

Критерии приёмки (на реальном кластере):
- ✅ `kubectl scale deployment X --replicas=2` → таблица обновляется без reload за < 200ms.
- ✅ `kubectl delete pod` → строка уходит мгновенно; индикатор «Syncing» мерцает 50–500ms.
- ✅ Смена context → watch-сессии пересоздаются, старые снимаются; 10 переключений подряд — memory stable.
- ✅ 200+ подов — виртуализация не дефектует; delta-стрим не грузит CPU (>2% idle не занят).

---

### Фаза UI-5 — Pod Ops: Logs, Terminal, Port Forward (L)

**Цель:** ключевая тройка Lens-сценариев.

Задачи:
- [ ] **UI-5.1** Logs: док-панель по §7.4 (виртуальный список, ANSI, фильтры, follow, pause, search, download, container picker, previous, tail). IPC `logs_start/stop` + `kubiki://logs/stream`.
- [ ] **UI-5.2** Terminal: док-панель по §7.5: local PTY (portable-pty) + exec (kube WS); resize, поиск, выбор контейнера/shell, таб-бар, reconnect.
- [ ] **UI-5.3** PF: диалог + панель Ports по §7.6; статус-бар badge; открытие браузера через plugin-opener.
- [ ] **UI-5.4** Кнопки в таблице/детали (Logs/Terminal/PF) → создают/фокусируют док-панели; множественные сессии — вкладками.
- [ ] **UI-5.5** Хоткеи терминала (`Ctrl+\``), ESC-иерархия.
- [ ] **UI-5.6** ConfirmDialog при смене контекста с активными PF/Exec (закрытие сессий).

Критерии приёмки (реальный кластер):
- ✅ Логи busy-пода (nginx/coredns) идут плавно; follow/pause не теряют хвост буфера; поиск работает.
- ✅ exec `sh`: resize корректен (`tput cols`), Ctrl-C/D и tab работают.
- ✅ PF: туннель к service отвечает на curl localhost:PORT; Stop реально закрывает слушатель.
- ✅ Память при 2 логах + 2 терминалах не растёт (буферы ограничены).

---

### Фаза UI-6 — YAML editor: schema, diff, apply (M)

Задачи:
- [ ] **UI-6.1** `monaco-yaml` + k8s schema; тема-синхронизация; вид diff-редактора.
- [ ] **UI-6.2** Edit YAML из детали: полноэкранный диалог (92%), Monaco редактирование; действия Save (apply), Cancel, Reset (контент заново с сервера).
- [ ] **UI-6.3** Diff view (Monaco DiffEditor) перед применением: слева origin, справа edited.
- [ ] **UI-6.4** `resource_apply` IPC (serde_yaml уже в deps) + ток; при ошибке — банер с деталями.
- [ ] **UI-6.5** Create resource: команда палитры «New Resource…» → билдер (kind picker, базовые поля), простейшие шаблоны Pod/Service/Deployment.
- [ ] **UI-6.6** Delete flows: ConfirmDialog с вводом имени + toast.

Критерии приёмки:
- ✅ Редактирование пода → apply → объект пересоздаётся (новый age); перед apply показывается корректный diff.
- ✅ Schema validation: `replicas: "abc"` подсвечивается ошибкой.
- ✅ Esc безопасно закрывает; Ctrl+S — Save.

---

### Фаза UI-7 — Остальные домены: Config, Network, Storage, Access, Events, CRD (M–L)

Задачи (каждый домен использует готовые таблицы/детали + `columnSpecs` + собственные карточки Summary):
- [ ] **UI-7.1** ConfigMaps/Secrets: колонки; для Secrets — маскирование значений (show/hide + Copy), base64-тултип.
- [ ] **UI-7.2** Services/Ingresses: URL кликабелен (browser); PF-шорткат у Service.
- [ ] **UI-7.3** PVC/PV/SC: capacity-бары, кросс-ссылки (PVC→PV→SC).
- [ ] **UI-7.4** Access: SA/Roles/Bindings таблицы; detail: таблица правил (verbs/resources) (полная RBAC-матрица — позже, задача 5.4 roadmap).
- [ ] **UI-7.5** Nodes & Namespaces (perspective `cluster`) по §7.8; Events-панель по §7.7.
- [ ] **UI-7.6** CRD-generic по §7.10 (discovery через `crds_list`, динамическая таблица по additionalPrinterColumns).

Критерии приёмки:
- ✅ Каждый kind из `03-KUBERNETES-SPECIFICATION.md` открывается через perspective с таблицей и деталью; нигде нет хардкод-данных.
- ✅ Значения Secret по умолчанию не отображаются открыто (деталь и YAML).

---

### Фаза UI-8 — Метрики и графики (M)

Задачи:
- [ ] **UI-8.1** `metrics_nodes/pods` IPC + опрос 15s (ядро: MetricsService) + `metrics_store`.
- [ ] **UI-8.2** `<Sparkline>` SVG (60 точек) и `<MiniBar>`; колонки CPU/Mem в таблицах Pods/Nodes.
- [ ] **UI-8.3** Detail-MetricsTab: line-chart CPU/Mem (cобственный SVG, без recharts); история — ring 5–15 мин.
- [ ] **UI-8.4** Cluster Overview: карты нод с capacity + usage.

Критерии приёмки:
- ✅ Открытый Overview: UI CPU < 3%; данные обновляются плавно (сглаживание 2s).
- ✅ Графики без внешних библиотек (< 5KB кода).

---

### Фаза UI-9 — Helm UI (M)

Задачи:
- [ ] **UI-9.1** Releases list/detail/actions (rollback, upgrade-диалог с values-редактором) по §7.9 + IPC `helm_*`.
- [ ] **UI-9.2** Repositories panel CRUD.
- [ ] **UI-9.3** Release Manifests view + переходы к ресурсам.

Критерии приёмки:
- ✅ На кластере с helm: список релизов корректен; Rollback повышает revision; правки values применяются.
- ✅ Uninstall требует ввода имени релиза.

---

### Фаза UI-10 — Command Palette, Settings, хоткеи, полировка (M)

Задачи:
- [ ] **UI-10.1** Палитра по §7.12 со всеми провайдерами и fuzzy.
- [ ] **UI-10.2** Settings UI по §7.11 (все поля работают и persist; theme Light — disabled с тултипом «Coming after UI-11»).
- [ ] **UI-10.3** Все хоткеи §8 подключены; keybindings-таблица read-only; modKey нормализован по платформам.
- [ ] **UI-10.4** Загрузка/пусто/ошибка — везде (аудит чек-листом).
- [ ] **UI-10.5** About, first-run hint (подсказка о палитре).
- [ ] **UI-10.6** QA-аудит pixel-perfect: focus ring consistency, focus trap, выравнивание чисел (mono, right-align), расстояния по сетке.

Критерии приёмки:
- ✅ ⌘K находит view/ресурс/действие < 50ms; Enter выполняет.
- ✅ Настройки переживают рестарт (и на mock, и на tauri).
- ✅ Клавиатурный сквозной сценарий: подключиться → таблица → логи → закрыть — без мыши.

---

### Фаза UI-11 — Light theme + финальный polish (S–M)

Задачи:
- [ ] **UI-11.1** Токены `[data-theme="light"]` (палитра JetBrains Light) + проверка страниц; контраст текст/фон ≥ 4.5:1.
- [ ] **UI-11.2** Theme switch (Dark/Light/System) + follow `prefers-color-scheme`.
- [ ] **UI-11.3** Финальный аудит: memory leak (React DevTools), accessibility (axe), dockview reset команды.

Критерии приёмки:
- ✅ Переключение темы мгновенное, без вспышек (FOUC guarded в main.tsx).
- ✅ Контраст бейджей и текста выдержан.

---

## 11. Definition of Done + бюджеты + QA-чеклист

### Definition of Done (для каждой фазы)
1. Код соответствует спецификациям документа и паттернам разделов 3–9.
2. TypeScript strict; линт чист; `any` нет (кроме моков тестовых).
3. Компоненты переиспользуют UI-kit (§4.8) — никаких локальных дублей Button/Dialog.
4. Состояния loading/empty/error обработаны; критерии фазы пройдены (на реальном кластере, где применимо).
5. Cleanup подписок/таймеров; в консоли нет предупреждений.
6. Чек-листы фазы в этом документе помечаются ✅ с датой.

### Performance budgets

| Метрика | Бюджет |
|---|---|
| TTI первого экрана | dev < 800ms; prod < 500ms |
| Скролл 10k строк таблицы | 60 fps, main-thread < 8ms/фрейм |
| Delta → отрисовка (p95) | < 120ms |
| Idle CPU при всех watch on | < 1.5% |
| UI heap при 10k объектов + 2 лога-потока | < 300MB |
| Переключение context | < 1.5s полностью |

### QA-чеклист релиз-кандидат
- [ ] Linux/macOS/Windows: окно, TitleBar, min/max/close работают.
- [ ] Состояния: кластер недоступен / kubeconfig нет / API недостижим — всё выглядит прилично.
- [ ] Ограниченный RBAC-пользователь: soft-fail, без крэшей.
- [ ] 30 минут работы с логами/терминалами — heap не растёт.
- [ ] Окно 900×600 и 4K — раскладка не разъезжается.
- [ ] Навигация таблиц стрелками/Enter/Esc — во всех панелях.

---

## 12. Конвенции и целевая структура файлов

Именование: файлы компонентов — PascalCase.tsx (уже так); модули/stores/хуки/utils — snake_case.

```
src/
├── main.tsx  App.tsx (shell, providers wiring)
├── app/ error_boundary.tsx keyboard.ts
├── design/ tokens.css theme.ts fonts/
├── core/
│   ├── ipc/ client.ts commands.ts events.ts
│   ├── providers/ types.ts index.ts tauri/{cluster,resources,pods,helm,metrics,crd}.ts mock/{...}.ts
│   ├── keybindings.ts config.ts
│   └── utils/ cx.ts format.ts ansi.ts fuzzy.ts id.ts
├── state/ (см. §9.3)
├── components/
│   ├── ui/ (полный список §4.8)
│   ├── layout/ TitleBar.tsx ActivityBar.tsx Sidebar.tsx StatusBar.tsx
│   │        regions/ EditorRegion.tsx DockRegion.tsx InspectorRegion.tsx
│   ├── navigation/ CommandPalette.tsx palette_providers.ts
│   ├── resource/ ResourceTable.tsx ResourceToolbar.tsx ResourceDetail.tsx resource_icons.ts column_specs.ts
│   │        detail/ Summary.tsx MetadataCard.tsx ContainersCard.tsx EventsCard.tsx
│   │        dialogs/ ScaleDialog.tsx DeleteDialog.tsx
│   ├── yaml/ YamlEditor.tsx YamlDiff.tsx schema.ts
│   ├── terminal/ XtermPanel.tsx TerminalTabs.tsx
│   ├── logs/ LogViewer.tsx LogToolbar.tsx
│   ├── pf/ PortForwardDialog.tsx PortForwardPanel.tsx
│   ├── metrics/ Sparkline.tsx MiniBar.tsx LineChart.tsx
│   └── helm/ ReleaseTable.tsx ReleaseDetail.tsx RepoPanel.tsx
├── views/ WorkloadsView.tsx ConfigView.tsx NetworkView.tsx StorageView.tsx AccessView.tsx HelmView.tsx CrdView.tsx ClusterView.tsx
└── bindings/ commands.ts (tauri-specta, генерируется)
```

> Примечание: существующие `components/k8s/StatusBadge.tsx`, `ResourceTable.tsx` переезжают в новые места (старые пути удаляются), моки данных из `App.tsx` уезжают в `providers/mock/`.

### Конвенции кода
- `import type` для типов; React 19 function-components без forwardRef; хуки — по файлу на домен (`src/hooks/use_watch.ts`…).
- Никакого fetch-в-`useEffect`: все запросы через services/providers.
- Без i18n: строки English прямо в коде (консистентно с IDE-подходом).
- Комментарии — только для non-obvious решений.
- Для составных классов — `cx()` (clsx + tailwind-merge) из `core/utils/cx.ts`; часто используемые составы — токен-алиасы (`bg-panel`, `text-secondary` и т.п.).

---

## 13. Риски и меры

| Риск | Вероятность | Мера |
|---|---|---|
| Глубокая кастомизация стилей dockview | Средняя | наш CSS override поверх theme-класса; в UI-2 зафиксировать пул переопределений и не расползаться |
| Monaco раздует бандл | Высокая | dynamic import + singleton (фаза UI-6); контроль размера бандла |
| Конфликт Tailwind 4 layers с dockview CSS | Низкая | dockview CSS подключается целиком до tailwind-слоёв; кастомные классы в отдельном файле |
| Потеря событий при высокой нагрузке (10k delta/сек) | Средняя | батчинг 50ms на Rust, ring buffer в JS, backpressure |
| Глюки custom titlebar в Linux WM (resize-зоны) | Средняя | setting-флаг fallback на нативную рамку; тесты в GNOME/KDE |
| Высокопоточный стрим логов (5k строк/сек) | Средняя | чанки 512, rAF-батчинг отрисовки, индикатор «skipped N lines» |
| Тестовый кластер недоступен в момент фазы | Низкая | все фазы прогоняются на mock; IPC-критерии — начиная с фазы UI-4 |

---

## 14. Что НЕ входит в этот план (но присутствует в roadmap)

- Плагины UI (фаза 9 roadmap) — только точки регистрации.
- Редактор keybindings — после первого релиза.
- TUI/мобильные интерфейсы.
- RBAC-матрица «Who can …» и NetworkPolicy visual graph — после базового UI-7.
- Prometheus auto-discovery с длинной историей графиков — после UI-8.

---

## История документа

| Версия | Дата | Изменения |
|---|---|---|
| 1.0 | 2026-10-19 | Первый утверждённый план UI (на основе docs 02/04/05 и решений владельца проекта) |
