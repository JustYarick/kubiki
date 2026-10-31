# План развития AI-агента Kubiki

Дата обновления: 2026-11-01. Статус: оптимизации P0–P3 и offline-часть P4 реализованы;
условный informer reuse, live-валидация и последующие продуктовые этапы открыты.

Документ разделяет выполненные оптимизации и **целевое поведение** следующих этапов.
Текущее состояние описано в [AI_AGENT.md](AI_AGENT.md), архитектурное решение —
в [ADR-003](decisions/003-shared-kubernetes-access-and-ai-phases.md).
Новые требования к запросам, большим кластерам и prompt подробно определены в
[AI_QUERY_DESIGN.md](AI_QUERY_DESIGN.md); основные контракты реализованы расширением
get_resource/list_resources, без отдельного query_resources.

## Приоритеты

1. Достоверность диагностики: единая policy, честная completeness и корректные связи.
2. Общий Kubernetes access и экономные запросы: fields, selectors, pagination, working scope.
3. Быстрые расследования: bounded parallel reads, budgets, cache и компактный контекст.
4. Глубокая диагностика с evidence и оценкой качества на больших кластерах.
5. Гибкие правила, планы, история/поиск и контролируемое хранение данных.
6. Ограниченные действия над существующими объектами и проверка результата.
7. **Создание ресурсов, установка приложений и развёртывание — в последнюю очередь.**

Архитектурная подготовка первого этапа должна обслуживать диагностику и не
превращаться в отдельную длительную перестройку всего приложения. Существующие
инструменты записи не расширять до выполнения предыдущих этапов.

## Что уже есть и что нужно изменить

| Область | Сейчас | Следующее изменение |
| --- | --- | --- |
| AI-домен | `crates/kubiki-ai` и `src/domains/ai` | Сохранить отдельный домен без собственного Kubernetes-ядра |
| Подключение | Общий `ClusterClientPool`, ResourceAccess, generation-bound transport | Live reconnect/TLS/auth проверка под нагрузкой |
| Доступ | Read only / Ask / Accept, Plan/Action в UI/prompt, запрет writes в Plan; каталог по operation grants | Расширенные профили и объяснение прав |
| Чат | Streaming, Markdown, фильтрованная localStorage история, evidence и полный estimated token budget | Native searchable history/retention и UI управления контекстом |
| Диагностика | Policy-projected diagnostics/GitOps/Helm, per-kind health, verify_workload | Richer network/storage workflows, historical metrics и live model evals |
| Запросы | Fields/profiles/selectors/cursors, ResourceAccess, working scope и summaries | Расширение специализированной child pagination по необходимости |
| Масштаб | Bounded concurrency/API budgets/cache, summaries и evidence | Live latency/quality baseline; optional informer reuse после freshness/generation контракта |
| Правила | Переключатели и упорядоченные правила ресурсов | Профили, объяснение решения, проверка конфликтов, раздельные права на поля и инструменты |

## Прогресс реализации 2026-11-01

| Пункт | Реализовано и проверено offline |
| --- | --- |
| P0: достоверность | Общая projection для Pod/workload/Events/GitOps, Helm values как структурированные данные; per-kind health, неизвестное вместо нулей, исправлены OOM/SIGKILL и normal completion |
| P0: права и lifecycle | Content до body GET, metadata-only discovery, owner UID через разрешённые поля, default writes выключены, generation pinned в сессии и проверяется перед транспортом |
| P1: queries | Fields/профили, selectors, pageSize, cursor с TTL/binding/byte-tail, один LIST при равномерных правах |
| P1: scope/prompt | Namespace/selectorKind/root/rootUid и причина расследования; defaults не расширяют права; сокращённый prompt и capability summary вместо всей policy |
| P1: общий доступ | ResourceAccess в core для UI/AI; AI-адаптер не создаёт kube::Api/Discovery, HelmReader использует общий kubeconfig/context |
| P2: скорость и budgets | Read-only batches до 4, global desktop AI cap 2 с резервом UI, HTTP request/byte/time caps, один bounded retry 429/503, discovery cache и in-flight coalescing |
| P3: сводки и память | summarize_resources, bounded evidence store/get_evidence, полный estimated request budget, целые tool exchanges, сохранение пользовательских ограничений и receipts |
| P4: verification/evals | verify_workload с UID/generation/replicas, fixtures Pending/CrashLoop/OOM/ImagePull и scale 1/10/1000/10000, исправлены ложные Healthy в UI |
| Хранение и UX | Tool payloads/YAML не сохраняются; migration старой истории, restore Read only + Plan; UI использует Action с совместимым wire tooling |
| Action lifecycle | После async lease validation повторно проверяются phase/revision/cancel; human approval не расходует time budgets; failed/declined/uncertain останавливает очередь; неподдерживаемые GitOps writes не предлагаются |

