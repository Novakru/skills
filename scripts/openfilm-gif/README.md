# OpenFilm Studio 的 GIF 对照录制

两次录制使用同一素材和场景。录制器分别启动隔离的 Studio，执行 Playwright 鼠标操作，并调用 FFmpeg 生成 GIF。

| 路径 | 用途 |
| --- | --- |
| [record.mjs](record.mjs) | 录制两个版本，保存视频、GIF 与测量结果 |
| [encode-gif.mjs](encode-gif.mjs) | 重新裁切和转换已有录屏 |
| [scenarios/waveform-height.mjs](scenarios/waveform-height.mjs) | #471 的轨道缩放操作、标注和验收断言 |

## 复现 PR #471

准备 Node.js 22.18 或以上、项目指定的 pnpm、FFmpeg，以及两个版本各自使用的 Playwright Chromium。从 skills 仓库根目录运行下面的命令。命令中的目录可替换。

安装官方稳定版和对应的 Chromium。

```sh
npm install --prefix ../waveform-before --no-save openfilm@0.3.2
node ../waveform-before/node_modules/playwright-core/cli.js install chromium-headless-shell
```

从 OpenFilm checkout 取 #471 的最终审阅提交，建立一个独立 worktree，安装依赖并构建 Studio。[#471 修订提交](https://github.com/openfilm/openfilm/pull/471/commits/926b26549ec0a54d7be4503d7a7a6ede9b3b1cfc) · [OpenFilm 环境配置](https://github.com/openfilm/openfilm/blob/main/CONTRIBUTING.md#quick-start)

```sh
git -C ../openfilm fetch https://github.com/openfilm/openfilm.git refs/pull/471/head
git -C ../openfilm worktree add --detach ../waveform-after 926b26549ec0a54d7be4503d7a7a6ede9b3b1cfc
pnpm --dir ../waveform-after install --frozen-lockfile
pnpm --dir ../waveform-after --filter openfilm build:ui
pnpm --dir ../waveform-after --filter openfilm exec playwright-core install chromium-headless-shell
```

使用一份至少 8 秒、有可辨识原声且可公开分享的 MP4。复用原演示素材时，从来源页下载视频，截取第 10–18 秒并保留原音量。它是演示素材，独立于 issue 报告里的素材。[Alex Meets the President，Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Alex_Meets_the_President.webm)

```sh
ffmpeg -ss 10 -i ../Alex-Meets-the-President.webm -t 8 -vf scale=640:360 -c:v libx264 -pix_fmt yuv420p -c:a aac ../waveform-example.mp4
```

将两个目录和同一个 MP4 传给录制入口。输出目录使用新建或空目录。`--before` 和 `--after` 都可以指向已构建的 OpenFilm checkout 或已安装的 OpenFilm npm 包目录。

```sh
node scripts/openfilm-gif/record.mjs --before ../waveform-before/node_modules/openfilm --after ../waveform-after --media ../waveform-example.mp4 --out ../waveform-gifs --scenario waveform-height --before-label "OpenFilm 0.3.2" --after-label "PR #471"
```

输出 `before.gif`、`after.gif`、原始 WebM 和 `measurements.json`。预期视频轨道从 36px 拉到 156px 时，稳定版的波形画布保持 13px，修订版从 13px 增至 40px。两版纯音频的画布均从 27px 增至 107px。场景同时核对实际波形像素、控件对齐、同高波形和音量。字幕、鼠标和描边均是录制标注。

已有录屏时可直接调整 GIF 的画面范围、开头裁切秒数与帧率。例如将此场景的 GIF 调至 8 帧每秒并输出新文件。

```sh
node scripts/openfilm-gif/encode-gif.mjs --input ../waveform-gifs/after.webm --output ../waveform-gifs/after-8fps.gif --trim 2 --crop 1280:500:0:400 --fps 8
```

## 复用到其他 Studio 改动

在 `scenarios/` 下新增名称对应的 `.mjs` 场景，再用 `--scenario <名称>` 选用。沿用现有示例的默认导出。`prepare({ folder, media, filmHtml })` 描述测试项目，`run({ page, caption, role, folder })` 执行操作、验证结果并返回可序列化的测量数据。按场景设置语言、视口和裁切范围。
