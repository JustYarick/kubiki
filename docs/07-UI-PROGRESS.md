# UI Build Progress — Kubiki

> Журнал прогресса разработки UI по плану `06-UI-BUILD-PLAN.md` (фазы UI-0 … UI-11).
> Агент обязан читать этот файл и обновлять его после каждого рабочего блока.
> Статусы: ✅ готово · 🟡 частично · ⬜ не начато.

---

## Последний блок — 2026-10-20: OPS-02B, настоящий local host terminal

- **OPS-02B — готово:** Local Terminal теперь portable-pty → Tauri Channel → xterm, общий renderer/JS transport с Pod exec. Настоящий interactive shell, домашняя папка, наследуемое окружение, stdin/UTF-8/Ctrl-C/resize/exit code, явные Reconnect/Disconnect и Clear. Локальный терминал доступен без kubeconfig и Kubernetes context. Demo остаётся симулированным, browser явно требует desktop.
- **Shell/metadata:** backend сообщает доступные shell/default/home; Unix учитывает SHELL и bash/zsh/fish/sh, Windows — COMSPEC/PowerShell. В local header нет контейнерного dropdown и Kubernetes target. Выбор shell создаёт новый процесс. Ошибка metadata нормализуется в читаемое сообщение; Reconnect повторно запрашивает metadata. Исправление проверено после воспроизведения `[object Object]` в первом browser прогоне.
- **Lifecycle:** сессии раздельные, owner настоящего окна, максимум 16; stdout/input/IPC ограничены. ACK идёт после xterm write callback. Blocking PTY I/O вынесено из async runtime; Unix nonblocking read/write и проверка cancel при backpressure. Close/pagehide/context change/destroy освобождают сессию; Unix teardown завершает foreground process group в собственной session и shell, выполняет wait. Сворачивание и переключение dock не пересоздают PTY. Общая политика dock при смене cluster context по-прежнему очищает local sessions.
- **Roadmap:** OPS-02B DONE; OPS-02 остаётся PARTIAL из-за OPS-02C. В native QA явно включены host PTY, длительные потоки/процессы, macOS и Windows ConPTY. Node debug — OPS-03, port-forward — OPS-04, остаются TODO. Документ с контрактом и запуском проверки — [15](15-HOST-TERMINAL.md).

Проверки финального состояния:

- `pnpm test`: **140 unit/contract tests**, 18 файлов. Новые 3 проверяют host commands/ACK/exit без ResourceRef, metadata/reset Pod+host и browser requirement; существующие sequence/input/late/cancel tests общего транспорта сохранены.
- `cargo test --manifest-path crates/kubiki-core/Cargo.toml --offline`: **30 Rust tests**. Четыре новых используют **настоящий Linux PTY**: TTY/UTF-8/cwd, stty 100×40 и exit 7, Ctrl-C/sleep с сохранением shell, независимость двух сессий, исчезновение PID shell/foreground job после stop, чужой owner, full-output queue/oversized input/invalid options/ранняя отмена. Проверяется реальный процесс и cleanup, не только mocks.
- `pnpm build`/typecheck, `cargo check --manifest-path src-tauri/Cargo.toml --offline`, `git diff --check`: успешно. К прежним зависимостям добавлен прямой Unix libc для PTY flags/process-group signals; оба tracked Cargo.lock обновлены. Сохраняется прежнее предупреждение о крупных bundle chunks.
- **46/46 production browser scenarios**, 53,9 с. Новые 3: host без кластера, ввод/Ctrl-C/W/resize/ACK, shell change/exit/reconnect/disconnect/hidden tabs/late batches/pagehide; metadata error + Retry; browser requirement. Общие Pod exec/logs/watch/diagram/YAML/appearance регрессии прошли. Первый прогон обнаружил ошибку отображения metadata и неточный test locator; исправления прошли целевой 3/3 и полный финальный прогон.
- Screenshot host terminal при 900×700 просмотрен. Native GUI/cross-platform/длительная приёмка не объявляется выполненной; реальные PTY backend tests выполнены на Linux. Изменений native pan/blur/graphics flags нет.

