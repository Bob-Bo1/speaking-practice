# 口语跟练室

这是 monorepo 里的口语练习应用，使用 Astro 和 React 构建。内置示例素材放在 `public`，用户导入的内容放在运行包根目录的 `user-data`。

## 本地开发

在源码仓库根目录执行：

```bash
pnpm install
pnpm --filter speaking-practice dev
```

构建静态页面：

```bash
pnpm --filter speaking-practice build
```

## 运行包

观众直接双击运行包根目录的 `口语跟练室.exe` 即可。备用入口是 `口语跟练室.cmd`。程序会启动本机服务，并把用户数据保存在 `user-data`。

网址导入使用随包工具，本地字幕识别使用 `models\\sensevoice` 中的模型。服务只监听 `127.0.0.1`，视频处理在本机完成。

## 中文翻译

中文翻译接口由使用者自行填写接口地址、API Key 和模型名称。配置只保存在当前电脑的浏览器本地存储中，发布包和训练素材里都不包含这些信息。
