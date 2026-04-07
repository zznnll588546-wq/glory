# 荣耀手机 - 维护与开发指南

## 项目概述

全职高手沉浸式角色扮演PWA手机模拟器。纯前端应用，使用 HTML5/CSS3/Vanilla JS (ES Modules)，数据存储于 IndexedDB，可部署到 GitHub Pages。

## 目录结构

```
├── index.html              # SPA入口，PWA Shell
├── manifest.json           # PWA清单（安装到主屏幕）
├── sw.js                   # Service Worker（离线缓存）
├── MAINTENANCE.md          # 本文件
├── css/
│   ├── variables.css       # 主题变量（颜色、圆角、间距、深色模式）
│   ├── global.css          # 全局样式、布局工具类、动画
│   ├── components.css      # 通用组件样式（气泡、导航栏、卡片、表单等）
│   └── pages.css           # 各页面专属样式
├── js/
│   ├── app.js              # 应用入口（路由注册、初始化、主题加载）
│   ├── core/
│   │   ├── db.js           # IndexedDB封装（CRUD、导入导出）
│   │   ├── api.js          # LLM API客户端（OpenAI兼容、流式传输）
│   │   ├── router.js       # 基于Hash的SPA路由
│   │   ├── state.js        # 全局状态管理（订阅/发布模式）
│   │   ├── storage.js      # 备份导入导出（JSON）
│   │   ├── background.js   # 后台保活（Web Worker + visibilitychange）
│   │   └── context.js      # 上下文组装引擎（世界书+角色卡+记忆+预设）
│   ├── models/
│   │   ├── user.js         # 用户档案模型
│   │   ├── character.js    # 角色定义模型
│   │   ├── chat.js         # 聊天/消息模型
│   │   ├── worldbook.js    # 世界书条目模型
│   │   ├── timeline.js     # 时间线/赛季数据
│   │   └── memory.js       # 记忆/总结模型
│   ├── pages/              # 各功能页面（每个文件导出 default async function）
│   │   ├── home.js         # 主屏幕（应用网格）
│   │   ├── chat-list.js    # 消息列表
│   │   ├── chat-window.js  # 1v1聊天窗口
│   │   ├── group-chat.js   # 群聊窗口
│   │   ├── contacts.js     # 通讯录
│   │   ├── weibo.js        # 微博
│   │   ├── forum.js        # 论坛
│   │   ├── moments.js      # 朋友圈
│   │   ├── schedule.js     # 赛程表
│   │   ├── timeline-select.js  # 时间线选择器
│   │   ├── novel-mode.js   # 小说模式
│   │   ├── settings.js     # 设置
│   │   ├── world-book.js   # 世界书编辑器
│   │   ├── au-panel.js     # AU设定面板
│   │   ├── user-profile.js # 用户档案
│   │   ├── preset-editor.js    # 预设编辑器
│   │   ├── memory-manager.js   # 记忆管理
│   │   ├── sticker-manager.js  # 表情包管理
│   │   ├── music.js        # 音乐（预留）
│   │   ├── radio.js        # 电台（预留）
│   │   └── game-hall.js    # 游戏大厅（预留）
│   ├── components/         # 可复用UI组件
│   │   ├── toast.js        # Toast提示
│   │   ├── modal.js        # 弹窗/抽屉
│   │   ├── context-menu.js # 长按上下文菜单
│   │   ├── navbar.js       # 导航栏
│   │   └── tabbar.js       # 底部标签栏
│   └── data/               # 预置数据（从源JSON提取）
│       ├── characters.js   # 全部角色数据
│       ├── world-books.js  # 世界书条目
│       ├── teams.js        # 战队数据
│       ├── prompts.js      # 内置提示词预设
│       └── au-presets.js   # AU快捷预设
└── assets/
    ├── icons/              # 应用图标
    └── img/                # UI素材
```

## IndexedDB Schema

数据库名: `GloryPhoneDB`, 版本: 1

| Store名称 | 主键 | 索引 | 用途 |
|-----------|------|------|------|
| users | id | name | 用户档案（多存档） |
| characters | id | name, team | 角色定义 |
| chats | id | userId, lastActivity, type | 聊天会话 |
| messages | id | chatId, timestamp, senderId | 聊天消息 |
| worldBooks | id | category, season, userId, isAU | 世界书条目 |
| memories | id | chatId, characterId, timestamp | 角色记忆 |
| settings | key | - | 键值配置 |
| stickerPacks | id | - | 表情包分组 |
| momentsPosts | id | authorId, timestamp | 朋友圈动态 |
| weiboPosts | id | authorId, timestamp | 微博动态 |
| forumThreads | id | timestamp | 论坛帖子 |