## 2026-10-20: OPS-01A, настоящий desktop log stream

- **OPS-01A — готово:** desktop вместо tail polling использует kube-rs log_stream → Tauri Channel → общий LogsSessionPane. ResourceRef/context/UID/container; предварительный GET Pod проверяет UID и наличие app/init/ephemeral container. Поддержаны follow, tail, since, previous; завершённому init не требуется Running. UID preflight не объявляется атомарной log precondition.
- **UI/lifecycle:** контейнерный picker и фильтр сохранены; Log options на любой ширине содержит tail 100/500/1000, since 5m/1h/24h, Previous container instance и Reconnect. Pause закрывает чтение, Resume заменяет историю новым tail (пояснение в меню). Статусы Connecting/Following/Completed/Failed/Stopped; ошибка не стирает уже полученные строки. Закрытие вкладки, смена контейнера/context, pagehide и destroy окна освобождают поток. Неактивная посещённая вкладка сохраняет поток; чтение истории не сбрасывает скролл вниз.
- **Ограничения ресурсов:** 32 native сессии; чтение 8 KiB, очередь 8 сообщений, IPC до 32 KiB/50 мс и один batch в полёте; ACK после JS consumption, timeout 30 с. Потоковый UTF-8 decoder, история до 1000 строк/2 Mi символов, незавершённая строка до 64 Ki с отбрасыванием избытка до newline. Большой stdout не создаёт бесконечную историю/IPC. Простые строки без timestamp больше не теряют первое слово.
- **Roadmap:** OPS-01 PARTIAL → OPS-01A DONE, OPS-01B browser stream TODO, OPS-01C native GUI/длительная QA TODO. Browser остаётся явно подписанным snapshot fallback (500/3s). DATA-01C PARTIAL: exec и logs получили ResourceRef/UID preflight, другие named operations и атомарные preconditions открыты. Технический контракт и инструкция проверки — [14](14-POD-LOG-STREAMS.md).
- **Проверено:** 137 unit/contract tests (18 файлов), 26 Rust tests, production build/typecheck и Tauri cargo check offline. Новые 4 Rust интеграционных теста с реальным kube-rs/local HTTP: выдача до EOF, follow/previous/tail/since/timestamps, GET/log 403, старый UID, фактическое закрытие TCP при stop, pending client/owner isolation и лимиты. JS tests: UTF-8/partial/plain/bounds/clear, ACK/EOF/gap/foreign/late, rejected/pending/aborted registrations.
- **Browser:** общий production прогон **43/43**, 53,7 с; новый сценарий покрывает поток/UTF-8, previous/tail/since, pause/resume, поздние batches, ACK, 403 с сохранением истории, reconnect и pagehide cleanup. Container/toolbar/full-tab регрессии сохранены. После финального переноса helper и уточнения подписи выполнен повторный production прогон Pod sessions: 5/5, 7,3 с; скриншот Log options при ширине 900 px просмотрен, controls доступны без горизонтального переполнения.
- **Live backend smoke:** read-only `logs_smoke`, context default / chaos-lab / pod-with-init-container / main-application: follow получил 58 байт, после stop active_sessions=0. Содержимое логов не печаталось. Это не проверка native GUI и не длительная нагрузочная приёмка. Прежние native pan/blur/graphics flags не менялись; прежний build warning о крупных chunks остаётся.

## 2026-10-20: UX-12, Events как уведомления объекта