Измерение fixture: для 10000 Pods policy-filtered baseline 21 400 000 байт,
выборка image/name/phase 1 940 000 байт (−90,9%), агрегат 568 байт. Это не замер
Kubernetes API/LLM latency или качества рассуждений модели.

Не выдавать за выполненную live-валидацию: реальные TLS/auth/reconnect под нагрузкой,
API p50/p95/UI latency, диагностику платной/локальной моделью и запись в тестовый
кластер. Транспортные, runtime, UI и browser fixtures проверяются локально.

Итоговый offline-прогон (2026-11-01):

- `cargo test --locked --manifest-path crates/kubiki-ai/Cargo.toml` — 63 теста.
- `cargo test --locked --manifest-path crates/kubiki-core/Cargo.toml` — весь набор core.
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` — 32 passed,
  один live `/version` probe оставлен ignored.
- `pnpm test` — 555 тестов; `pnpm test:e2e tests/e2e/ai_agent.spec.ts` — 4 сценария.
- `pnpm build` — typecheck и production-сборка успешны.

Отложено с явным основанием: raw informer reuse (native ResourceStore сейчас
выключен и не несёт безопасного generation/freshness контракта); историческое
rightsizing (нет подключённого источника временных рядов). В этих случаях агент
использует live reads/разрешённые evidence и сообщает неизвестное. Дублирующий
watch всего кластера или новая metrics DB не добавляются ради этого этапа.

Pagination list_namespaces также реализована с policy projection имён.
Специализированные child readers остаются ограниченными:
для полного расследования доступны generic cursors; специализированные ответы partial.
PlanArtifact, расширенные профили прав и native searchable history — отдельные
последующие продуктовые этапы ниже; создание/deployment не расширяются этим изменением.

## Первоочередные исправления и оптимизация запросов

Полный контракт и сценарии проверки: [AI_QUERY_DESIGN.md](AI_QUERY_DESIGN.md).
Чекбоксы ниже обозначают готовность целевого поведения целиком; существующий
инструмент не означает, что все требования к нему выполнены.

- [x] P0: применять metadata-only/content/denied paths и child-resource rules ко
  всем diagnostics, Events, Helm/GitOps; запрещённые bodies не загружать.
- [x] P0: убрать ложный `complete` при лимитах/ошибках; отличать denied/unavailable
  от пустой выборки; health считать по типу workload.
- [x] P0: корректные ReplicaSet/Pod связи через selectors (включая expressions)
  и owner UID; не искать владельцев только в первых 20 RS namespace.
- [x] P1: fields и компактные profiles для exact/group reads; ограниченный язык
  путей и сохранение структуры контейнеров; policy применяется раньше проекции.
- [x] P1: server-side selectors и cursor; отсутствие потерь при byte truncation
  посреди страницы, явная обработка expiry/410 и изменения policy/подключения.
- [x] P1: exact GET для имён, LIST без N+1 при разрешении всей выборки; при
  точечных разрешениях сохранить metadata discovery + разрешённые GET.
- [x] P1: allowed scope отдельно от working scope; начинать с минимального
  namespace/workload, расширять только по evidence в пределах прав.
- [x] P1: обновить prompt под доступные инструменты — гипотеза → минимальная
  проверка → evidence; единая терминология Action, без обязательных лишних reads.
- [x] P2: bounded parallel reads, per-connection semaphore с резервом UI,
  deduplication и discovery cache; API calls/bytes/pages/time/token budgets.
- [x] P3: агрегаты и top examples вместо тысяч объектов в модели; bounded discovery
  cache/coalescing и projected evidence reuse.
- [ ] Условный следующий этап: raw informer reuse только после generation/readiness/
  freshness контракта и замеров памяти; сейчас live fallback вместо неподтверждённого cache.
- [x] P3: бюджет полного provider request и памяти расследования; сохранять
  receipts и целые tool exchanges, подгружать evidence по ссылке.

Критерии: ноль forbidden bodies/fields, честное покрытие, один LIST для одной
равномерно разрешённой страницы без GET каждого объекта, воспроизводимый диагноз.
Снижение tool-output tokens ≥70% для выборок нескольких полей — цель эксперимента,
а не установленный результат. Latency и влияние на UI сравнить с baseline.

## Единая точка доступа к Kubernetes

Пользователь и агент работают с **одним подключением Kubiki к выбранному кластеру**:
один менеджер kubeconfig, общий пул клиентов, TLS/auth, discovery, lifecycle и
обработка ошибок. У AI нет отдельного kubeconfig, учётной записи или способа
подключиться в обход приложения. Подключения к моделям AI остаются отдельной
настройкой: они не являются подключениями к Kubernetes.

Общий сервис `KubernetesAccess` — внутренняя Rust-граница над существующим
`kubiki-core`, а не новый процесс, сервер, порт или второй Kubernetes-клиент.
Название сервиса предварительное; его ответственность фиксирована.

```mermaid
flowchart TD
    UI[Ручные действия и представления Kubiki] --> Host[Desktop application layer]
    AI[AI-домен: диалог, Plan/Action, вызовы инструментов] --> Adapter[AI tool adapter]
    Adapter --> Host
    Host --> Access[Общий KubernetesAccess: авторизация и операции]
    Access --> Core[kubiki-core: reads, diagnostics, mutations]
    Core --> Pool[Общий ClusterClientPool: TLS, auth, lifecycle]
    Pool --> K8s[Kubernetes API]
