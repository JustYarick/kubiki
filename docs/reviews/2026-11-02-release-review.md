# Review нового функционала относительно v1.1.1-dev.22

Дата: 2026-11-02. Исправления runtime/UI в рамках этого review не вносились.

База: `v1.1.1-dev.22`, `ee6a26b4ee5ca407468d9bb00c59eea0299b0b5c`.
HEAD: `4f5c7d0`, ветка `dev`. Включены 101 commit после тега, staged/unstaged
изменения и новые untracked исходники. Последний стабильный `v1.1.0` не был базой.
Основной diff: `git diff v1.1.1-dev.22...HEAD`, дополнен `git diff HEAD` и чтением
untracked файлов. Committed diff затрагивает 387 файлов.

Standards и Spec проверены независимыми review agents. Источники требований —
запросы пользователя, ADR-002–007, AI_PLAN_CONTRACT, AI_AGENT и документация
связанных функций. Источники стандартов — STRUCTURE, TESTING, EXTENSION_PLATFORM,
EXTENSIONS, UI_TABS, DESKTOP_RENDERING, TRAFFIC_OBSERVABILITY и README. Отдельных
AGENTS.md, CODING_STANDARDS.md и CONTRIBUTING.md в репозитории не найдено.

## Standards

### S1 · P2: отмена queued MCP request останавливает активный запрос

Источник: `crates/kubiki-mcp/src/lib.rs:182`; сериализация host-owned запросов
на общем gate — строки 79–80.

Обработчик отмены любого запроса вызывает `server.session.stop()`, даже если
запрос ещё ожидает mutex. Если A выполняется, B ждёт, а клиент отменяет только B,
отменяется и A. Воспроизведено через настоящий rmcp duplex transport с безопасным
mock executor: результат A — `is_error: true`, сообщение
`FIRST REQUEST CANCELLED BY SHARED SESSION`.

`docs/TESTING.md` требует сохранять cancellation и late-response isolation.
Для queued request нужно отменять ожидание, не изменяя running session. Для
выполняемого запроса cancellation должен относиться к его владельцу. Защиту
receipt после dispatch при этом сохранить.

### S2 · P2: AI lockfile блокирует документированную проверку и release CI

Источник: `crates/kubiki-ai/Cargo.lock:1166`. В dependencies пакета остаются `libc`
и `rmcp`, удалённые из manifest; lockfile в целом не соответствует графу.

`cargo test --locked --manifest-path crates/kubiki-ai/Cargo.toml` завершается
до компиляции, exit 101: `cannot update the lock file ... because --locked was passed`.
Именно эту команду запускают `docs/TESTING.md:6` и `.github/workflows/release.yml:259`.
Успешная сборка desktop использует другой lockfile и не выявляет проблему.

В отдельной временной копии AI crate с offline обновлением только её lockfile
прошли 56 тестов. Lockfile рабочего дерева не менялся. Требуется синхронизировать
его и повторить locked CI.

### S3 · Архитектурная эвристика: возможный Divergent Change

Источник: `crates/kubiki-tools/src/session.rs:14,20`. Portable tools содержит
`history: Arc<AsyncMutex<Vec<Turn>>>`, `ConversationMemory`, compaction и историю
provider turns. Изменения диалога встроенного агента теперь меняют библиотеку
кластерных инструментов, хотя OpenCode ведёт собственный диалог.

Это инженерная оценка, а не нарушение автоматически проверяемого правила.
Рекомендуется отделить access/execution session от conversation runtime:
scope, policy, evidence, receipts и cancellation остаются у tools; provider turns,
память и compaction возвращаются в AI runtime. Полное исключение зависимости AI
от implementation crate потребует отдельного компактного контракта.

### S4 · P2: два E2E-теста остались на предыдущем контракте метрик

Источники: `tests/e2e/node_details.spec.ts:69` и
`tests/e2e/pod_performance.spec.ts:151`.

При отказе Metrics API тесты ожидают `.telemetry-value` и пустые графики. Новые
`NodePerformanceBlock` / `PodPerformanceBlock` намеренно скрывают графики без
данных через `hasMetrics`; это соответствует изменению `dd2010a`. Сообщение
`metrics access denied` отображается, нулевые значения не подставляются.

Оба теста стабильно падают на отсутствующем элементе; это рассогласование тестов
с намеренным UI, а не доказательство неправильного отображения метрик. Обновить
ожидания: причина отказа видна, графики/ложные нули отсутствуют; наблюдения,
полученные до ошибки, по-прежнему показываются как stale. Требование TESTING —
проверять реальное видимое поведение и сохранять существенные assertions.

## Spec

### R1 · P1: внешний MCP не сохраняет связь verification с принятой мутацией

Источники: `crates/kubiki-mcp/src/lib.rs:317`,
`crates/kubiki-tools/src/kubernetes.rs:3546`, `kubernetes.rs:560`.

`ConnectionExecutor` создаёт новый `KubernetesTools` на каждый запрос, включая
пустой `accepted_identities`. Receipt мутации сообщает operationId/status/target,
но не UID/generation. Следующий `verify_workload` не принимает operationId и без
UID закрепляется за объектом первого свежего чтения.

На настоящем testbed:

1. Через MCP принят `scale_workload` тестового Deployment.
2. Deployment удалён и создан заново под тем же именем.
3. UID изменился с `d2db2aaa-a863-4447-8bd2-4dde10ee4f78` на
   `21b2501b-8854-4555-bc07-e987da7da05e`.