- **UX-12 — готово:** Event исключён из общего графа отношений до построения contains/ownerReferences и проверки бюджета. Related у Namespace, Pod и остальных объектов показывает только структурные связи с ресурсами; Events не попадают в список, поиск и счётчик, включая отсутствующие Event targets.
- **Отдельная вкладка Events:** уведомления только самого выбранного объекта; Namespace не собирает уведомления всех своих Pod. Сопоставление проверяет UID, kind, API group, namespace и name; при старом UID нет fallback на пересозданный объект. Для legacy events без UID проверяется ссылка по имени, для Node/Namespace учитывается cluster scope.
- **Отображение:** новые события первыми, Warning/Normal, reason/message, последнее время с исходным timestamp в tooltip, число повторений, reporting component/controller; поиск и вывод порциями по 50. Ошибка загрузки не скрывает ранее загруженные события, видны watch state и ограничение namespace scope. История ограничена snapshot, retention и разрешениями API, отдельного архива пока нет.
- **Единая нормализация:** core/v1 involvedObject и events.k8s.io regarding/series/note используют общий helper с боковым Events island диаграммы. Его лимит 10 и переходы к объекту сохранены.
- **Проверки:** 129 unit/contract tests в 16 файлах; production build с typecheck; 42 browser scenarios на production preview. Новые проверки покрывают отсутствие Events в Namespace/Pod Related и бюджете графа, чужие ссылки/старый UID, обе схемы событий, порядок, количество, поиск, пагинацию и события самого Namespace. `git diff --check` пройден. Прежнее предупреждение о крупных bundle chunks сохраняется; Rust/backend этим блоком не менялись.
- Roadmap: UX-12 закрыта; остальные открытые задачи, включая native GUI QA и отложенный pan/blur, не менялись.

## 2026-10-20: OPS-02A, живой Pod exec, контейнеры и адаптивные логи

- **OPS-02A — готово:** заглушка Pod terminal заменена kube-rs WebSocket → Tauri Channel → xterm. Работают stdin/stdout, Ctrl-C и другие управляющие последовательности, TTY resize, shell binary picker, exit/error, явные Reconnect/Disconnect. Контекст и UID закреплены в ResourceRef; перед подключением проверяются UID и running-состояние контейнера. Предварительный GET не объявляется атомарной exec precondition.
- **Lifecycle/flow control:** регистрация до handshake, cancel pending connection, owner реального окна, лимит 32 сессии, bounded input/output, отдельное параллельное чтение stdout, IPC batching и один batch в полёте. ACK идёт после xterm write callback; split UTF-8 передаётся байтами. При отмене RAII guard явно abort-ит задачу AttachedProcess и закрывает WebSocket. Автоматический reconnect/повтор ввода отсутствует. Сохраняются 403 как GET Pod, так и exec upgrade (в kube-rs 0.98 это отдельный ProtocolSwitch error).
- **Контейнеры:** app/init/native sidecar/ephemeral нормализуются по имени из соответствующих spec/status массивов, без index fallback. Native sidecar определяется только по init restartPolicy=Always; legacy sidecar не угадывается по названию. В Pod-таблице — компактные status icons с tooltip, без действий в строках; в Overview — роль, состояние и доступность shell. Завершённому init доступен Logs, shell отключён. Default-container annotation и выбор работающей цели учитываются во всех основных точках открытия.
- **Логи/shell:** общий dropdown с именем, ролью, состоянием и значком. Смена контейнера выполняется в текущей вкладке с закрытием предыдущего exec, не создаёт лишний dock tab и не сбрасывает log filter. Сессии разделены по context/namespace/UID/container; известное пересоздание Pod останавливает чтение его старой log-сессии. Логи всё ещё tail snapshots (500 строк / 3 с), follow остаётся OPS-01.
- **Адаптивный toolbar:** широкая панель — строка с target/namespace, контейнером, поиском и действиями; узкая — две строки, Pause и Options рядом с target, контейнер и поиск ниже. Timestamps/Wrap/Download/Clear доступны из Options. Длинные имена сокращаются с полным target в tooltip. Скриншот 900 px просмотрен, горизонтального overflow нет.
- **Рабочая область:** посещённые terminal/log tabs сохраняются смонтированными в фоне; вывод shell и фильтр логов не теряются при навигации, dock collapse или перестановке в split. Исправлена уникальность primary/split при focus/reopen/close. Ctrl-K/B/J/W в xterm передаются shell, не перехватываются IDE; настройки и scale shortcuts остаются доступны.
- **Исправлен дополнительный баг:** FixedMenu только закрывался, не вызывая callback выбранного действия. Теперь onSelect исполняется один раз. Открытие full-tab shell/logs из ПКМ проверено; добавлен пункт Terminal in Full Tab.
- **Roadmap/документация:** UX-09/10/11 и OPS-02A закрыты. OPS-02 остаётся PARTIAL: host PTY — OPS-02B, native GUI/длительные сессии — OPS-02C; Node debug — OPS-03. DATA-01C PARTIAL: exec получил ResourceRef/UID check, остальные named operations/preconditions ещё открыты. Описание реализации и запуск smoke — [13](13-POD-SESSIONS.md). Отложенные native pan/blur и graphics flags не менялись.

