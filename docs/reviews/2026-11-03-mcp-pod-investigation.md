# Разбор расследования Pod и MCP — 2026-11-03

Проверены сохранённый чат, текущий код Kubiki и публичные исходники Radar, containers/kubernetes-mcp-server и Flux159/mcp-server-kubernetes. Это разбор поведения и точечное исправление; полный перенос графа интерфейса в backend здесь не выполнен.

## Что произошло в чате

Источник: `~/.local/share/com.kubiki.app/ai/history.sqlite3`, таблица `conversations`, разговор `1c9ab0ef-99ac-477d-9b79-c6205dfce059`, название `Analyze: caretta-sql4j`. База открыта только для чтения. Сохранённый идентификатор модели — `fast`; он не доказывает, какая модель обслуживала запрос на стороне провайдера.

| Шаг | Сохранённое действие | Проблема |
|---|---|---|
| 1 | Пользовательский kickoff называет Pod `caretta/caretta-sql4j` и его UID; требует диагноз и remediation plan | Исходная идентичность известна |
| 2 | `get_pod_diagnostics(namespace=caretta, name=caretta-sql4j)` | Правильная отправная точка |
| 3 | `get_events_timeline` с namespace/name | UID в сохранённых аргументах отсутствует, но storage его всегда удаляет: нельзя утверждать, что агент его не передал |
| 4 | `get_config_diagnostics(kind=Deployment, name=caretta-sql4j)` | Не было предшествующего чтения владельца. Тип и имя контроллера придуманы |
| 5 | Агент сообщает CrashLoopBackOff, 1128 рестартов, exit 1 и ответ 404 для Deployment | Это утверждения агента, а не сохранённые ответы Kubernetes. «Нет OOMKill → не проблема памяти» — чрезмерный вывод |
| 6 | `get_workload_diagnostics(kind=Deployment, name=caretta-sql4j)` | Повторение уже опровергнутой идентичности через другой инструмент |
| 7 | `list_resources(kind=Deployment, namespace=caretta)` | Расширение поиска по неподтверждённому типу |

В сохранённом фрагменте нет `get_logs`, `get_resource` для определения владельца, обращения к DaemonSet или `propose_plan`. Агент обещал получить логи, но соответствующего вызова в истории нет. Причину завершения/остановки этот фрагмент не устанавливает.

Пользователь сообщает, что Pod принадлежит DaemonSet. В этой проверке live-кластер не опрашивался; история сама по себе не позволяет подтвердить владельца, поскольку ответы инструментов удалены.

## Причины в Kubiki

1. **Диагностический ответ терял владельца.** `crates/kubiki-tools/src/kubernetes.rs::read_pod_diagnostics` получает весь Pod, пропускает через policy projection, затем вручную собирает ответ. До исправления `metadata.ownerReferences` в ответ не попадал. Агент мог получить их отдельным `get_resource(profile=identity)`, но основной инструмент диагностики не давал эту ключевую подсказку.
2. **Паритета с UI-графом нет.** `src/core/resources/relationships.ts::buildResourceGraph` строит связи из объектов интерфейса, включая ownerReferences, ссылки конфигурации и другие отношения. Каталог `kubiki-tools` не содержит topology/neighborhood/related-objects инструмента. Встроенный агент и MCP используют общий каталог и executor, но это не означает общего графа с UI. Специализированные workload/service/config diagnostics покрывают отдельные связи, а не произвольный обход графа.
3. **Недостаточный контракт расследования.** Системный prompt советовал Pod diagnostics, но не требовал сначала доказать владельца и не запрещал зависимые запросы до получения результата. Каталог разрешает `get_config_diagnostics` непосредственно для Pod, однако модель выбрала ненужный промежуточный Deployment.
4. **Нет защиты от отсутствия прогресса в чтениях.** Runtime ограничивает запуск 20 вызовами, временем и бюджетом данных. Это ограничители ресурсов, а не обнаружение повторного обращения к той же несуществующей цели через разные инструменты. Здесь нужна нормализация цели и структурированных ошибок, а не только сравнение имён инструментов.
5. **Внешний MCP не получал общие инструкции.** `ClusterServer::get_info` возвращал capabilities без `instructions`; встроенный prompt внешнему клиенту автоматически не передаётся.
6. **История недостаточна для разбора ошибок.** `src-tauri/src/ai_history.rs::sanitize` сохраняет только group/version/kind/namespace/name и заменяет результат на `historical/payloadOmitted`. Исчезают UID, profile, selector, параметры логов, ошибки, coverage и evidence. Это намеренное ограничение хранения, но оно мешает отличить ошибку модели от ошибки инструмента. Полные необработанные логи сохранять для решения этой задачи не требуется.

