# 把白昼送回去

在永夜的曙港，从一处露天铁矿白手起家。亲手采矿，造出第一台能替你工作的机器，再把采矿、加工和运输接成产线，把地面工厂制造的反射镜送上轨道。沿跨谷班线向远方供货，让曙港、谷东和西岭连续迎来三轮日出。地图、城市、机器和货物均由程序绘制。

当前模拟以 30 Hz 运行。新战役从手制铁锭、铜锭与铜线起步，接通首个电网后在设备上选择配方。V10 支持导入 V4 至 V9 战役档，导入的旧战役沿用原配方和建造目录。

## 本地运行

安装 Node.js 20 或更新版本与 Rust 工具链，然后执行以下命令。打开终端显示的本地网址。

```sh
rustup target add wasm32-unknown-unknown
npm ci
npm run dev
```

点矿石或它旁边的「采集」开始。档案菜单支持暂停、保存和导入导出。桌面和手机均可游玩。

## 构建与部署

```sh
npm run build
npm run test:bundle
npm run test:sim
npm run test:content
npm run preview
```

构建结果在 `dist/`。仓库推送至 GitHub 后，在 Pages 设置里选择 GitHub Actions，工作流会构建并发布到仓库子路径。

默认读取 `data/content.config.json`。可编辑其中的 `dataset`、指定数据文件，或设置环境变量 `DAYBREAK_CONTENT_CONFIG` 选择另一份配置。手动运行 Pages 工作流时也可填写 `content_config`。完整战役回归使用默认平衡数值，选用自定义数据时，工作流检查包内的模拟与数据版本及存档往返。[数据配置与验收](docs/data-driven-handoff.md)