Проверки финального состояния:

- `pnpm test`: **125 unit/contract tests**, 15 файлов. Новые проверки: роли/status/default-container, сопоставление по имени, отсутствие ложного чужого status; session UID/context/container и split invariants; ACK после renderer consumption, input ordering/limits, sequence gaps, foreign ID, abort/late ack и callback cleanup.
- `pnpm typecheck`, `pnpm build`, `git diff --check`: успешно. Прежнее предупреждение о крупных Monaco/main chunks сохраняется.
- **41 browser scenario на production preview пройден**, 48,1 с. Новые 4: input/UTF-8/Ctrl-C/W/resize/exit/reconnect, контейнеры и адаптивный log toolbar, 403 и cleanup, full-tab/split keepalive и выбор контейнера без открытия dock. Эти сценарии используют реальный JS Channel SDK с подставленным IPC.
- `cargo test --manifest-path crates/kubiki-core/Cargo.toml --offline`: **22 Rust tests**. Четыре новых используют локальный HTTP/WebSocket Kubernetes API: настоящий kube-rs upgrade, stdin/resize frames, split UTF-8, exit 0/7, UID conflict/неработающий контейнер/GET 403, upgrade 403, фактическое закрытие WebSocket при stop, pending client cancellation и owner/input limits. `cargo check --manifest-path src-tauri/Cargo.toml --offline`: успешно.
- **Живой backend проверен на указанном пользователем Pod:** `default / chaos-lab / pod-with-init-container / main-application`. Новый `PodTerminalManager` выполнил фиксированный printf/stty/exit smoke: marker получен, exit=0, TTY 100×40 подтверждён, active_sessions=0. В репозитории оставлен явный opt-in `examples/terminal_smoke.rs`; автоматические тесты к кластеру не подключаются.
- Полная GUI-приёмка внутри Tauri, длительные сессии и cross-platform QA ещё не выполнены. Browser IPC tests и живой headless smoke не объявляются этой приёмкой. Стадия остаётся early alpha.

---

## 2026-10-20: DATA-03B1, namespace-scoped watch и состояния неполных данных

- **DATA-03B1 — готово:** общий namespace picker управляет реальным query desktop watch. Пересоздаются только namespaced подписки; Node/Namespace/PersistentVolume/StorageClass/CustomResourceDefinition продолжают работать без restart и потери snapshot. При возврате в All Namespaces query снова получает namespace=null.
- **Изоляция scope:** новая область немедленно очищает старый snapshot, pending changes, selectedItem и историю namespaced ресурсов; hasSnapshot=false до полного списка. Retry/Sync прежней области сохраняет последний snapshot. WatchState содержит query. Старые callbacks и late acknowledgements не меняют новую область, включая быстрые A → B → A; подписка на изменение namespace снимается вместе с session.
- **RBAC:** desktop picker позволяет выбрать `Use namespace: …` после ввода имени, даже если list namespaces запрещён. Имя валидируется как DNS label; путь, пробелы, uppercase и слишком длинные значения не принимаются. Это выбор области, не создание namespace; кластерные виды могут оставаться недоступными, независимо от доступа к Pods выбранной области.
- **Вкладки:** ресурс другого namespace получает «Resource outside namespace scope» и кнопку `Load namespace …`. Initial sync и ошибка чтения также не показываются как Resource Not Found. При загрузке прежнего namespace pinned UID снова разрешается обычным способом; защита от пересозданного одноимённого объекта сохраняется.
- **Related/диаграммы:** указана область загруженных namespaced данных. Namespace вне неё обозначен `not loaded`, а не нулём ресурсов; его диаграмма запускается после явной загрузки области. При initial sync есть предупреждение о неполных counts/relationships. Cluster Node/PV продолжают отображаться, но их связи учитывают ресурсы выбранного namespace.
- **Roadmap:** DATA-03B разбита на B1 (готово), B2 (lazy subscriptions) и B3 (native/live QA). Browser snapshots/filter semantics не изменены. Пока открыты watches всех 18 встроенных kinds; при стартовом All Namespaces по-прежнему запрашивается весь кластер. Следующие блоки — lazy subscriptions и OPS-01 follow logs; native pan/blur остаётся отложенным, графические настройки не менялись.

