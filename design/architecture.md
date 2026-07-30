# WallE

WallE 是一个 Agent 运行时框架。

## 架构

WallE 内部由以下模型构成：

- LLMConnector：用于连接各种 LLM API 服务，内部使用 [neuralink](https://github.com/maozy13/neuralink.git) 作为模型适配层。
- Tools：管理工具，仅 Agent 内部使用。提供列举工具和注册工具接口。

```mermaid
classDiagram

class Agent {
    llm: LLMConnector
    tools: Tools
    query(model, prompt)
}
```

## 工具使用

### 流程

Agent 使用工具按照以下流程执行：

```mermaid
sequenceDiagram

participant User as 用户
participant Agent
participant API as 模型 API 服务

User ->> Agent: 发送提示词

activate Agent
  Agent ->> Agent: tools.list()
  Agent ->> Agent: 调用模型适配层
  Agent ->> API: 请求选择工具
deactivate Agent

Agent ->> Agent: 执行工具

activate Agent
  Agent ->> Agent: 调用模型适配层
  Agent ->> API: 请求生成总结
deactivate Agent

Agent ->> User: 输出总结
```

## Tools

Tools 是 WallE 内部的工具管理模块，提供列举工具集及注册工具的接口。

WallE 内置 `bash` 工具，用于执行 CLI 命令。 `bash` 工具的设计参考 [bash](#bash)


## 使用示例
```typescript
import { Agent, Connector as LLM, ResponsesAPIConverter } from "walle";

const agent = new Agent({
    llm: new LLM({
        baseUrl: 'https://example.com/v1/responses',
        apiKey: process.env.LLM_API_KEY!,
        converter: new ResponsesAPIConverter(),
    })
})

for await event of agent.query('deepseek-v4-flash', '明天上海的天气怎么样？') {
    console.log(event.value.delta)
}

```

## 工具集

WallE 内置以下工具：

### **bash**<a id="bash"></a>
 
 用于执行 Bash 命令，接收 `command` 作为参数，返回 stdout 和 stderr。 Schema 定义如下：

 ```yaml
 name: bash
 description: |
    在当前工作目录执行一条 bash 命令，返回 stdout 和 stderr。
    出于安全考虑，只支持：ls、find、grep 等文件 read-only 命令，但禁止使用 edit、delete 类参数
    严禁执行任何权限命令：su、sudo、chmod、chown 等
    严禁执行任何删除命令：rm、rmdir 等
    严禁执行任何磁盘操作命令：mount、unmount、fdisk 等，但可以执行 du、df 等查看操作。
 parameters:
    - type: object
    - properties:
        - command:
            - type: string
            - description: 一条 bash 命令
 ```

