# Helm operations, RBAC и topology visibility

2026-10-20. Основные операции реализованы; native GUI/настоящий кластер/Helm 4/cross-platform acceptance остаются TODO. Пользовательский кластер при разработке не изменялся.

## Helm

Desktop: Install release в toolbar; Upgrade/Roll back/Uninstall в details и правом меню строки; repository Add/Edit/Remove/Update indexes в toolbar/правом меню. В строках таблицы нет inline mutation buttons. Browser остаётся read-only; POST/GET `/helm/mutate` отклоняются до вызова CLI.

Upgrade загружает user values текущей revision, позволяет заменить overrides YAML, выбрать repo/chart + version (поиск по локальным Helm indexes), OCI chart или локальный packaged `.tgz`. Chart source/version разрешаются до подтверждения: архив копируется/скачивается в private temporary directory, values сохраняются туда же. Создание namespace, hooks, wait и keep history выбираются явно; hooks по умолчанию выключены. Значения не включаются в workspace persistence.

Backend `PreparedHelmMutation` не Deserialize/Clone: владеет неизменяемым запросом, архивом/values и снимками. Preparation получает точный release snapshot и проверяет expected revision, делает server dry-run, строит review изменений rendered objects/values/hooks/CRDs. Review не обрезается: свыше 24000 символов операция отклоняется. Общий `MutationGuard` сериализует запись и открывает системный dialog из Rust; renderer не передаёт флаг approved или token. Отмена не запускает write.

После consent проверяются TTL, полный release snapshot, rollback target, frozen inputs и повторный dry-run. Нестабильный рендеринг (lookup/random/time) блокирует операцию. Перед commit release читается ещё раз. Repository операции проверяют исходные name/URL и raw local repository config до/после consent; cache update также подтверждается. Ошибка/таймаут write сообщает неопределённость результата, не раскрывает CLI payload и не retryable. Read timeout — 15s; pull/preview — 60s; approved write — 330s, Helm timeout — 300s. Временные файлы удаляются при success/cancel/error.

**Граница гарантий:** Helm CLI не имеет compare-and-swap для атомарной блокировки внешних Helm clients или API admission между final check и write. Templates/hooks/controllers могут иметь дополнительные эффекты. Review явно объясняет это; его нельзя считать полным server-side dry-run всех эффектов. Private input freezing и проверка рендеринга предотвращают подмену reviewed chart/values и явно обнаруживаемые races, но не обещают атомарность Helm CLI. Advanced flags (force/adopt/post-render plugins), registry credential management, reinstall kept-history names и сложные nondeterministic charts требуют отдельной реализации/приёмки. Права и реальное состояние после операции проверяются Refresh и History; автоматического повтора нет.

## Диаграммы и Related

- `HelmRelease` — synthetic graph kind `helm.sh/v1`, **не Kubernetes API kind**. Отсутствует в shared Kubernetes catalog и никогда не подписывается через K8s list/watch. Diagram scopes загружают Helm только для конкретного namespace, с ограничением 250 releases, cache 30s/8 namespace snapshots и инвалидацией после mutations. Cluster summary не расширяет Helm автоматически. Ошибка Helm не скрывает Kubernetes graph.
- Владение `Helm Release → manages → object` требует `app.kubernetes.io/managed-by=Helm` и точных `meta.helm.sh/release-name/release-namespace`; одного instance label недостаточно. Namespaced и cluster-scoped managed objects связываются с релизом. Произвольные CR instances пока не загружаются (DOMAIN-03).
- Нажатие Helm node открывает release details; Topology из release details открывает focus graph. Overview релиза показывает загруженные managed objects и открывает их подробности. Helm links добавлены в Related Kubernetes-объекта.
- RBAC: Pod/workload/CronJob → ServiceAccount; ServiceAccount → imagePullSecrets/legacy token Secrets; ServiceAccount → RoleBinding/ClusterRoleBinding → Role/ClusterRole; ClusterRole aggregation selectors. API group, namespace и subject kind проверяются. User/Group не являются K8s objects и не превращаются в фиктивные ServiceAccounts. Namespace graph добавляет только связанные cluster bindings/roles/aggregates, в пределах прежних budgets. Это declarative relationships, не вычисленные effective permissions.
- Компактное всплывающее меню **Types / Resource types** содержит все kinds исходной диаграммы и counts, включая сгенерированные Namespace frames. Show all/Hide all, переключение каждого kind, закрытие по Escape/клику снаружи. Меню не занимает ширину холста. Выключаются только отображение и incident edges; данные/позиции сохраняются, ELK повторно не вызывается. Namespace frame можно скрыть отдельно от ресурсов внутри него. Возврат типа восстанавливает узлы.

## Проверки

214 unit tests; полный Rust suite 70 tests, включая consent/cancel, changed revision/frozen chart/re-render, repository config conflict и ambiguous write/no retry. Production browser checks: основные mutation request flows (mocked desktop IPC), RBAC chains, Helm ownership/navigation, topology type visibility/namespace independence/positions/no additional layout worker; прежние детали/Events/drag regression tests. Настоящие изменения Helm и native dialog acceptance на кластере не выполнялись.

Выполненная очередь замечаний владельца и оставшаяся QA находятся в начале [10](10-IMPLEMENTATION-TASKS.md): Node terminal, компактный адаптивный Overview/Problems, auto-fit новых таблиц и обязательный container picker до Logs/Shell.
