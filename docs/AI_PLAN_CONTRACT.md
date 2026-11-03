# Контракт расследования и плана исправления

Дата: 2026-11-01. Реализация: `kubiki-ai::{plans,execution,runtime}`,
`agent_commands.rs`, `PlanArtifactCard.tsx`. Это контракт Kubiki для Kubernetes;
заголовок Markdown, thinking и текст «я составлю план» не являются артефактом плана.

## Результат Investigate with AI

Карточка ресурса передаёт только identity и intent `investigate`. Разговор начинается
в Plan + Ask. Агент собирает разрешённые evidence, формулирует диагноз и
неопределённость, затем вызывает `propose_plan` с `kind=remediation`.
Если после плана собраны новые данные, итоговый remediation plan требуется обновить.
Runtime допускает один корректирующий проход при ответе без плана; повторное
отсутствие артефакта означает незавершённое расследование, а не успешный результат.
Для неизвестной причины допустим план точных дополнительных проверок; выдумывать
изменение или объявлять отсутствие проблемы запрещено.

Обычный чат может завершаться без плана. Внутреннее размышление не классифицируется
по ключевым словам и не получает плашку Plan. UI принимает только валидированный
`schemaVersion=1` и отдельное типизированное событие/результат native backend.

## Формат

Поля, которые задаёт предложение модели:

| Поле | Смысл |
| --- | --- |
| kind | remediation, investigation или deployment; итог Investigate требует remediation |
| title / bodyMarkdown | Название и пояснение; Markdown не исполняется |
| diagnosis / uncertainty | Наблюдаемый вывод и пределы уверенности |
| evidenceIds | До 16 существующих, ещё доступных projected evidence IDs |
| steps | 1–16 упорядоченных шагов |
| planId | Только при новой версии существующего плана этой native-сессии |

Каждый шаг содержит `id`, `title`, `action`, `reason`, `risk`, `verification`.
`action`: inspect, manual, scale, restart, apply или delete. Для scale/restart/delete
нужен точный `target` (group/version/kind/namespace/name); scale требует replicas,
apply — YAML одного ресурса. `expectedUid` допустим как ранее наблюдавшаяся identity.

`dependsOn` требует подтверждённой проверки предыдущих шагов.
`dependsOnAccepted` явно требует только принятия API: например, PVC с
WaitForFirstConsumer может предшествовать созданию потребителя. Такая зависимость
не превращает Pending PVC в Bound; её риск и последующая проверка должны быть
описаны в плане. Ссылки ведут только к более ранним шагам, циклы запрещены.

Пример предложения (не разрешение на запись):

```json
{
  "kind": "remediation",
  "title": "Уточнить причину неготовности web",
  "diagnosis": "В разрешённых данных Pod имеет Ready=False",
  "uncertainty": "Причина probe failure пока не подтверждена",
  "bodyMarkdown": "Не менять workload до проверки причины.",
  "evidenceIds": ["e1"],
  "steps": [{
    "id": "check-readiness",
    "title": "Проверить condition и события выбранного Pod",
    "action": "inspect",
    "reason": "Ready=False сам по себе не доказывает ошибку probe",
    "risk": "Только ограниченные разрешённые чтения",
    "verification": "Получить condition reason и UID-bound Events либо явно зафиксировать отказ доступа",
    "dependsOn": [],
    "dependsOnAccepted": []
  }]
}
```

Native backend назначает ID, version, `sessionId`, фактический scope, session-local
`policyRevision`, время и status. `targetScope` модели — только подпись, не scope
исполнения. Policy revision стабилен при смене фазы; отдельный authorization
revision используется review token и проверяется перед каждым HTTP write.
Размер артефакта ≤60 KB; registry ≤16 версий / 256 KiB на сессию. Новая редакция
создаёт новую версию. Evidence ID доказывает происхождение разрешённого результата,
но сама ссылка не доказывает корректность причинного вывода модели.

