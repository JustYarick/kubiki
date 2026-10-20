# Cluster / Namespace Overview

Статус: UX-17 DONE. Открывается через Overview в Cluster Explorer, «+» у вкладок → Overview или команду Open Overview. Для нового workspace добавлена стандартная вкладка; существующий workspace открывает её через навигацию. Повторное открытие активирует ту же вкладку. Начальная активная Pods сохранена.

## Область и содержимое

Overview следует за глобальным cluster context и namespace picker рядом с кластером. All Namespaces показывает весь доступный кластер; конкретный namespace — только его namespaced ресурсы. Отдельного namespace picker на dashboard нет. Cluster-scoped Nodes/Namespaces/PV/StorageClass/CRD не включаются в namespace-сводку.

- Карточки: Pods, Workloads, Services, cumulative container restarts; в cluster scope дополнительно Nodes/Ready и Namespaces.
- Workloads = Deployment + StatefulSet + DaemonSet + Job + CronJob. ReplicaSet виден в inventory, но не дублирует workload count.
- Pod phases: Running/Pending/Succeeded/Failed/Terminating/Unknown, численные значения и пропорциональная полоса. Completed отображается как Succeeded; текущая deletionTimestamp имеет приоритет.
- Restarts учитывает application/init/ephemeral container statuses; fallback — нормализованный Pod restart count.
- Detected issues использует общие resource diagnostics, сортирует ошибки перед предупреждениями и показывает первые 10 объектов с переходом в details. Это обнаруженные проблемы в доступных данных, не гарантия здоровья недоступных объектов. Warning Events считаются отдельно.
- Resource inventory: counts загруженных встроенных kinds и переход к спискам. Общая сумма не включает Event. Произвольные custom instances пока не загружаются; отсутствующие kinds не подразумеваются в total.

Overview не запрашивает дополнительные списки и не создаёт дополнительных watch subscriptions. Desktop обновляется из существующих atomic watch commits; browser показывает snapshots, обновляемые Sync. При смене namespace/context watch snapshot должен покрывать выбранную область; старый snapshot другой области не участвует в статистике.

## Частичные данные и ограничения

Первичная загрузка/403/отсутствие snapshot показываются как `—`, а не ноль. При reconnect/ошибке с сохранённым snapshot counts остаются видимыми с явным stale/partial warning. Раскрываемый блок показывает недоступные kinds и причины. Пустой успешно загруженный namespace показывает настоящие нули. Connected описывает соединение, а не доступность каждого kind.

CPU/RAM usage, история, Metrics API/Prometheus, quotas/requests/limits не подключены в этом блоке. В UI явно указана недоступность usage metrics; DOMAIN-02 остаётся TODO. Dashboard агрегирует только уже доступные resource snapshots. Дополнительные live/native GUI и большие кластеры проверяются отдельной приёмкой; виртуализация и lazy subscriptions не закрыты этой задачей.

## Проверки

5 unit tests: cluster/namespace boundaries, phases/restarts/workloads, Events вне object totals, empty namespace, unavailable/stale/loading, namespace/context coverage watch и deduplication вкладки. Browser: scope switch, refresh, navigation, reload persistence, 403/empty/narrow pane; native IPC mock проверяет live phase/issue updates, stale reconnect, authoritative empty snapshot и неизменные 18 subscriptions. Результат общего прогона записан в [07](07-UI-PROGRESS.md).
