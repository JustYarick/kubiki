# 005: Ограниченные запросы и память AI-расследования

> Current implementation and limits: [AI tools](../AI_AGENT.md#tools-and-execution-limits).
> This record preserves the query design and its trade-offs; benchmark and migration
> statements below are evidence from the decision period, not current performance guarantees.

Дата: 2026-11-01. Статус: принято и реализовано; live-валидация отдельно.
Владельцы: desktop/core — транспорт, lifecycle и budgets; AI — стратегия/контекст;
frontend — история и отображение результатов. Уточняет [ADR-003](003-shared-kubernetes-access-and-ai-phases.md).

## Контекст и наблюдаемое давление

Первоначальный list_resources выполнял metadata LIST 50 объектов и до 50
последовательных GET. Fields/selectors/continuation отсутствовали. История оценивалась
в байтах с default 256k tokens; compaction могла разрывать tool exchanges и терять
receipts. Частичные дочерние выборки ошибочно объявлялись complete/healthy.

Эти проблемы требуют логического query layer внутри текущего runtime. Отдельный
процесс, agent fleet, MCP backend или vector DB не решают наблюдаемое давление.

## Решение и альтернативы

Выбран существующий модульный монолит с общим core ResourceAccess для UI/агента,
пулом клиентов и generation-bound client lease. Авторизация и egress projection
принадлежат backend; поля из модели только сужают разрешённый результат.

| Вариант | Решение |
| --- | --- |
| Только новый prompt поверх full JSON | Отклонён: нет технического контроля стоимости/полноты |
| Произвольный shell/jq/kubectl | Отклонён: лишние capabilities и сложный контроль исполнения |
| Типизированные fields/profiles/selectors/cursors | Выбран: bounded contract, тестируемые права и стоимость |
| Cache всех raw объектов/дублирующий watch | Отложен: native ResourceStore отключён и не имеет нужных generation/freshness гарантий |

Конкретные технологии: Rust, kube-rs, Tokio/futures для bounded reads, http-body
для проверки frames, serde_json для проекции. Один агент, один репозиторий и один
desktop-релиз. Развёртывание/инциденты остаются у существующих desktop/core владельцев.

## Инварианты

- Namespace и supporting selectors применяются до чтения; рабочие defaults имеют
  selectorKind и никогда не расширяют allowed scope. Фактический scope возвращается.
- Metadata-only не загружает bodies. Full LIST допустим только при доказанном
  равномерном content access; иначе metadata discovery и разрешённые точечные GET.
- Projection policy предшествует fields/профилю/агрегированию. Фильтры не становятся
  способом узнать исключённые значения. Связи owner UID используют разрешённые поля.
- Cursor — непрозрачное session-local состояние: query/revision binding, TTL и memory
  cap. Byte-tail выдаётся до следующей страницы. При 410/expiry новый scan явный.
- Независимые read-only batches могут выполняться параллельно. Scope changes, вопросы
  и writes являются барьерами; companions ask_user получают deferred results.
- Read budgets ограничивают реальные GET attempts/frames/time, а не только tools.
  Один bounded retry допустим для 429/503. Writes/receipts не прерываются/replay не выполняется.
- Discovery cache и in-flight coalescing ограничены текущим run/connection. Запись
  очищает cache, sequential resource reads остаются свежими. Lease проверяет реальную
  отправку, включая retries; host проверяет generation перед tool dispatch.
- После async lease validation write guard повторно проверяет phase/revision/cancel.
  Human approval не расходует active deadlines; failed/declined/uncertain mutation
  останавливает очередь. Каталог отражает operation grants; GitOps writes, которые
  исключены native allowlist, не предлагаются модели.
- Compaction сохраняет целые exchanges, пользовательские запросы и receipt identities.
  Evidence cache хранит только уже разрешённые результаты с TTL, а не raw UI cache.
- JSON из ресурсов/logs/evidence остаётся untrusted. Историческая запись не доказывает
  live health. verify_workload проверяет UID/generation/replicas в bounded deadline.

## Проверка, риски и внедрение

Offline tests покрывают policy, projection массивов, mixed grants, metadata Accept,
GET/LIST cost path, cursor tail/binding/expiry, read concurrency, cancellation,
транспортные caps/retry, generation invalidation, compaction, приватность истории,
UI и browser flows. Scale fixtures: 1/10/1000/10000 объектов. На fixture для 10000
Pods baseline JSON 21 400 000 байт, selected fields 1 940 000 байт (−90,9%), summary
568 байт; API/LLM latency и точность этим экспериментом не измерены.

Главные риски: неверный completeness при новых specialized readers, stale cache,
потеря tool/result identity, starvation UI и рост памяти. Gates: ноль запрещённых
bodies/полей, ноль writes в Plan, отсутствие разрывов exchanges, bounded store и
честная partial/unknown семантика. Token estimator не заменяет tokenizer провайдера.

Миграция шла по семействам поверх core, без двойных production reads/writes.
Совместимы прежние имена tools и wire tooling/action; новый list default — health,
full body доступен явно. Старые localStorage payloads мигрируют без tools/YAML;
restore не возобновляет runs/approvals. Rollback desktop-кода не откатывает кластер.
Нельзя оставлять legacy policy bypass как runtime fallback.

Следующая валидация — сравнить API calls/bytes, p50/p95 до диагноза, tokens/model
rounds, correctness/completeness и UI latency на одинаковом live окружении. Если
cache не даёт выигрыша или нарушает свежесть/память, его расширение не выполнять.
Историческое rightsizing требует реального источника временных рядов, сейчас его
нет. Delivery metrics сравнивать с baseline существующего desktop-релиза: frequency,
lead time, failed deployment recovery time, change fail rate и deployment rework rate.

Текущие лимиты и примеры: [AI_AGENT.md](../AI_AGENT.md). При замене решения
добавить ссылку superseded-by здесь; раннее ADR-003 сохраняет роль общего
подключения/фаз.
