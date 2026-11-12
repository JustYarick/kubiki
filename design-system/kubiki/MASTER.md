# Kubiki Design System Specification (MASTER)

> **Источник истины для дизайна и верстки Kubiki.**
> Все компоненты, формы, таблицы и инспекторы строятся на единых дизайн-токенах в `src/App.css`.
> Изменение любого токена в одном месте автоматически и консистентно масштабирует всё приложение.

---

**Продукт:** Kubiki (Kubernetes Developer IDE & Desktop Tool)  
**Стиль:** JetBrains Fleet & IntelliJ New UI / DataGrip High-Density Dark Theme  
**Базовый множитель UI:** `var(--ui-factor)` (поддержка масштабирования 100%, 110%, 125%, 150%)  
**Режимы плотности:** `compact` (по умолчанию) и `comfortable`  

---

## 1. Категории и Шкалы Токенов (Global Design Tokens)

Все токены определены в `:root` файла `src/App.css`.

### 1.1. Control Sizing Scale (Высота интерактивных элементов)
Все интерактивные элементы управления строго стандартизированы по высоте, чтобы в тулбарах, строках и карточках инпуты, селекты и кнопки всегда выравнивались идеально в одну линию:

| Токен | Базовое значение | Использование |
|---|---|---|
| `--control-h-xs` | `calc(20px * var(--ui-factor))` | Микро-переключатели, regex-кнопка (`.*`), inline badge actions |
| `--control-h-sm` | `calc(22px * var(--ui-factor))` | Компактные кнопки (`Button size="sm"`), компактные инпуты (`SearchInput size="sm"`), фильтры сайдбара/колонок |
| `--control-h-md` | `calc(26px * var(--ui-factor))` | **Базовый стандарт всех контролов**: `Input`, `SearchInput`, `Button (md)`, `ide-select`, `SearchableSelect`, `NamespaceSelect`, `resource-filter-trigger` |
| `--control-h-lg` | `calc(30px * var(--ui-factor))` | Крупные диалоговые кнопки, модальные действия |

### 1.2. Row & Grid Sizing Scale (Высота строк таблиц, списков и деталей)
Высота строк больше не задается случайными паддингами:

| Токен | Базовое значение | Использование |
|---|---|---|
| `--row-h-compact` | `calc(24px * var(--ui-factor))` | Плотный режим таблиц DataGrid (`density === 'compact'`), строки связей Related, строки дерева категорий в сайдбаре |
| `--row-h-md` | `calc(28px * var(--ui-factor))` | Стандартный режим строк DataGrid (`density === 'comfortable'`), строки развернутых связей, заголовки групп |
| `--row-h-lg` | `calc(34px * var(--ui-factor))` | Многострочные элементы, карточки контейнеров, блоки событий |

### 1.3. Typography Scale (Шкала типографики)
Размеры шрифтов привязаны к назначению текста и не смешиваются:

| Токен | Базовое значение | Назначение |
|---|---|---|
| `--font-size-2xs` | `calc(9.5px * var(--ui-factor))` | Микро-метки, чипы отношений (`owner`, `selector`), счетчики бейджей |
| `--font-size-xs` | `calc(10.5px * var(--ui-factor))` | Метаданные, подзаголовки, статус-бейджи, неймспейсы, таймстемпы, заголовки колонок таблицы (`datagrip-th`) |
| `--font-size-sm` | `calc(11.5px * var(--ui-factor))` | **Основной рабочий шрифт данных**: ячейки таблицы DataGrid, имена ресурсов, текст полей ввода, выпадающие селекты, строки инспектора |
| `--font-size-base` | `calc(12px * var(--ui-factor))` | Общий текст приложения, описания, кнопки, стандартные меню |
| `--font-size-md` | `calc(13px * var(--ui-factor))` | Заголовки подсекций, тултипы, активные вкладки редактора |
| `--font-size-lg` | `calc(14px * var(--ui-factor))` | Заголовки панелей, названия выбранных ресурсов в шапке инспектора |
| `--font-size-xl` | `calc(16px * var(--ui-factor))` | Заголовки модальных окон и полноэкранных диалогов |

### 1.4. Border Radius Scale (Шкала скруглений)
| Токен | Базовое значение | Применение |
|---|---|---|
| `--radius-xs` | `calc(3px * var(--ui-factor))` | Бейджи статусов (`StatusBadge`), бейджи типов (`ResourceKindBadge`), счетчики |
| `--radius-sm` | `calc(4px * var(--ui-factor))` | **Все контролы**: кнопки (`Button`), инпуты (`Input`), селекты (`ide-select`, `NamespaceSelect`), секции инспектора |
| `--radius-md` | `calc(6px * var(--ui-factor))` | Всплывающие тултипы, выпадающие меню (`Dropdown`), контекстные меню |
| `--radius-lg` | `calc(8px * var(--ui-factor))` | Диалоги (`PFDialog`, `SettingsDialog`), модальные панели |

