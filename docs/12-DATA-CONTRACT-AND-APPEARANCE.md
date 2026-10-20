# Контракт данных и масштаб интерфейса

Актуально: 2026-10-20. Журнал приёмки — [07](07-UI-PROGRESS.md), статусы и следующий шаг — [10](10-IMPLEMENTATION-TASKS.md).

## Идентичность ресурсов

`shared/resource-types.json` — общий каталог 18 встроенных kinds: group, version, kind, plural и namespaced. Его читают UI/provider, browser bridge и Rust. Каталог не заменяет discovery и не означает поддержку произвольных custom resources.

`ResourceQuery`: context / group / version / kind / namespace. `namespace: null` означает все namespace для namespaced kind либо cluster scope для Node/PV/Namespace/StorageClass/CRD. `ResourceRef` добавляет name и nullable UID; эти типы определены в TypeScript и Rust. Workspace сохраняет reference вместе с метаданными вкладки.

Логический ключ Related/диаграммы включает API group, kind, namespace и name. Версии внутри одной группы относятся к одному логическому объекту. Вкладки дополнительно учитывают context и UID: после удаления и создания одноимённого ресурса старая вкладка показывает Resource Not Found, новая открывается отдельно. Owner/Event references проверяют API group и UID, если они есть.

Списки передают group/version в оба транспорта. Bridge валидирует каталог и использует квалифицированные plural (`deployments.apps`), чтобы избежать неоднозначности с CRD. Динамические версии/plurals, watcher scope/session identity и атомарные UID/resourceVersion preconditions для mutations ещё не реализованы. Существующие logs/scale пока принимают отдельные context/name/namespace, не полноценный ResourceRef с обязательным UID.

Официальная модель Kubernetes: [имена и UID](https://kubernetes.io/docs/concepts/overview/working-with-objects/names/), [API concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/).

## Ошибки

Единый payload содержит `code`, `message`, опциональный `status`, `retryable`, `operation`, `context` и опциональный resource query/reference. HTTP возвращает `{ error: payload }`, Tauri отклоняет Promise с payload. Provider нормализует оба транспорта в `K8sRequestError`, сохраняя identity исходного запроса. Старые строковые ошибки остаются читаемыми.

Коды: unauthorized, forbidden, not_found, conflict, timeout, rate_limited, unavailable, invalid_request, unsupported, bridge_unavailable, internal. 403/404 не подменяются успешным пустым списком. Некорректный success payload не превращается в пустой кластер или Connected. При ошибке refresh последний snapshot сохраняется с предупреждением об устаревании; Retry снимает предупреждение только после успешного чтения.

Для kube-rs сохраняется настоящий status из ErrorResponse. kubectl по-прежнему возвращает stderr: классифицируются только известные server reasons и transport failures, неизвестные ошибки остаются internal с исходным сообщением. Совпадение kind/name с текстом «forbidden» не считается HTTP 403. Общие fixtures проверяются Rust и TypeScript; HTTP bridge дополнительно тестируется через локальный HTTP server с подставленным executor без запуска kubectl.

Browser request и чтение body ограничены 20 с. Процессы kubectl в обоих bridge ограничены 15 с, API request — 10 с; desktop ping/namespace discovery также ограничены 15 с. Scale теперь использует тот же timeout/kill-on-drop lifecycle, что reads/logs. Это ещё не lifecycle live streams.

## Размер интерфейса

В [JetBrains Typography](https://plugins.jetbrains.com/docs/intellij/typography.html) указан Inter и базовый размер UI 13; относительные размеры остальных элементов должны следовать настройке. [JetBrains Appearance](https://www.jetbrains.com/help/idea/settings-appearance.html) и [VS Code Accessibility](https://code.visualstudio.com/docs/configure/accessibility/accessibility) отделяют масштаб всего приложения от размера текста редактора.

Kubiki использует базу 13 CSS px при 100%, стартовый масштаб **110%**, отдельные **14 px** для YAML и терминала. Существовавшая геометрия 12px UI пересчитывается коэффициентом `13/12 × scale/100`.

Settings → Appearance:

- Interface scale: 80–200%, slider и presets; изменение применяется сразу ко всем панелям, иконкам, таблицам и body portals.
- YAML editor font / Terminal font: 10–24 px, независимо от общего UI scale; обновляются уже открытые Monaco/xterm без пересоздания моделей/сессий.
- Reset appearance: 110% и 14/14 px. Reset layout отдельно восстанавливает геометрию панелей.
- Ctrl/⌘ `+` / `−` — масштаб, Ctrl/⌘ `0` — стандартный масштаб 110%, Ctrl/⌘ `,` — настройки. Команды доступны также через палитру.

Настройки сохраняются в существующем `kubiki.settings.v3`; старые записи дополняются defaults, нечисловые/неконечные значения заменяются defaults, числовые ограничиваются диапазонами. Применение происходит до первого React render. В небольшом окне диалог ограничен viewport и прокручивается, Reset остаётся достижимым.

Поиск и фильтры ресурса занимают одну строку: широкий поиск слева, health/status/order рядом. Если ширины панели не хватает (в том числе после открытия inspector или увеличения UI scale), фильтры собираются в `Filters` menu с подписями и счётчиком активных настроек. Значения сохраняются при resize; Reset filters and order не стирает поиск. Высота toolbar в обоих режимах одинакова, поэтому первый click не сдвигает строку перед double-click. Глобальный Search Everywhere скрывается, если для него нет места в title bar; палитра доступна через Ctrl/⌘K и ActivityBar.

Масштаб меняет CSS dimensions/font tokens и приводит к layout/reflow. CSS zoom / transform всего приложения и графические WebKit flags не изменялись. Внутри React Flow viewport коэффициент 1: геометрия ELK и карточек сохраняется, сам граф масштабируется собственными zoom controls. Панель управления диаграммой и Events island следуют масштабу UI.

## Найденная регрессия YAML

Посимвольный browser test обнаружил потерю символов при быстром вводе: React effect синхронизировал устаревший draft обратно в модель Monaco. Модель теперь владеет пользовательским вводом и немедленно обновляет ref текущего текста; programmatic replace выполняется явно только при загрузке чистого snapshot, Revert или успешном demo apply. Copy/Download/Ctrl-S читают текущий ref. Изменение шрифта не пересоздаёт редактор.

Это отдельная воспроизведённая ошибка. Исходный `resolveDispatcher().useState` crash в native WebKit всё ещё требует подтверждения; его нельзя объявлять исправленным по browser tests.
