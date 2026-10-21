# Панели ресурсов и контекстные меню: Kubiki и Lens

Проверено 2026-10-21. Сравнение описывает текущий рабочий каталог Kubiki, включая незакоммиченные изменения.

## Метод и границы проверки

В Kubiki проверены исходники обработчиков, IPC и 45 встроенных типов: для каждого в Chromium открыты подробности и меню строки. В браузере использовались синтетические GET fixtures, операции изменения не нажимались; ошибок страницы не было. Полный результат: [инвентаризация UI](audits/2026-10-21-resource-ui.json). Эта проверка подтверждает доступность представлений, а не исполнение каждой операции на настоящем кластере. Flux/Argo/Helm дополнительно проверены по коду; они не входят в эти 45 встроенных типов.

Для Lens использована официальная документация. Она описывает More Actions; не везде отдельно оговорено, что абсолютно тот же набор появляется по правой кнопке. Поэтому ниже сравниваются операции контекстного меню Kubiki с документированным меню действий Lens. Текущий бинарник Lens не запускался. Неподтверждённые поля и операции не считаются поддержанными только по аналогии с Kubernetes.

## Node shell и debug Pod

**Lens тоже создаёт служебный Pod.** В опубликованном [NodeShellSession Lens v6.5.2](https://github.com/lensapp/lens/blob/v6.5.2/packages/core/src/main/shell-session/node-shell-session/node-shell-session.ts) создаётся `node-shell-<uuid>` в `kube-system`, закреплённый за выбранной Node, с privileged/hostPID/hostIPC/hostNetwork; доступ к host namespaces получается через `nsenter`. После этого открывается exec, а при закрытии соединения запрашивается удаление Pod. Это проверенный исторический исходник. Актуальные [настройки кластера Lens](https://docs.lenshq.io/k8slens/cluster/cluster-settings/) также описывают Node Shell Image и image pull secret, но сами по себе не доказывают все детали реализации нынешнего бинарника.

В Kubiki helper `kubiki-node-debug-<uuid>` нужен только для **Node shell**: Kubernetes API не предоставляет обычный exec непосредственно в Node. Helper запускается на Linux-узле, privileged/root, с host PID/IPC/network и монтированием `/` → `/host`; терминал выполняет `chroot /host <shell>`. Namespace настраивается пользователем, по умолчанию берётся текущий или `default` при All Namespaces. Service account token не монтируется. Обычный **Pod shell** подключается к существующему контейнеру и новый Pod не создаёт.

По согласованному решению Node shell сохранён, поведение изменено:

1. Открытие панели, просмотр Node, скрытие/возвращение панели ничего не создают и не запускают подготовку.
2. Перед началом показаны Node/context, root/host-доступ, namespace, image и shell.
3. Только **Create helper Pod and connect** передаёт запрос в общий mutation gateway. Бэкенд проверяет Node UID/RBAC и требует системное подтверждение создания с manifest.
4. Reconnect и смена shell сначала показывают настройки. Новый helper создаётся только после **Create replacement Pod and connect** и нового native confirmation.
5. Удаление helper требует отдельного системного подтверждения, включая cleanup после exit/disconnect. Отказ или закрытое окно могут оставить Pod; есть Other debug Pods/Retry cleanup. `activeDeadlineSeconds=3600` останавливает контейнер, но не удаляет объект Pod.

Код: [NodeShellPane](../src/components/k8s/NodeShellPane.tsx), [backend lifecycle](../crates/kubiki-core/src/pod_ops/node_debug.rs), [единый gateway](../src-tauri/src/mutation_commands.rs). Границы подтверждения команд внутри интерактивного терминала описаны в [mutation safety](22-MUTATION-SAFETY.md).

## Общая панель подробностей

| Возможность | Lens | Kubiki / результат |
|---|---|---|
| Общие действия сверху | Copy name, Edit, Delete | Copy as…, Logs/Shell/Ports по типу, Topology. Редактирование через вкладку YAML; прямого Delete в заголовке K8s-подробностей нет |
| Специфика типа | Дополнительные действия и данные ресурса | Общий `DetailsPanel` + `ResourceHeader`, содержимое выбирает `ResourceDetailsRouter`; Helm использует тот же каркас с собственными вкладками/действиями |
| Переходы между объектами | Подробности выбранного объекта | Owner breadcrumbs, Related, переходы по ссылкам, история Back с целевым объектом, открытие в отдельной вкладке, закрепление на Overview |
| Редактор | Advanced editor предлагает side-by-side diff и revert; функция зависит от платного плана | Clean YAML по умолчанию, показ служебных полей, поиск/форматирование/revert, сохранение через backend consent. Side-by-side diff текущих изменений отсутствует |

Основания Lens: [Details panel](https://docs.lenshq.io/k8slens/using-lens/details-panel/), [Advanced editor](https://docs.lenshq.io/k8slens/using-lens/advanced-editor/). Различие размещения кнопок само по себе не означает отсутствия операции: YAML edit в Kubiki работает, хотя отдельной кнопки Edit в заголовке нет.

## Подробности по семействам

| Ресурс | Что есть в Kubiki | Отличия, недостатки и проверенные ориентиры Lens |
|---|---|---|
| Pod | App/init/ephemeral containers, env/mounts/probes/limits, volumes и ссылки на Secret/ConfigMap/PVC, conditions, metrics, logs/shell/ports | Нет Attach/Evict/Share resource link. В Lens также документирована отдельная секция Resource Claims для DRA; в Kubiki DRA есть в каталоге/связях, но такого блока Pod нет. [Lens Pods](https://docs.lenshq.io/k8slens/using-lens/workloads/pods/) |
| Deployment / StatefulSet | Реплики/rollout, template containers, child Pods, conditions; рабочий scale через gateway; Deployment revision history | Live restart не подключён. Logs/Shell шаблона маршрутизируются неверно — см. находку A1. Rollback Deployment — уведомление-заглушка A2. [Lens Deployment](https://docs.lenshq.io/k8slens/using-lens/workloads/deployments/), [StatefulSet](https://docs.lenshq.io/k8slens/using-lens/workloads/stateful-sets/) |
| DaemonSet / ReplicaSet / ReplicationController | Workload details, шаблон, child Pods, conditions | Нет рабочего live restart для DaemonSet; scale есть только для Deployment/StatefulSet. В Lens у ReplicaSet документированы Scale/Logs. [Lens DaemonSet](https://docs.lenshq.io/k8slens/using-lens/workloads/daemon-sets/), [ReplicaSet](https://docs.lenshq.io/k8slens/using-lens/workloads/replica-sets/) |
| Job / CronJob | Состояние выполнения/расписание/длительность, шаблон, child Pods для Job; Run Now у CronJob создаёт Job через gateway | У CronJob нет отдельного Suspend/Resume; Run Now отсутствует в ПКМ. Logs/Shell шаблона имеют ошибку A1. У Lens документированы Job Logs и CronJob Trigger/Suspend. [Jobs](https://docs.lenshq.io/k8slens/using-lens/workloads/jobs/), [CronJobs](https://docs.lenshq.io/k8slens/using-lens/workloads/cron-jobs/) |
| Node | Capacity/allocatable, система, taints, conditions, metrics, управляемый Node shell | Нет Cordon/Drain; нет отдельного Devices-блока Node, описанного Lens для DRA. [Lens Nodes](https://docs.lenshq.io/k8slens/using-lens/nodes/) |
| Service | Type/IP/DNS/traffic/session affinity, ports, EndpointSlices и их readiness, selector Pods, ссылки, port-forward | Port-forward подключён к настоящему backend, не является toast-заглушкой. Поддерживает TCP и Services с selector; неподдержанные цели блокируются с объяснением. [Lens Services](https://docs.lenshq.io/k8slens/using-lens/network/services/) |
| Ingress | Rules, backend Services, TLS Secret links, metadata/conditions | Есть предметная панель. Точный паритет всех полей Lens по документации не установлен. [Lens Ingress](https://docs.lenshq.io/k8slens/using-lens/network/ingresses/) |
| Secret | Маскирование, text/base64/binary, immutable, защита устаревшего draft, backend confirmation, Used by | Полезные прикладные действия реализованы. Used by ограничен загруженным scope и поддержанными типами ссылок; отсутствие результата не доказывает отсутствие потребителей во всём кластере. [Lens Secrets](https://docs.lenshq.io/k8slens/using-lens/config/secrets/) |
| ConfigMap | Поиск/копирование/редактирование data, immutable/stale draft checks, Used by | Restart consumers сейчас только показывает уведомление A3. [Lens ConfigMaps](https://docs.lenshq.io/k8slens/using-lens/config/config-maps/) |
| PVC / PV / StorageClass | PVC: capacity/accessModes/class/volume links/conditions; StorageClass: spec и consumers | PV ошибочно использует PVC-компонент: capacity берётся не из `spec.capacity`, нет отдельного обзора claimRef/reclaimPolicy/CSI A4. Lens различает PV/PVC. [Lens PVC](https://docs.lenshq.io/k8slens/using-lens/storage/persistent-volume-claims/), [PV](https://docs.lenshq.io/k8slens/using-lens/storage/persistent-volumes/) |
| HPA / quota / limits / PDB | Summary и структурированные поля, metrics/target/behavior для HPA, conditions/Related/YAML | HPA присутствует. Часть вложенных конфигураций читается как structured fields, а не специализированные таблицы. Документация Lens подтверждает отдельный HPA view, но не полный паритет деталей. [Lens HPA](https://docs.lenshq.io/k8slens/using-lens/config/horizontal-pod-autoscalers/) |
| RBAC / ServiceAccount / Namespace / CRD | Spec, роли/subjects и потребители, CRD instances, переходы на загруженные объекты | Пользователи/группы в binding — идентичности, а не K8s-объекты для открытия. Related/Used by зависят от scope. У Event Used by отсутствует |
| NetworkPolicy / EndpointSlice / classes / admission / DRA | Общий каркас, предметные summary/structured sections, условия и связи | Наличие типа и YAML не означает такой же удобный предметный экран, как специализированный Pod/Service. Перечень всех 45 типов — ниже |
| Helm | Overview/history/values/manifest/notes, документы ревизий, restore из history, upgrade/rollback/uninstall через prepared backend plan | Это рабочие операции, в отличие от Rollback Deployment. UI каркас переиспользуется, но вычисление доступности действий в details и ПКМ задано отдельно. [Lens Helm](https://docs.lenshq.io/k8slens/using-lens/helm/releases/) |
| Flux | Отдельные группы CRD, status/conditions, source/revision/config, managed resources и ссылки | Lens документирует health dashboard, attention/events, source/workload cross-links и commit navigation. В Kubiki нет сопоставимого dashboard; часть ссылок показывается как текст. Наличие Reconcile-кнопки в Lens по этой документации не установлено. [Lens Flux](https://docs.lenshq.io/k8slens/flux-cd/using-flux-cd/) |
| Argo CD | Application/ApplicationSet/AppProject, sync/health, source/destination/policies, managed resources | Нет Sync/Refresh Normal/Hard, массовых операций, полноценного dashboard и перехода в Argo UI через service port-forward. Всё это описано у Lens в платной интеграции. [Lens Argo CD](https://docs.lenshq.io/k8slens/argo-cd/using-argo-cd/) |

## Контекстное меню строки

Общий набор Kubiki: View in Inspector; Inspect YAML (Side Panel); Open in Dedicated Tab; Open YAML Editor Tab; Open YAML in Split Right; Copy name; Delete. У custom resources Delete сейчас **disabled**, хотя backend умеет безопасное удаление custom GVK. В browser запись всё равно запрещена транспортом; доступная кнопка не равна разрешённой сервером операции.

| Тип | Добавочные пункты Kubiki по ПКМ | Документированные действия Lens / разница |
|---|---|---|
| Pod | Logs и Terminal в drawer/full tab, Port-forward | Lens: Show Details, Attach, Shell, Evict, Share, Logs, Edit, Delete. Не хватает Attach/Evict/Share; в Kubiki много отдельных пунктов выбора места открытия |
| Node | Node Shell in Bottom Drawer | Lens: Shell, Cordon, Drain, Edit, Delete. Cordon/Drain отсутствуют |
| Deployment / StatefulSet | Scale replicas; Restart rollout (demo), отключён в live | Lens: Scale, Restart, Logs, Edit, Delete. Logs в ПКМ Kubiki отсутствует, live Restart отсутствует |
| DaemonSet | Restart rollout (demo), отключён в live | Lens: Restart, Logs, Edit, Delete. Оба оперативных live-действия не предоставлены в ПКМ Kubiki |
| ReplicaSet | Только общие пункты | Lens: Scale, Logs, Edit, Delete. Scale/Logs в ПКМ Kubiki отсутствуют |
| Job | Rerun job (demo), отключён в live | Lens: Logs, Edit, Delete. Rerun не засчитывается как рабочая функция и не приписывается Lens |
| CronJob | Только общие пункты | Lens: Trigger, Suspend, Edit, Delete. В Kubiki Trigger есть только как Run Now в details; Suspend нет |
| Service | Port-forward | Дополняет общие Edit/Delete; реальный backend имеется |
| Остальные K8s | Только общие пункты | Для ресурсов без оперативных действий главная разница — размещение Edit/Delete и предметность details |
| Custom / Flux / Argo | Общие пункты, Delete отключён | У Argo в Lens есть Sync/Refresh. В Kubiki нет соответствующих операций и специализированного меню GitOps |
| Helm release | Inspect release, Open Helm topology, Upgrade, Rollback, Uninstall | Основные действия соответствуют Lens; код меню отдельный от K8s `buildRowMenu` |

Основания строк Lens — ссылки соответствующих типов в предыдущей таблице. **Topology** есть в заголовке K8s-подробностей, но отсутствует в K8s ПКМ; Helm имеет отдельный Open Helm topology. Условие показа операций независимо задано в заголовке, body и `buildRowMenu`, поэтому сейчас они расходятся.

## Подтверждённые проблемы и порядок исправления

Здесь перечислены оставшиеся проблемы, **не исправленные изменением Node shell**.

### A1. Высокий приоритет: неверная цель Logs/Shell у workload

[InspectorPanel](../src/components/layout/InspectorPanel.tsx) передаёт `item.name` в `openLogs/openTerminal` и для Deployment/Job/template containers. [dock_store](../src/state/dock_store.ts) разрешает это имя среди **Pod**, не выбирая Pod по controller UID. Поэтому Deployment `web` пытается открыть Pod `web`, а не `web-<replicaset>-<suffix>`. Обычно это ошибка подключения, но одноимённый посторонний Pod в том же namespace может стать ошибочной целью. Проверено по обработчикам; интерактивный exec на реальном кластере для доказательства не запускался.

Исправление: выбирать реальные дочерние Pods по цепочке owner UID, показывать выбор Pod/container, сохранять точный ResourceRef/UID; logs для workload — явный выбор или агрегация с обозначением источника. Для CronJob сначала выбирать Job/Pod, а не использовать имя CronJob как Pod.

### A2/A3. Высокий приоритет: ложное сообщение об операции

[RevisionHistoryBlock.rollback](../src/components/k8s/details/blocks/RevisionHistoryBlock.tsx) вызывает только `toast.info('Rollback requested', …)`. [UsedByList.restartConsumers](../src/components/k8s/details/blocks/UsedByList.tsx) вызывает только уведомление с текстом `Rolling restart scheduled`. Никакого запроса записи за ними нет. Показ успешного планирования вводит в заблуждение.

Исправление: до подключения backend отключить действие с понятной причиной; затем реализовать через общий mutation gateway, native review и обработку реального результата. Это **не** относится к рабочему Helm rollback.

### A4. Средний приоритет: PV отображается как PVC

[ResourceDetailsRouter](../src/components/k8s/details/ResourceDetailsRouter.tsx) направляет оба типа в [PvcDetails](../src/components/k8s/details/kinds/PvcDetails.tsx). `actualCapacity` читается из `status.capacity.storage`, requested — из `spec.resources.requests.storage`; у PV размер находится в `spec.capacity.storage`. Заголовки Storage Claim и Persistent Volume/unbound также не соответствуют PV.

Исправление: отдельная предметная конфигурация PV внутри общего каркаса: capacity, claimRef, reclaim policy, storageClass, volume mode, CSI/source, node affinity, conditions.

### A5. Средний приоритет: несколько независимых моделей UI-действий

Разный набор/доступность операций в ResourceHeader, kind details, `ResourceView.buildRowMenu` и Helm. Scale в меню ограничивается 64, в подробностях — 1000, backend — 100000. Это не обход backend validation, но поведение непоследовательно.

Исправление: общий каталог UI actions с `supports`, `enabled`, `disabledReason` и одним обработчиком. Header и ПКМ используют его, а навигация/место открытия остаются параметрами. Backend gateway остаётся единственной точкой записи и подтверждения.

### A6. Средний приоритет: дублирующее чтение metrics

`MetricsGaugeBar` в Pod/Node details независимо вызывает `useOverviewMetrics`. Хук хранит cache, но каждый mount запускает собственный polling без объединения in-flight запросов. Pod details читает все Pod metrics своего namespace, Node details — Pod+Node metrics всего кластера. Несколько деталей и Overview могут дублировать запросы каждые 15 секунд. См. дополненный [отчёт нагрузки](25-KUBERNETES-API-LOAD.md).

Исправление: общий metrics transport/cache по context/scope с подписчиками, пауза скрытых панелей и более узкие запросы, где возможно. Обычные resource watch при этом уже переиспользуются.

## Что проверено после изменения Node shell

`tests/e2e/node_shell.spec.ts` покрывает отсутствие подготовки при открытии/возвращении панели; создание по явной кнопке; UID/context/namespace/image; ввод в терминал; просмотр настройки перед reconnect/сменой shell; отмену native confirmation без helper/exec/retry; поздний readiness после отмены; отказ прав; повтор cleanup и удаление orphan по UID. IPC замокан, поэтому это не проверка отображения настоящего OS-диалога. Настоящие Pod/Node изменения в пользовательском кластере для этой задачи не выполняются.

Итоговый прогон: **16 E2E прошли** (`node_shell`, `pod_exec`, `host_terminal`), **277 unit tests прошли** в 40 файлах; `pnpm build` (три TypeScript-конфигурации и Vite production build) завершился успешно. В старых regression fixtures исправлены явный переход в Pods, область поиска кнопки, закрытие перекрывающего Inspector перед проверкой узкого terminal layout и моделирование постоянной ошибки shell metadata до ручного retry. Экран перед созданием Node helper проверен при ширине окна 900 px; `node-shell-review.png` сохраняется в test-results.

## Инвентаризация встроенных типов

Во всех 45 случаях открылись Overview и контекстное меню; в заголовке доступны вкладки Related/Events/YAML. Само наличие вкладок не является проверкой их сценариев для каждого типа. Таблица показывает renderer, а не обещает полный паритет предметных полей Lens. Structured sections появляются при наличии соответствующих данных; пустой синтетический fixture их может не содержать.

| Тип | Содержимое Overview |
|---|---|
| Pod | PodDetails |
| Deployment | WorkloadDetails |
| ReplicaSet | WorkloadDetails |
| StatefulSet | WorkloadDetails |
| DaemonSet | WorkloadDetails |
| Job | JobDetails |
| CronJob | JobDetails |
| Service | ServiceDetails |
| Ingress | IngressDetails |
| ConfigMap | ConfigMapDetails |
| Secret | SecretDetails + единый SecretDataEditor |
| PersistentVolumeClaim | PvcDetails |
| PersistentVolume | PvcDetails — проблема A4 |
| StorageClass | GenericResourceDetails |
| Node | NodeDetails |
| Namespace | GenericResourceDetails |
| Event | GenericResourceDetails, без Used by |
| CustomResourceDefinition | GenericResourceDetails + instances |
| ServiceAccount | GenericResourceDetails |
| Role | GenericResourceDetails |
| RoleBinding | GenericResourceDetails |
| ClusterRole | GenericResourceDetails |
| ClusterRoleBinding | GenericResourceDetails |
| Endpoints | ExtendedResourceDetails |
| ReplicationController | WorkloadDetails |
| ResourceQuota | ExtendedResourceDetails |
| LimitRange | ExtendedResourceDetails |
| HorizontalPodAutoscaler | ExtendedResourceDetails |
| PodDisruptionBudget | ExtendedResourceDetails |
| IngressClass | ExtendedResourceDetails |
| NetworkPolicy | ExtendedResourceDetails |
| EndpointSlice | ExtendedResourceDetails |
| PriorityClass | ExtendedResourceDetails |
| RuntimeClass | ExtendedResourceDetails |
| Lease | ExtendedResourceDetails |
| MutatingWebhookConfiguration | ExtendedResourceDetails |
| ValidatingWebhookConfiguration | ExtendedResourceDetails |
| ValidatingAdmissionPolicy | ExtendedResourceDetails |
| ValidatingAdmissionPolicyBinding | ExtendedResourceDetails |
| MutatingAdmissionPolicy | ExtendedResourceDetails |
| MutatingAdmissionPolicyBinding | ExtendedResourceDetails |
| DeviceClass | ExtendedResourceDetails |
| ResourceClaim | ExtendedResourceDetails |
| ResourceClaimTemplate | ExtendedResourceDetails |
| ResourceSlice | ExtendedResourceDetails |