Проверки финального состояния:

- `pnpm test`: **116 unit/contract tests**, 13 файлов. Новые проверки: переключение namespace с сохранением cluster maps/watchers, очистка pending/selection/history, scope validation, Retry, быстрые A → B → A, возврат к all, unsubscribe lifecycle и валидация namespace.
- `pnpm typecheck`, `pnpm build`, `git diff --check`: успешно; прежнее предупреждение о крупных Monaco/main chunks сохраняется.
- **37 browser scenarios на production preview пройдены**, 44,4 с. Отдельный dev-прогон desktop adapter — 8/8. Добавлены namespace switching с pinned tab/late events, ручной namespace после RBAC 403 и возвратом к запрещённому all, явная загрузка namespace из диаграммы.
- Browser-сценарии desktop adapter используют реальный JS Channel SDK с подставленным IPC; это **не native GUI/live cluster QA**. Rust/backend API в этом блоке не менялись, прежние 18 Rust tests относятся к предыдущему блоку. Проверка живого native-кластера остаётся DATA-03B3.

---

## 2026-10-20: DATA-02/03A, desktop live watch и стабильность диаграмм

- **DATA-02 — готово:** Init/InitApply буферизуются до InitDone; полный Restarted атомарно заменяет map UID, включая пустой результат. Не остаются объекты, удалённые во время disconnect. Store изолирован по context/group/version/kind/namespace/subscription; перекрывающиеся подписки не стирают друг друга. Неверный GVK/namespace/UID, ошибка или отмена initial list не публикуют частичный список. ResourceVersion не преобразуется в число.
- **DATA-03A — готово:** desktop использует kube-rs watcher через Tauri Channels, команды watch/stop/stop-owner. Owner определяется окном; ограничены число watchers (128), очередь (256) и IPC пачка (128 сообщений/50 мс). UI coalescing по UID до mapper/YAML serialization, одно обновление store каждые 50 мс; sequence gaps/overflow вызывают явную ошибку с Retry. Подписки закрываются при смене context, Sync/Retry, pagehide, window destroy и отказе канала; поздние callbacks/registration acknowledgements не оживляют старую generation.
- **Состояния и recovery:** connecting/syncing/live/reconnecting/failed, first-sync timeout 30 с, client initialization 15 с, kube-rs exponential backoff. 403 и другие terminal ошибки не превращаются в пустой список и не создают busy retry; 410 вызывает relist. Последний полный snapshot сохраняется при ошибке. Quiet reconnect подтверждается успешными HTTP watch headers, без ожидания изменения объекта; запоздалое подтверждение не перекрывает более свежую ошибку тела потока.
- **UI:** status bar отличает Watch от Snapshot, таблица показывает ожидание first sync, Sync/Retry пересоздают подписку. Таблица/inspector/Related/топология получают новые данные. Service не получает ложное предупреждение об отсутствии backend Pods, пока Pod watch не актуален. Browser dev bridge по-прежнему использует snapshots; demo остаётся отдельным режимом.
- **GRAPH-09 — частично:** обновление статуса/данных при прежнем составе и связях графа сохраняет ручные позиции и viewport, не создаёт новый ELK worker. Изменения структуры ещё запускают полную раскладку; инкрементальное размещение новых узлов остаётся TODO. Отложенная проблема native pan/blur и графические WebKit flags не менялись.
- **Roadmap разбит дальше:** DATA-03B — native/live cluster QA, namespace-scoped UI subscriptions и lazy watches; DATA-03C — browser SSE/WebSocket. Core уже поддерживает узкий namespace REST endpoint, но UI пока подписан на 18 встроенных kinds во всех namespaces. Произвольные custom resources не подключены. Далее OPS-01 (follow logs), OPS-02/04 (exec/lifecycle) и DATA-01C (refs/preconditions).
- Обновлены README, API-пример informer, фактический status, roadmap и [контракт watch](12-DATA-CONTRACT-AND-APPEARANCE.md). Старый generic watcher/global broadcast заменён query + отдельной bounded очередью; это изменение early-alpha core API.