```

- [ ] Общий контракт операций: catalog/discovery, get/list, metadata, Events,
  logs, metrics, relationships и диагностические запросы. Существующие core
  сервисы переиспользуются; одинаковую операцию не реализовывать отдельно для AI.
- [ ] Прямые `kube::Api` и `Discovery` из `agent_tools.rs` перенести в общий core
  read/diagnostic слой. AI-адаптер только валидирует tool arguments, передаёт
  полномочия и преобразует результат в ограниченный ответ для модели.
- [ ] Отдельные полномочия вызывающего: пользователь или агент, окно, сессия,
  scope, версия подключения, policy revision и фаза. Эти данные формирует backend.
- [ ] Права агента — дополнительное ограничение возможностей приложения.
  Итоговые Kubernetes-права всегда ограничены RBAC текущего подключения.
- [ ] Общие типы ошибок, пагинация, лимиты, timeout, cancellation и признак
  свежести. Cache/watch можно переиспользовать только с проверкой scope и прав:
  полный UI-кэш никогда не становится контекстом модели автоматически.
- [ ] Запрещённое содержимое не загружать ради последующей маскировки: для
  metadata-only использовать соответствующие Kubernetes metadata APIs.
- [ ] Смена kubeconfig, fingerprint подключения или активного context приостанавливает
  агентские операции, отменяет ожидающие действия и требует явного перепривязывания
  разговора. Агент не продолжает работу со старым сохранённым `Client`.
- [ ] Общие ограничения нагрузки с резервом для UI: диагностика AI не должна
  занимать все слоты чтения и мешать пользователю работать с кластером.

«Одно подключение» означает общий источник конфигурации, авторизацию и жизненный
цикл на context; Kubernetes watch и параллельные reads могут использовать несколько
HTTP-запросов. Если пользователь выбирает другой кластер, это явно другое подключение,
общее для его интерфейса и агента.

## Две независимые оси: фаза работы и разрешение изменений

Backend-фазы и запрет writes в Plan уже реализованы. Ниже — полный целевой
контракт, включая оставшиеся lifecycle/UI/plan-artifact проверки. Сейчас UI использует Action, wire
enum сохраняет tooling; `action` принимается как alias. Унифицировать
на Action с совместимостью сохранённых данных и IPC.

**Фаза работы:** `plan | action`. **Режим доступа:** `read_only | ask | accept`.
Один не заменяет другой.

| Режим доступа | Доступные фазы | Фаза по умолчанию | Изменения Kubernetes |
| --- | --- | --- | --- |
| Read only | Только Plan | Plan | Запрещены |
| Ask | Plan и Action | Plan | Только в Action, в пределах policy и с подтверждением конкретной операции |
| Accept | Plan и Action | Plan | Только в Action и в пределах policy; отдельное подтверждение для каждой разрешённой операции не требуется |

- [ ] Каждый новый и восстановленный разговор открывается в **Read only + Plan**.
- [ ] Выбор Ask или Accept оставляет Plan. Само изменение режима ничего не запускает.
- [ ] В Plan доступны только разрешённые чтения и локальные артефакты ответа.
  Запрещены Kubernetes writes, exec, debug pods, port-forward, Helm install,
  изменение настроек/правил приложения и любые обходные команды.
- [ ] Сохранение плана/сообщения выполняет host как часть чата. Оно не выдаёт
  модели произвольного доступа к файловой системе или права изменить конфигурацию.
- [ ] Переход в Action — явное действие пользователя. Текст сообщения, Markdown
  checkbox и просьба модели не могут переключить фазу или подтвердить операцию.
- [ ] Переход в Action разрешает обсуждение/подготовку выполнения, но не запускает
  накопленные действия автоматически. Выполнение выбранной версии плана начинается
  отдельным явным действием; прямой пользовательский запрос в уже выбранном Action
  может начать новый run в его пределах.
- [ ] В Read only Action недоступен и в UI, и в native API. Принудительный downgrade
  из Action переводит сессию в Plan и отзывает ещё не отправленные изменения.
- [ ] Перед фактическим dispatch заново проверяются phase, access mode, policy,
  connection generation и отмена. Разрешённый tool list также фильтруется по ним.
- [ ] Stop/возврат в Plan отменяет подготовку и pending approval. Уже принятый
  API-сервером запрос может завершиться; это отражается в receipt без обещания отката.

Два переключателя видны рядом: сначала **Plan / Action**, затем **Read only / Ask /
Accept**. Под ними — краткое объяснение эффективных прав. Переключение вкладок
Explorer / Topology / AI сохраняет разговор и не означает переключение в Action.

## Диагностика: главный следующий продуктовый этап

### Инструменты чтения

- [ ] Workloads: desired/current/ready replicas, rollout status, условия,
  generation/observedGeneration, владельцы и цепочка Deployment → ReplicaSet → Pod.
- [ ] Pods: scheduling, readiness/liveness/startup, restarts, last termination,
  OOM, exit code, image pull, requests/limits, доступные metrics и их время получения.
- [ ] Логи выбранного контейнера: текущие и `previous`, init containers,
  временной интервал, timestamps, поиск и пагинация в рамках лимитов.
- [ ] Events: связать по UID, объединить повторы, построить timeline; отсутствие
  Events после TTL или отказа доступа не трактовать как отсутствие проблемы.
- [ ] Сеть: Service selectors, Pod readiness, EndpointSlice, Ingress/Gateway,
  ссылки на backend и пассивный анализ NetworkPolicy. Активные пробы и exec
  выделять в отдельные возможности и не маскировать под безопасное чтение.
- [ ] Storage: PVC/PV/StorageClass, binding, provisioning, mount/attach Events,
  access modes и ограничения topology.
- [ ] Nodes: conditions, pressure, taints/tolerations, capacity/allocatable,
  влияние на выбранные workloads и ограничения планирования.
- [ ] Конфигурация: ссылки на Secret/ConfigMap, отсутствующие ключи/объекты и
  противоречия в настройках только в пределах разрешённого чтения. Поля Pod spec,
  env, annotations и логи тоже могут содержать секреты.
- [ ] CRD/GitOps/Helm: сначала диагностическое чтение статусов и ссылок через
  общие сервисы приложения. Refresh Argo CD и reconcile Flux не предлагаются:
  native allowlist пока не разрешает записи этих CRD;
  проверить их scope/policy/receipt и не расширять writes до закрытия P0/P1.
  Upgrade/install остаются последующим этапом.

### Как агент должен расследовать

- [ ] Начать с вопроса, scope и доступных данных; собрать факты, сформировать
  гипотезы, провести разрешённые проверки и обозначить неизвестное.
- [ ] Для каждого вывода хранить evidence: context, GVK, namespace/name, UID,
  resourceVersion при наличии, capturedAt, инструмент, фильтры и покрытие данных.
- [ ] Ответы инструментов включают `complete | partial | denied | unavailable`,
  причину усечения и свежесть. Не предлагать права шире необходимого автоматически.
- [ ] Ограничивать объём логов, число связанных объектов, шаги, время, токены и
  параллельные запросы. Следующие страницы запрашивать осознанно, сохраняя cursor.
- [ ] Кнопка «Разобрать ошибку» открывает Plan с идентичностью объекта. Снимок
  всего UI и секретные поля автоматически в prompt не добавляются.
- [ ] Показывать отдельно: наблюдение, вероятная причина, доказательство,
  дополнительная проверка и возможное исправление. Не выдавать гипотезу за факт.

Критерий готовности: воспроизводимые расследования Pending, CrashLoopBackOff,
OOMKilled, ImagePullBackOff, неготового Service, зависшего PVC и проблем rollout;
для каждого — ссылки на доказательства и корректное поведение при запрете данных.

## Гибкое управление правилами

- [ ] Профили: минимальная диагностика, workloads, сеть, storage и пользовательские.
  Новые разрешения требуют явного изменения настроек пользователем.
- [ ] Scope: context, namespace, API group/version/resource, kind, name и labels.
  Отдельно — cluster-scoped ресурсы и чувствительные типы.
- [ ] Разделить операции: metadata/get/list/watch, Events, logs/previous logs,
  metrics, чтение конфигурации, а позже — конкретные виды изменений.
- [ ] Данные: none/metadata/selected fields/content, allowlist/denylist полей,
  Secret и ConfigMap отдельно; ограничения env, annotations, log payload и CRD.
- [ ] Разделить право прочитать данные в приложении, передать их модели,
  сохранить в истории и экспортировать. Локальная модель не получает больше прав
  только потому, что endpoint локальный.
- [ ] Объяснение решения: «почему можно/нельзя», какое правило сработало,
  preview на конкретном объекте и инструменте без отправки данных провайдеру.
- [ ] Валидация правил: конфликты, перекрытия, недостижимые исключения,
  предупреждение перед широким разрешением и сравнение изменений профиля.
- [ ] Семантику определить явно: ограничения Plan, RBAC, scope и запрет capability
  нельзя обойти ресурсным исключением. Для ресурсных правил целевая модель —
  запрет по умолчанию, явные разрешения и приоритет явного deny.
- [ ] Текущий first-match формат мигрировать через версию policy и просмотр
  изменений эффективных прав. Не менять смысл сохранённых правил незаметно.
- [ ] Ужесточение правил немедленно отзывает будущие действия. Собранные раньше
  чувствительные tool outputs не пересылать повторно под новой более узкой policy:
  очистить/пересобрать контекст либо предложить новую сессию.

Критерий готовности: пользователь может разрешить диагностировать конкретный
workload в одном namespace без Secret content и исключить отдельные поля;
интерфейс объясняет результат, backend проверяет его до чтения и отправки модели.

## Markdown-чат и отдельный блок плана

Обычные ответы уже используют Markdown с таблицами. Сохранить этот формат для
заголовков, списков, цитат, ссылок и code blocks; форматированный ответ не должен
зависеть от конкретного провайдера модели.

- [ ] `PlanArtifact`: ID, версия, title, `bodyMarkdown`, ссылки на evidence,
  context/scope, дата, revision policy и proposed action references.
- [ ] План приходит отдельным типизированным событием/результатом инструмента,
  валидируется и отображается карточкой «План», а не распознаётся как команда из
  произвольного Markdown. Невалидный ответ остаётся обычным текстом без кнопки выполнения.
- [ ] Карточка: красиво отрисованный Markdown, раскрытие, копирование,
  просмотр исходника и экспорт `.md` по действию пользователя.
- [ ] Новая редакция — новая версия. Утверждение/запуск связывается с конкретной
  версией и scope; позднее изменение Markdown не меняет утверждённый набор операций.
- [ ] Статусы `draft / ready / running / completed / failed / cancelled / stale`
  меняет host по фактическим событиям. Checkbox в тексте не подтверждает выполнение.
- [ ] Кнопки «Уточнить», «Пересобрать по свежим данным» и позднее «Перейти к
  выполнению». В Read only кнопки выполнения нет.
- [ ] Raw HTML, скрипты и внешние изображения не исполняются/не загружаются.
  Экспорт и Markdown-ссылки не становятся способом прочитать локальные файлы.

Пример содержимого диагностического плана:

```md
# Диагностика payment-worker

