# 错题本（dsh-cuotiji）

DeepSeek Harness（DSH）插件：把试卷、作业、练习册变成可以按知识点反复查阅、可打印的错题集。

## 功能

- **上传并识别**：图片 / PDF / Markdown / 文本拖进面板，模型逐题识别入库；图片先在本机用 RapidOCR（PP-OCR）识别成文字，图片不上传服务器。
- **双轨保存**：结构化文本 + 原卷截图同时保存，题干逐字保留。
- **按知识点归集**：学科 → 册 → 章 → 节 → 知识点标签。
- **逐题复核**：点开题目对照原卷图修改题干、解析、答案与分类。
- **批量删除**：勾选任意多道题，一次删掉（连同各自的配图目录），删前需二次确认。
- **固定版式导出**：选中题后导出一题一页的 PDF / DOCX / HTML，原卷截图按题目动态缩放，选择题选项分行排版。

## 安装

### 从 npm 安装（推荐）
```bash
npm install dsh-cuotiji
```
或在 DSH 的「插件 → 添加插件」里直接填包名 `dsh-cuotiji`。
npm 官方源：`https://registry.npmjs.org/`；国内可用镜像：`https://registry.npmmirror.com/`（镜像自动同步 npm 官方源）。

### 从插件市场
在 DSH 的「插件 → 发现」中添加本仓库的 [index.json](index.json) 索引源，搜索「错题本」并安装（拉取的就是上面的 npm 包）。

### 本地目录
把本仓库克隆到本地，在「插件 → 添加插件」选择仓库根目录即可。

## 前置依赖（可选）

- **本地 OCR**：面板「交给模型识别」会尝试用本机 Python 的 `rapidocr_onnxruntime` 做本地 OCR；未安装时自动降级为直接读原图（模型看图识别）。可用环境变量 `CUOTIJI_PYTHON` 指定解释器。
- **PDF 导出**：优先用本机 Word / WPS 把 DOCX 转 PDF；都没有时用本机 Chrome / Edge 无头打印 HTML。

## 目录说明

| 路径 | 作用 |
|---|---|
| `index.js` | Host 半段：面板 API 路由、Agent 工具、斜杠命令 |
| `client.js` | Web 客户端面板 |
| `lib/` | 存储、导出、OCR、教材目录等实现 |
| `locale/` | 中英文展示元数据 |
| `docs/DETAIL.md` | 插件市场详情页 |

## 许可

MIT
