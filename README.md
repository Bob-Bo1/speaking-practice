# 口语跟练室 monorepo

这是口语跟练室的公开源码仓库。仓库继续使用 monorepo 结构，前端应用、SenseVoice 适配层和 FunASR 源码放在同一个工作区内。

## 目录

```text
apps/
├─ speaking-practice/  Astro 前端、本地服务和练习素材
├─ sensevoice/         本地 SenseVoice 适配层与 Python 项目配置
└─ funasr/             SenseVoice 使用的 FunASR 源码
scripts/               Windows 发布包与启动器构建脚本
```

练习素材保存在 `apps/speaking-practice/public/media`，会随源码仓库保留。模型、Python 虚拟环境、Node 依赖和发布包运行时不放进 Git 仓库。完整发布包会把这个源码目录、运行环境、模型和启动器放在同一个压缩包中。由于完整包体积较大，GitHub 仓库仍只上传本目录；完整包可放在其他文件存储中提供下载。

仓库已为练习视频和音频配置 Git LFS。上传前请先执行 `git lfs install`，完整步骤见 `GitHub上传说明.md`。

## 开发环境

需要 Windows、Node.js 22.12 以上、pnpm 10 和 Python 3.11–3.12。语音识别环境由 uv 管理。

```bash
pnpm install
pnpm dev
pnpm build
uv sync --project apps/sensevoice
pnpm transcription:check
```

默认前端地址为 `http://localhost:4321`。完整发布包用户无需安装这些开发依赖，解压后双击包根目录的 `口语跟练室.exe` 即可使用。

## 数据流水线

数据整理脚本位于 `apps/speaking-practice/scripts/build_dataset.py`。源视频目录默认是 `apps/speaking-practice/work/sources`，也可以通过 `SPEAKING_PRACTICE_SOURCE_ROOT` 指定外部目录。这样仓库可以独立运行，旧的采集项目不会成为必要依赖。

```bash
pnpm --dir apps/speaking-practice data:audit
pnpm --dir apps/speaking-practice data:transcribe
pnpm --dir apps/speaking-practice data:plan
pnpm --dir apps/speaking-practice data:render
pnpm --dir apps/speaking-practice data:validate
```

## 构建 Windows 发布包

把 Python 环境、SenseVoice 模型、yt-dlp、FFmpeg、FFprobe 和 Deno 准备好后，可以执行：

`-PythonRuntimeDirectory` 必须指向完整的独立 CPython 目录，里面要有 `python.exe`、Python DLL、标准库和 `DLLs`；不能填写 `apps/sensevoice/.venv`。如果第三方库安装在虚拟环境中，可以通过 `-PythonSitePackagesDirectory` 单独传入其 `Lib/site-packages` 目录。

```powershell
./scripts/prepare-release.ps1 `
  -PythonRuntimeDirectory 'D:\path\to\python-runtime' `
  -PythonSitePackagesDirectory 'D:\path\to\site-packages' `
  -ModelDirectory 'D:\path\to\sensevoice-model' `
  -ModelPackageOutputDirectory 'D:\path\to\model-package' `
  -JavaScriptRuntimePath 'D:\path\to\deno.exe'
```

完整发布包会把运行目录和模型放在正确位置，解压后直接双击 `口语跟练室.exe`。网址导入和本地视频导入仍由随包的 yt-dlp、FFmpeg、FFprobe 和本地 SenseVoice 完成。

## 许可说明

FunASR 和 SenseVoice 的许可文件保存在各自的应用目录中。完整发布包还会携带 Python 依赖和运行工具的许可文件；发布前请同时查看 `第三方组件说明.md`。
