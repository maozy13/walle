# 技能（Skills）

技能是一个描述 Agent 如何调用 CLI、API 接口、或如何执行业务流的说明文档。技能可选附带可执行脚本（如 Shell、Python 或 Javascript）。

## 技能包

技能包以文件夹的形式存放，一个技能包是一个文件夹，文件夹内包含：

```
.
├── SKILL.md                          # 技能描述文件（必需）
├── scripts/                          # 技能脚本（可选）
│   ├── *.sh | *.py | *.js            # 脚本文件，任意可执行代码皆可
```

### SKILL.md

`SKILL.md` 是技能的核心文件，结构如下：

```md
---
name: ${技能名称}
description: ${技能描述}
---

{instructions}
```

`SKILL.md` 分为两块内容：

- "---" 之间的部分称为 "Frontmatter"，是一段 YAML 格式的元数据，用于描述技能本身。
- Frontmatter 之后是技能指令 `{instructions}`，技能指令详细描述 Agent 需要遵循的流程、规则和约束，Agent 只会在模型判断必要时读取技能指令。

#### Frontmatter 元数据

Frontmatter 元数据是以一对分割线 “---“ 包围的 YAML 结构。元数据必须包含 `name` 和 `description` 字段，用户也可以自行扩展其他元数据。

- `name` 属性必须和技能包目录的名称一致，且只支持小写字母、数字、连字符“-“。

## 扫描技能

技能包存放在以下位置，按优先级从高到底进行读取：

1. `{cwd}/.walle/skills` 目录
2. `{cwd}/.agents/skills` 目录
3. `~/.walle/skills` 目录
3. `~/.agents/skills` 目录

Agent 启动时从以上位置增量读取技能包，但遇到同名技能包时，只保留位置优先级更高的技能包。

读取技能包时，扫描技能包目录下所有的 `*/SKILL.md` 文件。从每个 SKILL.md 的 Frontmatter 提取 `name` 和 `description` 属性和 `SKILL.md` 的绝对路径 `location`。

使用以下模板构建技能的 `catalog`，并注入到 `activate_skill` 工具的 `description` 中：

```
available_skills:
  % for (name, description) in skills %
  - name: ${name}
    description: ${description}
  % end %
```

注意：`location` 属性不需要注入到 `description`。

## activate_skill(name)

`activate_skill(name)` 工具根据 `name` 从收集到的技能元数据中检索技能，然后根据 `location` 属性读取完整的 `SKILL.md`，截去 Frontmatter，返回 {instructions} 部分。