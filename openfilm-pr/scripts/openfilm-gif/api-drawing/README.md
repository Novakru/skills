# 复现 API 绘图实测

用于检查 OpenFilm 画布的参考图能否进入 OpenRouter 生图请求，以及生成图是否原样保存到画布。[原始 issue 评论及录屏](https://github.com/openfilm/openfilm/issues/476#issuecomment-6907097920)

`example.json` 保留原实验的模型、提示词、宽高比、参考图顺序和文件哈希。`fixtures/` 提供原来实际发送的三张公开照片，按小黄鸭、红色咖啡杯、向日葵排序。[素材来源和许可](fixtures/CREDITS.md)

## 实时录制

准备 Node.js 22.18 或更高版本、FFmpeg 和 ffprobe，以及已构建 Studio UI 并安装 Playwright Chromium 的 OpenFilm checkout 或 npm 包。原实验基于 [OpenFilm 0.3.2 源码提交](https://github.com/openfilm/openfilm/tree/0bc08008d933af7d42ef73a53cae384e2f54e6eb)。从 checkout 构建时，用项目指定的 pnpm 执行 `pnpm install --frozen-lockfile`、`pnpm --filter openfilm build:ui`、`pnpm --filter openfilm exec playwright-core install chromium-headless-shell`。

在当前进程环境配置有效的 `OPENROUTER_API_KEY`。`--live` 启用真实请求，最多生成两张图，每次一张。运行前查看 [FLUX.3 当前价格](https://openrouter.ai/api/v1/images/models/black-forest-labs/flux-3-image/endpoints)。凭据由进程读取，示例配置及生成日志只保存验证所需数据。

从 `openfilm-pr/` 运行，指定新建或空输出目录：

```sh
node scripts/openfilm-gif/api-drawing/capture.mjs --openfilm ../../openfilm --out ../../api-drawing-run --live
```

第一次从 Studio 后端调用同一模型和提示词，参考图数量为 0。第二次在真实 Chromium 内选择连接三张照片的画布节点，用鼠标点击 Make。右侧录制辅助栏显示实际 HTTP 请求／响应摘要。脚本核对两次各返回一张图，三张输入图片哈希与配置一致，画布保存的图片哈希与第二次 API 返回一致。

输出 `workflow.webm`、`workflow.gif`、`workflow-full.mp4`、两张 `api-result-*` 原图、`workflow.png` 和 `network-calls.json`、`results.json`、`export.json`、`media-qa.json`。检查两次 HTTP 200、输入图片数 0 和 3、两张输出图片和保存哈希。模型生成有随机性，图片构图和用量以本次响应为准。

## 离线重导出

在新目录保留同一轮的 `workflow.webm` 和 `export.json`，运行下面的命令。`--input` 可指定原始录像的其他位置。GIF 默认剪去中段等待，`--keep-wait` 保留它，MP4 总是保留操作及实际等待过程。已存在的输出不会被覆盖。

```sh
node scripts/openfilm-gif/api-drawing/export.mjs --out ../../api-drawing-export
```

## 历史实测

2026-11-16 在 Windows、Chromium 149.0.7827.55，用原版 OpenFilm 做了两次真实请求。两次 HTTP 200，各一张 1360×768 图片，各 US$0.048。无参考图生成三个普通杯子，带参考图生成小黄鸭、红杯和向日葵。两次 `prompt_tokens` 均为 62；图片发送由请求体和哈希确认。原始 GIF 为 25 fps，18.04 秒。整理后的入口在 Windows 用已保存的真实响应做离线回放核验，并从原始 WebM 重导出，整理阶段未重复计费。

同一 issue 的 Google GIF 是另一项实验。它在发送前捕获并中止请求，确认 OpenFilm 当时构造的请求仅含文本。这项证据属于本地请求检查，Google 云端生成未验证。