Проверки финального состояния:

- `pnpm test`: **110 unit/contract tests**, 12 файлов. Новые проверки: coalescing 1000 событий одного UID, empty relist, stale recovery, sequence gap/duplicates/foreign query, неверный snapshot, first-sync timeout, cancellation/late acknowledgement, очистка Tauri callbacks и стабильная подпись структуры графа.
- `pnpm typecheck`, `pnpm build`: успешно; прежнее предупреждение о крупных Monaco/main chunks сохраняется.
- **34 browser scenarios на production preview пройдены**, 39,3 с. Новые 5 сценариев используют реальный JS Channel SDK с подставленным IPC: table/inspector updates, stale → empty recovery, Sync/cleanup/pagehide, A → B → A + late callbacks, first-sync без ложного empty state, сохранение ручных позиций/viewport при status delta.
- `cargo test --manifest-path crates/kubiki-core/Cargo.toml --offline`: **18 Rust tests**. Из них 5 используют настоящий kube-rs client/runtime с локальным HTTP Kubernetes API: 410/relist/offline deletions, 403, quiet reconnect после 503, bounded slow-consumer без потери порядка, cancellation pending client/owner isolation/reused ID. Отдельные reconciler/store tests проверяют atomic init/cancel и scope isolation.
- `cargo check --manifest-path src-tauri/Cargo.toml --offline`: успешно; `git diff --check`: успешно.
- Подставленные Tauri IPC и локальный HTTP API **не заменяют native GUI/live cluster QA**. Стадия проекта остаётся early alpha; DATA-03 целиком — PARTIAL. Native YAML dispatcher crash и native pan performance остаются открыты/отложены.

---

## 2026-10-20: DATA-01A/B, масштаб UI и адаптивные фильтры