### 1.5. Spacing Scale (Шкала внутренних и внешних отступов)
| Токен | Базовое значение | Применение |
|---|---|---|
| `--space-1` | `calc(2px * var(--ui-factor))` | Микро-отступы между иконкой и текстом |
| `--space-2` | `calc(4px * var(--ui-factor))` | Плотные вертикальные отступы строк свойств (`details-properties`) |
| `--space-3` | `calc(6px * var(--ui-factor))` | Стандартный гэп между контролами в тулбарах |
| `--space-4` | `calc(8px * var(--ui-factor))` | Базовый горизонтальный отступ ячеек таблицы и панелей |
| `--space-5` | `calc(10px * var(--ui-factor))` | Горизонтальные паддинги вкладок (`jb-tab`) |
| `--space-6` | `calc(12px * var(--ui-factor))` | Отступы между крупными секциями |
| `--space-8` | `calc(16px * var(--ui-factor))` | Отступы полей модальных окон |

### 1.6. Chrome Shell Heights (Высоты каркаса IDE)
| Токен | Базовое значение | Компонент |
|---|---|---|
| `--titlebar-h` | `calc(34px * var(--ui-factor))` | Верхняя панель TitleBar (`TitleBar.tsx`) |
| `--tabbar-h` | `calc(34px * var(--ui-factor))` | Главный таб-бар (`MainTabBar.tsx`, `.jb-tab-strip`) |
| `--dock-header-h` | `calc(32px * var(--ui-factor))` | Шапка нижнего дока (`BottomDock.tsx`) |
| `--statusbar-h` | `calc(26px * var(--ui-factor))` | Нижний StatusBar (`StatusBar.tsx`) |
| `--toolbar-h` | `calc(36px * var(--ui-factor))` | Строка тулбара с поиском и фильтрами |

---

## 2. Стандарты Компонентов

### 2.1. Поля ввода (Inputs & Search)
- **Стандартный инпут (`size="md"` / по умолчанию):**
  - Высота: `var(--control-h-md)` (26px * uiFactor)
  - Шрифт: `var(--font-size-sm)` (11.5px * uiFactor)
  - Скругление: `var(--radius-sm)` (4px * uiFactor)
  - Бордер: `1px solid var(--border-default)`, при фокусе `var(--accent)`
- **Компактный инпут (`size="sm"`):**
  - Высота: `var(--control-h-sm)` (22px * uiFactor)
  - Шрифт: `var(--font-size-xs)` (10.5px * uiFactor)
  - Скругление: `var(--radius-sm)` (4px * uiFactor)

### 2.2. Кнопки (Buttons)
- **`size="md"`:**
  - Высота: `var(--control-h-md)`
  - Паддинг: `px-2.5`
  - Шрифт: `var(--font-size-sm)`
  - Скругление: `var(--radius-sm)`
- **`size="sm"`:**
  - Высота: `var(--control-h-sm)`
  - Паддинг: `px-2`
  - Шрифт: `var(--font-size-xs)`
  - Скругление: `var(--radius-sm)`

### 2.3. Выпадающие списки и Селекты
- Класс `.ide-select`, компоненты `SearchableSelect`, `NamespaceSelect`:
  - Высота: строго `var(--control-h-md)`
  - Шрифт: `var(--font-size-sm)`
  - Скругление: `var(--radius-sm)`
  - Благодаря этому любой селект, стоящий рядом с `Input` или `Button`, имеет одинаковую высоту до пикселя.

### 2.4. Строки таблиц и списков
- Таблица DataGrid (`ResourceView.tsx`):
  - `density === 'compact'`: `rowHeight = 24 * uiFactor` (`--row-h-compact`)
  - `density === 'comfortable'`: `rowHeight = 28 * uiFactor` (`--row-h-md`)
- Вкладка Related в инспекторе (`InspectorPanel.tsx`):
  - Строки связей `RelatedRow` и заголовки групп:
    - При компактном режиме: `min-h-[var(--row-h-compact)] py-0.5`
    - При стандартном режиме: `min-h-[var(--row-h-md)] py-1`
- Дерево сайдбара (`Sidebar.tsx`):
  - Прямые категории: `h-[var(--control-h-md)]`
  - Сворачиваемые категории: `h-[var(--row-h-compact)]`
  - Подгруппы: `h-[var(--control-h-sm)]`

---

## 3. Как изменить размеры глобально в 1 месте

Если потребуется скорректировать масштаб или высоту любого элемента:
1. Открыть `src/App.css`.
2. В блоке `:root` изменить нужное базовое значение, например:
   - Сделать все поля ввода и кнопки чуть выше: `--control-h-md: calc(28px * var(--ui-factor));`
   - Изменить компактную высоту строк во всем приложении: `--row-h-compact: calc(22px * var(--ui-factor));`
   - Изменить базовый размер шрифта для таблиц и инспектора: `--font-size-sm: calc(12px * var(--ui-factor));`
   - Изменить радиус скруглений контролов: `--radius-sm: calc(6px * var(--ui-factor));`
3. Никаких хардкодных правок по десяткам файлов делать не требуется — все компоненты автоматически подхватывают новые размеры.
