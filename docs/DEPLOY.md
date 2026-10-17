### 2.5 前后端分离（前端纯静态，后端服务器）

前端域名只托管浏览器静态文件，后端域名运行游戏服务器（`/ws` 与 `/healthz`）。

**前端（构建并部署静态站点）：**

1. 构建时设置环境变量 `BACKEND_ORIGIN=<后端域名>`（含协议，如 `https://api.example.com`；构建时烘入 `js/config.js`，无需再手改该文件）。不设则保持单域名行为。
2. 依次运行：`npm ci` →（需要官方美术 / 音频时）`node tools/setup.mjs` → `BACKEND_ORIGIN=https://api.example.com node tools/build-frontend.mjs`（生成静态站点，默认输出 `dist/`；未设 `BACKEND_ORIGIN` 时为单域名站点）。仅前端构建默认烘入前后端分离支持（构建时环境变量 `ALLOW_SEPARATE_FRONTEND`，默认 `1`；设 `0` 可构建不含分离支持的站点）。
3. 把 `dist/` 部署到前端域名：任选静态站点托管平台，站点根目录指向 `dist/`。

**后端（运行前先设置环境变量）：**

4. 设置 `ALLOW_SEPARATE_FRONTEND=1` 允许 `/healthz` 跨域读取（**默认关**：关时 `/healthz` 只允许同源读取）；按需设置 `FRONTEND_ORIGIN=<前端域名>`（默认 `*`，即允许任意前端域名读取 `/healthz`）。
5. 运行 `npm start` 启动游戏服务器（如 `ALLOW_SEPARATE_FRONTEND=1 npm start`，或先 `export ALLOW_SEPARATE_FRONTEND=1` 再运行）。
6. 用隧道或反向代理（见 2.4）把服务器暴露为后端域名：服务器必须位于域名根路径，`/ws` 与 `/healthz` 之外不需要暴露其他路径。前端是 `https` 时，后端域名也必须是 `https`（客户端会自动改用 `wss://`）。

**运行时切换后端**：标题屏幕的设置中点「更换服务器」，输入后端域名（写入 `?server=<origin>`，留空恢复默认后端）。是否提供该按钮由**构建时**环境变量 `ALLOW_SEPARATE_FRONTEND` 决定（默认 `1` 提供；构建时设 `0` 则不含该按钮，且 `?server=` 一律被忽略，页面始终连接默认后端）。

### 2.6 玩家导入已有素材（需要 HTTPS）

标题画面登录框下面并排有两个按钮：「下载完整素材」从这台服务器下载全部素材（打开窗口就开始）；「导入素材包」读取玩家自己的文件夹或 zip，用来少传重复的美术。打开导入窗口不会向服务器请求任何素材，也不会开始下载；真正开始导入时，浏览器只向服务器读取三份素材清单。

- 只有 **HTTPS** 或 **localhost** 能导入。浏览器只在安全上下文里提供 Service Worker 和可用的 Cache Storage。`http://局域网IP:3000` 可以正常玩游戏，也可以用「下载完整素材」，但不能导入；按钮下面和导入窗口里都会说明原因，而不是报错。
- 玩家导入的是自己已经有的文件：维护者另外提供的素材包 `Stronghold-Protocol-v<版本>-assets.zip`（见第 7 节，不在 GitHub Releases 里），setup 得到的 `public/assets`，或完整发布包 zip。校验通过的文件存在这台浏览器里，并且按地址分开：换了域名或端口就要重新导入。整套素材包约 3.1 万个文件，桌面版 Chrome 导入约 1–2 分钟；zip 分段读取，不会整个读进内存。
- 和服务器清单里 SHA-256 一致的文件不再向这台服务器请求。整套美术大约 1 GB（下载的约 720 MB，加本地提取的场景和官方战斗特效）；玩家第一局真正用到的通常约 20–50 MB。导入能省下的，是这些本来会从你的机器发出去的字节。哈希对不上的旧版本文件会被拒绝，仍走下载。
- 导入不经过服务器，服务器日志里看不到这些文件。Service Worker 只回答带内容哈希的 `/assets/`、`/fonts/`、`/media/`。页面、脚本、`/data/`、`/sim/` 和 `/ws` 仍每次走网络。


## 3. Docker

```bash
# A) 构建时下载素材（需要联网，约 720 MB）
docker build -t stronghold-protocol --build-arg FETCH_ASSETS=1 .
docker run -d --name stronghold -p 3000:3000 --restart unless-stopped stronghold-protocol

# B) 不把素材打进镜像：先在宿主机运行 node tools/setup.mjs，然后挂载
docker build -t stronghold-protocol .
docker run -d --name stronghold -p 3000:3000 --restart unless-stopped \
  -v "$PWD/public/assets:/app/public/assets:ro" stronghold-protocol
```

镜像从源码（`git clone`）构建，Releases 的整合包不含 `Dockerfile`。镜像基于 `node:22-alpine`，多阶段构建，只含生产依赖（包括 `ses@2.3.0` 和 `acorn@8.18.0`）；`public/vendor`（含 `ses.umd.js` / `acorn.mjs`）在构建时生成。`node_modules` 是镜像安装目录里的实际文件，不是指向镜像外的符号链接，脚本沙箱子进程可以在 `--allow-fs-read` 范围内读取。`.dockerignore` 排除了 `public/assets`（不会把宿主机素材打进构建上下文）；`public/fonts`、`data/assets.json` 和 `data/local-assets.json` 若存在会被复制进去。环境变量同 README（`-e SP_VERIFY=sample` 等）。健康检查：`GET /healthz`。