## Цель
Определить причину Pending без изменения ресурсов.

## Область
Текущий кластер, namespace backend, workload payment-worker.

| Проверка | Источник | Ожидаемый результат |
| --- | --- | --- |
| Причина scheduling | Pod conditions и Events | Конкретное ограничение |
| Доступность storage | PVC/PV status | Bound или причина задержки |

## Ограничения
Содержимое Secret недоступно. Логи ещё не запрашивались.

## Результат
Факты и ссылки на объекты, гипотезы, следующая разрешённая проверка.
```

## Развитие чата и сессий

Сейчас Zustand сохраняет messages и метаданные в localStorage, восстановленные
mode/phase сбрасываются в Read only + Plan. Native run/approval не восстанавливаются.
Сначала ввести retention/opt-out для чувствительных payloads и план миграции
существующего `kubiki.ai_conversations.v1`; не описывать текущий чат как memory-only.

- [ ] История сессий: названия, переименование, закрепление, архивирование,
  удаление, группировка по cluster/namespace и дата последней активности.
- [ ] Поиск: по заголовку и тексту, в текущем разговоре и по сохранённым сессиям,
  фильтры по scope/дате, подсветка и переход к сообщению.
- [ ] Локальное хранение через native storage, schema version и миграции.
  Выбрать SQLite на этом этапе; это встроенная БД, отдельного сервера не требуется.
  Политика retention и opt-out задаются до включения сохранения содержимого.
- [ ] Чувствительные tool outputs по умолчанию не сохранять. Provider credentials
  остаются в OS keyring, история и поисковый индекс их не содержат.
- [ ] Восстановление не продолжает run, approval или Action. Разговор открывается
  в Read only + Plan, старые evidence отмечены как исторические.
- [ ] Новое сообщение, редактирование/повтор запроса, branching от сообщения,
  остановка генерации, копирование и экспорт выбранной сессии в `.md`.
- [ ] Управление контекстом: что отправится модели, использованный бюджет,
  исключение источника, явное обновление evidence и контролируемая compaction.
  Сводка не расширяет права и не заменяет ссылки на исходные доказательства.
- [ ] Смена модели/провайдера показывает, какие данные могут попасть новому
  endpoint, и заново проверяет egress policy. Историю не пересылать автоматически.

## Действия и развёртывание — последующие этапы

После готовности диагностики, правил, Plan и чата развивать ограниченные операции
над существующими объектами: например, scale/restart, с точным review в Ask,
receipt и разрешённой проверкой результата. Общий mutation executor используется
и вручную, и агентом; подтверждения не переносятся между операциями или версиями плана.

**Последний этап:** создание ресурсов, сценарий «создай Nexus», multi-resource
планы, Helm/GitOps, preview/diff, preflight, зависимости, поэтапное применение и
проверка готовности. YAML generation остаётся предложением, пока host не выполнил
разрешённые операции. Частичное выполнение и неопределённый исход показываются
явно; универсальный автоматический rollback и replay после timeout не обещаются.

## Порядок реализации и критерии перехода

| Этап | Результат | Условие завершения |
| --- | --- | --- |
| P0. Достоверность | Policy parity, ошибки/полнота, per-kind health, baseline | Ноль запрещённых bodies/fields; partial/denied не выдаются за complete |
| P1. Экономные queries | Общий read service, fields/profiles, selectors/cursors, working scope и prompt | Нет лишних GET для разрешённого LIST, нет потерь страниц, корректное сужение scope |
| P2. Скорость | Bounded reads, discovery cache, deduplication, budgets | Число API calls/bytes/time ограничено; UI не голодает |
| P3. Масштаб и память | Агрегаты, informer reuse, evidence memory | Fixtures до 10000 Pods, stale-cache/cursor/compaction проверки |
| P4. Диагностическое качество | Связанные сценарии, verification, история metrics | Точность/evidence не ухудшаются; измерены latency/tokens относительно baseline |
| 5. Правила и планы | Профили, preview прав, версионированный PlanArtifact | Экспорт/план не обходят policy и не становятся approval |
| 6. Чат | Native history, retention, поиск, миграция localStorage | Восстановление безопасно; удаление охватывает историю, индекс и evidence |
| 7. Ограниченный Action | Укрепление существующих действий и verification | Права, approvals, cancellation и receipts проверены в гонках |
| 8. Создание и deployment | Приложения и цепочки ресурсов | Готовы предыдущие этапы и проверки частичного результата |

P0–P4 уточняют приоритет диагностической ветки. Уже существующие backend phase
checks сохраняются на каждом этапе; перенос в общий сервис идёт по семействам,
а не требует переписать все операции до первого улучшения. Существующие write
инструменты не считаются новым этапом разработки и не расширяются автоматически.

## Проверка, эксплуатация и сопровождение

- [ ] Сначала снять baseline: скорость UI и диагностики без AI и под его нагрузкой,
  число API-запросов, время до объяснения причины и token usage.
- [ ] Регрессионные сценарии общего подключения: cold start, TLS/auth, proxy,
  exec credentials, смена kubeconfig/context, reconnect и недоступный API server.
- [ ] Проверки прав на backend: ноль writes в Plan при любом access mode,
  ноль доступных Action в Read only, ноль запросов запрещённого content.
- [ ] Гонки: отзыв policy/смена фазы/Stop между подготовкой и dispatch,
  устаревший connection handle, поздний ответ модели и повтор approval.
- [ ] Диагностические fixtures содержат известную причину проблемы и ограничения
  доступа; оценивать точность, полноту evidence, ложные выводы и стоимость.
- [ ] UI-тесты проверяют Markdown-таблицы, карточку плана, поиск и восстановление,
  а также независимость разделов Explorer / Topology / AI.
- [ ] Обычные проверки используют fixtures и mock API; записи — только в отдельном
  тестовом кластере. Read-only shared cache не означает отсутствие нагрузки.
- [ ] Отказ AI/provider отключает run, обычные Kubernetes экраны продолжают работать.
  Отказ общего K8s доступа показывается пользователю и агенту согласованно.

Один репозиторий, один desktop-релиз. Desktop/core отвечает за общий Kubernetes
сервис и авторизацию, AI-домен — за provider loop и диалог, frontend — за навигацию
и представление. Закрепить эти границы в CODEOWNERS при его введении. Изменения
gateway/mutation policy требуют core review; отдельный сервис и on-call AI не нужны.

Миграция операций — по одному семейству за раз, с контрактными тестами старого и
нового маршрута; не запускать двойные production reads или writes ради сравнения.
Откат фичи скрывает/отключает новый AI-путь, не откатывает подключение и ручные
операции пользователя. Старый обход policy не использовать как fallback.

Цели качества: отсутствие обходов прав и неподтверждённых writes, отсутствие
регрессии подключения/UI относительно baseline, воспроизводимая диагностика с
измеримым качеством. Числовые latency/accuracy бюджеты назначить после измерений.
Для desktop delivery сравнивать с исходным состоянием frequency, lead time,
failed deployment recovery time, change fail rate и deployment rework rate;
отдельного AI deployment pipeline не создавать.

## Зафиксированные границы

Отдельное AI Kubernetes-ядро, agent kubeconfig, произвольный shell/HTTP к кластеру,
автоматическое исправление в фоне и multi-agent orchestration в этот план не входят.
Свой AI-домен остаётся логическим модулем существующего приложения.

Ориентир интерфейса фаз — разделение на фазы планирования (Plan) и исполнения (Action).
В Kubiki пользовательское имя исполняющей фазы — **Action**, стартовая фаза —
**Plan**; жёсткий backend запрет изменений в Plan задаётся требованиями Kubiki.
