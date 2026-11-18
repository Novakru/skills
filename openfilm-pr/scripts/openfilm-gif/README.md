# OpenFilm GIF 功能索引

按要验证的操作和效果选择功能。命令从 `openfilm-pr/` 运行。每个功能目录提供输入准备、运行命令、预期输出和验收方法。

| 功能 | 适用场景 | 入口与复现说明 |
| --- | --- | --- |
| `api-drawing/` | 验证画布生图请求、参考图传递和返回图片 | [`api-drawing/capture.mjs`](api-drawing/capture.mjs) 录制真实调用，[`api-drawing/export.mjs`](api-drawing/export.mjs) 从已有录屏离线重导出。[复现步骤与实测记录](api-drawing/README.md) |
| `waveform-height/` | 验证 #471 轨道拉高时的波形变化及纯音频轨道行为 | [`record.mjs`](record.mjs) 加 `--scenario waveform-height`。[环境、素材和运行命令](waveform-height/README.md) |

共用的 [`record.mjs`](record.mjs) 启动独立 Studio，按功能场景录制前后两个版本，并可供其他入口定位已构建的 OpenFilm 包。[`encode-gif.mjs`](encode-gif.mjs) 用 FFmpeg 转码已有录屏，可独立运行：

```sh
node scripts/openfilm-gif/encode-gif.mjs --input ../../waveform-gifs/after.webm --output ../../waveform-gifs/after-8fps.gif --trim 2 --crop 1280:500:0:400 --fps 8
```

新增功能时在此目录下建同名子目录，将功能脚本、配置和复现说明放在一起。前后版本对照可提供 `<功能名>/scenario.mjs` 并传入 `--scenario <功能名>`，沿用波形场景的默认导出：`prepare({ folder, media, filmHtml })` 准备项目，`run({ page, caption, role, folder })` 执行操作、验证结果并返回测量。需要调用外部服务的场景可提供自己的功能入口，并调用共用转码函数。验证完成后同步更新此索引。
