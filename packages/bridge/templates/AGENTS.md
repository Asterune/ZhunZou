<!-- zhunzou:begin -->
# 准奏（Zhunzou）决策升级规则

本文件告诉 OpenCode：遇到需要人类拍板的卡点时，不要只在对话里问一句就停下，
而是把卡点提交到准奏（Zhunzou），由人类在看板上批复。

工具名以 `agent_hub_*` 开头。OpenCode 的 Code Mode 下通过 `tools.zhunzou.agent_hub_*` 调用。

> ⚠️ Code Mode 的系统目录是**部分目录**（会显示 `7 tools, 6 shown` 这类字样），
> `agent_hub_escalate` 经常不在目录里被逐条列出——**这不代表它不存在**。
> 看不到时先 `search({ query: "agent_hub_escalate" })` 拿到路径再调用；
> 绝对不要因为「目录里没看到这个工具」就放弃上奏、改在对话里直接问用户。

## 开始任务时（让看板显示真实状态）

- 如果任务是用户直接在当前编辑器里输入的，先调用 `agent_hub_report_task`，把
  `currentTask` 写成一句话（例如「修复登录页校验」），不要让看板一直显示「MCP 已连接」。
- 如果当前没有用户任务，或想领取看板下发的任务，调用 `agent_hub_next_task`。它会阻塞等待最多 40 秒：
  - 返回 `[TASK: RECEIVED] ...`：严格按任务里的 `Instruction` 执行，完成后调用 `agent_hub_complete_task`。
  - 返回 `[STATUS: NO_TASK]`：继续当前工作，稍后再试。
- 看板「下发任务」页创建的任务，必须通过 `agent_hub_next_task` 领取，不要凭空猜测。

## 会话开始

新会话、重启或断线重连后，先调用 `agent_hub_resume`：它会返回本环境未决/近期的奏折和仍在执行的任务。
如果有 `PENDING` 工单，立即用 `agent_hub_wait(ticketId)` 继续等待；如果有 `CLAIMED` 任务，继续执行并按约定回报。

## 何时升级

出现以下任一情况时，调用 `agent_hub_escalate`（Code Mode 目录里没列出时先 `search` 取路径）：

- 两个以上方案各有明显利弊，无法从现有规范推断；
- 涉及产品交互、API 契约、数据库 schema、删除功能、新依赖、部署/域名变更；
- 会改变现有对外行为，或难以回滚；
- 用户明确要求「先问我 / 等我确认」。

不要升级：格式化、纯内部命名、等价重构、补充测试或文档——按 `GLOBAL_RULES.md` 自行处理。

**不要在对话里抛出开放式问题后就结束回合。** 需要人类决定时，必须走 `agent_hub_escalate`，
让决策出现在准奏看板的「待批奏折」里。

## 如何升级

调用 `agent_hub_escalate`，必须提供：

1. `doneSummary`：刚刚完成了什么（一句话）。
2. `blockerQuestion`：当前卡点与具体分歧问题。
3. `nextStepPlan`：确认后的下一步计划。
4. `options`：2~4 个封闭选项，每项包含 `key`、`label`、可选 `prosCons`、可选 `risk`。
   - 删除数据、清空表、强制推送、生产配置等不可逆操作必须标 `risk: "destructive"`；
   - 有副作用但可回滚标 `risk: "caution"`；纯代码内重构可标 `risk: "safe"`。
5. `recommendedOption`：你推荐的方案 key。

禁止开放式提问，禁止只给一个选项；推荐方案必须真实存在于 `options` 中。

## 等待规则（必须严格遵守）

- 返回 `Decision Approved: Option [X] ...`：严格按该选项与 `Instruction` 继续实现，不要再次询问。
- 返回 `Ticket #N is pending human approval ... npx zhunzou-bridge wait --ticket N`：
  立即在终端执行该命令，等待 stdout 输出结果后再继续。
- 返回 `[STATUS: STILL_WAITING] ... agent_hub_wait(ticketId: N)`：
  立即调用 `agent_hub_wait` 继续等待；不要输出「等待人类回复」后结束任务。
- 返回 `Ticket #N was cancelled ...`：停止当前卡点相关工作，向人类请求新指令。

**等待期间绝对不要自行选择方案、不要继续实现、不要伪造审批结果。**

## 完成通知

- 看板下发的任务：调用 `agent_hub_complete_task(taskId, status: "DONE", result: "...")`；失败则传 `status: "FAILED"` 并说明原因。
- 普通任务：任务完成或进入空闲时，调用 `agent_hub_notify_done`，让看板状态灯变为 Idle。
<!-- zhunzou:end -->
