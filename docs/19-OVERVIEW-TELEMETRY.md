# Overview: CPU/RAM telemetry dashboard

Статус: UX-18 / DOMAIN-02A DONE. Перезапустить `pnpm tauri dev` для регистрации нового IPC. Overview → Compute & memory. Сводка следует глобальному cluster/namespace picker.

## Данные и смысл величин

Desktop: `get_overview_metrics(context, namespace)` → клиент пула → MetricsService. Browser dev: GET `/api/k8s/metrics` → kubectl `get --raw`. Чтение Metrics API `metrics.k8s.io/v1beta1`; Kubernetes resource watches остаются прежними. Pod и Node источники независимы: 403 одного не скрывает другой. Namespace запрашивает только свой PodMetrics endpoint, NodeMetrics не читает. Scope/context проверяются на обеих сторонах.

Cluster CPU/RAM usage агрегируется по NodeMetrics и включает процессы ноды; namespace usage — по PodMetrics выбранного namespace. Карточки не подменяют эти источники друг другом. CPU — средняя загрузка в cores по окну API, RAM — memory working set. Pod/контейнеры показаны отдельно в Resource consumers, с сортировкой CPU/RAM, выбором строки, деталями каждого измеренного контейнера и переходом в объект.

Capacity и allocatable читаются раздельно из Node.status. Процент cluster gauge = node usage / allocatable, namespace gauge = Pod usage / полные настроенные limits. При неполном покрытии, неизвестной ёмкости или unbounded limits процент не выдумывается. Показывается количество измеренных nodes/active Pods; сумма частичных измерений не означает полное покрытие. `Allocatable − usage` — арифметическая разность, а не показатель free RAM ОС.

Configured requests/limits рассчитываются из активных Pods; завершённые исключены. Учтены default requests из limits, порядок restartable init sidecars, максимумы обычных init, Pod-level resources и overhead. Requests включают Pending/unscheduled Pods: это настроенные требования, а не фактическая резервация scheduler. Текущие allocated/actuated значения при in-place resize отдельно не моделируются. Отсутствующие/нулевые limits обозначаются unbounded; overcommitted limits могут превышать allocatable. Некорректная/отсутствующая quantity не превращается в ноль. Поддержаны nano/micro/milli, decimal/binary suffix и exponent notation.

Metrics API не всегда содержит UID исходного Pod: сопоставление namespace/name с текущими объектами дополнено проверкой timestamp против creationTimestamp. Это защита от явно старого измерения после recreation, не атомарная гарантия identity между API-запросами.

## История, ошибки и производительность

Опрос каждые 15 секунд после завершения предыдущего запроса; кнопка Refresh metrics повторяет чтение явно. Namespace/context change, unmount и hidden document прекращают polling/отменяют browser fetch; поздние результаты отбрасываются. Native RPC ограничен timeout: клиентский abort не прерывает уже отправленный IPC, backend API calls ограничены 15 секундами, весь command — 20.

История только за время наблюдения: максимум 120 реальных source samples / 30 минут, окна 5/15/30 минут; пока данных мало, ось охватывает уже накопленный интервал. Одинаковые/старые timestamps не добавляются. Разрывы более 45 секунд не соединяются линией. Кэш в памяти ограничен 4 scope, после закрытия приложения истории нет. Prometheus/historical backfill пока не подключён. Demo явно помечен: usage и стартовая история симулированы только там.

404/403/503/malformed/timeout показываются с причиной. Успешно прочитанные старые значения сохраняются, но отмечаются stale; образцы старше 2 минут или с future clock skew не добавляются в историю. Недоступное usage — `—`, не фальшивый ноль. Пустой источник при известном пустом scope может дать настоящий ноль. История накопленных partial samples описывает измеренную часть; coverage всегда виден.

Графики — небольшие SVG, без новых chart dependencies и непрерывного animation loop. Gauge/mini bars переходят за 180 мс, цифры анимируются локально с RAF и cleanup; `prefers-reduced-motion` отключает движение. Hover chart не пересчитывает общую статистику; Events updates не пересоздают массивы Pod/Node для CPU-бюджетов. Таблица потребителей рендерит первые 10, Show next добавляет по 20, внутренний scroll ограничен. Graphics flags/topology renderer не менялись.

## Проверка и оставшиеся задачи

Unit/contract: quantity conversion, effective Pod resources, scope/recreation/freshness/coverage, capacity vs allocatable, bounded history, malformed sources, HTTP/native identity и HTTP namespace/RBAC isolation. Rust local HTTP: namespace endpoint, отсутствие Node запроса в namespace, независимый 403, missing quantities/invalid scope. Browser: usage/budgets/history/hover/sort/container detail, responsive scope, unavailable usage, late response, pause/resume/unmount polling. Полные числа — в журнале 07.

Read-only smoke в context `default`: Metrics API отдал 3 Node samples и 2 Pod samples в `chaos-lab`; Rust CLI MetricsService прочитал 3 Node / 17 Pod samples всего кластера. Содержимое не печаталось, только количества/валидность времени; ресурсов не меняли. Это не измерение FPS в native GUI.

Открыто: native GUI/cross-platform animation/FPS и большие кластеры, credential/proxy edge cases, Prometheus/длительная история, quotas, allocations при in-place resize, Metrics API streaming/discovery и Helm UI. DOMAIN-02 целиком PARTIAL.

Основания: [Kubernetes Metrics API](https://kubernetes.io/docs/reference/external-api/metrics.v1beta1/), [Resource metrics pipeline](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/), [Resource management](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/), [официальный resource helper](https://github.com/kubernetes/component-helpers/blob/master/resource/helpers.go).
