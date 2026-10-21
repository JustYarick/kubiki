# Нагрузка на Kubernetes API

Проверено 2026-10-21. Замеры выполнялись только на чтение.

## Реальный native watcher

В `crates/kubiki-core/examples/api_load_probe.rs` используется тот же `InformerManager`/kube-rs runtime, что в desktop. Middleware измерителя отклоняет любой метод кроме GET. Объекты/Secret values не выводятся и не сохраняются; отчёт содержит только количества.

Команда:

```sh
cargo run --manifest-path crates/kubiki-core/Cargo.toml --example api_load_probe -- default 15
```

Результат для доступного k3s кластера, scope All Namespaces:

| Показатель | Значение |
|---|---:|
| Поддержанные list+watch коллекции | 43 |
| Успешные начальные snapshots | 43 |
| Объектов в snapshots | 853 |
| Начальные LIST | 43 |
| WATCH | 43 |
| Время наблюдения после запуска подписок | 15,02 с |
| Дополнительные GET/LIST за интервал | 0 |
| Ошибки | 0 |
| Активные подписки после stop | 0 |

Измеритель отдельно выполнил 41 GET discovery перед началом интервала. Это discovery самого измерителя; приложение использует `kubectl api-resources` и его discovery cache, поэтому эту цифру нельзя автоматически прибавлять к каждому подключению приложения. Список объектов меняется со временем.

Замер считает исходящие запросы конкретного клиента. Он не измеряет CPU/etcd IOPS кластера и не приписывает приложению работу controllers или других клиентов. WATCH остаётся открытым и передаёт реальные изменения; отсутствие дополнительных HTTP-запросов не означает отсутствие сетевых событий или серверной работы.

## Исправленные лишние затраты

- **Один client на context.** Параллельный старт коллекций больше не строит несколько HTTP/auth clients до заполнения cache. Инициализация объединяется через per-context `OnceCell`; успешный client и connection pool переиспользуются. Ошибки не кешируются навсегда. Локальный HTTP/exec-credential тест запускает 32 одновременных чтения: общий provider вызывается дважды (Config + первый HTTP refresh kube-rs), а не отдельно для каждого чтения.
- **Watch timeout 30 → 290 с.** Значение ниже стандартного kube-rs read timeout 295 с. Повторное подключение использует текущий resourceVersion; обычное продление watch не требует полного LIST. Для 43 тихих подписок расчётная частота продлений при достижении полного timeout уменьшается с 43/30 ≈ 1,43 до 43/290 ≈ 0,15 запросов/с — примерно в 9,7 раза. Proxy/server могут закрыть поток раньше; это расчёт, а не обещание фиксированного RPS.
- Открытие обычной таблицы, подробностей, Related, Overview и диаграммы использует общий resource store. Дополнительные подписки для каждой панели не создаются. Это проверяет native-watch E2E.
- Смена namespace перезапускает только namespaced подписки; cluster-scoped остаются. Старые подписки/callbacks останавливаются при refresh/context change/pagehide. Неполный ответ старого запроса не заменяет новую выборку.

## Откуда берётся нагрузка

| Режим | Запросы |
|---|---|
| Desktop, All Namespaces | По одному LIST и WATCH на поддержанную коллекцию; большие LIST пагинируются |
| Desktop, N выбранных namespaces | На каждую namespaced коллекцию N независимых LIST/WATCH; cluster-scoped — один |
| Текущий полный каталог | 27 namespaced + 18 cluster-scoped: до `27 × N + 18` подписок, с учётом реально установленных API |
| Metrics Overview и подробностей Pod/Node | Каждый экземпляр `useOverviewMetrics` при открытии и раз в 15 с: All Namespaces — 2 GET (Pod + Node metrics); один namespace — 1 GET; N namespaces — N GET. Pod details читает metrics своего namespace, Node details — всех Pods и Nodes. При скрытом документе polling приостанавливается |
| API без watch | Только эти коллекции читаются snapshot polling раз в 30 с |
| Browser | Начальные snapshots и явный refresh/смена scope, без native watch. Запись запрещена |
| Custom resources | Лениво при открытии типа/refresh: проверка текущего CRD + LIST instances, отдельно для выбранных namespaces. Параллельные custom панели пока могут делать одинаковые чтения |
| Helm | Ленивые paginated reads; графовый cache 30 с и объединение одинаковых in-flight reads. Открытая Helm вкладка имеет собственные чтения |
| Logs/exec/port-forward | Дополнительные streams только для открытых сессий. Проверка списка локальных forward sessions раз в 2 с не делает новый Kubernetes LIST |
| Запись после подтверждения | Подготовительный GET + финальный GET + одна условная запись; для custom API добавляется discovery. Повторной автоматической записи нет |

`MetricsGaugeBar` в подробностях Pod/Node вызывает этот hook независимо от Overview. Cache хранит результат, но не объединяет in-flight запросы и polling между экземплярами. Поэтому несколько панелей могут дублировать metrics GET; скрытая внутри приложения, но смонтированная панель тоже продолжает polling, если документ видим. Это оставшаяся оптимизация, не включённая в замер watcher выше.

Большое число namespaces увеличивает connections и начальный объём данных. Например, пять namespaces полного каталога дают до 153 подписок; All Namespaces — до 45. Поэтому выбор всех namespaces не означает отдельную подписку на каждый namespace. Общий предел native watcher — 512 одновременно; сверх него возвращается понятная ошибка, подписки не создаются бесконтрольно.

## Большие выборки

E2E `api_inventory_scale.spec.ts`: 3500 Pods + 3500 ConfigMaps + 3500 custom resources (10 500 объектов), глубокая прокрутка, клавиатура, поиск, сортировка, namespace scope и refresh. В таблице остаётся меньше 100 DOM rows. Отдельно: native snapshot 3500 объектов + 500 последовательных обновлений.

Rust `watch_runtime_tests`: настоящий kube-rs HTTP/runtime против локального API fixture — пагинированные 3500 Pods публикуются одним snapshot, очередь событий ограничена, медленный consumer создаёт backpressure, остановка освобождает подписки. Проверяется timeoutSeconds=290 и восстановление watch/relist.

Эти проверки оценивают поведение клиента на больших объёмах. Нагрузочные записи и генерация тысяч объектов в реальном кластере не выполнялись. Для оценки конкретного production кластера нужны его API server/etcd metrics, интенсивность watch events и число одновременно работающих клиентов.

Источник протокола: [Kubernetes API — efficient detection of changes](https://kubernetes.io/docs/reference/using-api/api-concepts/#efficient-detection-of-changes).
