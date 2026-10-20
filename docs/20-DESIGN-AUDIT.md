# Аудит дизайна Kubiki с UI/UX Pro Max

Дата: 2026-10-20. Исходная версия: `140109e`, ветка dev. Задача этого блока — анализ, интерфейс не менялся. Незакоммиченный пользовательский `SKILL.md` не изменялся и не включён в коммит.

## Метод и границы

Прочитан `/home/yarick/.agents/skills/ui-ux-pro-max/SKILL.md`, quick-reference и pro-rules. Стек подтверждён package.json: React 19 / Tailwind 4 / Tauri 2. Продукт: desktop Kubernetes IDE для инженеров, плотные данные, длительные рабочие сессии, мышь и клавиатура.

Два запроса `--design-system` дали неподходящие готовые направления: FAQ/Documentation Landing, затем Operations Landing с Glassmorphism. Проверенного цельного шаблона именно для desktop IDE не найдено; эти результаты **не применены и не сохранены как MASTER**. Композиционные рекомендации ниже — экспертная оценка текущего продукта. Релевантные совпадения skill: UX Keyboard Navigation / Focus States, React Manage focus properly (уточнённый запрос), chart Trend Over Time / Line Chart with Highlights. SVG при 120 точках соответствует рекомендации для небольших временных рядов; новый chart engine не требуется по одному наличию этой рекомендации. Примеры библиотеки не считаются обязательными зависимостями.

Touch/mobile правила 44–48pt и base 16px не перенесены механически на IDE. Для desktop важны различимая цель клика, клавиатура и читаемый текст; в таблице допустим локальный horizontal scroll второстепенных колонок. Аудит не подтверждает соответствие WCAG целиком.

Просмотрены исходники и Chromium demo: 1440×900 и 900×720, таблица, inspector, logs, Overview с уже открытыми панелями. Выполнены DOM-измерения, расчёт контраста токенов, проверка Settings/Shift+Tab, поиска и Toggle Explorer. Скриншоты и результаты probe сохранены в `/tmp/kubiki-ui-audit` (временные локальные артефакты). Нативный Tauri FPS, screen reader и большая выборка ресурсов в этом блоке не проверялись. Кодовые тесты не запускались повторно: изменяется документация, а не реализация.

## Что уже получилось

1. Узнаваемый IDE shell: Explorer, tabs, editor/table, inspector и нижняя панель. Inter и JetBrains Mono сочетаются с задачами чтения интерфейса и технических значений; менять семейства шрифтов ради новизны не нужно.
2. Согласованная тёмная основа, единые Lucide icons, неброские границы, семантические статусы. Primary/secondary текст имеют хороший контраст на основных поверхностях.
3. Диагностический путь уже связный: warning → details → Related/Events → logs/shell; kind badges и отдельные Events помогают понимать связи.
4. Таблица сохраняет рабочую плотность и не содержит действий внутри строк; context menu, search/filter, columns/resize — подходящая база.
5. Overview содержит настоящую telemetry, различает usage/requests/limits/capacity, сообщает partial/stale, не дорисовывает отсутствующие замеры. Короткая локальная анимация и bounded SVG history предпочтительны для текущего объёма данных.
6. Практические улучшения уже есть: UI scale, независимые шрифты editor/terminal, контейнерные picker, ограниченные data blocks Secret/ConfigMap, keepalive terminal sessions.

## Подтверждённые проблемы и улучшения

### DS-01 — P1: полезный второстепенный текст слишком бледный и местами слишком маленький

`--text-muted: #6f737a` применяется и к disabled/decorative элементам, и к полезной информации. На непрозрачных базовых поверхностях расчёт даёт:

| Текст | Canvas #1e1f22 | Secondary #25272a | Sidebar #2b2d30 | Surface #313438 |
|---|---:|---:|---:|---:|
| primary #dfe1e5 | 12,59:1 | 11,44:1 | 10,55:1 | 9,55:1 |
| secondary #9da0a8 | 6,30:1 | 5,72:1 | 5,28:1 | 4,78:1 |
| muted #6f737a | 3,46:1 | 3,14:1 | 2,90:1 | 2,63:1 |

Целевое значение для обычного значимого текста — 4,5:1. Disabled/decorative роли надо оценивать отдельно. Это замеры токенов на сплошных фонах; градиенты, opacity и все состояния требуют отдельного composed contrast review.