4. Следующий MCP `verify_workload` без UID вернул `verification: verified`.

Проверка с явно переданным старым UID правильно отклоняет замену. Следовательно,
механизм сравнения есть, но нужная identity теряется между публичными вызовами.
Требование AI_PLAN_CONTRACT: «объект-замена не считается успехом»; ADR-007 сохраняет
проверку принятых изменений при извлечении MCP.

Нужны connection-owned registry принятых операций и verification по operationId
с закреплёнными UID/generation/desired state. Fresh budgets/cache должны оставаться
на уровне отдельных вызовов. Проверку текущего здоровья без accepted operation
следует отличать от подтверждения результата конкретного изменения.

### R2 · P2: Stop во время запуска OpenCode не останавливает запуск

Источник: `src/domains/ai/components/OpenCodePane.tsx:55`, startup — строки 34–46.

Пока ожидается `connectOpenCode`, `connection.current` пуст. Кнопка Stop меняет
надпись на Stopped и пытается закрыть только уже созданное connection; локальный
AbortController ей недоступен. После завершения pending startup процесс получает
stdin, а панель меняет статус на Connected.

Воспроизведено браузерным тестом с задержкой native `start_opencode`: после Stop
не было `close_host_terminal`; после разрешения pending запуска появился Connected.
ADR-007 требует Stop и корректный lifecycle установленного процесса.

Контроллер pending startup нужно хранить в ref и отменять из Stop. Не следует
обобщать этот результат на любую смену кластера: `App.tsx::closeExecConnections`
закрывает уже зарегистрированные pending terminal connections. Окно до регистрации
во время загрузки шрифтов требует отдельной проверки.

### R3 · P2: initial Analyze/Create intent теряется при неудачном запуске

Источник: `src/domains/ai/components/OpenCodePane.tsx:39`.

`openCodeRequestConsumed` устанавливается до `connectOpenCode`. Если executable
не найден либо запуск завершается до отправки prompt, после исправления и Restart
вторая попытка получает `prompt: null`. В браузере воспроизведена последовательность
параметров: `['Analyze the selected fixture Deployment', null]`.

Требование ADR-007: «Analyze направляет ограниченный ResourceRef/контекст выбранному
runtime». Нужно различать подтверждённую доставку, гарантированный отказ до
запуска и неоднозначный исход. Для гарантированного отказа сохранить исходное
задание; при неоднозначном исходе не вводить автоматическое повторение действий.

## Выполненные проверки

| Проверка | Результат |
| --- | --- |
| `pnpm typecheck` | Успешно |
| `pnpm test` | 575 passed, 80 файлов |
| `pnpm test:desktop` | 42 passed |
| `pnpm test:extensions` | 10 passed |
| `pnpm test:e2e` | 105 passed, 2 failed; причины S4 |
| `pnpm build` | Успешно; предупреждение о размере Monaco chunk |
| `cargo test --locked`, tools | 42 passed |
| `cargo test --locked`, MCP | 4 passed |
| `cargo test --locked`, core | 126 passed |
| `cargo test --locked`, native `--lib` | 31 passed, 1 existing ignored |
| `cargo test --locked`, AI | Блокируется устаревшим lockfile, S2 |
| AI в изолированной копии, offline lock resolution | 56 passed; не заменяет проверку рабочего locked-графа |
| `cargo check --locked`, native `--all-targets` | Успешно |
| MCP request cancellation reproduction | Дефект S1 воспроизведён |
| Два дополнительных браузерных reproduction | Дефекты R2/R3 воспроизведены |
| testbed, реальный MCP stdio | 16 функциональных проверок успешны; 1 regression выявил R1; cleanup успешен |

Testbed — контекст `testbed`, Kubernetes `v1.35.5+k3s1`. Использован отдельный
namespace `kubiki-review-20261102-1018524` и собственные Deployment/ConfigMap/
синтетический Secret. Проверены каталог, реальное чтение, namespace boundary,
блокировка Secret, диагностика, UID-bound logs, events, replica cap, scale,
restart, apply/read-back/delete ConfigMap, verification и write-disabled exposure.
Namespace удалён; существующие workloads не изменялись. Платные LLM-запросы не
выполнялись. Windows/macOS нативно не проверялись.

Тесты воспроизведения специально подтверждают наблюдаемый дефект: их успешное
завершение не означает, что дефект исправлен. Основной браузерный suite и locked
AI gate остаются красными.

## Артефакты текущего запуска

- `/tmp/kubiki-review-results.json` — сводка.
- `/tmp/kubiki-review-live/results.json` и `/tmp/kubiki-review-live.py` — live результаты/сценарий.
- `/tmp/kubiki-review-cancellation.log`, `/tmp/kubiki-cancel-repro/` — MCP cancellation.
- `/tmp/kubiki-review-ui.log`, `/tmp/kubiki-review-ui/stop.spec.ts` — UI reproductions.
- `/tmp/kubiki-review-ai-lock.diff` — отличие исправленного временного lockfile.
- `/tmp/kubiki-review-*.log` — отдельные suite logs.
- `test-results/report.json` — основной browser report, failure screenshots/traces рядом.

Standards: 3 подтверждённых дефекта и 1 архитектурная эвристика; наиболее
существенна отмена чужого MCP-запроса. Spec: 3 дефекта; наиболее существенна
verification замены как результата принятой операции. Текущее состояние не готово
к выпуску без устранения этих дефектов и восстановления обязательных test gates.
