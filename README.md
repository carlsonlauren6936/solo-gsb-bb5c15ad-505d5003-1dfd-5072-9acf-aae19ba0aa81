# 走台排程 · 小剧场提示点调度 Web 应用

录入每个**提示点（Cue）**的时长、最早开始时间、前置提示点和最晚完成时间，系统按依赖
关系自动计算每项的**最早开始 / 最早结束时间**；修改任一项后立即重新排程。发现**环依赖**
时指出涉及的提示点与环路，并自动标出**超过最晚完成时间**的项目。每个提示点还可填写多名
**演员**，系统自动检查同一演员是否被排到**时间重叠**的提示点（演员走位冲突），并在列表、
打印走台单与接口中标出。提供按开始时间排序的**走台单**和专用**打印视图**（可直接打印或
另存为 PDF）。

技术栈：Node.js + Express + SQLite（better-sqlite3）+ 原生 HTML/CSS/JavaScript（无前端构建）。

---

## 一条命令启动

```bash
docker compose up -d --build
```

容器启动时会自动执行 `npm install` 安装依赖，并在首次启动时初始化数据库、建表
（空库时写入 6 条示例提示点，可用环境变量关闭，见下）。

启动后打开：

- 排程页面（录入 / 编辑 / 重排）：<http://localhost:3000>
- 走台单 / 打印视图：<http://localhost:3000/print>

停止：`docker compose down`（数据保留在命名卷 `cue-data` 中；加 `-v` 可同时删除数据）。

> 本机 3000 端口被占用时：`PORT=8080 docker compose up -d --build`，
> 然后访问 <http://localhost:8080>。

## 不用 Docker 的本地启动

需要 Node.js 20+：

```bash
npm install
npm start
```

同样访问 <http://localhost:3000>。

---

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DB_PATH` | `data/app.db` | SQLite 数据库文件路径（容器内为 `/app/data/app.db`，已挂载命名卷） |
| `SEED_SAMPLE` | `true` | 首次启动且数据库为空时写入示例数据；设为 `false` 可得到空库 |

Compose 下修改示例数据开关：在 `docker-compose.yml` 的 environment 中改 `SEED_SAMPLE`，
或复制后自行调整。

---

## 使用说明

### 时间格式（所有时间均以开排零点 `00:00:00` 起算的相对时间）

- **时长**：纯数字按**分钟**（如 `10` = 10 分钟）；也支持 `MM:SS`（`1:30`）与 `H:MM:SS`（`1:02:30`）。
- **最早开始 / 最晚完成**：`HH:MM:SS`（如 `30:00` = 开排后 30 分钟）、`MM:SS` 或纯秒。
- 最早开始留空按 `00:00:00`；最晚完成留空表示不限。

### 排程规则

- 一项提示点的最早开始时间 = max(自己录入的最早开始时间, 所有前置提示点的最早结束时间)。
- 最早结束时间 = 最早开始时间 + 时长。
- 表格始终按**计算出的最早开始时间**升序排列，即走台执行顺序；“浮动”为最晚完成 − 最早结束
  （负值显示为超时）。
- 修改任意提示点（时长 / 最早开始 / 前置 / 最晚完成）后，保存即对所有项目重新排程。
- **环依赖**：环上项目标红并显示徽标“⚠ 环依赖”，页面顶部红色横幅列出涉及的全部提示点及
  一条具体环路（如 `Q2 → Q3 → Q2`）；依赖链上被环卡住的项目标记为“环阻塞”，二者在解除
  环前不参与排程。
- **超时**：最早结束时间晚于最晚完成时间时，整行高亮、结束时间标红并显示“⚠ 超过最晚完成”。

### 演员与时间冲突检查

- 新增 / 编辑提示点时，在**演员**一栏填写一名或多名演员（用逗号、顿号、分号或换行分隔，
  如 `林晓、周航`），保存后存入 SQLite 并显示在列表的“演员”列。
- 系统按 `/api/schedule` 算出的**计算开始 / 计算结束**时间，逐演员检查其参演的提示点是否
  时间重叠；判定采用半开区间——**结束时间恰好等于另一项的开始时间不算冲突**。
- **环依赖及被环阻塞的提示点没有有效时间，不参与冲突检查。**
- 发现冲突时：页面顶部出现琥珀色横幅，列出冲突演员、两项提示点与重叠时段；统计区显示
  冲突处数；列表中相关行高亮、状态列出现“⚠ 演员冲突”徽标，冲突中的演员姓名标红；
  打印走台单同样保留冲突横幅、行高亮与“⚠ 演员冲突”标记。
- 修改演员、时长或前置关系并保存后，冲突结果随排程自动刷新。
- 接口：`GET /api/schedule` 的响应中包含 `conflicts` 数组（每项含 `actor`、`cueA`、`cueB`、
  `overlapStart`、`overlapEnd`，时间均为相对开排零点的秒数），每个提示点上另有
  `conflictActors` 字段；`GET /api/conflicts` 单独返回该冲突数组。

### 延误推演（仅内存模拟，不保存）

- 在排程页面「**延误推演（仅模拟，不保存）**」卡片中选择一个**已排程提示点**作为延误起点，
  填写相对其**当前计算开始时间**的非负延误量（格式与时长输入一致：纯数字按分钟，
  也支持 `MM:SS` / `H:MM:SS`，如 `10` = 10 分钟、`1:30` = 1 分 30 秒），点击「开始推演」。
- 推演时仅在内存中把起点的最早开始约束提高到「原计算开始时间 + 延误量」，随后**复用现有
  排程与演员冲突计算**重新推演；不写入数据库，刷新或清除推演即恢复正式排程。
- 结果区展示：
  - **受影响提示点**的原排程与模拟排程开始 / 结束时间及变化量（`+H:MM:SS`）；
  - 单独列出**新增超时**（原本未超最晚完成、推演后超过）与**新增演员时间冲突**
    （推演后才出现的同演员时间重叠对）；
  - 推演期间下方走台单切换为模拟排程，受影响行高亮并在时间单元格标注变化量。
- **正式排程中已存在的超时与演员冲突在推演期间仍可见**（顶部横幅、行高亮、徽标），
  但**不计为新增**。
- **环上或被环阻塞的提示点不可作为起点**（下拉框中置灰）；延误量为负、格式无法识别、
  未选择起点等非法输入会在推演卡片内给出提示。
- 点击「**清除推演**」立即恢复正式排程；在推演期间新增 / 编辑 / 删除提示点会自动清除推演。
- 接口：`POST /api/schedule/simulate-delay`，请求体 `{ "cueId": 1, "delay": "10" }`
  （`delay` 为时间字符串：纯数字按分钟，与时长录入规则一致；也接受非负数字值，同样按分钟计）。响应含 `target`（起点及延误量）、`affected`（受影响提示点
  的 `baseStart/baseFinish/simulatedStart/simulatedFinish/deltaStart/deltaFinish/newOverdue`
  等）、`newOverdue`、`newConflicts`（结构同 `/api/conflicts` 条目），并附带完整的
  `baseline` 与 `simulated` 排程结果；非法输入返回 `400`，提示点不存在返回 `404`。

### 打印视图

<http://localhost:3000/print> 提供干净的 A4 走台单（含日期 / 场地 / 舞台监督签名栏与逐项
状态栏），点击“🖨 打印 / 另存为 PDF”即可。环依赖、超时与演员冲突标记会保留在打印结果中。

---

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/cues` | 提示点列表（原始录入，含演员名单） |
| `GET` | `/api/cues/:id` | 单个提示点 |
| `GET` | `/api/schedule` | 完整排程结果（含计算时间、超时 / 环标记、环路与演员冲突 `conflicts`） |
| `GET` | `/api/conflicts` | 演员时间冲突列表（演员、两项提示点、重叠时段） |
| `POST` | `/api/schedule/simulate-delay` | 延误推演（纯内存，不写库）：`{ "cueId": 1, "delay": "10" }`，返回受影响提示点的原/模拟时间与变化量、新增超时与新增冲突 |
| `POST` | `/api/cues` | 新增提示点 |
| `PUT` | `/api/cues/:id` | 修改提示点（前置列表、演员名单全量替换，保存后自动重排并重查冲突） |
| `DELETE` | `/api/cues/:id` | 删除提示点（相关依赖与演员记录一并删除） |

