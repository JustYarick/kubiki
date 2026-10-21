# Централизованное подтверждение изменений Kubernetes

Обновлено 2026-10-21.

## Граница записи

Renderer передаёт намерение через два зарегистрированных IPC-входа в `src-tauri/src/mutation_commands.rs`:

- `mutate_resource`: YAML create/update, scale, Secret data, Helm install/upgrade/rollback/uninstall и repositories, создание node-debug helper.
- `delete_resource`: удаление одного Kubernetes объекта или оставшегося debug Pod.

Старые IPC `apply_manifest`, `scale_workload`, `update_secret_data`, `mutate_helm`, `prepare_node_debug`, `remove_other_debug_pod` больше не зарегистрированы. В read-командах нет kubectl write helper. Неиспользуемые прямые mutating wrappers старого HelmClient удалены. Frontend использует `src/providers/mutations.ts`; HTTP bridge остаётся read-only и отвергает POST даже с поддельными approval flags. Demo меняет только память.

Запросы типизированы, неизвестные операции/поля отвергаются serde. Renderer не задаёт текст системного диалога, approval token или `confirmed: true`. JS permissions не предоставляют dialog plugin. Это защита от ошибок интерфейса; доверенный native backend и ОС входят в границу доверия.

## Проверка и подтверждение

1. Общий `MutationGuard` через try-lock блокирует параллельные команды записи на время подготовки, диалога и commit. Повторный клик получает Conflict, запрос не ставится в очередь.
2. Rust проверяет context, GVK, scope, имя, UID/resourceVersion и payload. Для custom resources точные plural и scope определяются через API discovery; URI нельзя передать с клиента. Только отдельные именованные объекты: без delete collection, force, subresource, YAML List или нескольких YAML-документов.
3. `PreparedMutation` читает серверный объект. Для существующего объекта обязательны совпадающие UID и resourceVersion. Отсутствующий редактируемый объект не пересоздаётся.
4. Backend формирует review: context, namespace, kind/name, UID, resourceVersion и изменения BEFORE/AFTER. Для удаления — metadata, finalizers, ownerReferences и предупреждение о каскадном удалении; для Namespace/CRD — отдельное предупреждение о содержимом. Слишком большой review (>24 000 символов) отвергается целиком.
5. Системный диалог получает неизменяемую копию review. На Linux это modal GTK окно с прокручиваемым literal text и Cancel по умолчанию; Windows/macOS используют native dialog plugin. Cancel, Escape/закрытие, ошибка диалога или отсутствие родительского окна не разрешают запись.
6. Подтверждение действует 120 секунд и однократно потребляет подготовленный payload. После согласия повторный GET проверяет UID/resourceVersion. Изменившийся объект требует нового review; автоматического rebase/повторного commit нет.
7. Последняя запись также условная: UPDATE — PUT с UID/resourceVersion; scale — узкий merge patch с UID/resourceVersion; DELETE — UID+resourceVersion preconditions и Background propagation. CREATE — POST, который не перезаписывает объект, появившийся между финальным GET и commit.
8. Сетевые вызовы ограничены таймаутом. Записи никогда не ретраятся автоматически, включая неизвестный результат после timeout. Для повторного действия нужны refresh и новое подтверждение.

YAML из редактора передаётся вместе с отдельной исходной идентичностью: изменение имени, namespace, API, UID или resourceVersion внутри текста не перенаправляет сохранение. Сохраняется полный объект; server-owned status, managedFields и creationTimestamp восстанавливаются из актуального GET. Поля ConfigMap и finalizers редактируются через тот же путь с полным исходным manifest и preconditions. Изменение finalizers или controller spec может инициировать удаления со стороны Kubernetes; review предупреждает об этом.

## Helm, debug Pod и терминалы

Helm использует тот же вход и native guard, но собственный prepared plan: замороженные chart/values, server dry-run, review rendered changes/hooks и проверка release revision до исполнения. Helm CLI не предоставляет атомарный compare-and-swap с внешними Helm клиентами; проверки сужают окно гонки, не делают эту операцию транзакцией Kubernetes.

Открытие Node shell не запускает подготовку helper. Экран объясняет root/host-доступ и показывает context/Node, namespace, image и shell; только кнопка Create передаёт запрос в gateway и вызывает native review создания. Reconnect/смена shell сначала открывают настройки замены, без автоматического создания.

Каждое удаление управляемого node-debug Pod теперь требует отдельного native review. Согласие на создание helper не разрешает его последующую очистку. Завершение exec/закрытие терминала останавливает shell и запрашивает удаление точного helper с UID/resourceVersion. Отмена, изменившийся Pod или закрытое окно оставляют Pod для явной очистки; ошибка видна в node shell. Повторная попытка требует нового подтверждения. Одна отмена не вызывает немедленный повторный диалог в том же stop-запросе.

Произвольные команды интерактивного shell исполняются напрямую, могут использовать kubeconfig/учётные данные контейнера и не проходят через объектный API приложения. Перед открытием local/Pod shell backend отдельно показывает системное подтверждение именно этого доступа. Root-доступ node shell описан в review создания helper. Гарантировать объектное подтверждение для произвольной shell-команды без ограничения самого shell/его credentials невозможно.

Kubernetes controllers, garbage collector, admission webhooks и другие клиенты могут изменять объекты независимо от приложения. Диалог подтверждает прямую операцию Kubiki и описанные последствия, не блокирует весь кластер.

## Проверки

- Rust HTTP fixtures: отмена удаления для всех 45 встроенных типов; согласованный delete содержит обе preconditions.
- YAML/custom resources: полный diff, exact API/scope, cancel/dialog error, отсутствие/смена UID/RV, смена identity в редакторе, удалённый исходный объект, гонка CREATE, conditional write conflict, запрет multi-object YAML и oversized review.
- Scale/Secret/Helm: cancel, stale/recreated targets, no-op/immutable, размер review, TTL, frozen inputs, отсутствие retry и утечки server error values.
- Debug: отдельное согласие на cleanup, отмена/недоступность окна → ноль DELETE, повторный stop → новый review, ownership и UID/RV.
- Desktop unit: try-lock не ставит дубликаты в очередь, полностью валидные request shapes отвергают добавленный `confirmed`/`approved`.
- Frontend/HTTP: общие маршруты YAML/Secret/scale/delete/Helm/debug, сохранение версии, запрет browser writes, отсутствие retry/fallback; E2E проверяют UI/IPC contract.

Тесты записи используют локальные API fixtures, реальный кластер не изменяется. Browser/IPC mocks и unit tests не заменяют ручной acceptance настоящих окон подтверждения на каждой ОС; Windows/macOS в этой среде не проверены.

Основания: [Kubernetes API: resource versions, conditional updates и watch](https://kubernetes.io/docs/reference/using-api/api-concepts/), [Kubernetes Preconditions](https://kubernetes.io/docs/reference/kubernetes-api/definitions/preconditions-v1-meta/).