- **DATA-01A/B — готово:** общий каталог GVK TS/Rust/browser bridge, ResourceQuery/ResourceRef и group/UID identity вкладок. Вкладка не переключается на пересозданный одноимённый объект, owner references и Events острова учитывают API group. Оба транспорта нормализуют ошибки в единый payload: code/status/retryable/operation/context/resource. Сохраняются настоящие API status kube-rs; ограниченная классификация stderr kubectl проверяется общими fixtures.
- **Ошибки UI:** 403/404/timeout и auth отображаются с понятными подсказками, Retry восстанавливает список; ошибка refresh оставляет последний snapshot с явной пометкой об устаревании. Неверный success payload не становится пустым кластером или ложным Connected. Browser requests/body ограничены 20 с; kubectl и desktop health/namespaces — 15 с. Scale переведён на общий timeout/kill-on-drop helper.
- **DATA-01 остаётся PARTIAL:** переход named operations на ResourceRef/UID preconditions — DATA-01C; произвольные CRD instances/discovery, watch/unwatch, relist и streams не объявлены готовыми. Следующий блок — DATA-02, затем DATA-03.
- **UX-07 — готово:** ориентир JetBrains UI 13, база Kubiki 13 CSS px при 100%, default 110%; Settings → Appearance содержит масштаб 80–200%, presets/reset и отдельные editor/terminal fonts 10–24 px (default 14). Настройки сохраняются, старые/ошибочные значения нормализуются. Панели, иконки, controls и body portals используют размеры с общим коэффициентом; resizers корректируют delta на масштаб. Ctrl/⌘ +/−/0 и Ctrl/⌘ ,; команды есть в палитре. Открытые Monaco/xterm обновляют font без пересоздания модели/сессии.
- **UX-08 — готово:** поиск и health/status/order в одной строке. На узкой панели (в том числе с inspector или увеличенным UI) фильтры переходят в `Filters` menu с подписями и счётчиком активных настроек. Поиск занимает оставшуюся ширину, значения не сбрасываются при resize. Высота toolbar неизменна при переключении режимов: первый click не сдвигает строку перед double-click. Глобальный Search Everywhere скрывается, если в title bar недостаточно места; ActivityBar/Ctrl-K остаются доступны.
- **YAML-03 — исправлено и проверено:** новый посимвольный test воспроизвёл потерю символов при быстром вводе. Причина — echo устаревшего React draft обратно в Monaco. Пользовательский ввод теперь принадлежит модели, программная замена выполняется явно; Copy/Download/Apply/Ctrl-S читают актуальный ref. Тест сохраняет черновик после смены шрифта. Отдельная YAML-01 (native dispatcher crash) остаётся открытой.
- Settings больше не называет приложение «mock-only», версия сервера не получает двойной префикс `v`. `pnpm typecheck` проверяет app, Node bridge/config и исходники тестов; `pnpm build` запускает его автоматически. `.tsbuildinfo` исключён из Git.
- Документация/roadmap/status обновлены; контракт и размеры описаны в [12](12-DATA-CONTRACT-AND-APPEARANCE.md). Графические WebKit flags и отложенные renderer-эксперименты не менялись. Масштаб внутри React Flow viewport остаётся 1; граф использует собственный zoom и прежнюю геометрию ELK.

Проверки финального состояния:

- `pnpm test`: **98 unit/contract tests**, 10 файлов; включены HTTP server с fake executor, parity HTTP/Tauri, Rust/TS fixtures, stalled request timeout и identity regressions.
- `pnpm typecheck`, `pnpm build`: успешно. Сохраняется предупреждение о крупных Monaco/main chunks; новых config-loader warnings нет.
- **29 browser scenarios на финальном production preview пройдены** (33,8 с), включая все прежние основные сценарии, 4 appearance tests, 5 error/recreation tests и адаптивный toolbar. До последнего изменения toolbar полный dev-прогон дал 28/28; после адаптации отдельный dev-прогон YAML/search/filter дал 4/4.
- `cargo test --manifest-path crates/kubiki-core/Cargo.toml --offline`: **9 Rust tests** (6 unit + 3 integration); `cargo check --manifest-path src-tauri/Cargo.toml --offline`: успешно.
- Проверены скриншоты default UI и узкой панели. Browser tests и fake executor не заменяют live Kubernetes/native Tauri приёмку; native clarity, исходный YAML dispatcher crash и native pan performance остаются отдельно открыты/отложены.

---

## 2026-10-20: лицензия и ветка разработки

- **Готово:** по выбору владельца добавлен официальный текст Apache License 2.0 в `LICENSE`; SPDX `Apache-2.0` указан в npm/Rust manifests, README содержит ссылку на лицензию.
- **Готово:** существующий `.gitignore` дополнен правилами для локальных `.env`, `.kube` и корневого kubeconfig; шаблоны `.env.example` / `.env.sample` разрешены.
- **Готово:** создана локальная ветка `dev`, настроен `origin` на `git@github.com:JustYarick/kubiki.git`. Отправка и результат проверяются отдельно через Git.
- **Готово:** из истории `dev` удалены ранее закоммиченные `crates/kubiki-core/target` (бинарные артефакты сборки). Текущее дерево файлов до/после очистки совпадает; исходная история сохранена локально в `master` и `backup/dev-before-history-cleanup`. На GitHub отправляется только чистая `dev`, без backup refs.

---

## Предыдущий блок — 2026-10-20: Events island, Namespace containers, фильтры и откат graphics

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
