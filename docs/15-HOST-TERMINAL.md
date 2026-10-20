# Host terminal — OPS-02B

## Проверка в приложении

Перезапустите `pnpm tauri dev` (новые Rust IPC-команды). Раскройте нижнюю панель → Open Local Terminal (Host PC); для следующей сессии нажмите `+` → Local Terminal (Host PC). Подключённый Kubernetes-кластер и kubeconfig не нужны. В header показаны Local host, домашняя папка, доступный shell и состояние подключения. Это настоящий терминал с окружением пользователя, в нём доступны установленные локально инструменты, включая kubectl, если он есть в PATH.

Выбор shell создаёт новую сессию; Reconnect также запускает новый процесс. Disconnect и закрытие вкладки завершают прежнюю сессию; введённые команды не повторяются. Ctrl-C/D/Z и управляющие клавиши передаются PTY; Ctrl-K/B/J/W внутри xterm не вызывают IDE-команды. Поддерживаются resize, Unicode, exit code и отдельный размер шрифта из Appearance. Clear очищает отображение. Сворачивание/переключение dock не пересоздаёт процесс и не стирает вывод.

Несколько локальных вкладок имеют независимые shell/PTY/ввод. Текущая общая политика dock при смене Kubernetes context очищает также local sessions. Pagehide, уничтожение окна и закрытие вкладки освобождают транспорт. Browser без Tauri показывает требование desktop, не имитирует настоящий shell; demo остаётся явно симулированным.

## Реализация

- `HostTerminalInfo`: найденные абсолютные пути к shell, default_shell и домашняя папка. Unix: SHELL с fallback на bash/zsh/fish/sh; Windows: COMSPEC и установленный Windows PowerShell. Shell выбирается только из найденного backend списка, без интерполяции командной строки. Unix запускает interactive login shell; TERM=xterm-256color и COLORTERM=truecolor, остальное окружение наследуется. Недоступная папка/неисполняемый shell/ошибка PTY показываются как ошибка.
- `HostTerminalRequest`: shell/cols/rows, без Kubernetes context/ResourceRef. Метаданные shell загружаются отдельно и повторно запрашиваются через Reconnect после ошибки. `LiveTerminalPane` и JS transport используются совместно с Pod shell, при этом имена IPC-команд разделены.
- `HostTerminalManager`: не более 16 сессий, owner берётся из настоящего Tauri window. start/write/resize/ack/close/stop_owner; проверка ID, размеров 1–1000 и input не более 64 KiB. Input queue 16, output queue 16 × 8 KiB, JS pending input до 128 KiB. IPC до 64 KiB каждые 16 мс, один batch в полёте; ACK после xterm write callback. Штатный выход передаётся после final output, без автоперезапуска.
- OS PTY I/O выполняется вне async runtime: supervisor и read/write workers. На Unix shared nonblocking file status позволяет остановить read/write даже при переполнении PTY; отмена проверяется также при backpressure. На Windows ConPTY закрывается при завершении shell с работающим output reader; resize использует Weak reference, чтобы не удерживать master во время blocking input. Windows/macOS реализация требует отдельной приёмки, см. ниже.
- Unix teardown посылает сигнал foreground process group только в собственной сессии, затем SIGHUP shell и выполняет kill/wait при необходимости. Reader/writer завершаются, master освобождается; PID shell не остаётся zombie. Независимо демонизированные/disowned процессы вне PTY-сессии не считаются принадлежащими терминалу и не уничтожаются обходом всей системы процессов.

## Проверено и что осталось

- 140 TS unit/contract tests. Новые проверки: маршрутизация host start/write/resize/ACK/exit без Kubernetes context, загрузка metadata, общий reset Pod/host, desktop requirement в browser. Общие проверки ACK/sequence/late callbacks/input bounds сохранены.
- 30 Rust tests, включая 4 новых **с настоящим Linux PTY**, а не подставленным API: TTY stdin/stdout, UTF-8, resize 100×40, cwd=home и exit 7; Ctrl-C прерывает sleep и сохраняет shell; две независимые сессии; проверка исчезновения PID shell и foreground job после stop; чужой owner; отмена при заполненном stdout, oversized input/invalid size/shell, ранняя отмена.
- 46 browser scenarios на production preview: новые 3 используют реальный JS Channel/xterm с подставленным native IPC. Ввод/Ctrl-C/Ctrl-W/resize, выбор shell, скрытие/возврат без пересоздания, exit/disconnect/reconnect/pagehide и late batches, ошибка metadata и Retry, работа без Kubernetes context и явное ограничение browser. Это проверка UI/IPC, не native GUI acceptance.
- Production build/typecheck, Tauri cargo check offline и diff check.

Повторяемый backend smoke:

```sh
cargo test --manifest-path crates/kubiki-core/Cargo.toml --offline --test host_terminal_tests
```

OPS-02C открыта: настоящий GUI Tauri, длительные/большие потоки и память, custom shell startup files, ConPTY final output/cancel/process tree на Windows, macOS, crash/reload. Текущие OS-тесты выполнены на Linux; наличие portable-pty не объявляется подтверждённой поддержкой всех платформ. Node debug shell остаётся OPS-03, port-forward — OPS-04.
