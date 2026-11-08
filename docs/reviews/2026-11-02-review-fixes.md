# Исправления после release review

Дата: 2026-11-02. Основание — [review относительно v1.1.1-dev.22](2026-11-02-release-review.md).
Ниже результаты повторных проверок после исправлений; исходный отчёт сохранён
как история воспроизведённых дефектов.

## Закрытые замечания

| ID | Изменение | Проверка |
| --- | --- | --- |
| S1 | Отмена MCP request использует отдельный сигнал. Отмена queued B не меняет ревизию общей сессии и не останавливает A. Глобальный Stop/инвалидация сохраняются; отправленная mutation дожидается receipt. | Два теста через настоящий rmcp duplex transport: host queue и embedded parallel execution. |
| S2 | Lockfile AI синхронизирован с manifest; удалены зависимости прежней environment/MCP реализации. | AI suite проходит с `--locked` на рабочем дереве. |
| S3 | Provider DTO, turns, conversation memory и compaction перенесены из tools в `kubiki-ai::ConversationState`. Tools хранит execution controls, scope, evidence и accepted operations. Публичные записи reviewed execution передаются через optional observer. | AI runtime/compaction и tools execution tests, native `--all-targets`. Компактные tool contracts пока экспортируются из tools, отдельный crate не добавлен. |
| S4 | Два E2E-теста метрик ожидают скрытые графики при отсутствии данных; сообщение об отказе и отсутствие ложных нулей проверяются. | Полный E2E suite проходит. |
| R1 | Accepted UID/generation и desired state хранятся в connection-owned registry между вызовами. Receipt выдаёт `operationId`; verification привязывается к принятой операции и отклоняет замену UID или другую generation. Registry ограничен 256 записями/одним часом. Без receipt или исторического UID нельзя выдать текущую health за подтверждение изменения. | Fake Kubernetes HTTP + новый executor на каждый вызов, изоляция подключений, неизвестный operationId, bounds; testbed: положительная verification, replacement и concurrent generation. |
| R2 | Stop отменяет startup до загрузки шрифтов и во время native запуска. Backend хранит отмену при перестановке IPC, прерывает ожидание settings/version check и отзывает связанную MCP session. Позднее завершение не возвращает Connected. | Два E2E-сценария Stop, native tests pending startup/изоляции owner/ограничения registry. |
| R3 | Типизированный native отказ гарантирует отсутствие запланированного процесса. Только тогда reservation исходного задания снимается для ручного retry. Неоднозначный исход и доставленное задание не повторяются. Reservation принадлежит конкретной попытке. | Два E2E-сценария known/ambiguous failure; повторный Restart после успешной доставки и последующего pre-start failure; native envelope test. |

## Повторные проверки

Все команды выполнены локально на Linux. Для Rust использован общий
`CARGO_TARGET_DIR=src-tauri/target`, каждый crate проверен по своему manifest/lockfile.

| Проверка | Результат |
| --- | --- |
| `pnpm typecheck` | Успешно |
| `pnpm test` | 575 passed |
| `pnpm test:e2e` | 111 passed |
| `pnpm build` | Успешно; прежнее предупреждение о размере bundle |
| `cargo test --locked --manifest-path crates/kubiki-ai/Cargo.toml` | 59 passed |
| `cargo test --locked --manifest-path crates/kubiki-tools/Cargo.toml` | 42 passed |
| `cargo test --locked --manifest-path crates/kubiki-mcp/Cargo.toml` | 6 passed |
| `cargo test --locked --manifest-path crates/kubiki-core/Cargo.toml` | 126 passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` | 34 passed, 1 existing ignored live probe |
| Native startup tests после финального ограничения ID | 3 passed |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets` | Успешно |
| Explicit ignored native current-context TLS probe | 1 passed: `/version` до и после AI initialization |
| Реальный MCP stdio → testbed | 23/23, включая cleanup |
| `git diff --check` | Успешно |

## Testbed

Контекст `testbed`, Kubernetes `v1.35.5+k3s1`. Сценарий работал только со своими
fixtures в namespace `kubiki-review-20261102-1096617`; namespace удалён, отсутствие
подтверждено дополнительным чтением. Проверены каталог, scope, блокировка Secret,
диагностика, UID-bound logs, events, replica cap, scale/restart, ConfigMap
apply/read-back/delete, read-only exposure и receipt-bound verification.

После принятого restart проверено успешное подтверждение исходной операции.
Конкурентная смена generation даёт `pending`. После удаления и создания Deployment
под прежним именем verification отклоняет replacement как с явным operationId,
так и через последнюю принятую запись. Передача нового UID клиентом также не
позволяет заменить identity принятой операции.

Платные LLM-запросы не выполнялись; совместимость permissions/Plan с live-моделью
OpenCode и native Windows/macOS этим прогоном не подтверждена.

Локальные диагностические артефакты: `/tmp/kubiki-fix-live/results.json`,
`/tmp/kubiki-fix-live.py`, `/tmp/kubiki-fix-rust-results.json` и
`/tmp/kubiki-fix-*.log`. Регрессии для MCP cancellation, verification и OpenCode
startup включены в исходники репозитория и не зависят от этих временных файлов.