## 常见维护操作

### 添加新角色

编辑 `js/data/characters.js`，在 `CHARACTERS` 数组中添加新对象：

```javascript
{
  id: 'unique_id',          // 唯一标识
  name: '角色名',
  realName: '真名',
  accountCard: '账号卡名',
  aliases: ['别名1', '别名2'],
  className: '职业',
  team: 'team_id',          // 对应 teams.js 中的 id
  avatar: null,
  defaultEmoji: '🎮',
  debutSeason: 'S7',
  personality: '性格描述...',
  speechStyle: '说话风格...',
  timelineStates: {
    S7: { team: 'baihua', card: '账号卡', class: '职业', role: '角色', status: '状态' },
    S8: { ... },
  },
  relationships: { other_char_id: '关系描述' },
}
```

### 添加世界书条目

编辑 `js/data/world-books.js`，在 `WORLD_BOOKS` 数组中添加：

```javascript
{
  id: 'wb-unique-id',
  name: '条目名称',
  category: 'timeline|team|social|meta|system',
  season: 'S8',            // 或 'all' 或 'S1,S2,S3'
  constant: false,          // true=始终注入, false=关键词触发
  position: 1,
  depth: 4,
  keys: ['关键词1', '关键词2'],
  content: '世界书内容...',
}
```

### 添加AU预设

编辑 `js/data/au-presets.js`，在 `AU_PRESETS` 数组中添加：

```javascript
{
  id: 'au-new-preset',
  name: 'AU名称',
  icon: '🎭',
  description: '简短描述',
  worldBookOverlay: '[AU世界观覆盖]\n具体世界观描述...',
}
```

### 修改提示词模板

编辑 `js/data/prompts.js`，修改 `PROMPTS` 对象中对应的 `content` 字段。用户也可在应用内通过"预设编辑器"页面实时修改（保存到 IndexedDB）。

### CSS主题自定义

编辑 `css/variables.css` 中的 `:root` 变量：

- `--primary`: 主题色（默认 #6ba3d6 浅蓝）
- `--bubble-self`: 用户气泡色
- `--bubble-other`: 对方气泡色
- `--bg`: 背景色
- `--glass-blur`: 毛玻璃模糊度

深色模式在 `[data-theme="dark"]` 选择器中定义。

## 上下文组装流程

`js/core/context.js` 中 `assembleContext()` 的组装顺序：

1. **世界书**：根据当前赛季筛选常驻条目和相关条目
2. **角色卡**：根据赛季获取角色当前状态（战队、账号卡、身份）
3. **用户卡**：用户名称、简介、俱乐部
4. **AU覆盖**：如果选择了AU预设，叠加AU世界观
5. **提示词预设**：聊天风格、行为补丁、恋爱边界
6. **记忆**：最近20条记忆条目
7. **历史消息**：最近50条聊天记录

最终格式: `[System] -> [Memory] -> [Recent Messages] -> [User Input]`

## 部署到 GitHub Pages

1. 将整个项目推送到 GitHub 仓库
2. 在仓库 Settings > Pages 中设置 Source 为 main 分支 / root
3. 访问 `https://username.github.io/repo-name/`
4. 在手机浏览器中打开，点击"添加到主屏幕"即可安装

## 已知限制与后续计划

### 当前限制
- 图标使用 emoji 占位，需要替换为实际图片
- 后台保活受限于浏览器策略，长时间后台可能被暂停
- 表情包需要用户自行上传
- 没有后端服务器，API密钥存储在本地

### 后续迭代
- [ ] 完善群聊AI轮流发言的队列机制
- [ ] 实现微博/论坛的AI自动生成内容
- [ ] 添加NPC私信触发系统
- [ ] 完善朋友圈AI互动（点赞、评论生成）
- [ ] 实现音乐/电台/游戏大厅功能
- [ ] 添加角色默认头像图片资源
- [ ] 优化移动端性能（虚拟滚动）
- [ ] 增加PWA离线模式完整支持
