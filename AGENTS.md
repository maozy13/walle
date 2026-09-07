# WallE

你的任务是开发 Agent 运行时框架 WallE 

## 技术要求

- 使用 TypeScript 作为开发语言。
- 使用 pnpm 作为包管理工具。
- 使用 zod 作为 Schema 验证器。
- 每个函数及参数都必须有完整的文档注释。
- 单元测试行覆盖率必须达到 100%，条件覆盖率达到 95% 以上。
- 使用 [neuralink](@maozy13/neuralink) 作为模型适配层，仔细阅读代码仓库内的 README.md 和 docs/ 目录下的文档了解用法。

## 流程

- 总是从 `design/architecture.md` 开始了解整体的项目架构。
- 优先更新 `typings` 中的类型定义。

## 二、项目结构

```
.
├── AGENTS.md                         # 项目的基本要求
├── package.json                      # npm 脚本与依赖定义
├── references/                       # 项目依赖的外部 API
└── src/                              # 源代码
│   ├── tools/                        # 内置工具集
│   ├── memory-adapters/              # 内置记忆系统
│   ├── typings/                      # TypeScript 类型定义
```

## 限制

- `design` 目录是项目的唯一设计来源，禁止修改该目录下的任何内容。
- `demo` 必须使用真实的 API 进行连接，禁止使用 Mock 数据。