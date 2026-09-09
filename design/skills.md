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

`SKILL.md` 是技能的描述文件，必须包含两部分内容：

1、front matter 元数据
2、技能正文

#### front matter 元数据

front matter 元数据是以一对分割线 “---“ 包围的 YAML 结构。元数据必须包含 `name` 和 `description` 字段，用户也可以自行扩展其他元数据。

- `name` 属性必须和技能包目录的名称一致，且只支持小写字母、数字、连字符“-“

## 扫描技能

技能包存放在以下位置，按优先级从高到底进行读取：

1. `{cwd}/skills` 目录
2. `{cwd}/.walle/skills` 目录
3. `~/.walle/skills` 目录
4. `~/.agents/skills` 目录

Agent 启动时从以上位置增量读取技能包，但遇到同名技能包时，只保留位置优先级更高的技能包。

读取技能包时，扫描技能包目录下所有的 `SKILL.md` 文件。从每个 SKILL.md 的 front matter 提取 `name` 和 `description` 属性，然后注入到上下文模板中：

```md

# 使用技能

## 使用规则

根据技能的 `name` 和 `description` 判断当前任务是否需要使用工具，如果有合适的技能：

1. 使用 `read_full_skill()` 工具读取完整的技能描述。
2. 判断技能的描述是否能够满足任务需求：
  2.1 如果能，则按照技能描述执行技能。
3. 根据需要，你可以一次加载多个技能，也可以在技能执行过程中按需加载其他技能。

## 技能列表

以下是可用的技能：
% for (name, description) of skills%
- name: %name%
  description: %description%
% end %

```

## read_full_skill()

`read_full_skill(name)` 工具根据 `name` 读取完整的 SKILL.md 文件并注入到上下文中。