**持久化插件**：把命名卷或宿主机目录挂到 `/app/plugins`，例如加 `-v stronghold-plugins:/app/plugins`。
镜像在 `/app/plugin-resources` 保留只读的 `_template/`、`README.md` 和 `AGENTS.md`，用
`SP_PLUGIN_RESOURCES=/app/plugin-resources` 让工作台读取模板；不要把卷挂到这个资源目录。
即使 `/app/plugins` 是空的，界面和脚本模板仍可用。CLI、Schemas、作者文档和测试助手也在镜像里。
命名卷首次使用继承目录的 `node` 用户权限；宿主机绑定目录须允许容器里的 `node` 用户写入（工作台钥匙和草稿也写在这里）。
镜像不会复制构建机器自己的插件、插件打包产物或备份。

脚本模式用 `-e SP_PLUGIN_SCRIPTS=sandbox` 显式开启；默认仍关闭。容器默认监听 `0.0.0.0`，
原生受信任执行因此必须选择 `trusted-force` 并按第 10 节审查与固定哈希。需要工作台时从本机或局域网地址访问。

Docker Compose 示例（插件命名卷与只读模板分开；脚本默认关闭）：

```yaml
services:
  stronghold:
    build:
      context: .
      args: { FETCH_ASSETS: "1" }
    ports: ["3000:3000"]
    restart: unless-stopped
    environment:
      SP_VERIFY: "off"
      # SP_PLUGIN_SCRIPTS: sandbox
    volumes:
      - stronghold-plugins:/app/plugins
volumes:
  stronghold-plugins:
```

## 4. macOS / Linux 常驻

- 临时开服：`scripts/start.sh`（或 `npm start`），保持终端窗口打开。macOS 首次会询问是否允许 node 接受传入连接，选「允许」。
- Linux systemd（`/etc/systemd/system/stronghold.service`，路径与用户按实际修改）：

  ```ini
  [Unit]
  Description=Stronghold Protocol game server
  After=network-online.target
  Wants=network-online.target

  [Service]
  WorkingDirectory=/opt/Stronghold-Protocol
  ExecStart=/usr/bin/node server/index.js
  Environment=PORT=3000 HOST=::
  Restart=always
  RestartSec=5
  User=stronghold

  [Install]
  WantedBy=multi-user.target
  ```

  `sudo systemctl daemon-reload && sudo systemctl enable --now stronghold`；日志 `journalctl -u stronghold -f`；防火墙 `sudo ufw allow 3000/tcp`。

## 5. 排错

| 现象 | 处理 |
|---|---|
| 任何问题 | `node tools/doctor.mjs`：Node 版本、依赖、素材完整性、端口、局域网地址、防火墙、网络类型 |
| `端口已被占用 / EADDRINUSE` | 已经有一个服务器在运行（自启任务？）或其他程序占用 3000：换端口 `scripts\start-windows.bat --port 3001` |
| 朋友打不开页面 | 防火墙规则 / 网络类型（1.2）；确认用的是 `LAN` 地址而不是 `localhost`；访客 Wi-Fi 常开启「AP 隔离」；不在同一网络请看第 2 节 |
| 画面是占位图、没有声音 | 素材没下完：重新运行 `node tools/setup.mjs`（会续传）；缺失明细在 `.cache/assets-report.json`。默认仅原始源和 jsDelivr；可用 `--asset-source=mirror` 手动开启前缀镜像（见上文） |
| 素材下载很慢 / 失败 | 网络问题可随时中断，重新运行会跳过已完成的文件；`node tools/fetch-assets.mjs --concurrency=4` 降低并发。有文件没下载成功时，素材清单 `data/assets.json` 保持不变（脚本列出缺少的条目并以非零状态结束；游戏里缺的图片用占位图，缺的声音不播放），重新运行即可补齐 |
| 表情显示成默认图标、「玩法说明」只有文字要点 | 素材没下载完整：重新运行 `node tools/setup.mjs`（表情和教程图随其他素材一起从公开镜像下载，不需要客户端）；缺失明细在 `.cache/assets-report.json` |
| 本地提取失败 | 游戏照常运行，只是第 6 节表格里的几样换成替代样式。确认客户端已下载全部资源；Python 版本太新导致依赖安装失败时，安装 Python 3.12 后删除 `.venv-extract` 再运行 `node tools/setup.mjs --local` |
| 3D 棋盘没出现 | 需要本地提取的棋盘贴图（`node tools/doctor.mjs` 会显示「3D 棋盘可用」），以及支持 WebGL2 的浏览器。没有客户端的服务器可以从同一版本的整合包复制本地素材（第 6 节） |
| 素材地址里的 `~` 加一串字母数字 | `/assets/~<哈希>/…` 是 0.2.6 起的带版本地址（见第 0 节「网络」），浏览器可以长期缓存，属于正常现象。怀疑它导致问题时，可以用 `SP_ASSET_INDEX=0` 启动服务器临时关闭（清单改回普通地址），并请在 issue 里说明 |
| 想知道开服电脑上传了多少流量 | 浏览器打开 `http://localhost:3000/healthz?traffic=1`（换成你的端口）：`traffic.http` 是服务器启动以来各类内容（`assets` 图片和模型、`audio` 音频、`code` 页面和脚本、`data` 游戏数据和素材清单）发出的字节数和请求数（压缩后的实际字节，`notModified` 是只回了「没变」的 304），`traffic.ws` 是 WebSocket 的线上字节（`wireOut` / `wireIn`，压缩后）和压缩前的消息字节（`payloadOut` / `payloadIn`）。数字只在内存里，重启后从 0 开始；只有本机和局域网（含虚拟局域网地址）的访问能看到，公网访问者（包括经隧道 / 反代转发来的）只拿到普通的 `/healthz`。玩家那边：设置 →「问题反馈」复制的诊断里有一行 `traffic:`，是这个页面从打开起下载的字节数（`cached` 是浏览器缓存直接给的，不占流量；`external` 是其他网站，例如 Google 字体） |
| 断线 | 同盟模拟 10 分钟内、独立模拟 24 小时内（`config.constants.singleReconnectTime`）用同一浏览器重新打开页面，自动回到原座位。同盟掉线期间按原阵容自动作战、到时自动准备（不会代为购买；想让 AI 代打请用「离开模拟 → 暂离（AI 托管）」）；独立模拟不计时，等你回来 |