На telemetry в текущем default scale подписи оси имеют computed 9px, часть процентов — 10,73px, source label — 11,92px. Числа usage хорошо заметны, но расшифровка бюджета и происхождение замера читаются значительно хуже. Синий `--accent` как маленький текст тоже нельзя автоматически считать доступным: около 3,85:1 на canvas и 2,92:1 на surface.

Решение: разделить readable-secondary / decorative-muted / disabled; добавить отдельный цвет accent-text. Зафиксировать desktop typography: основной UI 13–14px, техническая таблица 12–13px, полезные подписи 11–12px; не уменьшать важную метаинформацию до 9px. Проверить actual scale 100/110/150/200%, не только значения исходного CSS. Не повышать яркость всего интерфейса одинаково.

Основание: [токены](../src/App.css#L31), typography telemetry в App.css, [HistoryChart](../src/components/k8s/ResourceTelemetry.tsx#L72).

### DS-02 — P1: адаптивные панели лишают основную область рабочего пространства

Воспроизведено на 900×720: table width **332,48px**, details width **517,66px**. В таблице остаётся преимущественно Name, диагностические колонки уходят за пределы видимости. При открытом dock и таблице высоты хватает лишь на несколько строк. Explorer скрывается по viewport policy; нажатие Toggle Explorer не возвращает его, пока действует это ограничение.

На 1440px с Explorer + inspector + logs та же проблема мягче: центральная область узкая, а details остаются на всю высоту. При переключении на Overview справа сохраняется ранее выбранный Pod, снизу — его logs. Telemetry получает около **534px** ширины, обе CPU/RAM cards становятся одной колонкой и почти целиком уходят ниже fold.

Решение: ввести явные layout modes по доступной ширине контейнера. Wide — table + inspector; compact — inspector как drawer/отдельная вкладка с явным возвратом. Любой Toggle Explorer должен давать видимый результат, например overlay Explorer. Overview по умолчанию отдавать доступную ширину основной сводке; сохранять чужой inspector только при явном pin. Автоматическое скрытие панелей не должно завершать shell/log sessions. Для dock оценить размещение под центральной областью и inspector, оставив Explorer отдельной колонкой; сохранять достаточную высоту таблицы.

Основание: [showSidebar/detailWidth](../src/App.tsx#L176), [main/dock/inspector layout](../src/App.tsx#L209).

### DS-03 — P1: мышиный интерфейс заметно полнее клавиатурного

- MainTabBar использует clickable `div`, у вкладок нет tab role/tabIndex/keyboard handler. DOM probe: Overview и Pods — `DIV`, role null, tabIndex −1.
- В Settings после открытия focus остаётся на внешней кнопке Settings; Shift+Tab переводит его на Toggle Details Panel **за модальным окном**. В Modal нет initial focus, trap, возврата фокуса и связи с title через aria-labelledby.
- Подменю MenuList открывается через onMouseEnter; click при `item.items` ничего не делает. Клавиатурного раскрытия веток нет.
- Column resizers имеют separator role, но без tabIndex/onKeyDown; panel Resizer, напротив, уже поддерживает клавиатуру — его поведение стоит сохранить как положительный пример.
- После ввода поиска появляется clear button без accessible name. Графики имеют role img, но source point tooltip вызывается только pointer movement; tabIndex −1.

Решение: общий контракт tabs/menu/dialog: tablist/tab/tabpanel, roving focus, arrows/Home/End; корректный focus lifecycle и inert background для modal; Enter/Space/Right/Left для submenus. Добавить accessible names, клавиатурный resize и Shift+F10 для действий выбранной строки. Историю графика сделать доступной через клавиатурный cursor и/или таблицу замеров. Покрыть сценарии keyboard-only отдельно от mouse click tests.

Основание: [вкладки](../src/components/layout/MainTabBar.tsx#L138), [Modal](../src/components/ui/Modal.tsx#L18), [submenu](../src/components/ui/Dropdown.tsx#L134), [SearchInput](../src/components/ui/Input.tsx#L38), [column resize](../src/views/ResourceView.tsx#L789).

### DS-04 — P2: плотность таблицы есть, но приоритет колонок и выделение мешают диагностике

Таблица Pods без inspector уже имеет scrollWidth **1280px** при viewport таблицы **1098px**. Сам локальный scroll для IDE приемлем. Проблема — после открытия details Status/Restarts/Containers уходят далеко вправо, хотя именно они нужны для первичной диагностики.

Текущий focus рисует отдельный синий outline у каждой ячейки строки. Визуально это похоже на cell selection spreadsheet, но навигация работает по строке. Дополнительные линии конкурируют с warning/status.

Решение: приоритет Name → Status → Ready → Restarts; Namespace показывать при all scope, IP/Node/Age — дальше. Предусмотреть компактный preset, сохраняя пользовательские настройки. Name при горизонтальной прокрутке можно закрепить. Сделать различимые, спокойные hover/selected/keyboard-focus, одну рамку строки вместо множества синих клеток. Оставить операции в ПКМ, без inline scale/delete/restart buttons.

Основание: [columns/table](../src/views/ResourceView.tsx), [focused cell outlines](../src/App.css#L235).

### DS-05 — P2: Overview стоит сильнее организовать вокруг инженерных вопросов

Карточки CPU/RAM выглядят убедительнее прежнего списка счётчиков. Для чтения нагрузки не хватает устойчивой временной/числовой опоры: верхняя граница Y пересчитывается от max наблюдений, reference-линии requests/limits отсутствуют; текущие значения доступны лучше, чем тренд и отклонение от бюджета. Gauge при смене scope меняет знаменатель (allocatable → configured limits); маленькая подпись объясняет это недостаточно заметно.

Решение: в первом экране держать health + scope + CPU/RAM, ниже top consumers и важные проблемы, inventory — ниже или сворачиваемым. Явно писать знаменатель рядом с процентом. Предложить Auto/fixed Y scale, подписанные reference-линии и summary min/avg/max/last при достаточном числе samples. Отдельная Pause metrics для изучения точки, доступный список замеров. Сохранять честные gaps, sample window, working-set semantics и partial/stale. Не добавлять длительную историю без реального источника.

При выборе consumer детали появляются после всей таблицы и могут быть ниже видимой области. Нужны раскрытие под выбранной строкой либо явное перемещение/подсветка details с корректным focus. Добавлять новый chart engine имеет смысл по потребностям zoom/brush/export и профилю, а не ради внешнего вида.

### DS-06 — P2: терминология и декоративные акценты нуждаются в общей системе

В sidebar категория Workloads суммирует все вложенные kinds (в demo **38** объектов), а Overview Workloads считает контроллеры/Jobs/CronJobs без Pod/ReplicaSet (**16**). Это разные значения под одним названием. Также есть вложенные Workloads → Workloads и неодинаковые названия нижней области: Bottom Drawer / Terminal & services / panel. На Linux часть подсказок всё ещё показывает только ⌘.

Много разных уровней несут одинаковую яркость: активный toolbar, underline вкладки, focus cells, kind badges, status badges, цветные icons и ссылки. В telemetry появились локальные hex colors/radii, отличающиеся от остальных компонентов. Это пока не развал стиля, но дальнейшее копирование создаст расхождения.

Решение: единый glossary и правила badge counts; например Workloads без category sum либо отдельный Objects count. Платформенные shortcut labels. Общие tokens для text hierarchy, chart CPU/RAM, selection, radius, spacing и motion; акцент оставлять для active state/action/link, статус — для состояния ресурса. Нынешнюю Inter/JetBrains Mono и базовую тёмную палитру сохранить.

### DS-07 — P2: формы и обратная связь требуют локальности

Secret editor уже сохраняет draft при ошибке и ограничивает длинные значения. Однако validation выводится общей строкой после списка; при большом количестве ключей ошибка может оказаться далеко от неверной строки. Новый key с пустым именем не получает понятной локальной отметки и гарантированного focus.

Решение: inline key/value errors, переход к первой ошибке, видимый dirty/saving/saved/conflict state; после Add key — focus нового поля. Различать delete draft key и запись Secret на сервер. Это развитие существующего редактора, а не причина менять подтверждённую base64/UID/resourceVersion логику.

## Предлагаемый порядок

1. DS-01/02/03: читаемость, рабочее пространство и клавиатура. Это самый заметный вклад в ежедневную работу.
2. DS-04: читаемая таблица и согласованное выделение; сохранить context menu actions.
3. DS-05: второй проход по аналитике Overview с устойчивой шкалой/контекстом и локальной детализацией.
4. DS-06/07: tokens/glossary/platform labels и post-row form validation.

Критерии результата: на 900/1280/1440/1920px сохраняется понятная рабочая область; toggle всегда управляет видимой панелью; Overview не сжимается чужими неприкреплёнными details; важные подписи читаются; tabs/menu/modal/chart доступны без мыши; сохранены terminal keepalive, user column preferences и недеструктивные действия через ПКМ. Реальный native FPS и большие datasets проверяются отдельно, а не оцениваются по Chromium screenshots.
