# Pod shell, контейнеры и панель логов

Актуально: 2026-10-20. Результаты проверок — [07](07-UI-PROGRESS.md), оставшиеся задачи — [10](10-IMPLEMENTATION-TASKS.md).

## Использование

Перезапустите desktop через `pnpm tauri dev`: добавлены новые Rust IPC-команды. Выберите Pod → Shell справа либо ПКМ → Terminal in Bottom Drawer / Terminal in Full Tab. В header доступны контейнер, shell binary, состояние, Reconnect, Disconnect и Clear. Стандартный shell — `/bin/sh`; можно выбрать `/bin/bash`, `/bin/ash`, `/bin/zsh`, если бинарник есть в образе. В distroless-образе наличие shell не гарантируется; ошибка открытия показывается пользователю.

Dropdown логов включает все контейнеры. В shell завершившиеся и ожидающие контейнеры недоступны для выбора; backend отдельно проверяет реальное состояние. Временное отсутствие status в UI не считается доказательством работоспособности. Начальная цель учитывает `kubectl.kubernetes.io/default-container`; для shell приоритет получают работающие контейнеры, поэтому завершённый init не выбирается случайно.

Открытые terminal/log вкладки сохраняют своё состояние при переключении и сворачивании, в dock и основной рабочей области. Смена контейнера выполняется в текущей вкладке; прежний exec закрывается. Закрытие вкладки, Disconnect, смена context, pagehide и уничтожение окна освобождают транспорт. Reconnect всегда явный: введённые команды автоматически не повторяются. Ctrl-C/D/Z и обычные управляющие последовательности передаются shell; Ctrl-K/B/J/W при фокусе xterm не вызывают глобальные IDE-команды.

Логи пока остаются tail 500 строк с обновлением раз в 3 секунды. Широкая панель показывает toolbar одной строкой; узкая — цель/Pause/Options сверху и контейнер/поиск снизу. Timestamps, Wrap, Download и Clear доступны через Options. Длинные названия сокращаются с полным target в tooltip; выбор контейнера не сбрасывает фильтр.

## Модель контейнеров

В `ResourceContainer` добавлены role/state/reason/message/exitCode. Spec и status сопоставляются **по имени**, без позиционного fallback:

- `spec.containers` ↔ `status.containerStatuses`: обычные контейнеры. Legacy sidecar в этом массиве нельзя достоверно отличить от application по имени или образу.
- `spec.initContainers` ↔ `status.initContainerStatuses`: init; `restartPolicy: Always` означает native sidecar.
- `spec.ephemeralContainers` ↔ `status.ephemeralContainerStatuses`: ephemeral.

Маленькие значки в таблице и подробностях: зелёный — ready; жёлтый — ожидание/не готов; красный — известная ошибка/ненулевой exit; синий — успешное завершение или running init/ephemeral без обычной readiness; серый — данных нет. Tooltip содержит имя, роль, состояние/reason, exit code и restarts. В таблице это не кнопки действий; длинный список ограничен шестью значками с числом оставшихся.

Семантика native sidecar и init сверена с [Kubernetes Sidecar Containers](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/) и [Init Containers](https://kubernetes.io/docs/concepts/workloads/pods/init-containers/).

## Транспорт

`ExecRequest { resource: ResourceRef, container, shell, cols, rows }` требует context, Pod namespace/name и UID. Перед exec выполняется GET Pod, сравнение UID и проверка running-состояния контейнера. Это проверка перед подключением, **не атомарная UID precondition**: Kubernetes exec endpoint адресуется по имени, остаётся промежуток между GET и upgrade. Сессии/вкладки не подменяют закреплённый UID новым объектом.

Команды Tauri: `start_pod_exec`, `write_pod_exec`, `resize_pod_exec`, `ack_pod_exec`, `close_pod_exec`, `stop_pod_execs`. Owner берётся из WebviewWindow. Регистрация происходит до создания клиента/handshake, чтобы stop мог отменить и открытие. Максимум 32 сессии, bounded очереди ввода/вывода по 64 сообщения; один write до 64 KiB, ожидающий ввод UI до 128 KiB. Подключение ограничено 20 с. Лимит TTY — 1–1000 строк/колонок.

kube-rs exec использует WebSocket с TTY, stdin/stdout; `stderr=false`, поскольку в TTY вывод объединён. Вывод передаётся байтами, без lossy UTF-8 преобразования: split characters собирает decoder xterm. Ввод и чтение stdout идут параллельно, чтобы большой paste не блокировал вывод. Native batching — примерно 64 KiB/16 мс, максимум 32 сообщения в batch; один batch в полёте. Renderer отправляет ACK после callback `term.write`, ограничивая накопление данных. Отказ ACK за 30 с завершает транспорт с ошибкой. См. [xterm flow control](https://xtermjs.org/docs/guides/flowcontrol/).

Started/Output/Exited/Failed имеют sequence и session ID. Пропуск sequence останавливает сессию; чужие и поздние callbacks игнорируются. При окончании stdout считывается process status: успешный или ненулевой exit показывается явно; закрытие без status считается ошибкой. RAII guard вызывает `AttachedProcess::abort` при отмене: обычный drop этого объекта в установленном kube-rs не отменяет его фоновую WebSocket-задачу.

403 при GET или отказе WebSocket upgrade сохраняется как forbidden. В установленном kube-rs 0.98 используется **GET pods/exec**: нужны права GET Pod и соответствующие права на подресурс `pods/exec`, а API proxy должен поддерживать WebSocket upgrade. Роль, разрешающая только POST/create exec, может не разрешать GET. Реализация сверена с исходниками установленного SDK, включая `UpgradeConnectionError::ProtocolSwitch`, `terminal_size`, `take_status` и `abort`.

## Проверка живого backend

Опциональный инструмент использует тот же `PodTerminalManager`, что desktop. Target задаётся явно; выполняется фиксированная команда printf/stty/exit, затем session cleanup:

```sh
cargo run --manifest-path crates/kubiki-core/Cargo.toml --example terminal_smoke -- CONTEXT NAMESPACE POD CONTAINER
```

В этой сессии проверен существующий `chaos-lab/pod-with-init-container`, контейнер `main-application`: получен выполненный marker, exit 0, TTY 100×40, active_sessions=0. Это проверка живого Rust backend; полная приёмка GUI в Tauri и длительных сессий остаётся открытой.

Browser preview не выполняет remote shell и показывает требование desktop; demo shell остаётся явно симулированным. Host PTY и Node debug shell ещё не подключены. Следующие блоки: follow logs, host PTY, Node debug, полная native/cross-platform QA.
