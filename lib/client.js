// dsh-takeover —— 本项目仅作者维庸化石（不识幻庵）可修改；AI/他人不得擅自改动（完整声明见 lib/index.js 文件头）。
window.__ModuleLoader__.load({
  id: "dsh-takeover",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    // =====================================================================
    // dsh-takeover -- client half（第 5 步：真正建会话 + 预设跟随 + 预填交接提示）
    //
    // 本版改动（v0.5.0）：
    //   ① 【预设根因】byId[x].agentPreset 宿主从来不填 → 旧代码「跟随当前会话」永远读到空。
    //      实际值在 byId[x].projectionValues.agentPreset（宿主 workspace-client 自己也这么读）。
    //   ② 【预填根因】输入框是 Lexical 富文本，改 DOM 的 value/textContent 它不认。
    //      现在改走宿主门面 conversation.input.shell(id).setDraft(text)。
    //   ③ 【首选路径】uiWorkspace.startSession(wsId, { agentPreset, prompt, clearPreviousDraft })
    //      —— 宿主官方的「建会话 + 指定预设 + 打开 + 预填草稿」一体入口，2.5 秒核对没建出才降级。
    //
    // 已实证的宿主事实：
    //   * 会话清单：ctx.sessions.list.getSnapshot() -> { ids, byId, phase, projectionsBySession }
    //     byId[x] = { id, displayTitle, running, blank, updatedAt, projectionValues, title?, cwd?, parentId?, origin? }
    //     ↑ 没有 current 字段；当前预设只在 projectionValues.agentPreset
    //   * startSession：dsh-client-ui-workspace/lib/client.js（内部 openWorkspace + requestDraftInitialization）
    //   * 输入门面：ctx.get("conversation").input（InputHub）→ shell(sessionId).setDraft(text)
    //
    // 纪律：fail-soft；不读写会话/存储文件；出错只 warn。
    // =====================================================================

    var TAG = "[dsh-takeover]";
    var MENU_SLOT = "sidebar.workspaces.session.menu.item";
    var MENU_ORDER = 320;
    var MENU_ID = "dsh-takeover";

    var react = null;
    var primitives = null;
    try { react = require("react"); } catch (e) {
      console.warn(TAG, "拿不到 react：", e && e.message);
    }
    try { primitives = require("@deepseek-ai/dsh-client-ui-primitives"); } catch (e) {
      console.warn(TAG, "拿不到 ui-primitives，菜单项用降级样式：", e && e.message);
    }

    /** 新会话用哪个代理预设（都是本机 profile 里真实存在的）。 */
    var PRESETS = [
      { id: "", label: "跟随当前会话", hint: "新会话用你左边选中的那个老会话的模式，不用再挑。" },
      { id: "standard", label: "标准（standard）", hint: "给 AI 整套工具：能看文件、能改文件、能跑命令。日常干活选这个。" },
      { id: "cordis", label: "创造模式（cordis）", hint: "比「标准」多挂插件开发能力（能写插件、查运行时）。不确定选什么就用「标准」。" },
    ];

    /** 新会话怎么知道老会话的内容。只是预填不同的话，插件本身不读文件、不调模型。 */
    var READS = [
      {
        id: "auto",
        label: "自动读取（推荐）",
        hint: "新会话里放一句「先去看一下会话『X』，然后继续」。读多少由 AI 自己判断，最快。注意：这个模式不生成交接文档，也不会出现在清理页。",
      },
      {
        id: "five",
        label: "六段式交接",
        hint: "AI 先把老会话嚼成六段：①目标 ②硬约束 ③已定决策 ④当前状态 ⑤下一步 ⑥不确定的地方。每条附依据，原文没有就写「未提及」，不瞎猜。最稳，但慢一点。会留一份交接文档进清理页。",
      },
      {
        id: "recent",
        label: "只读最近 20 轮",
        hint: "只让 AI 读老会话最后 20 轮，再按六段式交接。老会话很长、只关心最近的事时用。会留一份交接文档进清理页。",
      },
    ];

    // ---------------------------------------------------------------------
    // 宿主探测
    // ---------------------------------------------------------------------

    function probe(ctx, name) {
      if (!ctx) return undefined;
      var reflectGet = ctx.reflect && ctx.reflect.get;
      if (typeof reflectGet === "function") {
        try {
          var found = reflectGet.call(ctx.reflect, name);
          if (found !== undefined) return found;
        } catch (e) {}
      }
      if (typeof ctx.get === "function") {
        try {
          var viaGet = ctx.get(name);
          if (viaGet !== undefined) return viaGet;
        } catch (e) {
          return undefined;
        }
      }
      try {
        return ctx[name];
      } catch (e) {
        return undefined;
      }
    }

    function workspacesSnap(ctx) {
      try {
        var ws = probe(ctx, "workspaces");
        return ws && ws.list && typeof ws.list.getSnapshot === "function"
          ? ws.list.getSnapshot()
          : undefined;
      } catch (e) {
        return undefined;
      }
    }

    function readArchived(ctx) {
      try {
        var snap = workspacesSnap(ctx);
        var ids = snap && snap.archivedSessionIds;
        return new Set(Array.isArray(ids) ? ids : []);
      } catch (e) {
        return new Set();
      }
    }

    /** cwd -> 工作区显示名（用户重命名过的 title 优先）。 */
    function readWorkspaceTitles(ctx) {
      var map = {};
      try {
        var snap = workspacesSnap(ctx);
        var items = snap && (snap.items || snap.workspaces || snap.list);
        if (!Array.isArray(items)) items = [];
        items.forEach(function (it) {
          if (!it || typeof it !== "object") return;
          var title = it.title || it.name || it.displayName;
          var path = it.path || it.cwd;
          if (typeof title === "string" && title && typeof path === "string" && path) {
            map[path] = title;
          }
        });
      } catch (e) {
        console.warn(TAG, "读工作区名失败：", e && e.message);
      }
      return map;
    }

    function readSessions(ctx) {
      var out = { sessions: [], currentId: undefined, currentCwd: undefined };
      try {
        var svc = probe(ctx, "sessions");
        var snap = svc && svc.list && typeof svc.list.getSnapshot === "function"
          ? svc.list.getSnapshot()
          : undefined;
        var byId = snap && snap.byId;
        if (!byId) return out;
        out.currentId = snap.current;
        var archived = readArchived(ctx);
        var ids = Object.keys(byId);
        for (var i = 0; i < ids.length; i++) {
          var id = ids[i];
          var info = byId[id] || {};
          if (info.origin === "subagent") continue;
          if (info.blank && id !== out.currentId) continue;
          if (archived.has(id)) continue;
          var title = typeof info.title === "string" ? info.title.trim() : "";
          if (!title || title === id) title = "（未命名会话）";
          out.sessions.push({
            id: id,
            title: title,
            cwd: typeof info.cwd === "string" ? info.cwd : "",
            // 当前预设只存在于投影里：byId[x].projectionValues.agentPreset。
            // byId[x].agentPreset 这个字段宿主从来不填（会话头里那个 cordis 是默认值，不是实际选择），
            // 旧写法永远读到空串 → 「跟随当前会话」= 什么都不跟随 → 新会话掉回工作区默认。
            preset:
              info.projectionValues && typeof info.projectionValues.agentPreset === "string"
                ? info.projectionValues.agentPreset
                : "",
            isCurrent: id === out.currentId,
          });
        }
        if (out.currentId && byId[out.currentId]) {
          var cur = byId[out.currentId];
          out.currentCwd = typeof cur.cwd === "string" ? cur.cwd : undefined;
        }
      } catch (e) {
        console.warn(TAG, "读会话清单失败：", e && e.message);
      }
      return out;
    }

    /** 工作区显示名：优先用 title，其次用路径最后一段。 */
    function workspaceLabel(cwd, titleMap) {
      if (cwd && titleMap && titleMap[cwd]) return titleMap[cwd];
      if (!cwd) return "未归属工作区";
      try {
        var parts = String(cwd).split(/[\\/]+/).filter(function (s) { return s && s.length > 0; });
        return parts.length ? parts[parts.length - 1] : String(cwd);
      } catch (e) {
        return String(cwd);
      }
    }

    // ---------------------------------------------------------------------
    // 样式
    // ---------------------------------------------------------------------

    var CSS = [
      /* =====================================================================
       * 全部对齐 DSH 原生 token（取自 @deepseek-ai/dsh-client-ui-theme 与
       * 各组件的 .module.css 实测值）；每个 var() 后面都带暗色主题回退值，
       * 所以你换主题/换肤时这些颜色会跟着变。
       * ===================================================================== */

      /* 遮罩 + 面板（Modal：radius-panel 28 / layer-2 / elevation-prominent） */
      "." + MENU_ID + "-overlay{position:fixed;top:0;left:0;right:0;bottom:0;z-index:9500;display:flex;" +
        "align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.5));" +
        "backdrop-filter:blur(2px)}",
      "." + MENU_ID + "-panel{width:880px;max-width:92vw;height:640px;max-height:86vh;display:flex;" +
        "flex-direction:column;border-radius:var(--dsw-radius-panel,28px);overflow:hidden;" +
        "background:var(--dsw-alias-bg-layer-2,#2c2c2e);color:var(--dsw-alias-label-primary,#f9fafb);" +
        "box-shadow:var(--dsw-elevation-prominent,0 0 0 .5px #ffffff29,0 3px 8px #0000000a,0 0 20px #0000000d)}",

      /* 头部 */
      "." + MENU_ID + "-head{padding:22px 24px 12px}",
      "." + MENU_ID + "-headtop{display:flex;align-items:center;gap:10px}",
      "." + MENU_ID + "-h2{margin:0;font-size:16px;line-height:24px;font-weight:500}",
      "." + MENU_ID + "-sub{margin:4px 0 0;font-size:12px;line-height:18px;" +
        "color:var(--dsw-alias-label-tertiary,#adb2b8)}",

      /* 标签页（SegmentedTabs：34 高 / radius-md / 选中 layer-3 + 半像素描边） */
      "." + MENU_ID + "-tab{height:34px;padding:0 12px;border-radius:var(--dsw-radius-md,12px);" +
        "font-size:14px;line-height:20px;font-family:inherit;cursor:pointer;border:0;" +
        "background:transparent;color:var(--dsw-alias-label-secondary,#cfd3d6);" +
        "transition:background .1s ease,color .1s ease}",
      "." + MENU_ID + "-tab:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff14)}",
      "." + MENU_ID + "-tab[data-on='1']{color:var(--dsw-alias-label-primary,#f9fafb);font-weight:600;" +
        "background:var(--dsw-alias-bg-layer-3,#353638);" +
        "box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3,#ffffff29)}",

      /* 主体两栏 */
      "." + MENU_ID + "-body{display:flex;flex:1;min-height:0;overflow:hidden}",
      "." + MENU_ID + "-left{flex:1 1 0;min-width:0;display:flex;flex-direction:column;" +
        "border-right:.5px solid var(--dsw-alias-border-l2,#ffffff1f)}",
      "." + MENU_ID + "-right{flex:1 1 0;min-width:0;padding:16px 20px;overflow:auto;" +
        "display:flex;flex-direction:column;gap:2px}",
      "." + MENU_ID + "-list{flex:1;overflow:auto;padding:12px 8px}",

      /* 左栏：工作区分组（sectionHeader：34 高 / tertiary / radius-md） */
      "." + MENU_ID + "-group{display:flex;align-items:center;gap:6px;height:34px;padding:0 8px;" +
        "border-radius:var(--dsw-radius-md,12px);font-size:13px;line-height:20px;font-weight:400;" +
        "color:var(--dsw-alias-label-tertiary,#adb2b8);cursor:pointer;user-select:none}",
      "." + MENU_ID + "-group:hover{color:var(--dsw-alias-label-secondary,#cfd3d6)}",
      "." + MENU_ID + "-caret{width:16px;flex:0 0 auto;display:inline-flex;align-items:center;" +
        "justify-content:center;font-size:12px;color:var(--dsw-alias-label-caption,#81858c);" +
        "transition:transform .15s}",
      "." + MENU_ID + "-group[data-collapsed='1'] ." + MENU_ID + "-caret{transform:rotate(-90deg)}",
      "." + MENU_ID + "-count{margin-left:auto;font-size:11px;line-height:17px;font-weight:400;" +
        "color:var(--dsw-alias-label-caption,#81858c)}",
      "." + MENU_ID + "-rows{padding-left:8px}",
      "." + MENU_ID + "-rows[hidden]{display:none}",

      /* 左栏：会话行（sessionRow：32 高 / 8 内距 / radius-md / 选中只一层中性填充） */
      "." + MENU_ID + "-row{display:flex;align-items:center;gap:8px;width:100%;padding:5px 8px;" +
        "border:0;border-radius:var(--dsw-radius-md,12px);background:transparent;text-align:left;" +
        "font-size:13px;line-height:20px;font-family:inherit;cursor:pointer;" +
        "color:var(--dsw-alias-label-secondary,#cfd3d6);transition:background .1s ease,color .1s ease}",
      "." + MENU_ID + "-row:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff14)}",
      "." + MENU_ID + "-row:active{background:var(--dsw-alias-interactive-bg-active,#ffffff24)}",
      "." + MENU_ID + "-row[data-selected='1']{background:var(--dsw-alias-interactive-bg-hover,#ffffff14);" +
        "color:var(--dsw-alias-label-primary,#f9fafb)}",
      "." + MENU_ID + "-row ." + MENU_ID + "-t{flex:1;min-width:0;display:flex;align-items:center;gap:6px}",
      "." + MENU_ID + "-row ." + MENU_ID + "-t span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      "." + MENU_ID + "-row ." + MENU_ID + "-m{flex:0 0 auto;font-size:12px;line-height:18px;" +
        "color:var(--dsw-alias-label-tertiary,#adb2b8)}",

      /* 「当前」标签（原 -badge 与菜单红点同名，已拆开） */
      "." + MENU_ID + "-curtag{flex:0 0 auto;padding:1px 8px;border-radius:999px;" +
        "background:var(--dsw-alias-bg-module-platform,#353638);" +
        "color:var(--dsw-alias-label-secondary,#cfd3d6);font-size:11px;line-height:17px;font-weight:500}",

      /* 右栏：小节标签与选项卡 */
      "." + MENU_ID + "-lbl{font-size:11px;line-height:15px;margin:10px 0 4px;" +
        "color:var(--dsw-alias-label-tertiary,#adb2b8)}",
      "." + MENU_ID + "-opt{display:flex;gap:8px;padding:8px 10px;border-radius:var(--dsw-radius-md,12px);" +
        "font-size:13px;line-height:20px;cursor:pointer;color:var(--dsw-alias-label-secondary,#cfd3d6);" +
        "transition:background .1s ease}",
      "." + MENU_ID + "-opt:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff14)}",
      "." + MENU_ID + "-opt[data-on='1']{background:var(--dsw-alias-bg-layer-3,#353638);" +
        "box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3,#ffffff29);" +
        "color:var(--dsw-alias-label-primary,#f9fafb)}",
      /* 单选圈（原 -dot 与状态点同名，已拆成 -radio） */
      "." + MENU_ID + "-radio{position:relative;width:16px;height:16px;flex:0 0 auto;margin-top:2px;" +
        "border-radius:50%;border:1.5px solid var(--dsw-alias-border-l4,#fff3)}",
      "." + MENU_ID + "-opt[data-on='1'] ." + MENU_ID + "-radio{" +
        "border-color:var(--dsw-alias-button-primary-fill,#f9fafb)}",
      "." + MENU_ID + "-opt[data-on='1'] ." + MENU_ID + "-radio::after{content:'';position:absolute;" +
        "top:3px;left:3px;right:3px;bottom:3px;border-radius:50%;" +
        "background:var(--dsw-alias-button-primary-fill,#f9fafb)}",
      "." + MENU_ID + "-opthint{display:block;margin-top:2px;font-size:12px;line-height:18px;" +
        "color:var(--dsw-alias-label-tertiary,#adb2b8);white-space:normal}",
      "." + MENU_ID + "-explain{margin-top:6px;padding:10px 12px;border-radius:var(--dsw-radius-md,12px);" +
        "background:var(--dsw-alias-bg-module-platform,#353638);" +
        "font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#cfd3d6);" +
        "white-space:pre-wrap}",

      /* 底部按钮（Button md：36 高 / 0 14 / radius-md；主按钮浅底深字） */
      "." + MENU_ID + "-foot{display:flex;justify-content:flex-end;align-items:center;gap:8px;" +
        "padding:12px 24px 16px;border-top:.5px solid var(--dsw-alias-border-l2,#ffffff1f)}",
      "." + MENU_ID + "-btn{height:36px;padding:0 14px;border-radius:var(--dsw-radius-md,12px);" +
        "font-size:14px;line-height:22px;font-family:inherit;cursor:pointer;" +
        "border:.5px solid var(--dsw-alias-border-l3,#ffffff29);background:transparent;" +
        "color:var(--dsw-alias-label-primary,#f9fafb);transition:background .12s}",
      "." + MENU_ID + "-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff14)}",
      "." + MENU_ID + "-btn:active{background:var(--dsw-alias-interactive-bg-active,#ffffff24)}",
      "." + MENU_ID + "-btn[data-primary='1']{background:var(--dsw-alias-button-primary-fill,#f9fafb);" +
        "color:var(--dsw-alias-label-primary-foreground,#0f1115);border-color:transparent;font-weight:500}",
      "." + MENU_ID + "-btn[data-primary='1']:hover{background:var(--dsw-alias-button-primary-hover,#ebeef2)}",
      "." + MENU_ID + "-btn[disabled],." + MENU_ID + "-chipbtn[disabled]{opacity:.4;cursor:not-allowed}",

      /* 清理页 */
      "." + MENU_ID + "-cleanpane{flex:1;min-height:0;display:flex;flex-direction:column;padding:16px 24px 20px}",
      "." + MENU_ID + "-cleanlist{flex:1;overflow:auto;margin-top:12px;border-radius:var(--dsw-radius-lg,16px);" +
        "border:.5px solid var(--dsw-alias-border-l2,#ffffff1f);" +
        "background:var(--dsw-alias-bg-layer-1,#232324)}",
      "." + MENU_ID + "-cleanempty{padding:24px 16px;font-size:13px;line-height:20px;" +
        "color:var(--dsw-alias-label-tertiary,#adb2b8)}",

      /* 工作区分组行 */
      "." + MENU_ID + "-wsgroup{display:flex;align-items:center;gap:6px;height:36px;padding:0 12px;" +
        "cursor:pointer;user-select:none;font-size:12px;line-height:20px;font-weight:500;" +
        "color:var(--dsw-alias-label-secondary,#cfd3d6);" +
        "border-bottom:.5px solid var(--dsw-alias-border-l2,#ffffff1f)}",
      "." + MENU_ID + "-wsgroup:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff14)}",
      "." + MENU_ID + "-wscaret{width:12px;flex:0 0 auto;font-size:12px;" +
        "color:var(--dsw-alias-label-caption,#81858c);transition:transform .15s}",
      "." + MENU_ID + "-wsgroup[data-collapsed='1'] ." + MENU_ID + "-wscaret{transform:rotate(-90deg)}",
      "." + MENU_ID + "-wsname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      "." + MENU_ID + "-wsbadge{flex:0 0 auto;font-size:11px;line-height:17px;font-weight:400}",
      "." + MENU_ID + "-wsbadge[data-k='ok']{color:var(--dsw-alias-state-success-primary,#22c55e)}",
      "." + MENU_ID + "-wsbadge[data-k='bad']{color:var(--dsw-alias-state-error-primary,#f25a5a)}",
      "." + MENU_ID + "-wsrows{padding-left:28px;" +
        "border-bottom:.5px solid var(--dsw-alias-border-l2,#ffffff1f)}",

      /* 记录行 */
      "." + MENU_ID + "-cleanitem{display:flex;align-items:center;gap:12px;padding:12px 16px;" +
        "border-bottom:.5px solid var(--dsw-alias-border-l2,#ffffff1f)}",
      "." + MENU_ID + "-cleanitem:last-child{border-bottom:0}",
      "." + MENU_ID + "-cleanmain{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}",
      "." + MENU_ID + "-cleanname{display:flex;align-items:baseline;font-size:14px;line-height:22px;" +
        "color:var(--dsw-alias-label-primary,#f9fafb);overflow:hidden}",
      "." + MENU_ID + "-cleanfrom{max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      "." + MENU_ID + "-cleanarrow{flex:0 0 auto;margin:0 6px;" +
        "color:var(--dsw-alias-label-tertiary,#adb2b8)}",
      "." + MENU_ID + "-cleanto{max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
        "color:var(--dsw-alias-label-secondary,#cfd3d6)}",
      "." + MENU_ID + "-cleanwhy{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;" +
        "color:var(--dsw-alias-label-tertiary,#adb2b8);overflow:hidden}",
      "." + MENU_ID + "-cleanstatetext{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      "." + MENU_ID + "-cleanfile{flex:0 0 auto;max-width:42%;overflow:hidden;text-overflow:ellipsis;" +
        "white-space:nowrap;color:var(--dsw-alias-label-caption,#81858c)}",

      /* 状态点（StateDot：10px 槽 + 40% 内点） */
      "." + MENU_ID + "-dot{position:relative;width:10px;height:10px;flex:0 0 auto}",
      "." + MENU_ID + "-dot::after{content:'';position:absolute;top:20%;left:20%;right:20%;bottom:20%;" +
        "border-radius:50%;background:var(--dsw-alias-state-idle-primary,#545557)}",
      "." + MENU_ID + "-dot[data-k='ok']::after{background:var(--dsw-alias-state-success-primary,#22c55e)}",
      "." + MENU_ID + "-dot[data-k='bad']::after{background:var(--dsw-alias-state-error-primary,#f25a5a)}",
      "." + MENU_ID + "-cleandim{opacity:.55}",

      /* 清理页底部工具条 */
      "." + MENU_ID + "-cleanfoot{display:flex;align-items:center;gap:8px;padding-top:16px}",
      "." + MENU_ID + "-cleanspacer{flex:1}",
      "." + MENU_ID + "-cleanswitch{display:flex;align-items:center;gap:6px;" +
        "font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#cfd3d6);cursor:pointer}",
      "." + MENU_ID + "-cleanswitch input{width:16px;height:16px;margin:0;" +
        "accent-color:var(--dsw-alias-button-primary-fill,#f9fafb)}",
      "." + MENU_ID + "-chipbtn{height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm,8px);" +
        "font-size:12px;line-height:18px;font-family:inherit;cursor:pointer;" +
        "border:.5px solid var(--dsw-alias-border-l3,#ffffff29);background:transparent;" +
        "color:var(--dsw-alias-label-primary,#f9fafb);flex:0 0 auto;transition:background .12s}",
      "." + MENU_ID + "-chipbtn:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff14)}",
      "." + MENU_ID + "-chipbtn:active{background:var(--dsw-alias-interactive-bg-active,#ffffff24)}",
      "." + MENU_ID + "-chipbtn[data-primary='1']{background:var(--dsw-alias-button-primary-fill,#f9fafb);" +
        "color:var(--dsw-alias-label-primary-foreground,#0f1115);border-color:transparent;font-weight:500}",
      "." + MENU_ID + "-chipbtn[data-primary='1']:hover{" +
        "background:var(--dsw-alias-button-primary-hover,#ebeef2)}",
      "." + MENU_ID + "-cleanfold{display:block;width:100%;text-align:left;padding:8px 16px;" +
        "background:none;border:0;border-top:.5px solid var(--dsw-alias-border-l2,#ffffff1f);" +
        "font-size:12px;line-height:18px;font-family:inherit;cursor:pointer;" +
        "color:var(--dsw-alias-label-tertiary,#adb2b8)}",
      "." + MENU_ID + "-cleanfold:hover{color:var(--dsw-alias-label-secondary,#cfd3d6)}",

      /* 菜单项小红点（保持原名 -badge，已与「当前」标签拆开） */
      "." + MENU_ID + "-badge{display:inline-flex;align-items:center;justify-content:center;" +
        "min-width:16px;height:16px;padding:0 4px;margin-left:6px;border-radius:8px;" +
        "font-size:10.5px;line-height:16px;" +
        "background:var(--dsw-alias-state-error-primary,#f25a5a);color:#fff}",

      /* 自绘确认框（RiskConfirmation：440 宽 / radius-panel / 正文 14·22 secondary） */
      "." + MENU_ID + "-confirm-mask{position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;" +
        "display:flex;align-items:center;justify-content:center;" +
        "background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.5));backdrop-filter:blur(2px)}",
      "." + MENU_ID + "-confirm-mask[data-in='1']{position:absolute;top:0;left:0;right:0;bottom:0;z-index:1}",
      "." + MENU_ID + "-confirm{width:440px;max-width:90vw;padding:22px 24px 20px;" +
        "border-radius:var(--dsw-radius-panel,28px);background:var(--dsw-alias-bg-layer-2,#2c2c2e);" +
        "color:var(--dsw-alias-label-primary,#f9fafb);" +
        "box-shadow:var(--dsw-elevation-prominent,0 0 0 .5px #ffffff29,0 3px 8px #0000000a,0 0 20px #0000000d)}",
      "." + MENU_ID + "-confirm-title{font-size:16px;line-height:24px;font-weight:500;margin-bottom:12px}",
      "." + MENU_ID + "-confirm-body{font-size:14px;line-height:22px;white-space:pre-wrap;" +
        "word-break:break-word;color:var(--dsw-alias-label-secondary,#cfd3d6)}",
      "." + MENU_ID + "-confirm-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}",

      /* 降级菜单项 + toast */
      "." + MENU_ID + "-menuitem{display:flex;align-items:center;width:100%;padding:7px 12px;" +
        "margin:1px 0;border:0;border-radius:var(--dsw-radius-md,12px);background:transparent;" +
        "color:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer;font-family:inherit}",
      "." + MENU_ID + "-menuitem:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff14)}",
      "." + MENU_ID + "-toast{position:fixed;right:16px;bottom:16px;z-index:9600;max-width:420px;" +
        "padding:12px 16px;border-radius:var(--dsw-radius-lg,16px);font-size:14px;line-height:22px;" +
        "white-space:pre-wrap;background:var(--dsw-alias-toast-bg,#43454a);" +
        "color:var(--dsw-alias-label-primary,#f9fafb);" +
        "box-shadow:var(--dsw-shadow-lv3,0 0 1px #0003,0 0 4px #00000005,0 12px 32px #00000014)}",
    ].join("\n");

    function ensureStyle() {
      try {
        if (document.getElementById("dsh-takeover-css")) return;
        var st = document.createElement("style");
        st.id = "dsh-takeover-css";
        st.textContent = CSS;
        document.head.appendChild(st);
      } catch (e) {}
    }

    function el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = MENU_ID + "-" + cls;
      if (text !== undefined) n.textContent = text;
      return n;
    }

    // ---------------------------------------------------------------------
    // 弹窗
    // ---------------------------------------------------------------------

    var dialogState = null;

    function closeDialog() {
      // 确认框还开着就先别关，否则那个 Promise 会永远悬着
      if (dialogState && dialogState.childOpen) return;
      try {
        if (dialogState && dialogState.onKey) {
          document.removeEventListener("keydown", dialogState.onKey, true);
        }
        var d = document.querySelector("." + MENU_ID + "-overlay");
        if (d && d.parentNode) d.parentNode.removeChild(d);
      } catch (e) {}
      dialogState = null;
    }

    // ---------------------------------------------------------------------
    // 第 7 步：交接记录 + 清理提醒
    //
    // 能力边界（实测过的）：client 半读不到「接手会话跑了几轮」——会话快照只有
    // blank / running / updatedAt / projectionValues.sessionListMetadata.lastPromptAt，
    // 没有 turn 计数（turnBoundary 只在 host 侧）。所以「跑满 3 轮」用
    // 「发过 3 次消息」近似：lastPromptAt 每变一次 +1。语义诚实标注，不假装精确。
    // ---------------------------------------------------------------------

    var API = "/dsh-takeover/api";
    var CLEAN_KEY = "dsh-takeover:clean-settings";

    /** 调主进程。记录、轮数、删除、打开文件夹全部在 host 半的 lib/index.js 里。 */
    function host(op, extra) {
      return fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json", "x-dsh-takeover": "1" },
        body: JSON.stringify(Object.assign({ op: op }, extra || {}))
      }).then(function (r) { return r.json(); });
    }

    function cleanSettings() {
      try {
        var raw = window.localStorage.getItem(CLEAN_KEY);
        var s = raw ? JSON.parse(raw) : {};
        return { sevenDays: s && s.sevenDays === true };
      } catch (e) {
        return { sevenDays: false };
      }
    }
    function setCleanSettings(patch) {
      var s = cleanSettings();
      try {
        window.localStorage.setItem(CLEAN_KEY, JSON.stringify({
          sevenDays: patch.sevenDays === undefined ? s.sevenDays : patch.sevenDays
        }));
      } catch (e) {}
    }

    /** 所有工作区路径（主进程按工作区分文件存记录） */
    function allWorkspaceCwds(ctx) {
      try {
        var snap = workspacesSnap(ctx);
        var items = snap && (snap.items || snap.workspaces || snap.list);
        if (!Array.isArray(items)) return [];
        var out = [];
        items.forEach(function (it) {
          var p = it && (it.path || it.cwd);
          if (typeof p === "string" && p && out.indexOf(p) < 0) out.push(p);
        });
        return out;
      } catch (e) {
        return [];
      }
    }

    /** 拉记录：主进程已经算好「跑了几轮 / 能不能删 / 文件还在不在」。 */
    function fetchRecords(ctx) {
      var s = cleanSettings();
      return host("list", { cwds: allWorkspaceCwds(ctx), sevenDays: s.sevenDays })
        .then(function (res) {
          if (!res || res.ok !== true) throw new Error((res && res.error) || "list failed");
          return Array.isArray(res.records) ? res.records : [];
        });
    }

    /** 「可删几份」——给菜单项小红点用 */
    var badgeValue = 0;
    var badgeListeners = [];
    function setBadge(n) {
      badgeValue = n;
      badgeListeners.forEach(function (f) { try { f(n); } catch (e) {} });
    }
    function onBadge(f) {
      badgeListeners.push(f);
      return function () {
        badgeListeners = badgeListeners.filter(function (x) { return x !== f; });
      };
    }

    /** 记一条移交：交给主进程写进工作区的 移交记录.json（窗口这半不自己存东西）。 */
    function recordTransfer(ctx, picked, newId, docPath) {
      if (!picked || !picked.id) return Promise.resolve();
      var cwd = picked.cwd;
      if (!cwd) {
        console.warn(TAG, "老会话没有工作区路径，跳过记录");
        return Promise.resolve();
      }
      return host("record", {
        cwd: cwd,
        rec: {
          oldId: picked.id,
          oldTitle: picked.title || "未命名会话",
          newId: newId || "",
          docPath: docPath || "",
          at: Date.now()
        }
      }).then(function (res) {
        if (!res || res.ok !== true) console.warn(TAG, "记录移交失败：", res && res.error);
        else console.info(TAG, "已记录移交：老=" + picked.id + " 新=" + (newId || "<未知>") +
          " 交接文档=" + (docPath || "<无>"));
        return res;
      }).catch(function (e) {
        console.warn(TAG, "记录移交请求失败：", e && e.message);
      });
    }

    function sessionsSnap(ctx) {
      try {
        var svc = probe(ctx, "sessions");
        return svc && svc.list && typeof svc.list.getSnapshot === "function"
          ? svc.list.getSnapshot()
          : undefined;
      } catch (e) {
        return undefined;
      }
    }

    var tickTimer = null;
    /**
     * 每 60 秒问一次主进程「有几份能删」，驱动菜单项小红点。
     * 轮数、7 天、文件在不在，全由主进程算（client 不再自己数）。
     */
    function startCleanTicker(ctx) {
      if (tickTimer) return;
      var tick = function () {
        fetchRecords(ctx).then(function (list) {
          setBadge(list.filter(function (r) { return r.canDelete; }).length);
        }).catch(function (e) {
          console.warn(TAG, "取清理数量失败：", e && e.message);
        });
      };
      // 页面刚启动时服务还没就绪，第一次常常拿不到工作区列表 → 红点一直是 0，
      // 必须点开一次弹窗才看到。改成：1.5 秒先试一次，前 6 次用 10 秒短间隔补上，
      // 之后 60 秒一次。这样开机不用任何操作，有可删的就自己显示数字。
      var fast = 0;
      var run = function () {
        tick();
        fast += 1;
        if (fast >= 6) {
          clearInterval(tickTimer);
          tickTimer = setInterval(tick, 60000);
        }
      };
      setTimeout(run, 1500);
      tickTimer = setInterval(run, 10000);
    }

    // ---------------------------------------------------------------------
    // 交接执行（第 5-6 步）
    // ---------------------------------------------------------------------

    /**
     * 生成要填进新会话的第一句话。插件只生成文字，不读文件、不调模型。
     * @returns {{ text: string, docPath: string }} docPath = 交接文档预期落盘路径（auto 模式为空）
     */
    function buildPrompt(picked, readMode) {
      var title = picked && picked.title ? picked.title : "未知会话";
      var id = picked && picked.id ? picked.id : "";
      if (readMode === "auto") {
        return {
          text: "先去看一下会话「" + title + "」（ID: " + id + "）的内容，了解之前做了什么，然后继续。",
          docPath: ""
        };
      }
      var lines = [];
      lines.push("你是接手会话。上一个会话「" + title + "」（ID: " + id + "）的工作移交给你了。");
      lines.push(readMode === "recent" ? "先读它最近 20 轮的内容。" : "先读它的内容。");
      lines.push("");
      lines.push("然后按下面格式写一份交接，最后继续工作。");
      lines.push("");
      lines.push("【必须遵守的规则】");
      lines.push("1. 每一条都必须来自老会话原文。找不到出处的，写「原文未提及」，不要补。");
      lines.push("2. 「下一步」只能从老会话里已经说过的待办/未完成事项中提取。");
      lines.push("   原文没有 → 写「原文未提及下一步，请指示」。");
      lines.push("   禁止自己推断接下来应该做什么。");
      lines.push("3. 区分【原文】和【推断】：推断的内容必须标「（推断，原文未直接说明）」。");
      lines.push("4. 每段末尾写「依据」：第几轮、谁说的、原话关键词。");
      lines.push("");
      lines.push("【六段格式】");
      lines.push("## 1. 目标");
      lines.push("## 2. 硬约束");
      lines.push("## 3. 已定决策");
      lines.push("## 4. 当前状态");
      lines.push("## 5. 下一步");
      lines.push("## 6. 我不确定的地方（哪些是推断、哪些可能已过时、哪些我没把握）");
      lines.push("");
      lines.push("写完这六段，按「下一步」继续。若「下一步」是「原文未提及」，停下来问我。");
      lines.push("");
      var dir = handoffDirOf(picked);
      var fileName = "交接_" + safeFileName(title) + "_" + stampOf(new Date()) + ".md";
      var docPath = dir + fileName;
      lines.push("【交接文档（写完六段后必须落盘）】");
      lines.push("把这六段原样保存一份到：" + dir);
      lines.push("文件名：" + fileName);
      lines.push("文件开头写三行元数据：");
      lines.push("  > 老会话：" + title + "（ID: " + id + "）");
      lines.push("  > 移交时间：" + stampOf(new Date()));
      lines.push("  > 接手会话 ID：<你自己的会话 id；取不到就写「未知」>");
      lines.push("这份文档是临时的：等你在这个会话里跑过几轮、内容进了上下文，它就可以删。");
      return { text: lines.join("\n"), docPath: docPath };
    }

    /** 交接文档目录：优先用老会话所在工作区，取不到就退到当前工作区。 */
    function handoffDirOf(picked) {
      var cwd = picked && picked.cwd ? String(picked.cwd) : "";
      if (!cwd) return "<当前工作区>\\AI工作区\\交接\\";
      return cwd.replace(/[\\/]+$/, "") + "\\AI工作区\\交接\\";
    }

    /** 文件名里不能出现的字符一律换成下划线。 */
    function safeFileName(name) {
      return String(name || "未命名会话").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60);
    }

    /** yyyyMMdd_HHmm（本地时间）。 */
    function stampOf(d) {
      function p(n) { return n < 10 ? "0" + n : String(n); }
      return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "_" + p(d.getHours()) + p(d.getMinutes());
    }

    /** 找出某个会话所属的工作区 id。 */
    function findWorkspaceId(ctx, sessionId) {
      try {
        var snap = workspacesSnap(ctx);
        var items = snap && (snap.items || snap.workspaces || snap.list);
        if (!Array.isArray(items)) return undefined;
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          if (it && Array.isArray(it.sessionIds) && it.sessionIds.indexOf(sessionId) >= 0) {
            return it.workspaceId || it.id;
          }
        }
      } catch (e) {}
      return undefined;
    }

    /** 有没有渲染出来的输入框（可见、够大、不在弹窗里）。 */
    function findComposer() {
      try {
        var cands = document.querySelectorAll('textarea, [contenteditable="true"]');
        for (var i = 0; i < cands.length; i++) {
          var node = cands[i];
          if (node.closest && node.closest("." + MENU_ID + "-overlay")) continue;
          var r = node.getBoundingClientRect();
          if (r.width >= 80 && r.height >= 20) return node;
        }
      } catch (e) {}
      return null;
    }

    /** 把文字填进输入框；填不进去就退到剪贴板。返回 true/false。 */
    function fillComposer(text) {
      var node = findComposer();
      if (node) {
        try {
          if (node.tagName === "TEXTAREA") {
            var desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
            if (desc && desc.set) desc.set.call(node, text);
            else node.value = text;
          } else {
            node.textContent = text;
          }
          node.dispatchEvent(new Event("input", { bubbles: true }));
          try { node.focus(); } catch (e) {}
          return true;
        } catch (e) {
          console.warn(TAG, "写入输入框失败：", e && e.message);
        }
      }
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          navigator.clipboard.writeText(text);
          toast("新会话已建好。\n交接提示已复制到剪贴板，粘贴后回车即可。");
          return true;
        }
      } catch (e) {}
      return false;
    }

    /** 等输入框出现（最多 ~5 秒）。 */
    function waitForComposer(cb, tries) {
      tries = tries || 0;
      if (findComposer()) { cb(true); return; }
      if (tries >= 25) { cb(false); return; }
      setTimeout(function () { waitForComposer(cb, tries + 1); }, 200);
    }

    /** 真正执行移交：建新会话 → 等输入框 → 填话。 */
    function doHandoff(ctx, picked, presetId, readMode) {
      var sessions = probe(ctx, "sessions");
      var ui = probe(ctx, "uiWorkspace");
      var wsId = findWorkspaceId(ctx, picked.id);
      // 「跟随当前会话」= 带上被移交那个会话自己的预设。
      var effectivePreset = presetId || (picked && picked.preset) || "";
      var built = buildPrompt(picked, readMode);
      var text = built.text;
      var docPath = built.docPath;

      function afterCreated(newId, alreadyOpened) {
        console.info(TAG, "新会话已创建：", newId, "预设：", effectivePreset || "<默认>");
        if (docPath) recordTransfer(ctx, picked, newId, docPath);
        if (!alreadyOpened) {
          try {
            if (newId && ui && typeof ui.openSession === "function") ui.openSession(newId);
          } catch (e) {
            console.warn(TAG, "打开新会话失败：", e && e.message);
          }
        }
        // ① 首选：宿主的会话输入门面（改的是 Lexical 编辑器的真实状态；改 DOM 它不认）
        if (newId) {
          waitForSessionInput(ctx, newId, text, function (ok) {
            if (ok) {
              console.info(TAG, "已通过 conversation.input 写入交接提示");
              return;
            }
            // ② 兜底：DOM 写入 + 剪贴板（旧逻辑）
            waitForComposer(function (found) {
              if (found) {
                var wrote = fillComposer(text);
                if (!wrote) toast("新会话已建好，但没找到输入框。请手动粘贴交接提示。");
              } else {
                copyToClipboard(text, "新会话已建好。\n交接提示已复制到剪贴板，粘贴后回车即可。");
              }
            });
          });
        } else {
          copyToClipboard(text, "新会话已建好。\n交接提示已复制到剪贴板，粘贴后回车即可。");
        }
      }

      /** 宿主会话输入门面：conversation.input.shell(id).setDraft(text)。 */
      function fillDraftByService(ctx, sessionId, text) {
        try {
          var conversation = probe(ctx, "conversation");
          var hub = conversation && conversation.input;
          if (!hub || typeof hub.shell !== "function") return false;
          var shell = hub.shell(sessionId);
          if (shell && typeof shell.setDraft === "function") {
            shell.setDraft(text);
            return true;
          }
          if (shell && shell.actions && typeof shell.actions.setDraft === "function") {
            shell.actions.setDraft(text);
            return true;
          }
        } catch (e) {
          // 新会话刚建、binding 还没挂上时会 throw，属于预期，继续轮询即可
          console.warn(TAG, "门面写草稿失败：", e && e.message);
        }
        return false;
      }

      function waitForSessionInput(ctx, sessionId, text, cb, tries) {
        tries = tries || 0;
        if (fillDraftByService(ctx, sessionId, text)) { cb(true); return; }
        if (tries >= 25) { cb(false); return; }
        setTimeout(function () { waitForSessionInput(ctx, sessionId, text, cb, tries + 1); }, 200);
      }

      function copyToClipboard(text, okMessage) {
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            navigator.clipboard.writeText(text);
            toast(okMessage);
            return true;
          }
        } catch (e) {}
        return false;
      }

      /** 当前会话清单里的 sessionId 数组（用于判断 startSession 有没有真的建出会话）。 */
      function sessionIds(ctx) {
        try {
          var svc = probe(ctx, "sessions");
          var snap = svc && svc.list && typeof svc.list.getSnapshot === "function"
            ? svc.list.getSnapshot()
            : undefined;
          if (snap && Array.isArray(snap.ids)) return snap.ids.slice();
          if (snap && snap.byId) return Object.keys(snap.byId);
        } catch (e) {}
        return [];
      }

      // 降级：openWorkspace（预设可能不生效，但至少能把会话开出来）
      function fallbackOpenWorkspace(reason) {
        if (reason) console.warn(TAG, "降级到 openWorkspace，原因：", reason);
        if (!ui || typeof ui.openWorkspace !== "function") {
          toast("创建会话失败：create 与 openWorkspace 都不可用。\n" +
                (reason ? "原因：" + reason : ""));
          return;
        }
        try {
          // openWorkspace 自己会把刚建好的会话切到主区域，所以 second 参数传 alreadyOpened=true，
          // 避免 afterCreated 里再 openSession 打断它自己的导航。
          var p = ui.openWorkspace(wsId, function (id) { afterCreated(id, true); },
                                   effectivePreset ? { agentPreset: effectivePreset } : {});
          if (p && typeof p.then === "function") {
            p.catch(function (e) {
              console.warn(TAG, "openWorkspace 失败：", e);
              toast("创建新会话失败：" + (e && e.message ? e.message : "未知错误"));
            });
          }
        } catch (e) {
          console.warn(TAG, "openWorkspace 抛错：", e);
          toast("创建新会话失败：" + (e && e.message ? e.message : "未知错误"));
        }
      }

      // ── 第一优先：uiWorkspace.startSession = 宿主官方的
      //    「新建会话 + 指定预设 + 打开 + 预填草稿」一体入口
      //    （workspace-client.js: startSession → openWorkspace(..., {agentPreset}) +
      //     beforeOpen 里 conversation.input.requestDraftInitialization({prompt})）
      if (ui && typeof ui.startSession === "function") {
        var idsBefore = sessionIds(ctx);
        var startOpts = { prompt: text, clearPreviousDraft: true };
        if (effectivePreset) startOpts.agentPreset = effectivePreset;
        console.info(TAG, "startSession 参数：", JSON.stringify({
          workspaceId: wsId,
          agentPreset: effectivePreset || "<默认>",
          promptLen: text.length
        }));
        var started = false;
        try {
          ui.startSession(wsId, startOpts);
          started = true;
        } catch (e) {
          console.warn(TAG, "startSession 抛错：", e && e.message);
        }
        if (started) {
          // startSession 内部把异步失败吞掉了（只 console.warn "new session failed"），
          // 所以 2.5 秒后核对一次会话清单。注意：宿主可能「复用」工作区里已有的空白会话，
          // 那样 ids 不会变——所以这里只提示、不再自动 create（否则会多建出一个会话）。
          setTimeout(function () {
            var added = sessionIds(ctx).filter(function (id) {
              return idsBefore.indexOf(id) < 0;
            });
            if (added.length > 0) {
              console.info(TAG, "startSession 成功，新会话：", added[0]);
              if (docPath) recordTransfer(ctx, picked, added[0], docPath);
              return;
            }
            // 没新增 = 可能复用了空白会话：仍然记一条（newId 留空，清理提醒跟踪不到它，
            // 但「老会话被移交过」这件事不能丢），日志里会说清楚。
            console.warn(TAG, "startSession 没有新增会话（可能复用了空白会话）；记录里新会话 id 留空");
            if (docPath) recordTransfer(ctx, picked, "", docPath);
          }, 2500);
          return;
        }
      }

      createSessionPath();

      // ── 第二优先：sessions.create({ workspaceId, agentPreset }) + 门面预填
      function createSessionPath() {
        if (sessions && typeof sessions.create === "function") {
          var opts = {};
          if (wsId) opts.workspaceId = wsId;
          if (effectivePreset) opts.agentPreset = effectivePreset;
          console.info(TAG, "创建会话参数：", JSON.stringify(opts));
          try {
            Promise.resolve(sessions.create(opts)).then(function (res) {
              var newId = res && res.ok && res.value ? res.value.sessionId : undefined;
              if (!newId) {
                console.warn(TAG, "create 没有返回 sessionId：", res);
                // 关键：不能只报错，必须退回 openWorkspace，否则连会话都建不出来。
                fallbackOpenWorkspace("create 返回里没有 sessionId");
                return;
              }
              afterCreated(newId);
            }).catch(function (e) {
              console.warn(TAG, "sessions.create 失败：", e);
              fallbackOpenWorkspace("sessions.create 失败：" + (e && e.message ? e.message : "未知错误"));
            });
          } catch (e) {
            console.warn(TAG, "sessions.create 抛错：", e);
            fallbackOpenWorkspace("sessions.create 抛错：" + (e && e.message ? e.message : "未知错误"));
          }
          return;
        }

        fallbackOpenWorkspace("宿主没有 sessions.create");
      }
    }

    function openDialog(ctx, payload) {
      ensureStyle();
      closeDialog();

      var titleMap = readWorkspaceTitles(ctx);
      var data = readSessions(ctx);
      var currentCwd = data.currentCwd;
      var rows = data.sessions.slice();

      if (currentCwd) {
        var same = rows.filter(function (s) { return s.cwd === currentCwd; });
        if (same.length > 0) rows = same;
      }
      rows.sort(function (a, b) {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
        return String(a.title).localeCompare(String(b.title));
      });

      var selectedId = payload && payload.sessionId ? payload.sessionId : undefined;
      var exists = rows.some(function (s) { return s.id === selectedId; });
      if (!selectedId || !exists) selectedId = rows.length ? rows[0].id : undefined;
      var selectedPreset = "";
      var selectedRead = "auto";

      var overlay = el("div", "overlay");
      var panel = el("div", "panel");

      var head = el("div", "head");
      var headTop = el("div", "headtop");
      var headTitle = el("h2", "h2", "移交会话");
      headTop.appendChild(headTitle);
      var tabHandoff = el("button", "tab", "移交");
      tabHandoff.type = "button";
      tabHandoff.setAttribute("data-on", "1");
      var tabClean = el("button", "tab", "清理交接文档");
      tabClean.type = "button";
      headTop.appendChild(tabHandoff);
      headTop.appendChild(tabClean);
      head.appendChild(headTop);
      var headSub = el("p", "sub", "挑一个老会话，新开一个干净的会话接着干。老会话原样保留。");
      head.appendChild(headSub);

      var body = el("div", "body");
      var left = el("div", "left");
      var list = el("div", "list");
      var right = el("div", "right");

      // ---- 左侧：按工作区折叠 ----
      var groupOrder = [];
      var groupMap = {};
      rows.forEach(function (item) {
        var key = item.cwd || "";
        if (!groupMap[key]) { groupMap[key] = []; groupOrder.push(key); }
        groupMap[key].push(item);
      });
      if (currentCwd && groupMap[currentCwd]) {
        groupOrder = [currentCwd].concat(groupOrder.filter(function (k) { return k !== currentCwd; }));
      }

      var allRows = [];
      function makeRow(item) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = MENU_ID + "-row";
        btn.setAttribute("data-session-id", item.id);
        if (item.id === selectedId) btn.setAttribute("data-selected", "1");

        var t = el("span", "t");
        if (item.isCurrent) t.appendChild(el("span", "curtag", "当前"));
        t.appendChild(document.createTextNode(item.title));

        var m = el("span", "m", (item.isCurrent ? "当前会话 · " : "") + (item.preset || "默认模式"));
        btn.appendChild(t);
        btn.appendChild(m);

        btn.addEventListener("click", function (ev) {
          try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
          selectedId = item.id;
          allRows.forEach(function (x) {
            if (x.getAttribute("data-session-id") === selectedId) x.setAttribute("data-selected", "1");
            else x.removeAttribute("data-selected");
          });
        });

        allRows.push(btn);
        return btn;
      }

      if (rows.length === 0) list.appendChild(el("div", "group", "没有可移交的会话"));

      groupOrder.forEach(function (cwd) {
        var members = groupMap[cwd];
        // 只有「选中项所在的工作区」默认展开，其余默认收起。
        var hasSelected = !!selectedId && members.some(function (m) { return m.id === selectedId; });
        var group = el("div", "group");
        group.setAttribute("data-collapsed", hasSelected ? "0" : "1");
        group.appendChild(el("span", "caret", "▼"));
        group.appendChild(document.createTextNode(workspaceLabel(cwd, titleMap)));
        group.appendChild(el("span", "count", String(members.length) + " 个会话"));

        var box = el("div", "rows");
        box.hidden = !hasSelected;
        members.forEach(function (item) { box.appendChild(makeRow(item)); });

        group.addEventListener("click", function (ev) {
          try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
          var collapsed = group.getAttribute("data-collapsed") === "1";
          group.setAttribute("data-collapsed", collapsed ? "0" : "1");
          box.hidden = !collapsed;
        });

        list.appendChild(group);
        list.appendChild(box);
      });

      left.appendChild(list);

      // ---- 右侧：两组选项，说明就写在选项里，不再另开解释区 ----
      // 模式一：新会话模式
      right.appendChild(el("div", "lbl", "新会话模式（决定给它什么工具）"));
      var optEls = [];
      PRESETS.forEach(function (p) {
        var opt = el("div", "opt");
        opt.setAttribute("data-preset", p.id);
        if (p.id === selectedPreset) opt.setAttribute("data-on", "1");
        opt.appendChild(el("span", "radio"));
        var wrap = document.createElement("span");
        wrap.appendChild(document.createTextNode(p.label));
        wrap.appendChild(el("span", "opthint", p.hint));
        opt.appendChild(wrap);
        opt.addEventListener("click", function (ev) {
          try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
          selectedPreset = p.id;
          optEls.forEach(function (x) {
            if (x.getAttribute("data-preset") === selectedPreset) x.setAttribute("data-on", "1");
            else x.removeAttribute("data-on");
          });
        });
        optEls.push(opt);
        right.appendChild(opt);
      });

      // 模式二：读取方式
      right.appendChild(el("div", "lbl", "它怎么读老会话的内容"));
      var readEls = [];
      READS.forEach(function (r) {
        var opt = el("div", "opt");
        opt.setAttribute("data-read", r.id);
        if (r.id === selectedRead) opt.setAttribute("data-on", "1");
        opt.appendChild(el("span", "radio"));
        var wrap = document.createElement("span");
        wrap.appendChild(document.createTextNode(r.label));
        wrap.appendChild(el("span", "opthint", r.hint));
        opt.appendChild(wrap);
        opt.addEventListener("click", function (ev) {
          try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
          selectedRead = r.id;
          readEls.forEach(function (x) {
            if (x.getAttribute("data-read") === selectedRead) x.setAttribute("data-on", "1");
            else x.removeAttribute("data-on");
          });
        });
        readEls.push(opt);
        right.appendChild(opt);
      });

      body.appendChild(left);
      body.appendChild(right);

      // ---- 「清理」页：数据全部来自主进程（记录、轮数、删除都在那边） ----
      var cleanPane = el("div", "cleanpane");
      cleanPane.style.display = "none";
      var cleanList = el("div", "cleanlist");
      cleanPane.appendChild(cleanList);
      var cleanFoot = el("div", "cleanfoot");
      cleanPane.appendChild(cleanFoot);

      var cleanState = { records: [], loaded: false, error: "" };

      function docName(rec) {
        return rec.docPath ? String(rec.docPath).split(/[\\/]/).pop() : "（没记到路径）";
      }

      /** 会话 id -> 当前标题（用户随时可能改名，所以每次都现取）。 */
      function sessionTitleMap(ctx) {
        var map = {};
        try {
          var svc = probe(ctx, "sessions");
          var snap = svc && svc.list && typeof svc.list.getSnapshot === "function"
            ? svc.list.getSnapshot()
            : undefined;
          var byId = snap && snap.byId;
          if (!byId) return map;
          Object.keys(byId).forEach(function (id) {
            var it = byId[id] || {};
            var t = typeof it.title === "string" && it.title
              ? it.title
              : (typeof it.displayTitle === "string" ? it.displayTitle : "");
            if (t) map[id] = t;
          });
        } catch (e) {}
        return map;
      }

      function renderClean() {
        cleanList.textContent = "";
        if (!cleanState.loaded) {
          cleanList.appendChild(el("div", "cleanempty", "正在问主进程…"));
          return;
        }
        if (cleanState.error) {
          cleanList.appendChild(el("div", "cleanempty", "取不到记录：" + cleanState.error));
          return;
        }
        if (!cleanState.records.length) {
          cleanList.appendChild(el("div", "cleanempty", "还没有移交记录。先去「移交」页选一个老会话、点「新建并移交」；做完回到这里，就会列出「哪份交接文档、跑了几轮、能不能删」。"));
          return;
        }
        var titles = sessionTitleMap(ctx);
        var pending = cleanState.records.filter(function (r) { return !r.done; });
        var doneList = cleanState.records.filter(function (r) { return r.done; });

        /** 一行记录：左边「老 → 新」+ 状态 + 文件名，右边操作按钮。 */
        function makeCard(rec, isDone) {
          var item = el("div", "cleanitem");
          var main = el("div", "cleanmain");

          var line1 = el("div", "cleanname");
          line1.appendChild(el("span", "cleanfrom", titles[rec.oldId] || rec.oldTitle || "未命名会话"));
          line1.appendChild(el("span", "cleanarrow", "→"));
          line1.appendChild(el("span", "cleanto", rec.newId
            ? (titles[rec.newId] || "（新会话还没起名）")
            : "（没记到接手会话）"));
          main.appendChild(line1);

          var why = "";
          var dotKind = "wait";
          if (isDone) {
            why = rec.doneReason === "ignored"
              ? "已忽略（当时没写出文档，不涉及任何文件）"
              : "已删（文件不在了，老会话还在）";
            dotKind = "ok";
          } else if (!rec.docExists) {
            why = "交接文档还没写到这个位置";
            dotKind = "bad";
          } else if (rec.canDelete) {
            why = rec.reasons.join("；");
            dotKind = "ok";
          } else {
            var left = Math.max(0, 3 - (rec.turns || 0));
            why = "已跑 " + (rec.turns || 0) + " 轮" + (left > 0 ? "，还差 " + left + " 轮" : "");
            if (!rec.turnsKnown) why = "还没跑过（或没打开过），轮数未知";
          }
          var line2 = el("div", "cleanwhy");
          var dot = el("span", "dot");
          dot.setAttribute("data-k", dotKind);
          line2.appendChild(dot);
          line2.appendChild(el("span", "cleanstatetext", why));
          if (rec.docPath) line2.appendChild(el("span", "cleanfile", "·  " + docName(rec)));
          main.appendChild(line2);
          item.appendChild(main);

          // 每条记录一个「打开文件夹」：点哪条就开它那个工作区的交接目录
          if (rec.cwd) {
            var openBtn = el("button", "chipbtn", "打开文件夹");
            openBtn.type = "button";
            openBtn.title = rec.cwd + "\\AI工作区\\交接";
            openBtn.addEventListener("click", function (ev) {
              try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
              host("openFolder", { cwd: rec.cwd }).then(function (res) {
                if (res && res.ok === true) {
                  toast("已打开交接文件夹（" + (res.via || "未知方式") + "）：\n" + (res.dir || rec.cwd));
                  return;
                }
                var dir = (res && res.dir) || (rec.cwd + "\\AI工作区\\交接");
                var notes = (res && res.notes) || [];
                toast("打开文件夹失败！\n" + (notes.length ? notes.join("\n") : ((res && res.error) || "未知原因")) +
                  "\n\n路径已复制，可以自己粘到资源管理器：\n" + dir);
                copyToClipboard(dir, "路径已复制");
              }).catch(function (e) {
                var dir = rec.cwd + "\\AI工作区\\交接";
                toast("打开文件夹请求没发出去：" + (e && e.message ? e.message : "未知") + "\n\n路径已复制：\n" + dir);
                copyToClipboard(dir, "路径已复制");
              });
            });
            item.appendChild(openBtn);
          }

          if (!isDone && rec.docExists) {
            var delBtn = el("button", "chipbtn", rec.canDelete ? "删除" : "删（还没到条件）");
            delBtn.type = "button";
            if (!rec.canDelete) delBtn.disabled = true;
            delBtn.addEventListener("click", function (ev) {
              try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
              confirmBox({
                title: "删这份交接文档？",
                message: rec.docPath + "\n\n删的是 .md 文件；老会话「" + rec.oldTitle + "」不受影响。",
                okText: "删除"
              }).then(function (yes) {
                if (!yes) return;
                host("delete", { paths: [rec.docPath] }).then(function (res) {
                  if (!res || res.ok !== true) { toast("删除失败：" + ((res && res.error) || "未知")); return; }
                  if (!res.deleted.length) {
                    var r0 = (res.refused && res.refused[0]) || (res.failed && res.failed[0]);
                    toast("没删成：" + ((r0 && r0.reason) || "未知原因"));
                    return;
                  }
                  return host("markDone", {
                    cwd: rec.cwd, oldId: rec.oldId, at: rec.at, reason: "deleted"
                  }).then(function () {
                    toast("已删：" + docName(rec));
                    loadClean();
                  });
                }).catch(function (e) {
                  toast("删除请求失败：" + (e && e.message ? e.message : "未知"));
                });
              });
            });
            item.appendChild(delBtn);
          } else if (!isDone && !rec.docExists) {
            var ignoreBtn = el("button", "chipbtn", "忽略");
            ignoreBtn.type = "button";
            ignoreBtn.addEventListener("click", function (ev) {
              try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
              confirmBox({
                title: "忽略这条记录？",
                message: "它对应的交接文档从来没写出来。\n忽略只影响这个列表，不删任何文件，老会话也不动。",
                okText: "忽略"
              }).then(function (yes) {
                if (!yes) return;
                host("markDone", {
                  cwd: rec.cwd, oldId: rec.oldId, at: rec.at, reason: "ignored"
                }).then(function (res) {
                  if (!res || res.ok !== true) { toast("忽略失败：" + ((res && res.error) || "未知")); return; }
                  toast("已忽略这条记录");
                  loadClean();
                }).catch(function (e) {
                  toast("忽略请求失败：" + (e && e.message ? e.message : "未知"));
                });
              });
            });
            item.appendChild(ignoreBtn);
          }
          return item;
        }

        // ---- 先按工作区分组（工作区默认收起，组头显示绿/红点统计）----
        var groups = [];
        var byCwd = {};
        pending.forEach(function (rec) {
          var key = rec.cwd || "";
          if (!byCwd[key]) { byCwd[key] = { cwd: key, rows: [] }; groups.push(byCwd[key]); }
          byCwd[key].rows.push(rec);
        });
        groups.forEach(function (g) {
          g.okCount = g.rows.filter(function (r) { return r.canDelete; }).length;
          g.missing = g.rows.filter(function (r) { return !r.docExists; }).length;
          var label = titleMap[g.cwd];
          g.label = label || (g.cwd ? g.cwd.split(/[\\/]/).filter(Boolean).pop() : "未归属工作区");
        });
        groups.sort(function (a, b) { return b.okCount - a.okCount; });

        if (!groups.length) {
          cleanList.appendChild(el("div", "cleanempty", "没有待处理的交接文档。"));
        }
        groups.forEach(function (g) {
          var head = el("div", "wsgroup");
          head.setAttribute("data-collapsed", "1");
          head.appendChild(el("span", "wscaret", "\u25BE"));
          head.appendChild(el("span", "wsname", g.label + "（" + g.rows.length + "）"));
          if (g.okCount) {
            var okb = el("span", "wsbadge", "\u25CF " + g.okCount + " 可删");
            okb.setAttribute("data-k", "ok");
            head.appendChild(okb);
          }
          if (g.missing) {
            var badb = el("span", "wsbadge", "\u25CF " + g.missing + " 缺文档");
            badb.setAttribute("data-k", "bad");
            head.appendChild(badb);
          }

          var box = el("div", "wsrows");
          box.style.display = "none";
          g.rows.forEach(function (rec) { box.appendChild(makeCard(rec, false)); });

          var opened = false;
          head.addEventListener("click", function (ev) {
            try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
            opened = !opened;
            box.style.display = opened ? "" : "none";
            head.setAttribute("data-collapsed", opened ? "0" : "1");
          });
          cleanList.appendChild(head);
          cleanList.appendChild(box);
        });

        // 已处理（已删 / 已忽略）默认收起，不占视线；点一下才展开看痕迹
        if (doneList.length) {
          var foldWrap = el("div");
          var foldBtn = el("button", "cleanfold", "▸ 已处理 " + doneList.length + " 条（已删 / 已忽略）");
          foldBtn.type = "button";
          var foldBox = el("div");
          foldBox.style.display = "none";
          doneList.forEach(function (rec) {
            var c = makeCard(rec, true);
            c.className = MENU_ID + "-cleanitem " + MENU_ID + "-cleandim";
            foldBox.appendChild(c);
          });
          var opened = false;
          foldBtn.addEventListener("click", function (ev) {
            try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
            opened = !opened;
            foldBox.style.display = opened ? "" : "none";
            foldBtn.textContent = (opened ? "▾ 已处理 " : "▸ 已处理 ") + doneList.length + " 条（已删 / 已忽略）";
          });
          foldWrap.appendChild(foldBtn);
          foldWrap.appendChild(foldBox);
          cleanList.appendChild(foldWrap);
        }
      }

      function loadClean() {
        cleanState.loaded = false;
        cleanState.error = "";
        renderClean();
        fetchRecords(ctx).then(function (list) {
          cleanState.records = list;
          cleanState.loaded = true;
          setBadge(list.filter(function (r) { return r.canDelete; }).length);
          renderClean();
          renderCleanFoot();
        }).catch(function (e) {
          cleanState.loaded = true;
          cleanState.error = e && e.message ? e.message : "主进程没响应";
          renderClean();
        });
      }

      function renderCleanFoot() {
        cleanFoot.textContent = "";
        var cs = cleanSettings();
        var sw = el("label", "cleanswitch");
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = cs.sevenDays;
        cb.addEventListener("change", function () {
          setCleanSettings({ sevenDays: cb.checked });
          loadClean();
        });
        sw.appendChild(cb);
        sw.appendChild(document.createTextNode("移交满 7 天也算可以删"));
        cleanFoot.appendChild(sw);

        cleanFoot.appendChild(el("span", "cleanspacer"));

        var refreshBtn = el("button", "chipbtn", "刷新");
        refreshBtn.type = "button";
        refreshBtn.addEventListener("click", function (ev) {
          try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
          loadClean();
        });
        cleanFoot.appendChild(refreshBtn);

        var allBtn = el("button", "chipbtn", "全部删除");
        allBtn.type = "button";
        var targets = cleanState.records.filter(function (r) { return r.canDelete; });
        if (!targets.length) allBtn.disabled = true;
        allBtn.addEventListener("click", function (ev) {
          try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
          if (!targets.length) { toast("现在没有满足条件的。"); return; }
          confirmBox({
            title: "全部删除",
            message: "只会删「现在能删的」这 " + targets.length + " 份。\n" +
              "没到条件（没跑满 3 轮、也没满 7 天）的记录不会被动。\n\n老会话不受影响。",
            okText: "删这 " + targets.length + " 份"
          }).then(function (yes) {
            if (!yes) return;
            host("delete", { paths: targets.map(function (r) { return r.docPath; }) }).then(function (res) {
              if (!res || res.ok !== true) { toast("删除失败：" + ((res && res.error) || "未知")); return; }
              var done = targets.filter(function (r) {
                return (res.deleted || []).indexOf(r.docPath) >= 0;
              });
              Promise.all(done.map(function (r) {
                return host("markDone", {
                  cwd: r.cwd, oldId: r.oldId, at: r.at, reason: "deleted"
                }).catch(function () {});
              })).then(function () {
                toast("已删 " + done.length + " 份交接文档（老会话都没动）");
                loadClean();
              });
            }).catch(function (e) { toast("删除请求失败：" + (e && e.message ? e.message : "未知")); });
          });
        });
        cleanFoot.appendChild(allBtn);

        var doneCount = cleanState.records.filter(function (r) { return r.done; }).length;
        var clearBtn = el("button", "chipbtn", "清空已处理");
        clearBtn.type = "button";
        if (!doneCount) clearBtn.disabled = true;
        clearBtn.addEventListener("click", function (ev) {
          try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
          if (!doneCount) { toast("现在没有已处理的记录。"); return; }
          confirmBox({
            title: "清空已处理记录",
            message: "会从列表里清掉 " + doneCount + " 条「已删 / 已忽略」的历史记录。\n\n" +
              "· 只清记录，磁盘上的 移交记录.json 本身保留\n" +
              "· 未处理的记录不受影响\n" +
              "· 已经删掉的 .md 不会回来，也不会再删别的文件",
            okText: "清空"
          }).then(function (yes) {
            if (!yes) return;
            host("clearDone", { cwds: allWorkspaceCwds(ctx) }).then(function (res) {
              if (!res || res.ok !== true) { toast("清空失败：" + ((res && res.error) || "未知")); return; }
              toast("已清掉 " + (res.removed || 0) + " 条已处理记录");
              loadClean();
            }).catch(function (e) { toast("清空请求失败：" + (e && e.message ? e.message : "未知")); });
          });
        });
        cleanFoot.appendChild(clearBtn);

        // 关闭弹窗（清理页没有「新建并移交」，所以单独给一个取消）
        var closeBtn = el("button", "chipbtn", "取消");
        closeBtn.type = "button";
        closeBtn.addEventListener("click", function (ev) {
          try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
          closeDialog();
        });
        cleanFoot.appendChild(closeBtn);
      }
      renderCleanFoot();

      var foot = el("div", "foot");
      var cancelBtn = el("button", "btn", "取消");
      cancelBtn.type = "button";
      var nextBtn = el("button", "btn", "新建并移交");
      nextBtn.type = "button";
      nextBtn.setAttribute("data-primary", "1");
      foot.appendChild(cancelBtn);
      foot.appendChild(nextBtn);

      // ---- 两个标签页切换 ----
      function showPane(which) {
        var isClean = which === "clean";
        headTitle.textContent = isClean ? "清理交接文档" : "移交会话";
        body.style.display = isClean ? "none" : "";
        cleanPane.style.display = isClean ? "" : "none";
        foot.style.display = isClean ? "none" : "";
        if (isClean) {
          tabClean.setAttribute("data-on", "1");
          tabHandoff.removeAttribute("data-on");
          headSub.textContent = "交接文档是临时的：接手会话跑满 3 轮（或移交满 7 天）就能删。删的是那份 .md，老会话不受影响。";
          if (!cleanState.loaded) loadClean();
        } else {
          tabHandoff.setAttribute("data-on", "1");
          tabClean.removeAttribute("data-on");
          headSub.textContent = "挑一个老会话，新开一个干净的会话接着干。老会话原样保留。";
        }
      }
      tabHandoff.addEventListener("click", function (ev) {
        try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
        showPane("handoff");
      });
      tabClean.addEventListener("click", function (ev) {
        try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
        showPane("clean");
      });
      if (payload && payload.openClean) showPane("clean");

      panel.appendChild(head);
      panel.appendChild(body);
      panel.appendChild(cleanPane);
      panel.appendChild(foot);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);

      setTimeout(function () {
        try {
          var sel = list.querySelector("." + MENU_ID + "-row[data-selected='1']");
          if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "center" });
        } catch (e) {}
      }, 10);

      var onKey = function (ev) {
        // 确认框开着的时候，Esc 归确认框管，别把主弹窗一起关了
        if (dialogState && dialogState.childOpen) return;
        if (ev && ev.key === "Escape") {
          try { ev.stopPropagation(); } catch (e) {}
          closeDialog();
        }
      };
      document.addEventListener("keydown", onKey, true);
      dialogState = { onKey: onKey, overlay: overlay };

      cancelBtn.addEventListener("click", function (ev) {
        try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
        closeDialog();
      });
      nextBtn.addEventListener("click", function (ev) {
        try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
        var picked = rows.filter(function (s) { return s.id === selectedId; })[0];
        if (!picked) {
          toast("还没有选中要移交的会话。");
          return;
        }
        closeDialog();
        doHandoff(ctx, picked, selectedPreset, selectedRead);
      });
      overlay.addEventListener("click", function (ev) {
        if (ev && ev.target === overlay) closeDialog();
      });

      console.info(TAG, "弹窗打开：会话 " + rows.length + " 条");
    }

    /**
     * 插件自己的确认框——替掉 window.confirm（那个是系统原生窗口，样式不受控）。
     * @param {{title?: string, message?: string, okText?: string, cancelText?: string}} opts
     * @returns {Promise<boolean>}
     */
    function confirmBox(opts) {
      opts = opts || {};
      return new Promise(function (resolve) {
        try {
          ensureStyle();
          // 主弹窗开着就挂进它的遮罩里：同一层叠上下文 + DOM 顺序靠后，天然压在它上面
          var host = (dialogState && dialogState.overlay) || document.body;
          var inDialog = host !== document.body;
          var mask = el("div", "confirm-mask");
          if (inDialog) mask.setAttribute("data-in", "1");
          var panel = el("div", "confirm");
          panel.appendChild(el("div", "confirm-title", opts.title || "确认"));
          panel.appendChild(el("div", "confirm-body", String(opts.message || "")));
          var foot = el("div", "confirm-foot");
          var cancelBtn = el("button", "chipbtn", opts.cancelText || "取消");
          cancelBtn.type = "button";
          var okBtn = el("button", "chipbtn", opts.okText || "确定");
          okBtn.type = "button";
          okBtn.setAttribute("data-primary", "1");
          foot.appendChild(cancelBtn);
          foot.appendChild(okBtn);
          panel.appendChild(foot);
          mask.appendChild(panel);
          host.appendChild(mask);

          // 主弹窗的 Esc 先于本框执行，这里挂个标记让它让路
          if (dialogState) dialogState.childOpen = true;

          function close(value) {
            try { mask.remove(); } catch (e) {}
            try { document.removeEventListener("keydown", onKey, true); } catch (e) {}
            if (dialogState) dialogState.childOpen = false;
            resolve(value === true);
          }
          function onKey(ev) {
            if (ev && ev.key === "Escape") {
              try { ev.stopPropagation(); } catch (e) {}
              close(false);
            }
          }
          cancelBtn.addEventListener("click", function (ev) {
            try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
            close(false);
          });
          okBtn.addEventListener("click", function (ev) {
            try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
            close(true);
          });
          mask.addEventListener("click", function (ev) {
            if (ev && ev.target === mask) close(false);
          });
          document.addEventListener("keydown", onKey, true);
          setTimeout(function () { try { okBtn.focus(); } catch (e) {} }, 10);
        } catch (e) {
          // 兜底：自绘失败就直接问系统
          try { resolve(window.confirm(String(opts.message || ""))); } catch (e2) { resolve(false); }
        }
      });
    }

    function toast(text) {
      try {
        ensureStyle();
        var div = el("div", "toast", text);
        document.body.appendChild(div);
        setTimeout(function () {
          try { div.remove(); } catch (e) {}
        }, 4000);
      } catch (e) {}
    }

    // ---------------------------------------------------------------------
    // 菜单项：优先复用宿主 MenuItemButton
    // ---------------------------------------------------------------------

    var currentCtx = null;

    function HandoffMenuItem(props) {
      var sessionId = props && props.sessionId;
      var displayTitle = props && props.displayTitle;

      // 可删数量（主进程算的）——菜单项右上角一个小红点
      var badgeState = react.useState(badgeValue);
      var count = badgeState[0];
      var setCount = badgeState[1];
      react.useEffect(function () {
        var off = onBadge(setCount);
        try { startCleanTicker(currentCtx); } catch (e) {}
        return off;
      }, []);

      var label = react.createElement(
        "span",
        null,
        "移交会话",
        count > 0 ? react.createElement("span", { className: MENU_ID + "-badge" }, String(count)) : null
      );

      function onSelect(event) {
        try { if (event) { event.preventDefault(); event.stopPropagation(); } } catch (e) {}
        try {
          openDialog(currentCtx, { sessionId: sessionId, displayTitle: displayTitle });
        } catch (e) {
          console.warn(TAG, "打开弹窗失败：", e && e.message);
          toast("打开移交弹窗失败：" + (e && e.message ? e.message : "未知错误"));
        }
      }

      // 图标：16×16 单色线条（B 弧线迁移的 16px 版）
      // 造型：一个会话气泡 + 一道弧线冲向右上。砍掉生图里第二个气泡——16px 装不下两个主体。
      // 经验：16px 里最多两个元素；线宽 1.5 才够显眼；图形要占满 1.5~14.5，别缩在中间。
      var iconNode = react.createElement(
        "svg",
        {
          width: 16,
          height: 16,
          viewBox: "0 0 16 16",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.5,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true"
        },
        react.createElement("rect", {
          key: "bubble",
          x: 1.5,
          y: 8.5,
          width: 9,
          height: 6,
          rx: 2
        }),
        react.createElement("path", { key: "arc", d: "M5.8 8.3C5.8 4.2 9.2 1.9 13.6 1.9" }),
        react.createElement("path", { key: "head", d: "M11.6 0.6 13.9 1.9 11.6 3.2" })
      );

      // 宿主组件：样式完全一致（外层 itemWrap + button[role=menuitem]）
      if (primitives && typeof primitives.MenuItemButton === "function") {
        return react.createElement(primitives.MenuItemButton, { onSelect: onSelect, icon: iconNode }, label);
      }

      // 降级：自己画一个尽量像的
      return react.createElement(
        "button",
        {
          type: "button",
          role: "menuitem",
          className: MENU_ID + "-menuitem",
          onClick: onSelect,
        },
        iconNode,
        label
      );
    }

    function apply(ctx) {
      try {
        currentCtx = ctx;
        var slots = probe(ctx, "slots");
        if (!slots) {
          console.warn(TAG, "宿主没有 slots 服务，插件静默不启用");
          return;
        }
        if (!react) {
          console.warn(TAG, "没有 react，跳过菜单项注册");
          return;
        }
        if (typeof slots.inject !== "function" || typeof slots.register !== "function") {
          console.warn(TAG, "slots 服务缺少 inject/register，宿主版本可能不兼容");
          return;
        }

        function seat() {
          return slots.register(
            { name: MENU_SLOT, id: MENU_ID, order: MENU_ORDER },
            HandoffMenuItem
          );
        }

        function registerMenuItem() {
          try {
            slots.inject(MENU_SLOT, seat);
          } catch (e) {
            console.warn(TAG, "菜单项注册失败：", e && e.message);
          }
        }

        if (typeof ctx.effect === "function") {
          ctx.effect(function () {
            ensureStyle();
            registerMenuItem();
            startCleanTicker(ctx);
            return function () {
              closeDialog();
              if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
            };
          }, "dsh-takeover: menu item");
        } else {
          ensureStyle();
          registerMenuItem();
          startCleanTicker(ctx);
        }

        console.info(TAG, "client v0.10.0 已加载（MenuItemButton=" + (primitives && primitives.MenuItemButton ? "复用" : "降级") + "）");
      } catch (e) {
        console.warn(TAG, "初始化失败：", e && e.message);
      }
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
