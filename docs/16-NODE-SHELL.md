# Управляемый Node debug shell

Статус: OPS-03A DONE, OPS-03B TODO. Desktop transport реализован; реальный privileged Pod на пользовательском кластере в этом блоке не создавался.

## Проверка

Перезапустить `pnpm tauri dev` после обновления Rust. Nodes → объект → Node shell (либо соответствующий пункт ПКМ). Открытие панели ничего не создаёт. Сначала показаны Node/context, описание root/host-доступа, namespace, образ и shell. Подготовка начинается только по **Create helper Pod and connect**, затем backend показывает системное подтверждение полного Pod перед созданием. Начальный namespace — текущий выбранный namespace либо default при All namespaces; настройки можно изменить до создания. При ошибке/отмене повтор — только новой явной кнопкой, без автоматических retries. По умолчанию используется `docker.io/library/ubuntu:24.04`; образ должен иметь `/bin/sh`, `sleep`, `chroot`. Целевая нода должна быть Linux, host filesystem — содержать выбранный shell.

Создаётся privileged Pod с hostPID/IPC/network и hostPath `/` → `/host`, без service account token. После readiness exec запускает `chroot /host /bin/sh` (либо выбранный shell). Это доступ к файловой системе ноды с высокими привилегиями. Подготовка проверяет Node UID и разрешения get Node / create,get,delete Pod / get pods/exec. kube-rs 0.98 использует GET WebSocket upgrade. Admission/Pod Security или image pull могут запретить запуск даже после успешной проверки RBAC.

## Жизненный цикл

Сессия закреплена за context/Node UID и владельцем настоящего Tauri window. Максимум 8 managed preparations/sessions. Подготовка ограничена 120 секундами, отдельные API-запросы — 20. Статусы подготовки и cleanup доступны в header. Подключение использует общий xterm/ACK/backpressure transport; скрытие вкладки не пересоздаёт shell.

Exit, Disconnect, закрытие вкладки, Cancel, смена context/pagehide и destroy инициируют cleanup. **Каждый DELETE требует отдельного системного подтверждения**; согласие на создание не разрешает удаление. Отмена подтверждения или отсутствие окна оставляют Pod для ручной очистки. DELETE использует UID/resourceVersion preconditions, labels проверяются; чужой или пересозданный Pod не удаляется. Завершение удаления подтверждается GET/404. Ошибка удаления сохраняется для Retry cleanup. Reconnect/смена shell возвращают экран настройки: существующий helper не заменяется до **Create replacement Pod and connect**. Удаление старого helper и создание нового требуют своих backend confirmations. Команды не воспроизводятся автоматически.

Other debug Pods показывает помеченные Kubiki Pods выбранного namespace без активной сессии **в текущем процессе**. Другой экземпляр приложения может использовать такой Pod: удаление ручное, с проверкой UID/labels. Успешное ручное удаление снимает соответствующую failed lease.

Ограничения: аварийное завершение процесса или неопределённый результат POST после сетевого timeout могут оставить helper. `activeDeadlineSeconds=3600` завершает контейнер, но **не удаляет Pod**. Автоматическое удаление после crash не гарантируется; предусмотрено ручное восстановление. Exec endpoint адресуется по имени: проверка UID перед upgrade не даёт атомарной гарантии между GET и WebSocket.

## Проверки и оставшиеся задачи

Rust local HTTP/WS integration tests проверяют сериализацию Pod, host chroot exec/stdin/output, отмену во время POST, RBAC/UID, отдельное подтверждение cleanup, retry и orphan deletion. Provider unit tests проверяют gateway/Node routing/ACK. Шесть browser IPC tests: отсутствие подготовки при открытии/скрытии панели, явное создание с UID/scope, ввод, reconnect/exit cleanup, cancel/late ready, отказ разрешений, ручное удаление, отмена backend confirmation без retry и просмотр настройки замены после смены shell. Browser fixture моделирует ответ native consent; настоящий системный диалог проверяется отдельно.

OPS-03B: native GUI на тестовом кластере, admission/image pull/finalizers, реальные обрывы и длительные потоки, proxy/credentials, macOS/Windows transport. Browser IPC и локальный API этого не заменяют.

Основание модели helper: [Kubernetes — Debugging Kubernetes nodes](https://kubernetes.io/docs/tasks/debug/debug-cluster/kubectl-node-debug/), [Debug Running Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/).

Опубликованный [NodeShellSession Lens v6.5.2](https://github.com/lensapp/lens/blob/v6.5.2/packages/core/src/main/shell-session/node-shell-session/node-shell-session.ts) также создаёт привилегированный Pod на выбранном узле. Это исторический исходный код, а не проверка текущего закрытого бинарника Lens.
