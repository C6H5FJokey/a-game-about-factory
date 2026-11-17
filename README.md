# 把白昼送回去

一款零位图资源的工厂网页游戏。首版从曙港矿区启动，覆盖运输链修复、镜阵发射、试照、日照补能和四个厂段的扩建。

## 本地运行

安装 Node.js 20 或更新版本与 Rust 工具链，然后执行以下命令。打开终端显示的本地网址。

```sh
rustup target add wasm32-unknown-unknown
npm ci
npm run dev
```

先点任务面板的「定位断点」，确认修好输送带。准备首次试照时，可在地面站附近预览蓄电池，等它充电再运行。档案菜单支持存档导入与导出，手机可以用底栏切换建造、电网和轨道。

## 构建与部署

```sh
npm run build
npm run test:sim
npm run preview
```

构建结果在 `dist/`。仓库推送至 GitHub 后，在 Pages 设置里选择 GitHub Actions，工作流会构建并发布到仓库子路径。

[完整游戏规格](docs/game-spec.md)
