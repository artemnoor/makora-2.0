# Источники рекурсивных лабораторий

Подборка от 20 ноября 2026 г. и проверенные материалы авторов. Номера соответствуют приложенному каталогу. Этапы RL-01–RL-06 обозначают проверки в локальном проекте. Записи о результатах прогона хранятся вместе с его ID.

| № | Источник | Решение Makora | Граница применимости | Проверка |
|---|---|---|---|---|
| 1 | [Epic](https://github.com/bitmonk8/epic) | Локальное восстановление неудавшейся ветви | Репозиторий архивирован, это пример процесса | RL-05 |
| 2 | [Roo Code](https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks/) | Короткий результат подзадачи и возврат управления | Механизм зависит от среды Roo | RL-02 |
| 3 | [Task Master AI](https://github.com/eyaltoledano/claude-task-master) | Выделение сложных задач для декомпозиции | Команды и оценки зависят от стека агента | RL-03 |
| 4 | [Task Master — структура задач](https://github.com/eyaltoledano/claude-task-master/blob/main/docs/task-structure.md) | Идентификаторы и явные зависимости | Формат Makora проверяет иерархию и граф совместно | RL-01 |
| 5 | [Metaswarm](https://github.com/dsifry/metaswarm) | Контракты, границы записи и проверки до интеграции | Набор ролей и инструментов зависит от процесса | RL-04 |
| 6 | [Google ADK — иерархия](https://codelabs.developers.google.com/codelabs/production-ready-ai-with-gc/3-developing-agents/build-a-multi-agent-system-with-adk) | Разделение ролей и ограниченный обмен состоянием | Пример учебного workflow | RL-03 |
| 7 | [LangGraph — Subgraphs](https://docs.langchain.com/oss/python/langgraph/use-subgraphs) | Явные входы и выходы ветви | Семантика графов LangGraph зависит от его рантайма | RL-04 |
| 8 | [LangGraph — Persistence](https://docs.langchain.com/oss/python/langgraph/persistence) | Чекпойнты и сохранение успешной работы после сбоя | Макоре достаточно локального устойчивого журнала | RL-05 |
| 9 | [CrewAI](https://docs.crewai.com/en/learn/hierarchical-process) | Менеджер назначает задачи и проверяет результаты | Документация паттерна без оценки выгоды для Makora | RL-02 |
| 10 | [AutoGen Group Chat](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/design-patterns/group-chat.html) | Централизованные события и явная очередность | Общий чат имеет дополнительные расходы | RL-03 |
| 11 | [OpenAI — оркестрация](https://developers.openai.com/api/docs/guides/agents/orchestration) | Оркестратор хранит управление, исполнители получают узкие задания | Документация паттерна | RL-03 |
| 12 | [Anthropic Cookbook](https://github.com/anthropics/claude-cookbooks/blob/main/patterns/agents/README.md) | Разделение постановки, исполнения и оценки | Примеры иллюстративны | RL-02 |
| 13 | [OpenHands](https://github.com/OpenHands/OpenHands) | Раздельные слои управления и работы с окружением | Репозиторий показывает архитектуру конкретного продукта | RL-05 |
| 14 | [SWE-agent](https://github.com/SWE-agent/SWE-agent) | Интерфейс исполнителя влияет на проверяемость | Бенчмарки зависят от окружения и инструментов | RL-06 |
| 15 | [Makora 2.0](https://github.com/artemnoor/makora-2.0) | Переиспользовать batch, assemble, verify и writeScope | Авторитет для реализации — текущие файлы локального проекта | RL-01 |
| 16 | [Anthropic — Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) | Начинать с простого пути и усложнять по измерениям | Инженерные рекомендации | RL-06 |
| 17 | [Anthropic — Harness Design](https://www.anthropic.com/research/harness-design-long-running-apps) | Заранее задать критерии, независимо проверять собранный итог | Результаты зависят от модели и категории разработки | RL-02 |
| 18 | [Anthropic — Effective Harnesses](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents) | Сохранять проверяемое состояние и короткий handoff | Наблюдения из длительных сессий Claude | RL-05 |
| 19 | [Anthropic — Multi-Agent Research](https://www.anthropic.com/research/multi-agent-research-system) | Параллелизм полезен при независимом поиске, расход учитывать целиком | Исследовательские задачи отличаются от разработки на общей базе | RL-06 |
| 20 | [Google — Scaling Agent Systems](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/) | Подбирать параллелизм под зависимости | Наибольшие эффекты измерены на конкретных бенчмарках | RL-06 |
| 21 | [BOAD](https://research.ibm.com/publications/boad-discovering-hierarchical-software-engineering-agents-via-bandit-optimization) | Проверять результаты перед межветочной передачей | Иерархия также передаёт ошибки при слабой проверке входов | RL-04 |
| 22 | [CRMA](https://www.sciencedirect.com/science/article/pii/S0921889026004872) | Калибровать границу возможностей по наблюдаемому исполнению | Доступные разделы описывают AI2-THOR | RL-06 |
| 23 | [When Agents Coordinate](https://arxiv.org/abs/2608.16801) | Выбирать компактный обмен артефактами и измерять накладные расходы | Оценки зависят от задачи и способа коммуникации | RL-06 |
| 24 | [Towards a Science of Scaling Agent Systems](https://arxiv.org/abs/2512.08296) | Сохранять сравнение с одним исполнителем | Связанный источник с материалом Google выше | RL-06 |
| 25 | [Understanding Agent Scaling](https://arxiv.org/abs/2602.03794) | Учитывать насыщение одинаковых исполнителей | Выводы зависят от независимости и разнообразия источников | RL-06 |
| 26 | [Mythical Man-Month Meets Agents](https://arxiv.org/abs/2611.19140) | Централизованная интеграция может увеличить задержку | Препринт и задачи веб-разработки | RL-06 |
| 27 | [Harness Engineering](https://arxiv.org/abs/2609.00006) | Выделить небольшие адаптеры состояния, выполнения и проверок | Сравнение исходников рантаймов, а не оценка Makora | RL-01 |
| 28 | [CWC Long-running Agents](https://github.com/anthropics/cwc-long-running-agents) | Сохранять доказательства результата вне контекста модели | Пример реализации на Claude | RL-02 |
| 29 | [OpenCode Tools](https://opencode.ai/docs/tools/) | Дерево Makora независимо от глубины вызовов исполнителя | Семантику событий сверять с установленным сервисом | RL-05 |
| 30 | [OpenCode Agents](https://opencode.ai/docs/agents/) | Проверять фактический агент и модель дочерней сессии | Параметры зависят от версии и локального профиля | RL-05 |
| 31 | [OpenCode Nested Subagents](https://github.com/anomalyco/opencode/issues/50539) | Не опираться на индикатор вложенности интерфейса | Обсуждение реализации, контракт закрепляется локальной схемой | RL-05 |
| 32 | [DeepSeek Flash 1017 — model card](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017) | Проверять заявленный ID и версию кандидата | Карточка модели не подтверждает версию прокси OpenCode | RL-06 |
| 33 | [DeepSeek API Updates](https://api-docs.deepseek.com/updates/) | Фиксировать модель и harness в отчёте пилота | Официальные значения получены на конкретных benchmark harness | RL-06 |
| 34 | [SWE-bench Verified](https://www.swebench.com/verified) | Оценивать исправление с независимыми критериями и тестами | Публичный benchmark отличается от локальных задач Makora | RL-06 |
| 35 | [Google ADK Workflows](https://github.com/google/adk-docs/blob/main/docs/workflows/index.md) | Развести последовательные и параллельные зависимости | Примеры рантайма ADK | RL-03 |
| 36 | [Reddit — 35 прогонов](https://www.reddit.com/r/ClaudeCode/comments/1xuqnnc/i_tested_anthropics_one_agent_with_skills_beats_a/) | Проверить, оправдывает ли команда дополнительные время и токены | Самоотчёт на двух сценариях Claude Code | RL-06 |
| 37 | [Reddit — делегирование дешёвым моделям](https://www.reddit.com/r/ClaudeCode/comments/1xxyc5a/does_delegating_to_cheaper_models_actually_save/) | Сравнить исполнителей на одинаковых листьях | Набор задач и модели автора отличаются | RL-06 |
| 38 | [Reddit — стоимость subagents](https://www.reddit.com/r/ClaudeCode/comments/1ur70w0/where_do_subagents_actually_pay_off_in_typical/) | Учитывать стартовый контекст и передачу результатов | Практический анализ и частные измерения | RL-06 |
| 39 | [Reddit — несколько coding agents](https://www.reddit.com/r/AI_Agents/comments/1y0tdak/i_run_several_coding_agents_in_parallel_on_one/) | Проверить возобновление после потери чата | Опыт автора | RL-05 |
| 40 | [Reddit — управление общим репозиторием](https://www.reddit.com/r/ClaudeCode/comments/1st213z/how_are_you_managing_multiple_coding_agents_in/) | Назначать одного владельца зоны записи | Советы из обсуждения | RL-03 |
| 41 | [Reddit — worktrees](https://www.reddit.com/r/ClaudeAI/comments/1qzduim/stop_running_multiple_claude_code_agents_in_the/) | Сохранять отдельные рабочие копии | Изоляция Git предотвращает конфликт копий на этапе исполнения | RL-01 |
| 42 | [Reddit — атомарные задачи и gates](https://www.reddit.com/r/ClaudeCode/comments/1r8h10y/this_is_what_3k_hours_in_cc_looks_like/) | Фиксировать критерии до исполнения | Пользовательский процесс, экономику измеряем локально | RL-02 |
| 43 | [Reddit — Subtask](https://www.reddit.com/r/ClaudeCode/comments/1qhzagf/subtask_claude_code_creates_tasks_and_spawns/) | Привязывать run ID и копию к листу | Реализация стороннего инструмента | RL-03 |
| 44 | [Reddit — DeepSeek и Orca](https://www.reddit.com/r/DeepSeek/comments/1xg0ymi/you_guys_asked_about_my_dsv41_flash_1017_orca/) | Проверить Flash отдельно на проверяемых задачах | Пользовательская конфигурация и другие лимиты | RL-06 |
| 45 | [Reddit — Opus/Sonnet и DeepSeek](https://www.reddit.com/r/opencode/comments/1xw1du6/how_are_you_using_claude_opussonnet_deepseek_v41/) | Разделить постановку и исполнение | Обсуждение вариантов рабочих процессов | RL-06 |
| 46 | [Reddit — зависшие субагенты](https://www.reddit.com/r/opencode/comments/1w1i9cm/is_there_any_way_to_continue_frozen_subagents/) | Ввести неподтверждённое состояние и запрет дублей | Наблюдение автора, причину выясняет API и журнал | RL-05 |
| 47 | [Reddit — task_id](https://www.reddit.com/r/opencodeCLI/comments/1re8dyi/psa_spawning_subagents_returns_a_task_id_that_you/) | Сверять ID сессии при восстановлении | Существование ID само по себе не подтверждает результат | RL-05 |
| 48 | [Reddit — Flash и GLM advisor](https://www.reddit.com/r/opencode/comments/1ugyxlk/how_to_set_up_deepseek_flash_glm_52_advisor_in/) | Проверить выборочную эскалацию | Опыт на другом наборе моделей и провайдеров | RL-06 |
| 49 | [Reddit — лимиты OpenCode](https://www.reddit.com/r/opencode/comments/1ugagq3/quick_fix_for_hitting_opencode_limits_ds_flash/) | Отдельно классифицировать исчерпание провайдерского лимита | Пользовательский отчёт | RL-05 |
| 50 | [Reddit — ожидание CI](https://www.reddit.com/r/ClaudeCode/comments/1xroq2g/agents_waiting_on_ci_were_31_of_my_claude_code/) | Отделять простой от активной работы модели | Конкретная инструментальная среда автора | RL-06 |
| 51 | [Reddit — модели OpenCode Go](https://www.reddit.com/r/opencode/comments/1xw5rap/what_models_are_you_using_for_your_opencode/) | Учитывать роль модели при сравнении | Рекомендации зависят от текущих тарифов и набора моделей | RL-06 |
| 52 | [Reddit — 6 моделей OpenCode Go](https://www.reddit.com/r/opencode/comments/1y080cl/i_ran_6_go_models_through_the_same_8_prompts_and/) | Закрепить одинаковые задания, проверки и среду | Малый пользовательский benchmark | RL-06 |
| 53 | [Reddit — много основных и вложенных агентов](https://www.reddit.com/r/opencode/comments/1tl7m3o/roast_my_opencode_setup_3_primary_agents_8/) | Держать один видимый локальный планировщик | Частный опыт сопровождения | RL-03 |
| 54 | [Reddit — 25 уроков coding](https://www.reddit.com/r/ClaudeCode/comments/1nrv3jl) | Узкое задание и независимая проверка помогают воспроизведению | Пользовательские обобщения | RL-02 |