## 6. 本地客户端素材（可选）

`public/assets/local/` 和 `data/local-assets.json` 是从本机安装的《明日方舟》客户端里提取的官方素材（`tools/local-extract`，DESIGN §13）：`node tools/setup.mjs` 检测到客户端时会询问是否提取，之后可以用 `node tools/setup.mjs --local` 重新提取，或用 `--game "<…/StreamingAssets/AB/Windows>"` 指定客户端目录。setup 从公开镜像下载的素材不包含这部分，所以在没有客户端的电脑上（例如 Linux 服务器）用源码或精简包部署时不会有它；Releases 的完整包里已经带上了。

没有本地素材时游戏照常运行，只是下面几样换成替代样式：

| 内容 | 没有本地素材时 |
|---|---|
| 官方 3D 棋盘（贴图、模型、地图特效） | 2D 棋盘，地块由程序绘制 |
| 各战场的官方场景（沙地等 11 个战场，0.2.5 素材包；完整包在提取后带上，精简包和源码可在本机下载并提取，见下） | 3D 棋盘用程序生成的金属地块 |
| 部分官方界面图标与底板：交流按钮和表情面板的边框、暂停面板、装备替换窗口、干员调配界面、队友状态与漏怪标记、模组类型图标等 | 样式相近的替代图形、图标或文字 |
| 灼热 / 炽焰源石虫的官方模型 | 染成橙色 / 红橙色的普通源石虫 |
| 39 个召唤物的官方模型（多数自选召唤物，以及凯瑟琳的爬行号·防护单元、凛御银灰的风雪之眼；公开镜像没有） | 召唤物头像（菱形底板） |
| 官方战斗特效（0.3.0「官方特效」：普攻、弹道、命中、状态、阵亡、部署和技能；`extract.py --only fx --fx-set used` 单独提取，约 8800 个文件、磁盘约 190 MB，清单是 `data/local-fx.json`；完整包附带一份，精简包和源码需要本机提取） | 本作自己绘制的特效，设置里不显示「官方特效」 |

表情（6 套 × 6 个）和「玩法说明」的 19 页教程图公开镜像也有：`node tools/setup.mjs` 会和其他素材一起下载（约 21 MB），不需要客户端；有本地素材时优先显示本地的。

