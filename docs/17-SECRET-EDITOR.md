# Построчный редактор Secret data

Статус: MUT-03A DONE. Kubernetes Secret → Overview → Secret data. Live YAML apply остаётся отдельной задачей MUT-01.

## Интерфейс

Каждый data key отображается отдельной строкой. Значения скрыты до Reveal values; небольшой общий переключатель Text / Base64 рядом работает и при просмотре, и при редактировании. Edit data открывает ключи и многострочные значения для изменения, Add key/Remove меняют состав data. Save data кодирует текст в base64 автоматически; Cancel удаляет черновик из памяти. После сохранения значения снова скрыты. Demo изменяет только память, desktop и browser dev выполняют реальный запрос.

Text использует строгий UTF-8 и сохраняет Unicode/BOM/переводы строк/пустые значения. Бинарные значения остаются base64 и отмечены `Binary · base64`, даже при выборе Text. Переключение кодировки сохраняет байты. Невалидный base64 блокирует сохранение/переход в Text. Нет неработающих dropdown на отдельных строках.

Проверяются уникальность ключей, допустимые символы/длина, canonical base64 и суммарный decoded data limit 1 MiB. Immutable Secret можно читать, но нельзя изменять.

Большие значения Secret и ConfigMap прокручиваются внутри собственного блока: максимум `min(280px × UI scale, 40vh)`. Это ограничение действует и на textarea Secret при ручном resize. Ключи, следующие значения и действия остаются вне внутренней прокрутки; данные не обрезаются. Прокручиваемый preview доступен с клавиатуры.

## Сохранение

Цель фиксируется по context + core/v1 Secret + namespace/name + UID + resourceVersion на момент начала редактирования. Desktop получает актуальный Secret через kube-rs, проверяет UID/resourceVersion/immutable, заменяет только содержимое data в полученном объекте, сохраняет прочие поля и отправляет PUT с исходными UID/resourceVersion. Серверная optimistic concurrency защищает промежуток между GET и PUT. Требуются get и update Secret. Browser dev делает тот же GET/check/replace через kubectl; manifest передаётся **stdin**, значения не попадают в argv/URL/временные файлы.

403/409/422/timeout не считаются успехом. Ошибка оставляет черновик. Watch/snapshot update во время редактирования не перезаписывает ввод и блокирует устаревший Save; Cancel → Edit загружает последнюю версию. После timeout результат записи может быть неопределённым: обновить объект для проверки. Смена context не направляет старый draft в новый cluster.

Значения/черновики не сохраняются в localStorage и не включаются в уведомления; ошибки записи backend очищаются от потенциального содержимого Secret. Открытый редактор показывает декодированные значения, а транспорт к API использует стандартные Kubernetes permissions. Base64 — представление байтов, а не шифрование.

## Проверки и границы

Codec tests: Unicode/BOM/binary/empty, add/delete, prototype-like keys, duplicates, invalid/canonical base64, size. Provider tests: IPC identity, HTTP body без Secret в URL. HTTP bridge tests: stdin, stale version, ошибки и cross-origin rejection. Rust API tests: GET/PUT, сохранение metadata/type, UID/resourceVersion, immutable, ограничения, 403/409/422 и очищенные ошибки. Browser scenarios: редактирование/кодировки/сохранение, добавление/удаление, ошибки с сохранением draft, immutable, обновление объекта во время редактирования.

MUT-03B TODO: native GUI + controlled live Secret на отдельном тестовом namespace, admission/webhooks, timeout outcome, изменения обязательных ключей TLS/dockerconfig. Пользовательские Secret в этом блоке не изменялись. Специализированные TLS/dockerconfig формы, live YAML schema/diff/dry-run/apply и общий create/delete pipeline не реализованы.

Контракт Kubernetes: [Secrets](https://kubernetes.io/docs/concepts/configuration/secret/).
