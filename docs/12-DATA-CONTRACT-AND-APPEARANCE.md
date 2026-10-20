# Контракт данных и масштаб интерфейса

Актуально: 2026-10-20. Журнал приёмки — [07](07-UI-PROGRESS.md), статусы и следующий шаг — [10](10-IMPLEMENTATION-TASKS.md).

## Идентичность ресурсов

`shared/resource-types.json` — общий каталог 18 встроенных kinds: group, version, kind, plural и namespaced. Его читают UI/provider, browser bridge и Rust. Каталог не заменяет discovery и не означает поддержку произвольных custom resources.

`ResourceQuery`: context / group / version / kind / namespace. `namespace: null` означает все namespace для namespaced kind либо cluster scope для Node/PV/Namespace/StorageClass/CRD. `ResourceRef` добавляет name и nullable UID; эти типы определены в TypeScript и Rust. Workspace сохраняет reference вместе с метаданными вкладки.

Логический ключ Related/диаграммы включает API group, kind, namespace и name. Версии внутри одной группы относятся к одному логическому объекту. Вкладки дополнительно учитывают context и UID: после удаления и создания одноимённого ресурса старая вкладка показывает Resource Not Found, новая открывается отдельно. Owner/Event references проверяют API group и UID, если они есть.

Списки передают group/version в оба транспорта. Bridge валидирует каталог и использует квалифицированные plural (`deployments.apps`), чтобы избежать неоднозначности с CRD. Watcher scope/session identity реализованы; динамические версии/plurals и атомарные UID/resourceVersion preconditions для mutations ещё не реализованы. Существующие logs/scale пока принимают отдельные context/name/namespace, не полноценный ResourceRef с обязательным UID.