新增 / 修改请求体示例：

```json
{
  "ref": "Q6",
  "title": "第二场灯光转换",
  "duration": "5:30",
  "minStart": "30:00",
  "maxFinish": "55:00",
  "actors": ["林晓", "周航"],
  "prerequisites": [2, 5]
}
```

`duration` 也可传整数秒；`minStart` / `maxFinish` 同样接受整数秒；`actors` 为演员名字数组
（可省略，单个提示点最多 20 名，每个名字最长 30 字）。

`GET /api/conflicts` 响应示例：

```json
[
  {
    "actor": "周航",
    "cueA": { "id": 2, "ref": "Q2", "title": "第一场演员走位", "earliestStart": 900, "earliestFinish": 2100 },
    "cueB": { "id": 6, "ref": "Q6", "title": "台词专项排练", "earliestStart": 1500, "earliestFinish": 2400 },
    "overlapStart": 1500,
    "overlapEnd": 2100
  }
]
```

`POST /api/schedule/simulate-delay` 响应示例（节选）：

```json
{
  "target": {
    "id": 6, "ref": "Q6", "title": "台词专项排练", "delay": 1500,
    "baselineStart": 1500, "baselineFinish": 2400,
    "simulatedStart": 3000, "simulatedFinish": 3900
  },
  "affected": [
    {
      "id": 6, "ref": "Q6", "title": "台词专项排练",
      "baseStart": 1500, "baseFinish": 2400,
      "simulatedStart": 3000, "simulatedFinish": 3900,
      "deltaStart": 1500, "deltaFinish": 1500,
      "baseOverdue": false, "simulatedOverdue": false, "newOverdue": false,
      "newConflictActors": ["周航", "陈默"]
    }
  ],
  "newOverdue": [],
  "newConflicts": [
    {
      "actor": "陈默",
      "cueA": { "id": 5, "ref": "Q5", "title": "谢幕定位", "earliestStart": 3300, "earliestFinish": 3780 },
      "cueB": { "id": 6, "ref": "Q6", "title": "台词专项排练", "earliestStart": 3000, "earliestFinish": 3900 },
      "overlapStart": 3300,
      "overlapEnd": 3780
    }
  ],
  "baseline": { "cues": [ "…完整正式排程（结构同 /api/schedule）…" ], "cycle": null, "conflicts": [] },
  "simulated": { "cues": [ "…完整模拟排程…" ], "cycle": null, "conflicts": [] }
}
```

## 项目结构

```
.
├── Dockerfile
├── docker-compose.yml
├── docker-entrypoint.sh   # 启动时 npm install 并启动服务
├── package.json
├── src
│   ├── server.js          # Express 路由与参数校验
│   ├── db.js              # SQLite 建表、CRUD、事务、示例数据
│   ├── scheduler.js       # 拓扑排程、Tarjan 环检测、超时判定、演员冲突检测
│   └── timeutil.js        # 时间解析与格式化
└── public
    ├── index.html         # 排程主页面
    ├── print.html         # 走台单打印视图
    ├── css/style.css
    └── js/{common,app,print}.js
```
