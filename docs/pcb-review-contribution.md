# PCB 复核与 Windows DSH 接入改进的来源和边界

这些增量基于 [zhoushoujianwork/easyeda-agent](https://github.com/zhoushoujianwork/easyeda-agent)，
比较基线为 `69af00c0db3960757bff36a68edb286adcd64458`。这是社区衍生改进，不代表
EasyEDA、DeepSeek、GitHub 或上游作者的官方产品/认可；上游已经具备 CLI、daemon、连接器、
DSH bundle/MCP/Skill 及线条形泪滴等功能，不能将它们标成此次原创。

本次增量限于：离线 PCB 快照差异复核、条件化的九项布线审查规范、源码副本的无 Bash MCP
配置助手，以及既有 Skill 链接安装器的显式 `dsh` 目标。MCP 助手不发明新的 EDA 接口，不更改
闭源 EDA，不绕过软件授权或安全设置，不自动编辑真实电路。

## 从实际返工提炼的失败模式

| 观察到的问题类型 | 通用修法与验证边界 |
|---|---|
| DRC 无报错，但必要孔或接口发生变化 | 前后对账实际对象与网络；`review-delta` 报变化供人判断，不自动判不合格。 |
| 删孔后独立阻焊开窗还在 | 同查两侧铜、阻焊、锡膏和钻孔；残留候选须核是否有意改为表面焊线盘。 |
| 用外接矩形代替长圆或异形铜 | 外框只作标注过的初筛；结论用真实轮廓，未知形状记 incomplete。 |
| 把通用外围或厂家常见阈值当要求 | 回对应型号/版本/工艺的原始资料，不把某块板的阻值、针脚和尺寸写成通用规则。 |
| 最终文件未生成，却拿旧快照放行 | 固定最终文档身份与文件散列，旧版只作差分；保存后重新加载并回读。 |
| 开发板跑通，被外推为生产板跑通 | 列明供电、封装、引脚、固件及恢复路径差异；实物验证独立于静态检查。 |
| 没有可靠操作接口，却给出猜测界面教程 | 区分亲测、当前官方文档与未验证推测；缺能力如实报告，优先可验证的 typed 接口。 |
| Skill、MCP 和 EDA 连接混为一谈 | 分别验证发现/读取、MCP 握手、目标 EDA 窗口与真实读写。混装前核重复 id/provider。 |

这些是去标识的经验总结，公开回归使用合成数据。完整聊天、私有板文件、账号、电脑路径、
器件坐标和现场 UUID 不作为公共示例上传。工具发现问题的实际范围须在输出中披露，不能把
人工审查规则宣传成已实现的自动检测，也不能据局部离线测试宣称可量产或整机可用。

## 公开提交要求

- 保留根目录 `LICENSE`、`NOTICE` 及第三方目录许可；上游整体 MIT，`extension/src/beautify/`
  保留其 Apache-2.0 许可与归属。未修改的第三方代码不改署名；新增改动说明真实作者和来源。
- GitHub 上展示明确的衍生关系、增量、测试结果和未验证项；只在有证据时使用兼容或性能声明。
- 不随包提交凭据、配置备份、原始会话/测试现场数据或未获许可的其他资料；只链接公开原始资料，
  不批量复制数据手册与他人教程。
- 按上游 `AGENTS.md`、现有贡献模板和授权范围提交聚焦改动；不批量自动发 issue/PR，不刷星、
  不冒充上游或官方组织。当前本地包不是已经公开的 Git ref，也不是上游正式 Release。

依据：[GitHub 使用条款](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)、
[可接受使用政策](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies)
以及参与 GitHub Community Discussions 时适用的[社区行为准则](https://docs.github.com/en/site-policy/github-terms/github-community-code-of-conduct)。
具体贡献还应遵守目标仓库自己的规则；本说明不代替许可文本，也不表示 GitHub 已审定此包。