В model history результат `propose_plan` содержит компактную квитанцию с ID,
версией, статусом и ссылками на steps/evidence. Полный артефакт отправляется UI;
повторно получить его модель может явно через `get_plan`. Текст/YAML плана поэтому
не дублируется в каждом tool result. Каждый новый Investigate turn требует своего
актуального remediation artifact; артефакт предыдущего turn его не заменяет.

## Review → execution → verification

1. Пользователь явно выбирает Ask/Auto accept и Action, затем шаги конкретной версии.
2. Кнопка Apply selected steps автоматически запускает native review, который повторно проверяет scope, права операции, YAML и identity.
   Текущие UID/resourceVersion или отсутствие объекта закрепляются в token на 5 минут.
   На один ресурс — одно изменение в таком плане; изменения одного объекта нужно
   объединить либо рассматривать отдельной следующей версией.
3. После review UI передаёт только одноразовый token для исполнения.
   Ask и Always ask показывают native confirmation; Auto accept выполняет разрешённые шаги без дополнительного вопроса.
   Изменить payload/target/version через этот запрос нельзя. Это не tool модели.
4. Каждый шаг проходит существующие PreparedMutation/MutationGuard. Ask дополнительно
   показывает native review конкретного изменения. Auto accept также требует текущей policy.
   Изменение объекта после review, Stop, смена mode/phase/config отзывает будущую отправку.
5. Принятый write получает durable receipt. UID из ответа API хранится native и
   используется при проверке созданного объекта; объект-замена не считается успехом.
   Служебные concurrency-поля не добавляются в историю модели или tool events.
6. Controllers (`Deployment`, `StatefulSet`, `DaemonSet`, `ReplicaSet`) проверяются
   bounded fresh reads по UID/generation/replicas. Пакетные задания (`Job`) проверяются
   по UID, условию завершения (`Complete`), отсутствию `Failed` и снятию с паузы (`suspended`),
   не требуя generation контроллера или количества реплик. Для остальных объектов
   сверяются разрешённые desired fields; PVC дополнительно требует Bound.
   Недоступные/замаскированные поля не удовлетворяют проверке.
   Удаление проверяется отдельным metadata read. Application health этим не доказана.
7. Failed/declined/uncertain прекращает дальнейшие записи. При uncertain допускается
   read-only observation для reconciliation, но не повтор write и не автоматическое
   объявление операции успешной. Непроверенная prerequisite блокирует `dependsOn`.

Host-статусы: draft, ready, running, completed, partial, failed, cancelled, stale.
Completed означает выполнение и оговорённую техническую проверку выбранных шагов;
не является заявлением о здоровье приложения. Partial сохраняет receipts и
неопределённость. Повтор старой попытки/автоматический rollback не выполняются;
требуется новое расследование и новая версия предложения.

Поддерживаются существующие разрешённые native kinds. Secret/RBAC/raw Pod,
cluster mutations, shell/exec, Helm install/upgrade и GitOps writes этим контрактом
не включаются. Для них нужна отдельная capability и модель review; свободный текст
шага manual не превращается в разрешённую автоматическую операцию.

## Хранение и интерфейс

Карточка показывает диагноз, uncertainty, шаги, риски, проверки, dependencies,
версию и status. Доступны просмотр referenced historical evidence, уточнение,
обновление по свежим данным, source/copy/export. HTML не выполняется, внешние
изображения не загружаются. Экспорт проверяет отдельный локальный allowExport.
Evidence IDs принадлежат исходной native-сессии. При смене модели создаётся новая
сессия: историческая карточка остаётся видимой, но её evidence/review/execute
недоступны. Обновление исторической карточки запрашивает новый план в новой сессии.

SQLite history хранит очищенный transcript, а не runtime replay/approvals. Tool
payloads и PlanArtifact bodies по умолчанию не сохраняются. Восстановление всегда
Plan + Ask; старый transcript не пересылается модели автоматически.
