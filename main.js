const { Plugin, Notice, Menu, normalizePath, getLinkpath, setIcon } = require("obsidian");

const LOG_KEY = "log";
const LOG_FOLDER = "logs";
const SIZE = { width: 380, height: 520 };

// Obsidian 不同版本暴露 remote 的方式不同，两种都试
const getRemote = () => {
    for (const load of [() => require("electron").remote, () => require("@electron/remote")]) {
        try {
            const r = load();
            if (r) return r;
        } catch {}
    }
    return null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const linkOf = (raw) => String(raw).replace(/^\[\[|\]\]$/g, "").split("|")[0];

module.exports = class StickyLogPlugin extends Plugin {
    async onload() {
        this.wins = new Map(); // 便签窗口 window -> { win, bw, btns, collapsed, height }
        this.decorated = new WeakSet(); // 已加过按钮的 view
        document.body.removeClass("sticky-log", "sticky-collapsed"); // 主窗口永远不是便签
        const onClick = (e) => this.onClick(e);
        this.registerDomEvent(document, "click", onClick, true);
        this.registerEvent(this.app.workspace.on("window-open", (_, win) =>
            this.registerDomEvent(win.document, "click", onClick, true)));
        this.registerEvent(this.app.workspace.on("window-close", (_, win) => {
            if (!this.wins.delete(win)) return;
            if (!this.wins.size) this.showMain();
        }));
        // 便签窗口里新建/切换的标签页也要补上按钮
        this.registerEvent(this.app.workspace.on("layout-change", () => this.decorateAll()));

        this.addCommand({ id: "open-current-log", name: "以便签打开当前项目日志", callback: () => this.openFromActive() });
        this.addCommand({ id: "toggle-pin", name: "切换当前窗口置顶", callback: () => this.togglePin() });
        this.addCommand({ id: "show-main", name: "显示 Obsidian 主窗口", callback: () => this.showMain() });
    }

    // 停用插件时清掉便签样式类，避免残留（包括上个版本误加到主窗口上的）
    onunload() {
        for (const doc of [document, ...[...this.wins.keys()].map((w) => w.document)])
            doc.body.removeClass("sticky-log", "sticky-collapsed");
        if (this.wins.size) this.showMain();
    }

    // 拦截属性面板里 log 链接的点击；按住 ⌘ 点击保留默认行为（在标签页打开）
    onClick(e) {
        if (e.button !== 0 || e.metaKey || e.ctrlKey) return;
        const t = e.target;
        if (!t?.closest) return;
        const prop = t.closest(`.metadata-property[data-property-key="${LOG_KEY}"]`);
        const link = prop && t.closest(".internal-link, .metadata-link-inner");
        if (!link) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.openSticky(link.dataset.href || link.textContent.trim(), this.sourceOf(t));
    }

    sourceOf(el) {
        let src = this.app.workspace.getActiveFile()?.path ?? "";
        this.app.workspace.iterateAllLeaves((l) => {
            if (l.view?.file && l.view.containerEl.contains(el)) src = l.view.file.path;
        });
        return src;
    }

    openFromActive() {
        const file = this.app.workspace.getActiveFile();
        const raw = file && this.app.metadataCache.getFileCache(file)?.frontmatter?.[LOG_KEY];
        if (!raw) return new Notice("当前笔记没有 log 属性");
        this.openSticky(linkOf(raw), file.path);
    }

    async resolve(linktext, src) {
        const linkpath = getLinkpath(linktext);
        return this.app.metadataCache.getFirstLinkpathDest(linkpath, src) ?? await this.createLog(linkpath, src);
    }

    // 在便签窗口里找已打开该日志的标签页（可限定某个窗口）
    findLeaf(file, win) {
        let hit = null;
        this.app.workspace.iterateAllLeaves((l) => {
            const w = l.view?.containerEl?.win;
            if (!hit && l.view?.file?.path === file.path && this.wins.has(w) && (!win || w === win)) hit = l;
        });
        return hit;
    }

    focusLeaf(leaf) {
        leaf.view.containerEl.win.focus();
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
    }

    async openSticky(linktext, src) {
        const file = await this.resolve(linktext, src);
        const old = this.findLeaf(file);
        if (old) return this.focusLeaf(old);

        const remote = getRemote();
        const before = new Set(remote ? remote.BrowserWindow.getAllWindows().map((w) => w.id) : []);
        const leaf = this.app.workspace.openPopoutLeaf({ size: SIZE });
        await leaf.openFile(file, { active: true, state: { mode: "source" } });
        // 必须在 openFile 之后取窗口：之前 view 还没挂到弹出窗口，拿到的会是主窗口
        const win = leaf.getContainer?.()?.win ?? leaf.view.containerEl.win;
        if (win === window) return new Notice("便签窗口创建失败");
        const s = { win, bw: null, btns: new Set(), collapsed: false, height: SIZE.height };
        this.wins.set(win, s);
        win.document.body.addClass("sticky-log");
        // 折叠状态下点击横条上的标题即展开
        this.registerDomEvent(win.document, "click", (e) => {
            if (!s.collapsed || !e.target?.closest?.(".view-header-title-container")) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            this.toggleCollapse(s);
        }, true);
        this.decorateAll();

        if (!remote) return new Notice("已打开日志窗口，但当前环境无法置顶");
        // 新弹出的窗口不一定立刻出现在列表里，短暂轮询
        for (let i = 0; i < 20; i++) {
            s.bw = remote.BrowserWindow.getAllWindows().find((w) => !before.has(w.id)) ?? null;
            if (s.bw) {
                s.bw.setAlwaysOnTop(true, "floating");
                // 从主窗口打开便签后把主窗口藏起来，最后一个便签关闭时再恢复
                const main = this.mainWindow();
                if (main && main.isVisible()) main.hide();
                return;
            }
            await sleep(50);
        }
        new Notice("已打开日志窗口，但未能置顶");
    }

    // 插件代码运行在主窗口的渲染进程里，getCurrentWindow 拿到的就是主窗口
    mainWindow() {
        try { return getRemote()?.getCurrentWindow() ?? null; } catch { return null; }
    }

    showMain() {
        const main = this.mainWindow();
        if (!main) return;
        if (main.isMinimized()) main.restore();
        main.show();
        main.focus();
    }

    // 给便签窗口里每个日志标签页的标题栏加按钮；addAction 往左插入，所以后加的「切换日志」在折叠按钮左边
    decorateAll() {
        this.app.workspace.iterateAllLeaves((leaf) => {
            const view = leaf.view;
            const s = this.wins.get(view?.containerEl?.win);
            if (!s || view.getViewType() !== "markdown" || this.decorated.has(view)) return;
            this.decorated.add(view);
            const btn = view.addAction(s.collapsed ? "chevrons-down" : "chevrons-up",
                s.collapsed ? "展开" : "折叠为横条", () => this.toggleCollapse(s));
            s.btns.add(btn);
            view.addAction("notebook-tabs", "打开其他项目日志", (e) => this.pickLog(e, leaf));
        });
    }

    // 列出所有未归档项目，选中后在当前便签窗口新开标签页（已打开则切过去）
    pickLog(evt, leaf) {
        const current = leaf.view?.file?.path;
        const items = this.app.vault.getMarkdownFiles()
            .filter((f) => !f.path.startsWith("_templates/"))
            .map((f) => ({ f, fm: this.app.metadataCache.getFileCache(f)?.frontmatter }))
            .filter(({ fm }) => fm?.type === "project" && fm.archived !== true && fm[LOG_KEY])
            .sort((a, b) => b.f.stat.mtime - a.f.stat.mtime);
        if (!items.length) return new Notice("没有带 log 属性的未归档项目");
        const menu = new Menu();
        for (const { f, fm } of items) {
            const dest = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(linkOf(fm[LOG_KEY])), f.path);
            menu.addItem((it) => it.setTitle(f.basename).setIcon("folder")
                .setChecked(dest?.path === current)
                .onClick(() => this.openInWindow(linkOf(fm[LOG_KEY]), f.path, leaf)));
        }
        menu.addSeparator();
        menu.addItem((it) => it.setTitle("显示 Obsidian 主窗口").setIcon("app-window")
            .onClick(() => this.showMain()));
        menu.showAtMouseEvent(evt);
    }

    async openInWindow(linktext, src, leaf) {
        const file = await this.resolve(linktext, src);
        const win = leaf.view.containerEl.win;
        const old = this.findLeaf(file, win);
        if (old) return this.focusLeaf(old);
        const parent = leaf.parent;
        const tab = this.app.workspace.createLeafInParent(parent, parent.children.length);
        await tab.openFile(file, { active: true, state: { mode: "source" } });
        this.decorateAll();
        this.focusLeaf(tab);
    }

    // 折叠：只保留标题栏一条（仍置顶）；展开：恢复折叠前的高度
    async toggleCollapse(s) {
        const body = s.win.document.body;
        // 主窗口隐藏/最小化时，调整便签尺寸可能把它连带唤出来，记下状态，之后恢复
        const main = this.mainWindow();
        const mainState = main && { visible: main.isVisible(), minimized: main.isMinimized() };
        s.collapsed = !s.collapsed;
        if (s.collapsed) {
            s.height = s.bw ? s.bw.getContentSize()[1] : s.win.innerHeight;
            s.bw?.setWindowButtonVisibility?.(false);
            body.addClass("sticky-collapsed");
            await sleep(30); // 等布局刷新后再量标题栏高度
            const header = [...s.win.document.querySelectorAll(".view-header")].find((h) => h.offsetParent);
            if (header) this.resize(s, Math.ceil(header.getBoundingClientRect().bottom));
        } else {
            body.removeClass("sticky-collapsed");
            s.bw?.setWindowButtonVisibility?.(true);
            this.resize(s, s.height);
        }
        for (const btn of s.btns) {
            if (!btn.isConnected) { s.btns.delete(btn); continue; }
            setIcon(btn, s.collapsed ? "chevrons-down" : "chevrons-up");
            btn.setAttr("aria-label", s.collapsed ? "展开" : "折叠为横条");
        }
        if (!mainState || (mainState.visible && !mainState.minimized)) return;
        await sleep(150);
        if (mainState.minimized && !main.isMinimized()) main.minimize();
        else if (!mainState.visible && main.isVisible()) main.hide();
        s.bw?.focus();
    }

    resize(s, height) {
        if (s.bw) {
            s.bw.setMinimumSize(120, 1); // 默认最小高度会挡住折叠
            s.bw.setContentSize(s.bw.getContentSize()[0], height);
        } else {
            s.win.resizeTo(s.win.outerWidth, height + s.win.outerHeight - s.win.innerHeight);
        }
    }

    // log 指向的文件不存在时，在 logs 下按模板新建
    async createLog(linkpath, src) {
        if (!this.app.vault.getAbstractFileByPath(LOG_FOLDER)) await this.app.vault.createFolder(LOG_FOLDER);
        const project = src.split("/").pop().replace(/\.md$/, "");
        const date = window.moment().format("YYYY-MM-DD");
        const name = linkpath.split("/").pop();
        const file = await this.app.vault.create(normalizePath(`${LOG_FOLDER}/${name}.md`),
            `---\ntype: log\nproject: "[[${project}]]"\ncreated: ${date}\n---\n\n- [ ] \n`);
        new Notice(`已新建日志：${file.path}`);
        return file;
    }

    togglePin() {
        const bw = getRemote()?.BrowserWindow.getFocusedWindow();
        if (!bw) return new Notice("当前环境无法置顶");
        const on = !bw.isAlwaysOnTop();
        bw.setAlwaysOnTop(on, "floating");
        new Notice(on ? "📌 已置顶" : "已取消置顶");
    }
};