**没有客户端的服务器**想要上表中的官方素材：从**同一版本**的完整包（[Releases](https://github.com/sganggs/Stronghold-Protocol/releases)）里，把 `public/assets/local/` 文件夹和 `data/local-assets.json`（还有官方战斗特效的清单 `data/local-fx.json`）复制到服务器项目目录下的相同位置。服务器每次请求都会重新读取这两处，不必重启，玩家刷新页面即可。一定要用与服务器代码相同版本的完整包：各版本提取的内容和清单可能不同（例如灼热 / 炽焰源石虫的模型是 0.1.0 之后才加入的，召唤物模型是 0.2.0 加入的），混用其他版本的文件会缺图或用错图。复制后 `node tools/doctor.mjs` 会显示本地素材的条目数和「3D 棋盘可用」。

**0.2.0 之前提取过的**：召唤物模型是 0.2.0 新增的提取项，旧的提取结果里没有（`node tools/setup.mjs` 会提示「缺少新版的自选召唤物模型」）。有客户端的电脑运行 `node tools/setup.mjs --local` 重新提取即可，只想补这一项也可以在提取用的 Python 环境里运行 `tools/local-extract/extract.py --only spine/token`（新文件写入 `public/assets/local/spine/token/`，清单里其他条目保持不变）。

**各战场的官方场景**（0.2.5 素材包，维护者 2026-10-12：可以进完整包；精简包和源码安装可以在本机下载）：官方棋盘是每个战场一个做好的场景（11 个战场，其中 9 个是沙地）。场景包只在赛季开放期间随客户端分发，赛季外的客户端里没有。仓库不存放这些官方文件。有客户端的电脑可以 `node tools/setup.mjs --scenes`（询问或强制下载并提取；`--no-scenes` 跳过）。也可以分两步：`python3 tools/local-extract/fetch_scenes.py`（从官方 CDN 下载赛季版本 `26-04-13-12-31-42_e9b560` 的 33 个场景包，共 22,801,308 字节，放进 `.cache/official-scenes/`；`--list` 只看清单不下载），再用提取环境的 Python 运行 `tools/local-extract/extract.py --only scene`（材质和贴图仍取自本机客户端；`--game` 可指定客户端目录）。没有 Python 3.8+，或 UnityPy / lz4 / Pillow 没装好时，setup 只提示并继续，3D 棋盘用金属地块。没有客户端时贴图取不出来，从同一版本的完整包复制 `public/assets/local/` 和 `data/local-assets.json`。作者估计每个场景在进对局时另下载约 2–7 MB，各场景共用贴图约 3 MB；本机没有跑过提取，完整包因此增加的解压体积没有实测。

**3D 棋盘贴图的下载量**：每位玩家进入对局时都要从开服的电脑下载 3D 棋盘的 12 张贴图。提取时会给这 12 张各写一份 WebP（颜色贴图有损、质量 95，法线和数据贴图无损），清单里列的是 WebP，同名 PNG 留在旁边给裁切工具和 setup 用。这部分下载量从约 6.7 MB 降到约 2 MB，网速慢的远程联机最明显。只有 PNG 的本地素材（例如在这一改动之前提取的）可以用提取时的 Python 环境运行 `tools/local-extract/extract.py --webp` 就地补上，只需要 Pillow，不需要客户端。

**「玩法说明」教程图的下载量**（0.2.6 起）：本地提取的 19 页教程图每页 1.2–1.5 MB，玩家每翻一页都要从开服的电脑下载。提取时同样给每页写一份 WebP（有损，质量 90，放大两倍对比看不出差别），清单列 WebP，PNG 留在旁边；19 页合计从约 25.6 MB 降到约 4.2 MB。看说明时只预载下一页（以前前后两页都预载）。已经提取过的同样用 `tools/local-extract/extract.py --webp` 补上。

## 7. 打包发布（维护者）

Releases 的 zip（完整包、精简包，0.2.1 起还有更新包）由 `tools/package.mjs` 生成，在**源码仓库**里运行（整合包里没有这个工具）：

```bash
npm run package -- --dry-run --list   # 只检查：列出每个文件和大小，不写任何文件（精简包加 --lite）
npm run package -- --out <目录>        # 完整包 Stronghold-Protocol-v<版本>.zip
npm run package:lite -- --out <目录>   # 精简包 Stronghold-Protocol-v<版本>-lite.zip
npm run package -- --update --from <旧版本的完整包>[,<…>] --out <目录>   # 更新包 Stronghold-Protocol-v<版本>-update.zip
node tools/package.mjs --assets --out <目录>   # 素材包 Stronghold-Protocol-v<版本>-assets.zip（给「导入素材包」用，不放进 Releases）
```

完整包在打包机已经提取战场场景时带上 `public/assets/local/scene/`（`--dry-run` 摘要里的 `battlefield scenes` 一行）。还没有提取时完整包仍能打，棋盘用金属地块。要带上 11 个官方场景，先运行 `python3 tools/local-extract/fetch_scenes.py`，再用提取环境的 Python 运行 `tools/local-extract/extract.py --only scene`（或 `node tools/setup.mjs --scenes`），然后再 `npm run package`。精简包不带场景。`.cache/official-scenes/` 在拒绝名单里，不会打进任何包。`tools/local-extract/scenes.py` 和 `fetch_scenes.py` 必须先提交：打包读的是 `git ls-files`，未提交的脚本不会进玩家包。

- **打进去的**：`git ls-files` 里的 `server/`、`shared/`、`data/`、`public/`（不含 `public/dev/`）、`packs/`（随仓库提交的内容包；只在本机安装、没提交的不打进去）、`plugins/`（只允许 `README.md`、`AGENTS.md` 与 `_template/`，即使误跟踪服主插件也不打进去；服务器自己放进去的插件不会提交，也不打进去，见 [PLUGINS.md](PLUGINS.md)）、启动脚本、玩家会运行的工具（setup、vendor、fetch-assets 与 `tools/assets/`、doctor，以及 setup 调用的 `tools/local-extract/` 和 `crop-board-atlas.mjs`）、`tools/plugin.mjs`、`schemas/`、插件作者文档（`docs/PLUGINS.md`、`docs/PLUGIN-GUIDE.md`、`docs/PLUGIN-DSL.md`、`docs/PLUGIN-API.md` 与目录示例）、`test/helpers/battleHarness.js`（作者测试使用，只依赖包内的 server/shared）、服务器和 fetch-assets 读取的 4 张研究数据表（`docs/research/` 的 `03-operators`、`05-enemies`、`05-maps`、`07-assets` 四个 JSON）、`package.json` / `package-lock.json`、许可证与说明（`LICENSE`、`NOTICE.md`、`THIRD-PARTY-NOTICES.md`、`README.md`、`CHANGELOG.md`）、`docs/PLAYING.md` 和本文；然后在临时目录里生成 `packs/index.json`（打进去的语言包和内容包的列表，供纯静态托管使用；服务器自己会实时列出，见 [PACKS.md](PACKS.md)），再 `npm ci --omit=dev` 装上运行依赖和 `public/vendor`（含沙箱必需的 SES / Acorn 及其浏览器文件，玩家无需另装）。完整包再加上 `data/assets.json` 列出的素材、`public/fonts`，以及本地提取的 `public/assets/local/` 和 `data/local-assets.json`。磁盘上有、清单却没列出的文件不打进去（例如 0.2.0 移出自选的焰狐龙梓兰的旧素材）。日文干员语音（`audio.voiceJp`，`public/assets/audio/voice/jp/` 的 2674 个文件，约 85 MB，zip 后约 76 MB）默认也打进完整包；`tools/package.mjs` 里的开关 `FULL_ZIP_JP_VOICE` 改成 `false` 时，完整包（以及由它比较出的更新包）不带这些文件：玩家首次启动时 setup 会像精简包那样下载它们，下载完成前选「日本語」会播中文语音，更新包也不会删除玩家已有的日文语音。英语、韩语和本土语言配音（`audio.voiceEn` / `audio.voiceKr` / `audio.voiceNative`）同样默认打进完整包（5712 个文件，约 169 MB，zip 后约 157 MB）；开关是 `FULL_ZIP_OPTIONAL_VOICE`（`tools/package.mjs`，默认 `true`）。改成 `false` 时完整包不带这些文件，玩家首次启动时 setup 再下载，下载完成前缺的那一句播中文，更新包也不会删除玩家已有的这些配音。
- **不打进去的**：`test/` 除上述作者助手外的文件、维护用的工具（数据构建、golden、botbench、i18n、导入检查、本工具等）、`scripts/make-windows-bundle.mjs`（Windows 便携包，见 [WINDOWS.md](WINDOWS.md)）、其他文档、研究笔记和 `docs/img/`、`handoff/`、`.github/`、`types/`、lint / 编辑器 / Docker 配置。和 0.1.x 的整树打包（全部跟踪文件加上 `public/assets` 的全部内容）相比，0.2.0 的完整包少了约 640 个文件、解压后小约 26 MB，zip 小约 8 MB。
- **打包前的检查**（`--dry-run` 也全部做一遍）：拒绝名单（`pv`、`review`、`.cache`、`.claude`、`.git`、`logs`、`.env`、`scripts/service.env.cmd`、`handoff`、`test` 除精确允许的作者助手外、服主自己的插件、`plugins/_dist/` / `_moved/` 等）；每个打进去的模块的相对导入、玩家用的 npm 脚本（start / setup / doctor / launch / postinstall / vendor / assets）都指向包里的文件；完整包里 `data/assets.json` 和 `data/local-assets.json` 列出的文件都在（缺了先运行 `node tools/fetch-assets.mjs`）；没有只差大小写的两个路径；包里的文件（二进制素材也查）不含个人目录路径（`/Users/…`、`C:\Users\…`、`/home/…`）或本机的账户名（运行时从系统读取；`SP_PACKAGE_SCAN_NAMES=a,b` 可以再加名字）；打进去的已跟踪文件没有未提交的改动（重新生成的 `data/assets.json` 要先提交）。有任何问题都会列出原因、以非零状态结束，不写 zip；正式打包时还会核对临时目录里的文件和计划完全一致。
- **玩家包里的脚本和文档链接**：临时目录里的 `package.json` 只留下每条 `node <文件>` 都指向包内文件、并且至少指出一个文件的脚本（`start`、`dev`、`setup`、`doctor`、`launch`、`postinstall`、`vendor`、`assets`）。`test`、`golden`、数据构建、lint、本工具等不留，避免玩家运行 `npm test` 时在没有测试文件的情况下得到「0 个测试、成功退出」。`README.md`、`CHANGELOG.md`、`NOTICE.md`、`THIRD-PARTY-NOTICES.md`、`docs/PLAYING.md`、本文、插件参考和作者指南里，指向包内没有的文件的相对链接改成该版本 GitHub 标签上的同一路径（版本号去掉末尾的 `-dev` 后加 `v`；图片用 `raw`，其余用 `blob`）；`../../releases/latest` 改为仓库的 Releases 地址。源码仓库里的这些文件仍是相对链接。
- **MANIFEST.json**：三种包的根目录都有（`npm ci` 之后写入）：除素材（`public/assets/`、`public/fonts/`、`data/assets.json`、`data/local-assets.json`，归 setup 管）以外每个文件的大小和 sha256，同一版本的三种包内容相同。`npm run doctor` 和更新包的启动检查（`server/update.js`）用它核对安装。
- **更新包**（0.2.1 起，每个版本都发）：`--from` 后面列出**此次支持升级的每个旧版本完整包**（Releases 上的 zip，或它解压出来、没动过的文件夹；逗号分隔或写多个 `--from`），例如发布 0.2.2 时 `--from Stronghold-Protocol-v0.2.0.zip,Stronghold-Protocol-v0.2.1.zip`。工具照常构建完整包的临时目录（`npm ci` 等），逐个文件（大小 + sha256）和每个旧版本比较：和任何一个旧版本不同、或旧版本没有的文件都打进去，所以一个更新包能覆盖在列出的每个版本上；旧版本有、新版本没有的文件记进 `UPDATE.json` 的 `removed`（连同各旧版本里的 sha256，玩家那边只删内容一致的文件；只差大小写的同名文件和 `.env` 之类的本机文件名不删，摘要里会列出）。旧版本必须比当前版本旧、带素材（不能是精简包或更新包）、每个版本只给一次，`--dry-run` 只读取并检查旧版本。更新包里还有新版本的 `MANIFEST.json` 和 `UPDATE.json`（适用的旧版本、文件数、字节数、文件列表和 `removed`），同样经过拒绝名单和个人信息检查；摘要列出和每个旧版本相比改动 / 新增 / 删除的文件数和更新包里各类文件的数量。发布时在 Releases 说明里写明更新包适用的版本（即 `--from` 列出的版本）。0.3.0 至少以 0.2.6 完整包为基线；新增的插件模块、Schemas、作者工具、模板、SES / Acorn 与前端库都会作为新增或改变的文件进入更新包。删除列表以实际基线比较为准，不要凭开发过程里曾出现过的页面名手写。`--keep-stage` 保留更新包目录和完整包的临时目录（`<目录>/Stronghold-Protocol-v<版本>-update/` 里的 `Stronghold-Protocol/` 和 `.full/`）。
- **素材包**（`--assets`，0.3.0 起，可选）：给标题画面「导入素材包」用的范例，只含这个版本导入时能收下的美术——`data/assets.json`、`data/local-assets.json`、`data/local-fx.json` 列出的文件（字体也在其中），按打包机上的语音和官方特效开关取舍，和完整包一致；不含清单本身（浏览器读的是服务器上的清单）、清单没有列出的本地提取残留文件，也不含任何代码。zip 里只有一个文件夹 `Stronghold-Protocol-v<版本>-assets/`，里面是 `public/assets/…`、`public/fonts/…` 和中英文说明 `README.txt`（是什么、对应哪个版本的清单、怎么导入；其他版本的服务器上，内容变了的文件校验不符、不会收下）。每个路径都带 `public/`，导入时整包按同一个前缀识别；说明文件是导入结果里唯一「跳过」的文件。打包前做和完整包相同的检查：清单列出的文件都在、没有只差大小写的路径、个人信息扫描（素材也查）、`data/assets.json` 已提交（`--allow-dirty` 跳过这一项）、开发版本要加 `--allow-dev`；`--dry-run [--list]` 只检查、不写文件。不运行 `npm ci`，也没有 `MANIFEST.json`。素材包要和发布的完整包用同一份素材来打：打包后又重新提取过本地素材（例如官方特效）就要重打，改过的文件在别人的服务器上会校验不符；本地提取的那部分（场景、官方特效等）也只对提供同一份提取结果的服务器（这个版本的完整包）有效，自己从其他客户端版本提取的服务器会拒收这些文件，其余照常导入。0.3.0 的素材包是 30936 个文件、990 MB，zip 约 711 MB。素材包**不附在 GitHub Release 上，也不提交到仓库**：维护者可以把它放到网盘等处另行提供下载；Releases 仍然只有完整包、精简包和更新包。
- **需要**：已下载素材的仓库（完整包）——打包前先联网运行一次 `node tools/fetch-assets.mjs`，补齐清单计划但本机还没有的素材（清单只列出磁盘上有的文件，打包工具看不出缺了哪些；`data/assets.json` 有变化就先提交）；能访问 npm 的网络（`npm ci`）；`zip`（或 bsdtar 的 `tar`，Windows 10 起自带）；更新包还要之前各版本的完整包（工具自己读 zip，不需要 `unzip`；Releases 上可以重新下载）。`--out` 默认是系统临时目录下的 `stronghold-protocol-release`，不能在仓库里面；`--force` 覆盖已有的 zip，`--keep-stage` 保留打包用的目录供检查。

## 8. 插件：服主策略文件（0.3.0 起）

插件放在 `plugins/<id>/`（见 [PLUGINS.md](PLUGINS.md) §2）。房主在房间的「插件」面板里开关：外观插件只换画面和声音，对局仍是原版；**改变玩法的插件**（数据 / DSL，以及显式启用的脚本）让这个房间玩一套自己的内容组合，每位博士的页面都会下载并逐字节校验，对局标为「非官方」，默认不计入统计总览（PLUGINS.md §11）。

房间能用哪些插件由服主决定：在 `plugins/` 里放一个可选的 `config.json`（和服务器自己的插件一样不会提交、不会被更新覆盖）。没有这个文件、且未开启脚本执行时，就是下面的默认值：

```json
{
  "rooms": "host",
  "default": [],
  "allow": ["*"],
  "classes": { "cosmetic": true, "content": true },
  "limits": { "maxSets": 4 },
  "allowIncompatible": false
}
```

| 字段 | 含义 |
|---|---|
| `rooms` | `"host"`：房主自己选插件（默认）；`"fixed"`：每个房间都固定用 `default` 里的插件，房主不能改；`"off"`：房间只玩原版（玩家在「设置」里给自己开的外观插件不受影响，它们不会进房间） |
| `default` | 新房间一开始就开着的插件 id（默认没有：原版） |
| `allow` | 房间可以用的插件：`["*"]` 全部，或列出 id |
| `classes` | 关掉某一类：例如 `{ "content": false }` 只允许外观插件；`classes` 按项覆盖默认值：默认允许 cosmetic/content；开启 sandbox 时再默认允许 script，trusted 模式再默认允许 trusted。其他未列出的类别不允许。ui 只供个人开启，不进房间组合 |
| `limits.maxSets` | 同时运行的「改变玩法」内容组合上限（0–64，默认 4）；超过时房主会看到「本服务器同时运行的插件组合已达上限，请稍后再试」 |
| `allowIncompatible` | 为其他游戏版本制作的改变玩法插件默认不能启用；设成 `true` 时大厅放行（房间里会提示）——但目前内容组合的构建本身仍会拒绝这类插件，所以暂时还开不了（DESIGN §32.6 待办）。外观插件只提示，不拦 |
| `allowDownloadHosts` | 按地址安装时额外允许的主机（字符串数组，默认没有）。一项是主机名（任意端口），或 `主机:端口`，IPv6 写成 `[地址]` 或 `[地址]:端口`。没有通配符。点名的主机才可以不是公网地址、才可以用 443 以外的端口。目录文件自己不能往这份名单里加。这个字段不参与房间策略；写错或文件坏了就当作没有额外主机，公网 https 下载不受影响。也可以用环境变量 `SP_PLUGIN_DOWNLOAD_ALLOW`（逗号分隔），和文件里的名单一起生效 |

- 环境变量 `SP_PLUGINS=off|host|fixed` 优先于文件里的 `rooms`，例如 `SP_PLUGINS=off npm start` 临时让所有房间只玩原版。
- 文件改了不用重启：房主下一次操作时（最多每秒检查一次）按新内容生效。写错的字段保持默认值，并在服务器日志里提示一次（`[plugins] …`）。
- 用了改变玩法插件的房间，对局在单独的子进程里运行（每套内容组合一个，同一组合的房间共用）：开发机实测子进程启动约 0.2 秒，载入数据和对局代码后约占 117 MB 内存（RSS），每个的堆上限 768 MB，最多同时 4 个，空闲 10 分钟后自动结束。子进程卡死（10 秒没有心跳）、崩溃或内存用尽时，只结束这套组合的对局，房间回到大厅并提示原因，服务器和其他房间不受影响。
- `SP_MATCH_HOST=worker` 改用 worker 线程（在服务器进程里运行，不另起 Node 进程）。**公网服务器不要用**：在 Node 22 上实测，worker 线程里一次性的超大分配用尽内存时，会让**整个服务器进程**退出（`FATAL ERROR: … Allocation failed`，退出码 134），原版房间也一起断开；子进程同样的情况只结束子进程。默认就是子进程（DESIGN §32.6）。
- `http://localhost:3000/healthz` 的 `content.sets` 是当前在用的改变玩法内容组合数。
- 按地址安装（[PLUGINS.md](PLUGINS.md) §17）只接受公网 https 的 443 端口，并且必须校验 zip 的 SHA-256；服务器下载后先检查再放入 `plugins/`，不执行包里的任何代码。内网、本机、链路本地和 `.local` 默认拒绝，重定向到这些地址或离开 https 也会拒绝。一次等待包含正文，不是每一跳重新计时。服主要放行某个主机，写在上面的 `allowDownloadHosts` 或 `SP_PLUGIN_DOWNLOAD_ALLOW` 里。
- 有人反馈问题时，诊断信息里的 `content:` 一行写着房间用的内容（`MODDED cs=… plugins=…` 表示开了改变玩法的插件），问题模板也会问「是否开了插件」。插件房间的问题请先找插件作者，并尽量在原版里复现。


## 9. 脚本沙箱与 CSP（0.3.0 起）

`SP_PLUGIN_SCRIPTS=sandbox` 开启 script 类的 SES 沙箱执行，默认关闭；trusted 类遵循第 10 节的原生执行门槛，永远
不进入此沙箱。用启动脚本开服时也可以不设环境变量，直接加参数：`scripts/start.sh --scripts sandbox`、
`scripts\start-windows.bat --scripts sandbox`；Windows 上双击 `scripts\start-windows-sandbox.bat` 等于后者（参数取
`off` / `sandbox` / `trusted` / `trusted-force`，`off` 会去掉继承来的环境变量；服务器已经在运行时参数不生效，要先停止它）。此开关允许公网部署，要求有效 lock 和全部文件字节一致，但不要求 trusted pin，也不要求逐人同意
（维护者 2026-10-14 确认）。房间标「脚本（沙箱）」；同一 SDK、描述符与预算已接通，不降级执行。所有玩法插件的浏览器战斗都在专用 Worker 中，卡死看门狗默认 2 秒。
首次应用未缓存的脚本时，每个插件的注册探测默认最多 5 秒，大厅（含原版房间）可能短暂停顿；`SP_SCRIPT_PROBE_MS` 可设为 500–60000 毫秒，慢机器可提高。成功与失败都会缓存，文件或设置变了需重新探测。
沙箱脚本服务器宿主强制子进程，忽略 `SP_MATCH_HOST=worker`；Node 22 `--permission` 只开放安装目录读取，没有写文件、
起子进程、起线程或原生扩展权限，通过 JSON IPC 收取内容，保留现有内存上限和心跳看门狗。

Node 22 权限模型不是恶意代码安全边界，且不限制网络。SES/V8 逃逸后仍可能访问内网、安装目录和已打开的文件描述符；
安装目录内指向外部的符号链接可能扩大可见范围，也可能被 Node 的真实路径权限检查拒绝。`node_modules` 必须实际装在安装目录里，不要链接到外部目录，否则沙箱可能无法加载 SES / Acorn。建议用低权限用户，最好部署在限制出站/内网访问、内存与 CPU 的容器中
[ASSUMED]。不要把启用沙箱等同于可以安全运行任何来源的插件。官方说明见
[Node 22 permissions](https://nodejs.org/docs/latest-v22.x/api/permissions.html)。

整站默认发送 CSP，覆盖主页、开发页面和 `/studio/`；importmap 用精确内容的 SHA-256 放行，页面没有 unsafe-eval。
字体保留 Google Fonts 域名，样式允许 unsafe-inline，图片允许 data/blob，WebSocket 与同源连接以及 blob Worker
保留。Pixi 使用无动态求值的 uniform 适配器。服主可设 `SP_CSP=off` 关闭整站策略 [ASSUMED]；界面插件 `/p/` 和
模拟 Worker 自己的 CSP 不随此开关关闭。整站 connect-src 仅保留 'self'，现有同源 WebSocket 仍可连接。反向代理应保留 CSP 响应头，不要额外叠加会阻断 importmap 或 Worker 的策略。
Worker 响应单独允许 unsafe-eval 供 SES evaluate 使用，并设 `connect-src 'none'`。
受信任页面脚本从同源 `/cs/<cs16>/scripts/<id>/<entry>` 下发，先校验描述符与响应字节，再原生 import；
无需给页面 script-src 加 data:、blob: 或 unsafe-eval。script 与 trusted 混合组合整体按受信任处理，逐人同意。

CSP 和沙箱在 Chrome 里有浏览器测试（`SP_E2E=1 node --test test/ui/sandbox.e2e.test.js` 及 DESIGN §32.11 列出的套件）；
Firefox 和 Safari 还没有专门测过，遇到问题请附浏览器版本反馈。

## 10. Trusted script plugins（原生受信任执行，实验接口）

Scripts are off by default. After reviewing every file, pack the plugin and set `SP_PLUGIN_SCRIPTS=trusted`.
In `plugins/config.json`, add `"trusted": { "<id>": "<SHA-256 of plugin.lock.json>" }`. The exact lock and every
file must match; repack and repin after edits. The catalogue still lists disabled scripts with a refusal reason.

Bind to an explicit loopback or private LAN IP. Public addresses and wildcard listeners (`0.0.0.0`, `::`) refuse
trusted code; `SP_PLUGIN_SCRIPTS=trusted-force` explicitly overrides this [ASSUMED name]. The check uses the listening
address, never a request's address. If a public reverse proxy fronts the server, make the same public-deployment
`trusted-force` decision even when the listener is on a loopback address. Existing room class/allow policy still applies.
All numeric spellings of IPv6 zero, IPv4 0/8 and IPv4-mapped equivalents are refused;
the actual address returned after binding is checked again, and any refused trusted service is killed and reaped.

This executes native third-party code: it can control a player's whole game page, and server code can access the
server account's files and network. The lexical “sandboxable” label is not isolation. Every seated player must accept
the current content hash before starting; a red banner stays visible. Unconsenting spectators receive data/snapshots
only. Infinite loops in the page are not stopped by P3a's action budget. Use only code all participants trust.

Gameplay code always runs in a match child, including bots and SP_VERIFY; it never runs in the main server.
Experimental trusted server entries use a separate child and become active at startup. Restart to change/revoke those
entries; end an active match to revoke its already pinned snapshot. Activation/request timeouts (5 s), startup failures
and shutdown use SIGKILL and wait for that child to exit. Its 128 MB old-space heap limit is not a total memory or
subprocess sandbox. Health extensions are limited to 16 KiB of UTF-8 JSON per plugin.

Composition keeps the synchronous C1 interface: an uncached registration probe pauses the lobby for up to 5 s per
plugin (`SP_SCRIPT_PROBE_MS`, 500–60000: raise it on a slow machine, where starting the engine and SES takes longer),
including vanilla rooms — once per plugin version and settings, since results are cached. Probes use SIGKILL and cache successes/failures by plugin, lock, source descriptor and
settings (256 recent results). The explicit local `node tools/plugin.mjs test <id>` command authorizes execution
without server mode or trusted-pin checks; it is not evidence that those files match the production pin.
Full SDK, pinning, consent and limitations:
[PLUGINS §13](PLUGINS.md#13-scripts-p3a).

Node 22 的 `--permission` **不限制网络**（TCP/UDP/DNS/监听均可能可用）。安装根内指向外部的符号链接也会
扩大可读范围：不要在安装根中放此类链接，包括外链 node_modules、npm link 和配置/存储链接。建议使用容器或
网络命名空间限制出站与内网访问，并设置 OS 内存/CPU 限额。父进程已对日志、启动错误、发送帧、RPC 回复等 IPC
做形态和长度复核（DESIGN §32.11），但 Node 在复核前已解码 IPC，不能据此声称免疫内存炸弹或消息洪泛。
