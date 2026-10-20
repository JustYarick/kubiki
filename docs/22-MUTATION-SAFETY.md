# ADR: централизованное подтверждение Kubernetes-записи

Дата: 2026-10-20. Решение: принято, реализация и автоматические проверки в работе. Linux GTK диалог реализован; acceptance Windows/macOS и проверка поведения окна в desktop harness выделены отдельно.

## Проблема и граница доверия

Ошибка выбора строки, повторный вызов обработчика или неверный optimistic state не должны незаметно менять кластер. Ранее scale выполнялся напрямую через kubectl, Secret сохранялся после frontend Save, HTTP bridge тоже имел write endpoints. Frontend ConfirmDialog и `confirmed: true` не дают независимого согласия пользователя.

Сохраняем модульный монолит. Авторитетный путь записи — Rust backend; решение о применении принимает человек через системный диалог Tauri, открытый backend. Диалог не предоставляется JS permissions. Renderer передаёт намерение, точный ResourceRef/UID/resourceVersion и желаемые значения, но не текст подтверждения и не факт согласия. Это защита от ошибок UI, не изоляция от вредоносного native-кода или компрометации ОС.

## Протокол

1. Общий desktop `MutationGuard` захватывается через try-lock на всю операцию. Второй запрос отклоняется, не ставится в очередь и не переиспользует чужое согласие.
2. Backend валидирует allowlist операции, GVK, context, namespace, имя, UID, resourceVersion и payload. Общего `apply`, произвольного kubectl write или обхода `force` в IPC нет.
3. `PreparedMutation` читает актуальный объект из API и сверяет его UID/версию с объектом из редактора. Backend формирует точное описание цели и diff. План содержит собственную копию payload, не имеет Deserialize/Clone или внешнего идентификатора и потребляется однократно.
4. Backend открывает системный диалог с context, kind/name, namespace, UID, resourceVersion, последствиями и diff. При закрытии, Cancel, ошибке диалога или исчезновении окна запись не начинается. `spawn_blocking` не блокирует UI/event loop.
5. Подтверждение действительно 120 секунд. После согласия повторный GET проверяет UID и resourceVersion. Любое изменение требует свежего просмотра и нового согласия; автоматического rebase нет.
6. Kubernetes также проверяет версию атомарно: Secret PUT сохраняет UID/resourceVersion и остальные поля исходного объекта; scale отправляет узкий merge patch только replicas и metadata UID/resourceVersion. DELETE debug Pod содержит обе preconditions.
7. Сетевые этапы ограничены таймаутами отдельно от ожидания человека. Записи не ретраятся автоматически. После таймаута исход может быть неизвестен: нужен refresh перед повторной операцией. Frontend сохраняет backend `retryable: false`.

Отмена имеет отдельный код `cancelled`, не маскируется под RBAC Forbidden. Draft Secret остаётся доступным после отмены/ошибки. Согласие не сохраняется на диск, не выдаётся renderer и не действует на другие изменения.

## Покрытые операции

| Путь | Подтверждение и условия |
|---|---|
| Deployment / StatefulSet scale | Backend diff старого → нового `spec.replicas`, предупреждение о создании/остановке Pods, UID/RV из строки таблицы, повторный GET, условный patch |
| Secret data | Добавленные, изменённые и удалённые ключи с точными значениями BEFORE/AFTER в base64; сохранение metadata/type; immutable и no-op отклоняются |
| Node shell: создание helper | Backend показывает полный фиксированный manifest привилегированного Pod, Node UID, namespace, image, host root/privileged последствия; проверяет Node UID до и после согласия, затем создаёт helper |
| Node shell: завершение/закрытие/ошибка | Первоначальное подтверждение создания явно разрешает дальнейшую автоматическую очистку **этого** owned helper по UID. Не спрашиваем повторно при уничтожении окна, чтобы не оставлять привилегированные Pods. Полномочие ограничено lease, UID, labels и session ID; произвольный ресурс таким способом удалить нельзя |
| Generic delete plan в core | Подготовлен и покрыт mock API тестом: точный текущий объект, labels/owners/finalizers, scope/UID/RV и последствия background GC; final DELETE требует тех же UID+RV. Live IPC/меню для произвольных ресурсов пока не подключены; helper Pods по-прежнему удаляет manager с ownership/active-lease проверкой |
| Ручное удаление оставшегося debug Pod | Проверка ownership/неактивного lease, серверный snapshot в диалоге, повторная проверка версии и UID, DELETE с UID+RV preconditions, explicit background propagation |
| HTTP `/scale`, `/secrets` | Всегда 403 до чтения payload/обращения к kubectl. Browser bridge теперь read-only, в том числе при поддельном `confirmed`/`approved` |
| Обычный live Delete / rollout restart / YAML apply | По-прежнему не подключены; demo меняет только память. Не включать, пока операция не пройдёт тот же backend-протокол |

