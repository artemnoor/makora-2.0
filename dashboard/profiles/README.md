# Профили тикетов

Версионированные Markdown-SKILL профили. Общий контракт полей тикета
(`goal`, `context`, `contract`, `writeScope`, `criteria`, `report`) сохраняется
дословно; профили меняют только упаковку. Персональные роли и «улучшающие»
переформулировки не добавляются.

| Профиль | Идентификатор | Версия | Роль | Псевдонимы для `control.cjs compile` |
| --- | --- | --- | --- | --- |
| `gpt-6.2-sol.v1.SKILL.md` | `gpt-6.2-sol` | `1.0.0` | оркестратор | `sol`, `gpt-6.2-sol`, `gpt-6.2` |
| `opencode-big-pickle.v1.SKILL.md` | `opencode/big-pickle` | `1.0.0` | исполнитель | `big-pickle`, `opencode/big-pickle`, `pickle` |

Каждый профиль содержит разделы:

- «Официальные рекомендации» — задокументированные правила;
- «Эмпирические наблюдения» — локальные замеры и наблюдения, не норма;
- «Рубрика оценки» — критерии с наблюдаемым результатом и серьёзностью;
- «Приём идей из других чатов» — явный приём через `idea.add` с идемпотентностью текста;
- «Передача этапа Figma» — два человеческих шлюза (`references_approved`, `figma_approved`)
  и явная блокировка при отсутствии подключения к Figma.

Сборка без сети:

```powershell
node dashboard/control.cjs compile sol ticket.json
node dashboard/control.cjs compile big-pickle ticket.json
```

На выходе JSON с полями `profile`, `version`, `prompt`, `ticket`.

Чтобы создать профиль для другой модели или обновить текущий, используй [model-prompt-profile](../../skills/model-prompt-profile/SKILL.md).