Официальная модель Kubernetes: [имена и UID](https://kubernetes.io/docs/concepts/overview/working-with-objects/names/), [API concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/).

## Ошибки

Единый payload содержит `code`, `message`, опциональный `status`, `retryable`, `operation`, `context` и опциональный resource query/reference. HTTP возвращает `{ error: payload }`, Tauri отклоняет Promise с payload. Provider нормализует оба транспорта в `K8sRequestError`, сохраняя identity исходного запроса. Старые строковые ошибки остаются читаемыми.

Коды: unauthorized, forbidden, not_found, conflict, timeout, rate_limited, unavailable, invalid_request, unsupported, bridge_unavailable, internal. 403/404 не подменяются успешным пустым списком. Некорректный success payload не превращается в пустой кластер или Connected. При ошибке refresh последний snapshot сохраняется с предупреждением об устаревании; Retry снимает предупреждение только после успешного чтения.

Для kube-rs сохраняется настоящий status из ErrorResponse. kubectl по-прежнему возвращает stderr: классифицируются только известные server reasons и transport failures, неизвестные ошибки остаются internal с исходным сообщением. Совпадение kind/name с текстом «forbidden» не считается HTTP 403. Общие fixtures проверяются Rust и TypeScript; HTTP bridge дополнительно тестируется через локальный HTTP server с подставленным executor без запуска kubectl.

Browser request и чтение body ограничены 20 с. Процессы kubectl в обоих bridge ограничены 15 с, API request — 10 с; desktop ping/namespace discovery также ограничены 15 с. Scale теперь использует тот же timeout/kill-on-drop lifecycle, что reads/logs. Это ограничения snapshot-операций; lifecycle нового Pod exec описан в [13](13-POD-SESSIONS.md), follow logs остаётся в плане.

## Desktop resource watch

В desktop списки 18 встроенных kinds поступают из kube-rs через Tauri `watch_resources(query, subscriptionId, onEvent)`. `stop_resource_watch(subscriptionId)` отменяет одну подписку; `stop_resource_watches` — подписки текущего окна. Owner берётся из реального WebviewWindow, а не из аргумента JavaScript. Window destroy, pagehide, context switch, Sync/Retry и отказ канала освобождают watchers. На переподключении страницы сначала очищаются старые подписки окна.

`WatchBatch { subscription_id, query, messages: [{ sequence, event }] }`; event — Status (connecting/syncing/live/reconnecting/failed/stopped) или Delta (Restarted/Applied/Deleted). Sequence монотонна внутри подписки; повторы игнорируются, пропуск останавливает подписку с явной ошибкой и возможностью Retry. Подписка привязана к context/GVK/namespace и generation UI. Поздние callbacks/ack предыдущей подписки не меняют актуальные данные.

Init/InitApply не публикуют частичный список: InitDone заменяет map UID одним Restarted, включая пустой список. Relist удаляет объекты, исчезнувшие во время disconnect. Scope Rust store включает subscription и query; один namespace/context не стирает другой. Namespace REST endpoint выбирается напрямую, без fieldSelector на all-namespaces endpoint. ResourceVersion остаётся непрозрачной строкой.

Очередь core ограничена 256 сообщениями; IPC пачки — до 128 каждые 50 мс, с backpressure. UI объединяет изменения одного UID за 50 мс до mapper/YAML serialization и применяет одним обновлением store; максимум 5000 уникальных ожидающих изменений, превышение вызывает явную ошибку и resync через Retry. Это ограничение очередей, не числа ресурсов в полном snapshot.

kube-rs использует default exponential backoff. Ошибки 400/401/403/404/422 завершают подписку без busy retry; 410 вызывает relist. Клиент инициализируется не более 15 с, first complete sync в UI — не более 30 с; stop отменяет также инициализацию. Ошибки сохраняют последний полный snapshot. Подтверждение восстановления тихого watch берётся из успешного HTTP-ответа на открытие потока, поэтому live не зависит от следующего изменения объекта. Некорректный snapshot или sequence не публикуют накопленную частичную пачку.

Status bar отличает Watch от Snapshot. До first sync таблица показывает ожидание, без ложного «No resources». Диагностика отсутствующих backend Pods у Service выполняется только по актуальным Pod-данным. Изменение статуса узла диаграммы сохраняет позиции/viewport; изменение структуры пока запускает полную раскладку.

Общий namespace picker теперь меняет реальную область desktop watch. Пересоздаются только namespaced kinds; Node/Namespace/PersistentVolume/StorageClass/CustomResourceDefinition остаются в cluster scope. При смене scope старые snapshot, selection и история namespaced ресурсов очищаются сразу, hasSnapshot становится false; Retry/Sync в том же scope сохраняют последний полный snapshot. Каждый WatchState включает query, чтобы ожидание/ошибка оставались привязаны к области. Поздние события старой области не публикуются, даже при A → B → A.

Если list namespaces запрещён, можно ввести имя вручную в поиске общего picker и выбрать `Use namespace: …`; проверяется DNS label (1–63 символа, lowercase/digits/hyphen, без ведущего/замыкающего hyphen). Это выбор существующей области, не создание namespace. Операция доступна в desktop; browser остаётся на прежних snapshots/filter semantics.

Открытая вкладка другого namespace показывает «Resource outside namespace scope» и `Load namespace …`. Ожидание initial sync и ошибка чтения также отделены от Resource Not Found. Related и диаграммы предупреждают о пределах загруженных данных; namespace вне текущей области получает `not loaded` вместо ложного нуля. Его диаграмма строится после явной загрузки области через общий picker. Для cluster Node/PV отношения учитывают только Pods/PVC выбранного namespace.

Для потока использованы [Tauri Channels](https://v2.tauri.app/develop/calling-frontend/#channels); семантика Init/InitDone и backoff сверена с исходниками установленного kube-runtime 0.98. Адаптер освобождает callback через guarded `__TAURI_INTERNALS__.unregisterCallback`, поскольку установленный JS SDK не имеет public Channel.close; это место необходимо проверять при обновлении Tauri.

**Ограничения:** browser dev bridge остаётся snapshot; UI открывает watches всех 18 встроенных kinds; namespaced queries следуют общему picker. Стартовый All Namespaces всё ещё загружает весь кластер; lazy subscriptions остаются DATA-03B2. Произвольные CR instances не добавлены. Native GUI/live cluster QA и долгий нагрузочный прогон ещё не выполнены; HTTP server и browser IPC tests их не заменяют.

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