## Сравнение реализаций

Ссылки ниже закреплены на просмотренных revision. Это сравнение устройства, не сравнительный benchmark качества моделей.

| Реализация | Что проверено | Вывод для Kubiki |
|---|---|---|
| Radar | [get_neighborhood](https://github.com/skyhook-io/radar/blob/4fa114de070f32d7a59db5b746cee619292ddc39/internal/mcp/tools_neighborhood.go) использует общий `pkg/topology`: BFS, default 1 hop / max 2, default 25 nodes, RBAC, truncated/omitted. [Ownership access](https://github.com/skyhook-io/radar/blob/4fa114de070f32d7a59db5b746cee619292ddc39/internal/mcp/ownership.go) проверяет права чтения | Связи должен разрешать backend, а модель — выбирать дальнейшую гипотезу; нужен ограниченный локальный граф вокруг известного объекта |
| Radar agent | [Agent](https://github.com/skyhook-io/radar/blob/4fa114de070f32d7a59db5b746cee619292ddc39/internal/ai/agent.go) и [Diagnoser](https://github.com/skyhook-io/radar/blob/4fa114de070f32d7a59db5b746cee619292ddc39/internal/ai/diagnoser.go): адаптеры локальных Claude/Codex/Cursor/OpenCode CLI; CLI выполняет агентный цикл через MCP. [Guidance](https://github.com/skyhook-io/radar/blob/4fa114de070f32d7a59db5b746cee619292ddc39/pkg/investigation/guidance.go) направляет на diagnose/neighborhood и требует доказательств | Замена собственного цикла на внешний CLI не восполнит отсутствующие связи в инструментах |
| containers/kubernetes-mcp-server | [pods_get](https://github.com/containers/kubernetes-mcp-server/blob/e71a831713163de1ff17a7287c24fe8b55f6b678/pkg/toolsets/core/pods.go) вызывает Kubernetes API и возвращает YAML + structured object; рядом отдельный инструмент логов с previous. [Реализация Pod API](https://github.com/containers/kubernetes-mcp-server/blob/e71a831713163de1ff17a7287c24fe8b55f6b678/pkg/kubernetes/pods.go) | Базовый полный объект сохраняет связь владельца; компактные diagnostics Kubiki должны сохранять столь же важную идентичность. Это не доказательство наличия у конкурента общего графа |
| Flux159/mcp-server-kubernetes | [kubectl_get](https://github.com/Flux159/mcp-server-kubernetes/blob/5536776f7338dc7c5239e6dc1ef07581434a7bf5/src/tools/kubectl-get.ts) и [k8s-diagnose prompt](https://github.com/Flux159/mcp-server-kubernetes/blob/5536776f7338dc7c5239e6dc1ef07581434a7bf5/src/prompts/index.ts): определить ресурс/связи контроллера, проверить состояние, историю, current/previous logs | Явный workflow полезен, но prompt сам по себе не является гарантией корректного разрешения владельцев |

## Что исправлено сейчас

- `get_pod_diagnostics` возвращает `ownerReferences` из уже разрешённой policy projection. Не обращается к владельцу автоматически; не добавляет API-запросов. Недоступное поле остаётся `null`, отдельные запрещённые поля ссылки не восстанавливаются.
- Общий `INVESTIGATION_GUIDANCE` передаётся встроенному агенту и внешним MCP-клиентам через initialize instructions. Он требует точных owner references, проверки UID, последовательного получения зависимых данных, пересмотра цели после NotFound и осторожной трактовки OOM.
- Описания Pod/workload/config инструментов самостоятельно объясняют правильную маршрутизацию, даже если внешний клиент не использует server instructions.
- Интеграционный тест вызывает настоящий executor с mock Kubernetes API: DaemonSet, StatefulSet, ReplicaSet, Job, пользовательский контроллер; полное/частичное скрытие ownerReferences; отсутствующий владелец. Mock допускает только GET исходного Pod.
- MCP protocol test проверяет получение общей инструкции клиентом.

Это устраняет потерю данных и улучшает инструкции. Это не детерминированная защита от любых ошибочных решений модели и не реализация UI-графа в MCP.

## Следующие изменения по приоритету

1. **Разрешение связей в backend.** Один контракт resource identity + typed edges для UI/MCP; начать с owner chain, Node, ConfigMap/Secret, PVC и Service/EndpointSlice. Инструмент neighborhood принимает exact root/UID, глубину и бюджет, возвращает доказанную связь отдельно от непроверенной ссылки. Проверять UID владельца, обнаруживать циклы, учитывать scope каждого GVK, фильтрацию полей и права каждого узла; отсутствие доступа не превращать в отсутствие связи. UI-граф нельзя просто передать агенту как доверенные данные из renderer.
2. **Собранная диагностика Pod.** Вернуть ownership, статусы контейнеров, UID-bound events, ограниченные current/previous logs и ссылки конфигурации одним evidence bundle с coverage и ошибками частей. Дополнительные чтения выполнять только когда нужны и разрешены. Известный Pod должен быть достаточной отправной точкой без угадывания workload.
3. **Обработка тупиков.** Структурированные NotFound/Forbidden/filtered/stale ошибки; учитывать повторные неудачи по нормализованной цели, даже если инструмент меняется. После повторения — пересмотр идентичности/получение связей либо честное завершение с неизвестной причиной. Не запрещать легитимный повтор после изменения ресурса.
4. **История доказательств.** Хранить безопасные параметры, код исхода, resolved identity, UID, evidence IDs, coverage/truncation, версии tool catalog/prompt и фактический model identifier, если провайдер его отдаёт. Содержимое секретов и сырые логи не нужны для базового аудита. Отдельно сохранять причину остановки запуска.
5. **Поведенческие evals.** Реальный model run на сценариях Pod→DaemonSet, Pod→ReplicaSet→Deployment, Pod→Job→CronJob, bare/static Pod, CRD owner, owner UID mismatch, Forbidden и скрытые ссылки. Проверять результат расследования, неверные цели и число бесполезных вызовов. Тест с заранее заданными ответами провайдера не доказывает качество reasoning.

## Проверка

Успешно: `cargo test --manifest-path crates/kubiki-tools/Cargo.toml` (44 теста), MCP `--test protocol` (4), AI `--test runtime` (20), `git diff --check`.

Добавленные инструкции увеличили фиксированный контекст. Существующий тест compaction с бюджетом 16 384 перестал помещать фиксированный prompt/catalog вместе с сохраняемой свежей историей. Бюджет fixture поднят до 20 480; ~80 KB начальной истории по-прежнему требуют compaction. Это также аргумент в пользу коротких общих инструкций и дальнейшего измерения стоимости каталога; нижний предел контекста не следует считать неизменным.

Desktop не пересобирался и реальный запрос к модели не повторялся; live-кластер не изменялся. Уже существовавшие изменения в других документах не затрагивались.


## Продолжение реализации

Полный read catalog сохранён по уточнению пользователя. Реализованы neighborhood/diagnostic bundle, сокращение prompt и skill descriptions, evidence compaction, метрики, свёрнутый thinking и внешние Codex/Claude. Итоговые решения, измерения и ограничения: [ADR-008](../decisions/008-evidence-first-investigation.md). Прежние предложения о маленьком каталоге по intent отозваны.
