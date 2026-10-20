# Pod log streams — OPS-01A

## Как проверить

Перезапустите desktop через `pnpm tauri dev`: добавлены Rust IPC-команды. Выберите Pod → Logs (либо ПКМ → Stream Logs in Full Tab). Статус Following означает открытый поток Kubernetes; Completed — EOF контейнера/ответа, Failed показывает причину.

В общем container picker доступны app/init/native sidecar/ephemeral. `Log options` содержит:

- Initial tail: 100 / 500 / 1000 строк на подключении.
- Since: без ограничения времени / 5 минут / 1 час / 24 часа. С tail действует пересечение ограничений API.
- Previous container instance: предыдущий запуск выбранного контейнера; конечный snapshot, без follow. Если предыдущего запуска нет, отображается ошибка Kubernetes.
- Reconnect logs: явное открытие нового потока и замена истории выбранным tail.

Pause прекращает чтение и освобождает native сессию; Resume вновь читает tail, не обещая непрерывную историю за время паузы. Изменение источника также заменяет историю. Фильтр, wrap и отображение timestamps не меняют источник. Clear очищает текущий буфер; Download сохраняет только доступную историю. Автоскролл действует у нижнего края; прокрутка вверх позволяет читать историю. Неактивные посещённые desktop-вкладки продолжают поток в пределах буфера, возврат не пересоздаёт запрос.

Browser dev остаётся snapshot fallback: tail 500 строк / 3 секунды, с явной подписью. Demo по-прежнему симулирует логи. OPS-01B открыта.

## Контракт и ограничения

`LogRequest`: ResourceRef context/GVK/namespace/name/UID, container, follow, previous, tail_lines, since_seconds. Требуется UID; backend предварительно читает Pod и проверяет UID и наличие выбранного контейнера, включая init/ephemeral. Нужны права get pods и get pods/log. Running-состояние не требуется: завершённые контейнеры также имеют логи. Kubernetes log subresource не поддерживает атомарную UID precondition: между GET и открытием остаётся гонка пересоздания; это не гарантия атомарной привязки.

`PodLogManager`: owner окна, не более 32 сессий, регистрация до сетевого открытия, timeout handshake 30 с; отмена покрывает pending client, GET и активное чтение. Destroy window/context change/pagehide/close tab/container change освобождают поток. Ошибки GET Pod и pods/log сохраняют HTTP status, в том числе 403/404; EOF и ошибка различаются, автоматически поток не перезапускается.

Native читает порции до 8 KiB, очередь до 8 сообщений. Tauri отправляет до 8 сообщений / 32 KiB каждые 50 мс с sequence и session ID; один batch в полёте, ACK после обработки JS consumer, timeout ACK 30 с. Это подтверждение обработки байтов, не завершения browser paint. Native backpressure не допускает бесконечной очереди IPC.

`LogBuffer`: потоковый TextDecoder сохраняет UTF-8 между порциями; строки без настоящего timestamp не теряют первое слово. Незавершённая строка ограничена 64 Ki символами; избыток отбрасывается до newline с явной пометкой. При EOF/ошибке остаток показывается. История ограничена 1000 строками и 2 Mi символами, старое отбрасывается с уведомлением. Это окно просмотра, не архив. Подсветка уровней основана на тексте, не на гарантированной структурированной схеме логов.

## Выполненная проверка

- 137 frontend unit/contract tests (18 файлов), включая 8 новых: split UTF-8, final partial line, простой текст без timestamp, line/text bounds, oversized unterminated output, clear/sequence, ACK/EOF, gap/foreign/late batches, rejected/pending start/cancel.
- 26 Rust tests, включая 4 новых с настоящим kube-rs против локального HTTP API: данные до EOF, параметры follow/previous/tail/since/timestamps, HTTP 403 на GET и pods/log, старый UID, закрытие TCP при cancel, owner isolation/pending client/options/session limits.
- 43 browser scenarios на production preview, включая новый log stream scenario через настоящий JS Tauri Channel SDK с подставленным IPC: UTF-8, previous/tail/since, pause/resume, late batches, ACK, 403 с сохранением истории, reconnect/pagehide cleanup. Остальные container/full-tab/toolbar regression tests сохранены.
- Read-only live smoke: context `default`, namespace `chaos-lab`, Pod `pod-with-init-container`, container `main-application`; follow получил 58 байт, после stop — 0 сессий. Содержимое логов не печаталось. Повторяемая команда:

```sh
cargo run --manifest-path crates/kubiki-core/Cargo.toml --offline --example logs_smoke -- <context> <namespace> <pod> <container>
```

Headless live smoke и browser IPC не заменяют нативную GUI/длительную/cross-platform приёмку. OPS-01C открыта.