SelfSubjectAccessReview — неперсистентная проверка RBAC, не изменение workload, согласие для неё не требуется. Read/watch/logs/metrics/port-forward не записывают объекты Kubernetes.

## Ограничения и компромиссы

- Linux показывает полный review в scrollable системном GTK окне с Cancel по умолчанию. Другие desktop ОС используют системный Tauri dialog с отдельной Apply кнопкой; platform acceptance остаётся TODO. Native dialog выбран вместо frontend подтверждения или токена, который UI мог бы сам принять. Серверный prepare/commit через IPC не нужен: план живёт в одном Rust вызове, что убирает хранение токенов, replay и подмену payload.
- Secret values не логируются и не входят в ошибки, но base64 в подтверждении обратим. Диалог предназначен пользователю, который уже редактирует Secret; никакой защиты от просмотра экрана он не обещает.
- Полный review ограничен 24 000 символами. Слишком большие изменения отклоняются целиком, без усечения diff. Их нужно разбить на меньшие правки. Linux full diff прокручивается в GTK окне. Другие ОС используют системный dialog; их layout и длинный текст ещё требуют native UX acceptance.
- Admission/defaulting и контроллеры Kubernetes могут изменить объект или создать/удалить зависимые объекты после запроса. Diff описывает конкретный запрос, не обещает предсказать все эффекты reconciliation. Дочерние Pods при scale не перечисляются как гарантированный конечный список.
- Exec/host terminal/node shell дают пользователю командную оболочку: команды внутри неё и внешний kubectl не проходят этот guard. Kubernetes RBAC/admission остаются независимой границей прав. Подтверждение привилегированного node shell явно описывает этот доступ.
- Headless Rust API получает callback согласия от доверенного интегратора. Возможность написать `Ok(true)` в другом Rust приложении не предоставляется renderer через IPC.
- Это не постоянный audit log Kubernetes. Backend не пишет Secret values или snapshots в markdown/telemetry. Для server audit нужны настройки самого API server.

## Дальнейшие задачи

- WRITE-GUARD-01: готов первый защищённый путь для доступных live-записей и read-only HTTP. Обычный live Delete/YAML Apply остаётся disabled; native platform acceptance ещё открыта.
- WRITE-GUARD-02: native acceptance на Linux/Windows/macOS: Cancel/Escape/закрытие/поведение длинного diff, parent window, platform portal; без автоматического применения к реальному кластеру — TODO.
- WRITE-GUARD-03: generic Delete prepare/conditional commit есть в core и тестируется; подключение к IPC/UI всё ещё требует type-specific cascade review, dry-run/structural diff для YAML, Namespace/CRD ограничения и отдельного acceptance. YAML/restart остаются TODO.
- WRITE-GUARD-04: после успешной операции показать результат API и возможную admission-нормализацию; persistent audit metadata без Secret values при отдельном продуктовом запросе — TODO.

## Проверки и источники

Автотесты используют mock API, не реальный кластер: отказ/ошибка согласия → ноль записей; неверная/изменившаяся идентичность до/после review; optimistic conflict на финальной записи; отсутствие retry; точный scale payload; diff Secret add/change/remove; no-op/immutable/слишком большой review; TTL; node creation consent и повторный Node UID; orphan delete cancellation и изменение версии. HTTP contract проверяет отказ даже для поддельного согласия до вызова executor. Browser tests проверяют редактор/transport, не доказывают нажатие настоящего системного диалога.

Основания: [Kubernetes API concepts — resource versions и concurrency](https://kubernetes.io/docs/reference/using-api/api-concepts/), [DeleteOptions preconditions](https://kubernetes.io/docs/reference/kubernetes-api/common-definitions/delete-options/), [Tauri dialog plugin](https://v2.tauri.app/plugin/dialog/), [Rust MessageDialogBuilder](https://docs.rs/tauri-plugin-dialog/latest/tauri_plugin_dialog/struct.MessageDialogBuilder.html).
