# Спецификация функциональности Kubernetes в Kubiki

> Примечание аудита 2026-10-20: это целевая спецификация, а не список готовых возможностей. Фактическая матрица: [08-UX-TECHNICAL-AUDIT.md](08-UX-TECHNICAL-AUDIT.md).


> **Проект:** Kubiki — K8s Desktop IDE  
> **Статус:** Техническая спецификация поддержки объектов и операций  
> **Дата:** 2026-10-19

---

## 1. Матрица поддерживаемых объектов Kubernetes

Цель Kubiki — поддержка перечисленных ниже стандартных ресурсов, динамических CRD и Helm. Реализованное подмножество отражено в актуальном аудите.

### 1.1. Workloads (Рабочие нагрузки)
- **Pods (`v1`):** View, Logs, Exec Shell, Port Forward, Delete, Evict, Edit YAML, Describe.
- **Deployments (`apps/v1`):** Scale replicas, Restart (rollout restart), Rollback revision, Edit YAML, View Pods, Pause/Resume.
- **StatefulSets (`apps/v1`):** Scale, Restart, Edit YAML, View PVCs, View Pods.
- **DaemonSets (`apps/v1`):** Restart, Edit YAML, View Pods, Node selector.
- **ReplicaSets (`apps/v1`):** Scale, Edit YAML, View Owner Deployment.
- **Jobs (`batch/v1`):** Trigger rerun, Delete, View Logs of Pods, Stop (terminate).
- **CronJobs (`batch/v1`):** Trigger immediate Job run, Suspend / Resume, Edit Schedule, View History.

### 1.2. Configuration & Storage
- **ConfigMaps (`v1`):** Просмотр и редактирование ключ-значение (с подсветкой синтаксиса вложенных файлов `.properties`, `.yaml`, `.json`), экспорт.
- **Secrets (`v1`):** Безопасный просмотр (маскирование значений `******` с кнопкой "Показать/Скопировать"), Base64 автодекодирование/кодирование при сохранении, типы (Opaque, TLS, docker-registry).
- **PersistentVolumeClaims (`v1`):** Статус (Bound/Lost/Pending), емкость, StorageClass, примонтированные Pods.
- **PersistentVolumes (`v1`):** Reclaim Policy, Access Modes, Capacity, Source (CSI, NFS, HostPath).
- **StorageClasses (`storage.k8s.io/v1`):** Provisioner, ReclaimPolicy, VolumeBindingMode, AllowVolumeExpansion.
- **HorizontalPodAutoscalers (`autoscaling/v2`):** Текущие метрики vs Target (CPU%, Mem%), Min/Max replicas.
- **ResourceQuotas & Limits (`v1`):** Визуальные прогресс-бары использования квот CPU/Memory/Storage.

### 1.3. Networking
- **Services (`v1`):** Порт-маппинг, Type (ClusterIP, NodePort, LoadBalancer, ExternalName), External IP, Endpoints, кнопка быстрого Port Forward.
- **Ingresses (`networking.k8s.io/v1`):** Визуализация правил маршрутизации (Hosts, Paths, Backend Services), TLS сертификаты, кликабельные ссылки на домены.
- **IngressClasses (`networking.k8s.io/v1`):** Controller, Parameters, Default статус.
- **NetworkPolicies (`networking.k8s.io/v1`):** Визуальный граф Ingress/Egress правил разрешенного/запрещенного трафика.
- **Endpoints & Slices (`discovery.k8s.io/v1`):** Просмотр активных IP-адресов и портов бэкенд-подов.

### 1.4. Access Control (RBAC)
- **ServiceAccounts (`v1`):** Привязанные Secrets/Tokens, связанные роли.
- **Roles & ClusterRoles (`rbac.authorization.k8s.io/v1`):** Матрица разрешений: API Groups ✕ Resources ✕ Verbs (get, list, watch, create, delete...).
- **RoleBindings / ClusterRoleBindings (`rbac.authorization.k8s.io/v1`):** Связи субъектов (Users, Groups, ServiceAccounts) с Roles.

### 1.5. Cluster & Infrastructure
- **Nodes (`v1`):** Загрузка CPU/Memory (графики), Taints & Tolerations, Node Conditions (Ready, DiskPressure), Cordon / Uncordon, Drain ноды.
- **Namespaces (`v1`):** Создание, удаление, просмотр лимитов, быстрый переключатель в шапке.
- **Events (`v1` / `events.k8s.io/v1`):** Лента событий кластера с подсветкой Warning/Error, фильтром по ресурсам и времени.
- **CRDs (`apiextensions.k8s.io/v1`):** Полный каталог установленных Custom Resource Definitions с версионированием.

---

## 2. Спецификация динамических CRD (Custom Resources)
1. **Дискавери CRD:** Чтение списка `CustomResourceDefinition`, группировка по API Group.
2. **Определение колонок (Printer Columns):** Парсинг `spec.versions[].additionalPrinterColumns` и извлечение JSONPath выражений.
3. **Генерация схем:** Извлечение `spec.versions[].schema.openAPIV3Schema` и передача в Monaco Editor.

---

## 3. Спецификация интерактивных подсистем
- **Pod Logs Streaming:** `kube::api::Api<Pod>::log_stream()`, multi-container выбор, `previous: true`, полнотекстовый regex-поиск, экспорт.
- **Pod Interactive Shell (Exec):** `kube::api::AttachedProcess` через WebSocket (`v4.channel.k8s.io`), автоопределение `/bin/bash` -> `/bin/sh`, обработка resize.
- **Port Forwarding:** `kube::api::Portforwarder` + Tokio `TcpListener` на `127.0.0.1`, статистика байт, клик для открытия в браузере.
- **Helm 3:** Управление репозиториями, поиск чартов, инспекция релизов, установка/обновление с редактированием `values.yaml` в Monaco Editor, rollback в один клик.
- **Метрики:** Metrics Server (`metrics.k8s.io/v1beta1`) + автообнаружение Prometheus для построения графиков истории.
