# 07 — nocoo 软件工厂真实调查（2026-09-16）

本报告来自 2026-09-15 UTC 的 GitHub API 实际调查，不是应用内固定数据。原始响应、逐仓明细与截图保留在本地 `.factory-cache/`，未纳入 Git。可用 [06 中的命令](06-software-factory.md)重新生成自己的调查。读取权限只证明当前凭证可见的仓库范围。

## 范围与规模

归属仓库完整遍历 12 个 GraphQL 分页：113 个可见归属仓库，排除 36 archived、9 个剩余非 archived fork、1 个 effective mirror `nocoo/rsshub`，纳入 67 个（62 public / 5 private）。这些排除计数互斥；archived 组内还可能带 fork 标记。

合计 `diskUsage` 2,475,951 KiB（2.36 GiB，GitHub 磁盘口径），Linguist 语言字节 85,771,935（85.77 MB）。固定默认分支头的历史提交合计 36,531，按仓库独立计数。66 个仓库在窗口内有提交；清单时点 66 个仓库在近 7/30/90 天内有 push。push 不是 commit 创建时间。

主语言仓库数：TypeScript 50、Swift 5、JavaScript 4、未标记 3、Python 2、HTML 2、Go 1。

| 语言 | Linguist 字节 | 字节占比 |
| --- | ---: | ---: |
| TypeScript | 67,597,589 | 78.81% |
| HTML | 4,343,782 | 5.06% |
| JavaScript | 4,237,723 | 4.94% |
| Swift | 3,171,554 | 3.70% |
| CSS | 2,029,745 | 2.37% |
| Python | 1,880,273 | 2.19% |
| Go | 1,180,426 | 1.38% |
| Rust | 819,096 | 0.95% |
| Shell | 421,673 | 0.49% |
| Astro | 49,291 | 0.06% |
| Dockerfile | 28,433 | 0.03% |
| PLpgSQL | 6,869 | 0.01% |
| Objective-C | 3,214 | 0.00% |
| PowerShell | 1,590 | 0.00% |
| Lua | 677 | 0.00% |

## 工作与交付

窗口 **[2026-06-18 00:00:00, 2026-09-15 22:12:27) UTC**，90 个日历日，最后一天不完整。提交固定为第一轮清单观察到的默认分支 SHA，按 committer date 筛选；所有作者，不是 nocoo 个人贡献。

| 指标 | 观测结果 |
| --- | ---: |
| 窗口默认分支提交 | 15,710 |
| 有提交的 UTC 日期 | 90 / 90 |
| 可关联 GitHub 作者身份数 | 4（包含 unlinked 分类时需按 API 归因理解） |
| 窗口 Issue 创建 / 最后关闭 | 6,897 / 6,896 |
| 窗口 PR 创建 / 合并 / 未合并关闭 | 3,486 / 3,265 / 226 |
| 合并 PR created→merged P50 / P90 | 3.23 分钟 / 1.576 小时，n=3,265 |
| 可见 workflow runs | 10,636 |
| CI success / 失败判定 / 其他 / 进行中 | 8,989 / 743 / 902 / 2 |
| CI 判定成功率 | 92.3654%（8,989 / 9,732） |
| 窗口 Release | 330，含 prerelease，不含 draft |
| 清单中全部可见 Release | 843 |
| 账号贡献日历 | 24,940；其中 restrictedContributionsCount=1,399 |

账号贡献覆盖整个 GitHub 账号，包含外部/被工厂排除仓库，与默认分支提交不能相加。CI 使用 API 可见的 workflow run 最新 attempt；删除或超保留期的 runs 无法恢复。

清单时点有 39 open / 8,774 closed issues；3 open / 4,154 merged / 295 closed-unmerged PR。后续完整 PR 明细有 4,453 条，比清单三种状态之和 4,452 多 1 条。这是 API 无原子快照时的实际变化，报告不强行“校平”。

所有 67 仓库的 commits/issues/prs/actions/releases/根依赖证据端点均完成分页，无容量截断。全部 67 个 Dependabot 告警端点不可用（403）；因此**安全告警总数未知**。根 package.json 可识别包名的仓库 59 个。指定路径未观察到 dependabot.yml / renovate.json，窗口内未观察到匹配 dependabot/renovate 身份的 PR；这不证明没有其他自动依赖维护机制。

## 实现的独立交叉验证

随后通过新实现的采集器再次完成 113 → 67 个仓库调查，记录 838 次逻辑请求。将第二轮明细重新聚合到第一轮相同时间窗口，Issue/PR 创建关闭、PR 合并、P50/P90、CI 的四个分类与 Release 全部一致。

仅默认分支提交相差 +4，均来自 `nocoo/gecko`。GitHub compare 确认第二轮固定头相对第一轮 ahead 5、behind 0：4 个提交的 committer date 在第一轮窗口内，但在第一轮固定头中尚不可达，另 1 个合并提交位于窗口外。不是重复分页计数。

- 第一轮头：`0060f8377573016d998847d5bb3ecc3e60ef2805`
- 第二轮头：`3d2506b1fb7738329d53260fd8b3dde41be9f84d`
- [GitHub compare 证据](https://github.com/nocoo/gecko/compare/0060f8377573016d998847d5bb3ecc3e60ef2805...3d2506b1fb7738329d53260fd8b3dde41be9f84d)

第一轮独立深度调查脚本记录 826 次调用（包括权限拒绝），另有 12 个成功清单分页及初始查询失败/只读检查请求。查询先使用较大 GraphQL 批次遇到 502，缩为每页 10 仓库后完成。采集器实跑还验证了 GitHub 将分页 Link 改写为 `/repositories/:numericId/...` 的行为；实现保留原仓库和原查询过滤条件，只采用合法连续页码。
