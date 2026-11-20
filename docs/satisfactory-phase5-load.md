# 用《幸福工厂》终章估算压力样本

以四条交付线和全部上游同时生产、处理机最高 100% 时钟为口径。用铝锭转制 Ficsite Ingot 的方案，**稳定运行两小时交付需要 1,821 台处理机，平均运输 15 秒时约有 20,128 件固体同时在途**。按速通录像约一小时的时间尺度，估算升到 **3,480 台和约 38,854 件在途**。机器数与在途量是按下面的配方和运输假设计算的工况。

## 数据来源

Coffee Stain 的 1.0 发布说明将太空电梯第五阶段列为 Project Assembly 终章，开放第 9 层。默认交付量为核意面 1,000、Biochemical Sculptor 1,000、AI Expansion Server 256、Ballistic Warp Drive 200。1.2 可单独调整交付与配方成本倍数，两者默认都是 1×。本次计算固定使用 1.0 游戏数据和 1× 交付量。[Coffee Stain 1.0 发布说明](https://store.steampowered.com/news/posts/?appgroupname=Satisfactory&appids=526870&enddate=1730976779&feed=steam_community_announcements) · [交付量表](https://satisfactory.wiki.gg/wiki/Space_Elevator#Project_Assembly_phases) · [Coffee Stain 1.2 设置说明](https://store.steampowered.com/news/posts/?appgroupname=Satisfactory&appids=526870&enddate=1781158052&feed=steam_community_announcements)

配方取自 SatisfactoryTools 对游戏随附类描述 `CommunityResources/Docs/` 的解析数据。锁定提交 `74b691c82ed69030f32cd9419d8c327c878e2ac8`，文件 SHA-256 为 `4caf63ba1cfd495eb33534fd5d1ae92631e786e72ad833e39357cb5194faa35f`。机器、周期、投入和多项产出来自 `recipes`，是否走管道来自 `items` 的 `liquid` 标记，直接开采资源以 `resources` 为准。交付量单独用电梯阶段表核对。[版本锁定的数据](https://raw.githubusercontent.com/greeny/SatisfactoryTools/74b691c82ed69030f32cd9419d8c327c878e2ac8/data/data1.0.json) · [解析器的数据来源说明](https://github.com/greeny/SatisfactoryTools#updating-data) · [游戏随附数据目录](https://satisfactory.wiki.gg/wiki/Community_resources#Docs_files)

| 终端产品（游戏数据名） | 默认交付量 | 100% 时钟下的配方机器 | 每批 | 周期 | 单机产量（件/分钟） |
| --- | ---: | --- | ---: | ---: | ---: |
| Nuclear Pasta | 1,000 | Particle Accelerator | 1 | 120 秒 | 0.5 |
| Biochemical Sculptor | 1,000 | Blender | 4 | 120 秒 | 2 |
| AI Expansion Server | 256 | Quantum Encoder | 1 | 15 秒 | 4 |
| Ballistic Warp Drive | 200 | Manufacturer | 1 | 60 秒 | 1 |

Ballistic Warp Drive 每件消耗 5 个 Singularity Cell。每批 10 个 Singularity Cell 消耗 1 份 Nuclear Pasta，因此完成交付需要实际生产 1,100 份 Nuclear Pasta。核意面的单批铜粉投入为 200，整阶段单是核意面就需要 220,000 铜粉与 1,320,000 铜锭。数据中的三个 Ficsite Ingot 来料选项都可用于常规生产，复算时应明示选用的来料。[版本锁定的配方数据](https://raw.githubusercontent.com/greeny/SatisfactoryTools/74b691c82ed69030f32cd9419d8c327c878e2ac8/data/data1.0.json)

## 时间尺度与并行假设

koouu 的 1.1 单人 Any% NMG 录像把第五阶段起点标在 `05:53:21`，把最终完成标在 `06:55:31`，相差 **62 分 10 秒**。榜单验证的全程为 **6 小时 55 分 12 秒**，采用普通蓝图，附有崩溃和分段录像说明。本计算用录像分章选择一个快工况。跑者的备货、施工顺序、超频和共享产线会改变实际需要的安装量。 [跑者录像的第五阶段](https://www.youtube.com/watch?v=OvfBALgLLUE&t=21201s) · [榜单计时与规则](https://www.speedrun.com/satisfactory/runs/ydpe0rqy)

- 四条交付线与所有上游在管线填满后同时生产。各线从原矿和流体开始计算，合并共享上游需求，阶段零件的前期备货按零计。设定的窗口是稳态生产时长，建造、通电、启动和末批运达用时另计。
- 默认配方加明确选定的铝制 Ficsite Ingot，总计 68 道工序。各配方独立分配机器，按 100% 单机产能向上取整，末台可以低于满负荷。水、二氧化硅和暗物质残渣回用于有需求的工序。重油残渣经炼油厂制成石油焦，送往回收器。脚本核对所有输入、输出与副产物的平衡。
- 表中的处理机包含这段副产物加工。固体采集另按普通纯度 Mk.3 单机 240 件/分钟折算，实际需要的矿机数取决于节点纯度和超频。抽水、抽油、油井压力机、回收器、发电与物流装置另计。最快工况的整条线需要 **26,150 铜矿/分钟**，发电和矿区布局仍需满足原料连续到厂的假设。[固定版本的配方与矿机资料](https://raw.githubusercontent.com/greeny/SatisfactoryTools/74b691c82ed69030f32cd9419d8c327c878e2ac8/data/data1.0.json)

## 机器数、吞吐与同时在途

对某道配方，先把上游、下游和最终交付对它的需求合并，再按 `机器数 = 向上取整(总批数 × 单批周期 / 稳态窗口)` 分配。满载当量使用向上取整前的数值求和。

固体流量按每件物料从来源到下一工序的交接计一次。最终送到电梯和副产品送回收器也计入。用**流量加权平均运输时间**估算带上占用。各段在途量等于该段通过率乘以停留时间，累加后可写成 `平均在途件数 = 全厂固体交接件/分钟 × 平均运输秒数 / 60`。固体缓冲库存、机器内库存和流体管道分别计量。表值是稳态平均，实际堵塞和批量释放会产生峰值。[Little 定律原文](https://doi.org/10.1287/opre.9.3.383)

| 稳态窗口 | 处理机台数 | 满载处理机当量 | 普通纯度 Mk.3 矿机折算 | 固体交接件/分钟 | 在途 5 秒 | 在途 15 秒 | 在途 30 秒 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 62 分 10 秒 | 3,480 | 3,442 | 252 | 155,415 | 12,951 | 38,854 | 77,708 |
| 2 小时 | 1,821 | 1,783 | 133 | 80,514 | 6,709 | 20,128 | 40,257 |
| 4 小时 | 929 | 892 | 68 | 40,257 | 3,355 | 10,064 | 20,128 |

62 分 10 秒的处理机中有 1,355 台 Constructor、1,119 台 Smelter、350 台 Assembler、276 台 Refinery、143 台 Manufacturer、131 台 Foundry、53 台 Particle Accelerator、27 台 Blender、19 台 Converter 和 7 台 Quantum Encoder。把 Ficsite Ingot 改成铁路线时，同一窗口为 **3,573 台**、**159,889 件/分钟**，按 15 秒得约 **39,972 件在途**。两小时窗口在铁路线下为 **1,868 台、约 20,708 件在途**。产线分布与配方分支会影响机器类型和单段吞吐。[可复算模型](../scripts/estimate-satisfactory-phase5.mjs)

快工况还需要约 3,597 m³/分钟的外部水、5,436 m³/分钟的原油和 1,086 m³/分钟的氮气。按水和原油 120 m³/分钟、氮气 60 m³/分钟折算为 95 台流体抽取设备。与处理机、固体矿机折算合计约 3,827 台，供电、回收与油井压力机另计。上表的在途量统一按固体经传送带交接估算。采用列车、无人机或不同走线长度时，应按实际去向和停留时间重算。[矿机与抽取器数据](https://raw.githubusercontent.com/greeny/SatisfactoryTools/74b691c82ed69030f32cd9419d8c327c878e2ac8/data/data1.0.json)

## 映射到本项目的压力样本

本项目每条运输通道在每格最多容纳一件在途货物。假设各段稳态平均占用 **40%–60%** 作两档布线估算。实际样本以运行中采集的占用比例为准。交叉器的两条通道各算一个位置。[运输段表示](../sim/src/belts.rs)

| 工况 | 同时调度的设备 | 固体跨工序交接 | 平均在途货物 | 通道位置估算 |
| --- | --- | ---: | ---: | ---: |
| 两小时并行产线 | 约 1,800 台处理机，另有原料和供电设备 | 约 1,342 件/秒 | 约 20,000 | 约 34,000–50,000 |
| 约一小时快工况 | 约 3,500 台处理机，另有原料和供电设备 | 约 2,590 件/秒 | 约 39,000 | 约 65,000–97,000 |

- **常态密集样本**可用两小时工况。约五万通道位置与两万在途货物对应约四成占用，和原规格的物流量同阶。这条参考产线的处理机规模约 1,800 台。另记录机器实际运转数、配方周期分布和供电区，避免仅以地图上安放的机器数计负载。
- **复合压力样本**可用约一小时工况。把长程干线和多工序端点同时做满，用约 3,500 台处理机和约 40,000 件在途货物验证模拟，并另测镜头覆盖范围内的可视实例数。每秒约 2,590 次跨工序交接，在 30 Hz 下平均约 86 次/步，周期同步时应记录峰值。
- **样本构成**保留持续产出和消耗的开放链路、分流与多入口合流、快慢带切换以及多个供电区。分别测稳态、下游堵塞后重启、批量建设与拆线。持续测量货物交接、就绪机器、库存和堵塞。目前已在独立构建中实测接近两小时档的开放链路。1,316 格闭环、560 件货物的发布地图场景继续用于浏览器复测。[扩容实测](quality-baseline.md#两小时档的扩容模拟) · [浏览器实测](quality-baseline.md#浏览器实测)

## 复算

```powershell
New-Item -ItemType Directory -Force -Path docs/performance.local
$recipeSource = 'https://raw.githubusercontent.com/greeny/SatisfactoryTools/74b691c82ed69030f32cd9419d8c327c878e2ac8/data/data1.0.json'
$recipeData = 'docs/performance.local/satisfactory-1.0.json'
Invoke-WebRequest -Uri $recipeSource -OutFile $recipeData
node scripts/estimate-satisfactory-phase5.mjs $recipeData aluminum 3730 7200 14400
node scripts/estimate-satisfactory-phase5.mjs $recipeData iron 3730 7200 14400
```

输出含数据哈希、每种配方的机器分配、每种原料和中间品的流量、流体吞吐与不同运输时长对应的在途量。
