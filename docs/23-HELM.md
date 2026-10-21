# Helm: read-only интеграция

Обновление: DOMAIN-02C1/C2 и основные операции C3 реализованы. Release ↔ resource links и диаграммы подключены; см. [24](24-HELM-OPERATIONS-AND-RBAC.md). UI-9 остаётся PARTIAL из-за расширенных сценариев и native/live/cross-platform приёмки. Ниже сохранён контракт первоначального read-only слоя; новые mutations имеют отдельный desktop-only IPC через backend consent.

## Как проверить

1. Установленный `helm` должен быть доступен через PATH процесса приложения. После изменения PATH перезапустите Kubiki.
2. В Explorer откройте **Helm → Releases**. Список следует глобальным context/namespace; All Namespaces запрашивает весь кластер. Отдельного namespace picker здесь нет.
3. Нажмите строку релиза: справа откроется панель; в узком workspace она располагается под списком. Доступны Overview, History, Values, Manifest и Notes. Enter/Space на строках также открывают подробности.
4. В History нажмите ревизию: Values откроется для неё. При переключении Values/Manifest/Notes сохраняется эта revision; Latest revision возвращает к ревизии из списка.
5. **Helm → Repositories** показывает конфигурацию локального Helm CLI, общую для кластеров. Refresh перечитывает конфигурацию; не выполняет `helm repo update`.
6. Для визуальной проверки без Helm/кластера используйте `?demo=1`: данные явно обозначены Demo и не подменяют ошибки обычного режима.

## Реализация

- Новый `kubiki-core::helm::reader::HelmReader` обслуживает только фиксированные read-команды. Tauri IPC: `list_helm_releases`, `get_helm_history`, `get_helm_content`, `list_helm_repositories`. Browser dev bridge предоставляет только GET `/api/k8s/helm/{releases,history,content,repositories}`.
- Каждый запрос к релизу передаёт явный `--kube-context=<selected context>`, namespace и проверенное имя. Values/Manifest/Notes дополнительно получают положительную `--revision`. Аргументы передаются напрямую процессу, без shell. Локальный current-context не изменяется.
- Список — snapshots с ручным Refresh: 100 строк на странице, дополнительная запись определяет Next page; offset передаётся явно. Явные status flags включают deployed/failed/pending/uninstalled/superseded/uninstalling и совместимы с Helm 3/4. Пагинация ограничивает ответ/UI, но внутренний storage driver Helm может читать больше записей. Сортировка и поиск по имени/namespace применяются только к текущей странице; это подписано под таблицей.
- Ошибки PATH/RBAC/auth/not-found/timeout/повреждённого JSON не превращаются в пустой список. Только точное `no repositories to show` означает пустую конфигурацию репозиториев. После неудачного Refresh сохранённый snapshot помечается как устаревший.
- Контекст/namespace/target входят в ключ запроса; late responses игнорируются. Смена scope сбрасывает selection и offset. Browser fetch отменяется при уходе; native invoke может закончить чтение до backend timeout, но его результат не попадёт в другой scope.
- Таймаут subprocess — 15 секунд; Rust ограничивает stdout 8 MiB и stderr 64 KiB, browser bridge — output buffer 8 MiB. При ошибке/таймауте Rust child уничтожается через kill-on-drop. History ограничена 256 ревизиями. Документы загружаются при открытии секции и прокручиваются внутри ограниченного блока; содержимое не сохраняется в localStorage.
- Helm имеет отдельные workspace tabs и собственную панель подробностей; общий Kubernetes Inspector на этих вкладках скрыт. В таблицах нет inline mutation buttons. Статусы подписаны текстом и цветом, поиск занимает свободную ширину, таблицы прокручиваются внутри pane, панели адаптируются к ширине workspace.
- Прежний `HelmClient` оставлен только для чтения; неиспользуемые mutating wrappers удалены. Все изменения доступны через `PreparedHelmMutation` с backend review/consent и повторной проверкой релиза; desktop вход — общий `mutate_resource`.

## Проверки и оставшиеся задачи

- Unit/API tests: literal argv/context, namespace/ref validation, offset/has_more, revision/document allowlist, запрет POST, структура ответов, PATH/RBAC/timeout/empty/corrupt output, tab identity и Go timestamps.
- Rust executable fixtures: реальные subprocess, 100+1 pagination, pinned revision, local repo reads, invalid targets, missing binary, 403, output limit, timeout и уничтожение зависшего child.
- Production Chromium: list/filter/pages/details/history/documents, scope/context switching и late responses, retained snapshot/retry, missing Helm, empty repositories, 10k-символьные/длинные документы в узкой панели; desktop IPC проверен browser harness.
- Дополнительный smoke установленным Helm **3.16.2** против локального mock Kubernetes API прошёл: list/history/values старой ревизии/manifest/notes; специально невалидный current-context подтвердил явный context; все 10 Kubernetes запросов — GET. Пользовательский кластер не использовался.
- DONE DOMAIN-02C3: основные операции подключены через backend confirmation; ограничения и проверки описаны в [24](24-HELM-OPERATIONS-AND-RBAC.md).
- TODO DOMAIN-02C4: настоящий кластер, native Tauri GUI, Helm 4 и Windows/macOS PATH/kubeconfig/credentials. Совместимость флагов Helm 4 проверена по документации, реальный Helm 4 не запускался.
- PARTIAL DOMAIN-02C5: точные Helm ownership links и навигация из релиза/диаграммы подключены; история свыше 256 ревизий и поиск по всем страницам остаются TODO.

Источники контракта CLI: [helm list](https://helm.sh/docs/helm/helm_list/), [helm get all](https://helm.sh/docs/helm/helm_get_all/), [helm repo list](https://helm.sh/docs/helm/helm_repo_list/).
