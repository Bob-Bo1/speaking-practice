# GitHub 上传说明

请把完整发布包里的 `源码` 文件夹作为 GitHub 仓库根目录。现有练习素材已经保留，其中有视频文件超过普通 GitHub 文件上限，仓库已加入 `.gitattributes`，上传前需要安装并启用 Git LFS。

```bash
git lfs install
git init
git add .
git commit -m "发布口语跟练室 monorepo"
git branch -M main
git remote add origin <你的 GitHub 仓库地址>
git push -u origin main
```

源码仓库不包含 Node 依赖、Python 虚拟环境、模型和生成后的 `dist`。完整发布包把源码和可运行环境合在一起，适合直接给观众使用。当前完整包约 4.03 GB，超过 GitHub Release 单个文件 2 GiB 的限制，不能直接作为一个 Release 资产上传；GitHub 仓库上传本 `源码` 目录即可。
