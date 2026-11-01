const {
    Plugin, PluginSettingTab, Setting, Modal, Notice, Menu, MarkdownView, normalizePath, getLinkpath, setIcon, setTooltip,
    editorLivePreviewField, editorInfoField,
} = require("obsidian");
const { ViewPlugin, Decoration, WidgetType, EditorView } = require("@codemirror/view");

// 设置页里可改的约定，默认值就是作者自己仓库的写法
const SETTINGS = {
    projectKey: "type", projectValue: "project", // 项目笔记的识别属性：type: project
    archivedKey: "archived", // 该属性为 true 的项目不出现在列表里
    logKey: "log", // 项目笔记里指向日志的属性
    logFolder: "logs", // 日志不存在时新建到这里
    excludeFolders: "_templates", // 不扫描的文件夹，逗号分隔
    parkHeading: "## 待整理", // 杂念记到日志里的这个小节
    presets: "15, 25, 45, 60", // 番茄钟菜单里的专注时长（分钟）
};
const SIZE = { width: 380, height: 520 };
// 固定用实时预览：纯源码模式下属性会以 YAML 文本显示，无法隐藏
const VIEW_STATE = { mode: "source", source: false };

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
const DRAG_THRESHOLD = 4; // 横条上按下后移动超过这么多像素才算拖动，否则视为点击
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const linkOf = (raw) => String(raw).replace(/^\[\[|\]\]$/g, "").split("|")[0];

const DEFAULTS = { ...SETTINGS, lastMinutes: 25, lastWaitHours: 1, sound: true, timer: null, notified: [], stickyWindows: [] };
const pad = (n) => String(n).padStart(2, "0");
const clock = (sec) => {
    const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};
const minutesOf = (ms) => +(ms / 60000).toFixed(1);

// ---- 任务行上的标记 ----
// 番茄：🍅[开始日期 开始-结束 专注分钟]；在跑：⏰[预计完成时间]，同时把复选框改成 [/]
// 源码里信息齐全、可被搜索和统计；实时预览和阅读视图里收成小标记，悬停看详情，光标碰到时露出源码方便修改
const POMO_RE = /🍅\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})-(\d{2}:\d{2}) (\d+)m\]/gu;
const WAIT_RE = /⏰\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]/u;
const MARK_RE = new RegExp(`${POMO_RE.source}|${WAIT_RE.source}`, "gu");
const NEXT_RE = /^\s*[-*+] 👉 ?(.*)$/u; // 任务下面的「下一步」子项
const TASK_LINE = /^\s*[-*+] \[.\]/;
const DONE_LINE = /^\s*[-*+] \[[xX-]\]/;
// Tasks 插件的字段（优先级、日期、重复、依赖）、在跑标记和块 id 留在行尾，番茄记录插到它们前面
const TASKS_TAIL = new RegExp(String.raw`(?:\s+(?:[🔺⏫🔼🔽⏬]\uFE0F?|(?:🛫|⏳|⌛|📅|📆|🗓|✅|❌|➕)\uFE0F?\s*\d{4}-\d{2}-\d{2}|🔁\uFE0F?[^🔺⏫🔼🔽⏬🛫⏳⌛📅📆🗓✅❌➕🆔⛔🏁⏰^]*|🆔\uFE0F?\s*[\w-]+|⛔\uFE0F?\s*[\w,-]+|🏁\uFE0F?\s*\w+|⏰\[[^\]]*\]))+(?:\s+\^[\w-]+)?\s*$|\s+\^[\w-]+\s*$|\s*$`, "u");

const pomoToken = (start, end, ms) =>
    `🍅[${window.moment(start).format("YYYY-MM-DD HH:mm")}-${window.moment(end).format("HH:mm")} ${Math.max(1, Math.round(ms / 60000))}m]`;
const pomoLabel = ([, date, from, to, min]) => `${date.slice(5)}  ${from}–${to} · 专注 ${min} 分钟`;
const waitToken = (ms) => `⏰[${window.moment(ms).format("YYYY-MM-DD HH:mm")}]`;
const waitDue = (stamp) => window.moment(stamp, "YYYY-MM-DD HH:mm").valueOf();
const dueIn = (hours) => Math.ceil((Date.now() + hours * 3600e3) / 60000) * 60000; // 取整到分钟
const span = (ms) => {
    const m = Math.max(1, Math.round(ms / 60000));
    return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分` : ""}`;
};
// 今天只写时刻，明天写「明天」，再往后写日期
const whenOf = (ms, today = "") => {
    const d = window.moment(ms), days = d.clone().startOf("day").diff(window.moment().startOf("day"), "days");
    return days === 0 ? today + d.format("HH:mm") : days === 1 ? `明天 ${d.format("HH:mm")}` : d.format("MM-DD HH:mm");
};
// 在跑标记：未到点 ⏳ 预计时刻，到点 ⏰ 待验收，任务已完成则淡显
const waitView = (stamp, done) => {
    const due = waitDue(stamp), left = due - Date.now();
    const state = done ? "done" : left > 0 ? "running" : "due";
    const text = state === "due" ? "⏰ 待验收" : `${state === "done" ? "⏰" : "⏳"} ${whenOf(due)}`;
    const label = `预计 ${stamp.slice(5)} 完成` + (state === "done" ? "（任务已结束）"
        : state === "due" ? `，已过 ${span(-left)}` : `，还有 ${span(left)}`);
    return { state, text, label };
};
// 同一任务的多个番茄紧挨着写，显示成一串 🍅🍅🍅
const insertPomo = (line, token) => {
    const i = line.search(TASKS_TAIL), head = line.slice(0, i).trimEnd();
    return `${head}${/🍅\[[^\]]*\]$/u.test(head) ? "" : " "}${token}${line.slice(i)}`;
};
// 在跑标记放在番茄之后、Tasks 字段之前；标记时 [ ] 改成 [/]，取消时改回来
const setWait = (line, token) => {
    line = line.replace(/\s*⏰\[[^\]]*\]/u, "")
        .replace(/^(\s*[-*+] )\[[ /]\]/, token ? "$1[/]" : "$1[ ]");
    if (!token) return line;
    const i = line.search(TASKS_TAIL);
    return `${line.slice(0, i).trimEnd()} ${token}${line.slice(i)}`;
};
// 去掉复选框、番茄、在跑标记和 Tasks 字段后的任务正文，用来在任务行被改动后认回它
const taskTitle = (line) => line.replace(/^\s*[-*+] \[.\]\s*/, "").replace(POMO_RE, "").replace(/⏰\[[^\]]*\]/gu, "")
    .replace(TASKS_TAIL, "").replace(/\s+/g, " ").trim();
const shortTitle = (line) => {
    const s = taskTitle(line) || "（空任务）";
    return s.length > 24 ? s.slice(0, 23) + "…" : s;
};
// 原行号上的内容没变就用它，否则找离原位置最近、正文相同的任务行（期间可能打了勾或上下挪过）
const locateTask = (lines, task) => {
    if (lines[task.line] === task.text) return task.line;
    const title = taskTitle(task.text);
    if (!title) return -1;
    let best = -1;
    lines.forEach((l, i) => {
        if (TASK_LINE.test(l) && taskTitle(l) === title && (best < 0 || Math.abs(i - task.line) < Math.abs(best - task.line)))
            best = i;
    });
    return best;
};

// 「下一步」子项：只认任务的直接子项，返回行号或 -1
const nextStepLine = (lines, i) => {
    const indent = (l) => l.match(/^\s*/)[0].length, base = indent(lines[i]);
    const child = i + 1 < lines.length ? indent(lines[i + 1]) : 0;
    for (let j = i + 1; j < lines.length && lines[j].trim() && indent(lines[j]) > base; j++)
        if (indent(lines[j]) === child && NEXT_RE.test(lines[j])) return j;
    return -1;
};
// 杂念记到「待整理」小节末尾，没有这个小节就在文末新建
const appendParked = (lines, item, heading) => {
    const h = lines.findIndex((l) => l.trim() === heading);
    if (h < 0) {
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        lines.push("", heading, item, "");
        return lines;
    }
    let end = h + 1;
    while (end < lines.length && !/^#{1,2}\s/.test(lines[end])) end++;
    while (end > h + 1 && !lines[end - 1].trim()) end--;
    lines.splice(end, 0, item);
    return lines;
};
// 编辑器里只替换改动的那一段，光标、滚动位置和撤销历史都不受影响
const replaceDiff = (editor, before, after) => {
    let a = 0, z = 0;
    while (a < before.length && a < after.length && before[a] === after[a]) a++;
    while (z < before.length - a && z < after.length - a && before[before.length - 1 - z] === after[after.length - 1 - z]) z++;
    editor.replaceRange(after.slice(a, after.length - z), editor.offsetToPos(a), editor.offsetToPos(before.length - z));
};

// m 是 MARK_RE 的匹配：分组 1-4 属于番茄，分组 5 属于在跑
const markSpec = (m, done) => {
    if (m[1]) return { cls: "sticky-pomo", text: "🍅", label: pomoLabel(m) };
    const w = waitView(m[5], done);
    return { cls: `sticky-wait is-${w.state}`, text: w.text, label: w.label };
};
const markEl = (doc, { cls, text, label }) => {
    const el = doc.createElement("span");
    el.className = cls;
    el.textContent = text;
    if (setTooltip) setTooltip(el, label, { placement: "top" });
    else el.setAttribute("aria-label", label);
    return el;
};

class MarkWidget extends WidgetType {
    constructor(spec) { super(); this.spec = spec; }
    eq(o) { return ["cls", "text", "label"].every((k) => o.spec[k] === this.spec[k]); }
    toDOM(view) { return markEl(view.dom.ownerDocument, this.spec); }
    ignoreEvent() { return false; } // 点击交给编辑器，光标落到旁边就会露出源码
}

const buildMarks = (view) => {
    if (!view.state.field(editorLivePreviewField, false)) return Decoration.none; // 源码模式原样显示
    const { doc, selection } = view.state, decos = [];
    for (const { from, to } of view.visibleRanges) {
        for (const m of doc.sliceString(from, to).matchAll(MARK_RE)) {
            const a = from + m.index, z = a + m[0].length;
            if (selection.ranges.some((r) => r.from <= z && r.to >= a)) continue;
            const spec = markSpec(m, DONE_LINE.test(doc.lineAt(a).text));
            decos.push(Decoration.replace({ widget: new MarkWidget(spec) }).range(a, z));
        }
    }
    return Decoration.set(decos, true);
};

const markEditorPlugin = ViewPlugin.fromClass(class {
    constructor(view) {
        this.decorations = buildMarks(view);
        // 在跑标记的剩余时间会变：每 30 秒空派发一次事务，让 update 重建
        this.win = view.dom.ownerDocument.defaultView;
        this.timer = this.win.setInterval(() => {
            if (!view.visibleRanges.some(({ from, to }) => view.state.doc.sliceString(from, to).includes("⏰["))) return;
            this.stale = true;
            view.dispatch({});
        }, 30000);
    }
    update(u) {
        const lp = (s) => s.field(editorLivePreviewField, false);
        if (this.stale || u.docChanged || u.viewportChanged || u.selectionSet || lp(u.startState) !== lp(u.state)) {
            this.stale = false;
            this.decorations = buildMarks(u.view);
        }
    }
    destroy() { this.win.clearInterval(this.timer); }
}, { decorations: (v) => v.decorations });

// 阅读视图
const renderMarks = (el) => {
    const doc = el.ownerDocument, walker = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */), nodes = [];
    while (walker.nextNode()) {
        const n = walker.currentNode, v = n.nodeValue;
        if ((v.includes("🍅[") || v.includes("⏰[")) && !n.parentElement?.closest("code, pre")) nodes.push(n);
    }
    for (const n of nodes) {
        const s = n.nodeValue, frag = doc.createDocumentFragment();
        const done = /[xX-]/.test(n.parentElement?.closest("li")?.dataset.task ?? "");
        let last = 0;
        for (const m of s.matchAll(MARK_RE)) {
            frag.append(s.slice(last, m.index), markEl(doc, markSpec(m, done)));
            last = m.index + m[0].length;
        }
        if (!last) continue;
        frag.append(s.slice(last));
        n.replaceWith(frag);
    }
};

// 自定义时长：专注/休息切换 + 大号数字输入 + 常用时长，回车即开始
class DurationModal extends Modal {
    constructor(app, minutes, onSubmit) {
        super(app);
        this.minutes = minutes;
        this.onSubmit = onSubmit;
        this.kind = "focus";
    }

    onOpen() {
        this.modalEl.addClass("sticky-timer-modal");
        this.titleEl.setText("自定义番茄钟");
        const form = this.contentEl.createEl("form");
        const kinds = form.createDiv({ cls: "sticky-timer-kind" });
        const field = form.createDiv({ cls: "sticky-timer-field" });
        const input = field.createEl("input", {
            type: "number", value: String(this.minutes),
            attr: { min: "0.1", max: "600", step: "any", inputmode: "decimal" },
        });
        field.createSpan({ text: "分钟" });
        let edited = false;
        input.addEventListener("input", () => { edited = true; input.removeClass("is-invalid"); });
        for (const [kind, text] of [["focus", "专注"], ["break", "休息"]]) {
            const b = kinds.createEl("button", { text, type: "button" });
            b.toggleClass("is-active", kind === this.kind);
            b.addEventListener("click", () => {
                this.kind = kind;
                for (const el of kinds.children) el.toggleClass("is-active", el === b);
                if (!edited) input.value = String(kind === "focus" ? this.minutes : 5);
                input.focus();
            });
        }
        const quick = form.createDiv({ cls: "sticky-timer-quick" });
        for (const m of [5, 10, 15, 30, 50, 90])
            quick.createEl("button", { text: `${m} 分`, type: "button" }).addEventListener("click", () => this.submit(m));
        const footer = form.createDiv({ cls: "modal-button-container" });
        footer.createEl("button", { text: "取消", type: "button" }).addEventListener("click", () => this.close());
        footer.createEl("button", { text: "开始", cls: "mod-cta", type: "submit" });
        form.addEventListener("submit", (e) => {
            e.preventDefault();
            const m = parseFloat(input.value);
            if (m > 0 && m <= 600) return this.submit(m);
            input.addClass("is-invalid");
            input.focus();
        });
        setTimeout(() => { input.focus(); input.select(); }, 0);
    }

    submit(m) {
        this.close();
        this.onSubmit(m, this.kind);
    }

    onClose() {
        this.contentEl.empty();
    }
}

// 标记在跑：输入几小时后完成，实时显示预计完成时刻；已在跑时可调整或取消
class WaitModal extends Modal {
    constructor(app, opts) {
        super(app);
        this.opts = opts; // { task, hours, existing, onSubmit(due, hours), onClear() }
    }

    onOpen() {
        const { task, hours, existing } = this.opts;
        this.modalEl.addClass("sticky-timer-modal");
        this.titleEl.setText(existing ? "调整在跑时间" : "标记为在跑");
        this.contentEl.createDiv({ cls: "sticky-modal-task", text: task });
        const form = this.contentEl.createEl("form");
        const field = form.createDiv({ cls: "sticky-timer-field" });
        const input = field.createEl("input", {
            type: "number", value: String(hours),
            attr: { min: "0.05", max: "720", step: "any", inputmode: "decimal" },
        });
        field.createSpan({ text: "小时后完成" });
        const eta = form.createDiv({ cls: "sticky-wait-eta" });
        const valid = () => { const h = parseFloat(input.value); return h > 0 && h <= 720 ? h : 0; };
        const show = () => {
            const h = valid();
            eta.setText(h ? `预计 ${whenOf(dueIn(h), "今天 ")} 完成，到点提醒你验收` : "请输入 0–720 之间的小时数");
            eta.toggleClass("is-invalid", !h);
            input.toggleClass("is-invalid", !h);
        };
        input.addEventListener("input", show);
        show();
        const quick = form.createDiv({ cls: "sticky-timer-quick" });
        for (const h of [0.5, 1, 2, 4, 8])
            quick.createEl("button", { text: `${h} 小时`, type: "button" }).addEventListener("click", () => this.submit(dueIn(h), h));
        quick.createEl("button", { text: "明早 9:00", type: "button" }).addEventListener("click", () =>
            this.submit(window.moment().add(1, "day").startOf("day").hour(9).valueOf()));
        const footer = form.createDiv({ cls: "modal-button-container" });
        if (existing) footer.createEl("button", { text: "取消在跑", cls: "mod-warning", type: "button" })
            .addEventListener("click", () => { this.close(); this.opts.onClear(); });
        footer.createEl("button", { text: "取消", type: "button" }).addEventListener("click", () => this.close());
        footer.createEl("button", { text: existing ? "更新" : "开始等待", cls: "mod-cta", type: "submit" });
        form.addEventListener("submit", (e) => {
            e.preventDefault();
            const h = valid();
            if (h) return this.submit(dueIn(h), h);
            input.focus();
        });
        setTimeout(() => { input.focus(); input.select(); }, 0);
    }

    submit(due, hours) {
        this.close();
        this.opts.onSubmit(due, hours);
    }

    onClose() {
        this.contentEl.empty();
    }
}

// 一句话输入：下一步、杂念都用它；回车提交，Esc 取消
class TextModal extends Modal {
    constructor(app, opts) {
        super(app);
        this.opts = opts; // { title, task, placeholder, value, hint, cta, onSubmit(text) }
    }

    onOpen() {
        const { title, task, placeholder, value = "", hint, cta = "保存" } = this.opts;
        this.modalEl.addClass("sticky-text-modal");
        this.titleEl.setText(title);
        if (task) this.contentEl.createDiv({ cls: "sticky-modal-task", text: task });
        const form = this.contentEl.createEl("form");
        const input = form.createEl("input", { type: "text", value, attr: { placeholder, spellcheck: "false" } });
        if (hint) form.createDiv({ cls: "sticky-modal-hint", text: hint });
        const footer = form.createDiv({ cls: "modal-button-container" });
        footer.createEl("button", { text: "取消", type: "button" }).addEventListener("click", () => this.close());
        footer.createEl("button", { text: cta, cls: "mod-cta", type: "submit" });
        form.addEventListener("submit", (e) => {
            e.preventDefault();
            this.close();
            this.opts.onSubmit(input.value.trim());
        });
        setTimeout(() => { input.focus(); input.setSelectionRange(value.length, value.length); }, 0);
    }

    onClose() {
        this.contentEl.empty();
    }
}

// ---- 设置页 ----
// 文本项随输入即时保存；除「排除的文件夹」外，留空的项在使用时退回默认值（见 opt）
class CairnSettingTab extends PluginSettingTab {
    constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

    display() {
        const { containerEl } = this, p = this.plugin;
        containerEl.empty();
        const text = (name, desc, key, placeholder = SETTINGS[key]) => new Setting(containerEl).setName(name).setDesc(desc)
            .addText((t) => t.setPlaceholder(placeholder).setValue(p.data[key] ?? "").onChange((v) => {
                p.data[key] = v.trim();
                p.saveData(p.data);
            }));

        new Setting(containerEl).setName("项目与日志").setHeading();
        new Setting(containerEl).setName("项目笔记的识别属性")
            .setDesc("frontmatter 里这个属性等于这个值的笔记算项目，例如 type: project。属性值是列表时，包含该值即可。")
            .addText((t) => t.setPlaceholder(SETTINGS.projectKey).setValue(p.data.projectKey ?? "").onChange((v) => {
                p.data.projectKey = v.trim();
                p.saveData(p.data);
            }))
            .addText((t) => t.setPlaceholder(SETTINGS.projectValue).setValue(p.data.projectValue ?? "").onChange((v) => {
                p.data.projectValue = v.trim();
                p.saveData(p.data);
            }));
        text("日志属性", "项目笔记里指向日志的属性，值是一个内部链接，例如 log: \"[[项目 log]]\"。", "logKey");
        text("归档属性", "这个属性为 true 的项目不出现在项目列表里。", "archivedKey");
        text("日志文件夹", "日志链接指向的文件不存在时，在这里新建。", "logFolder");
        text("排除的文件夹", "扫描项目时跳过这些文件夹，多个用逗号分隔，例如模板文件夹。留空则不排除。", "excludeFolders", "例如 _templates");

        new Setting(containerEl).setName("杂念").setHeading();
        text("记到哪个小节", "杂念追加到日志里这个标题下面，没有就在文末新建。需要包含 # 号。", "parkHeading");

        new Setting(containerEl).setName("番茄钟").setHeading();
        text("菜单里的专注时长", "单位分钟，用逗号分隔。上次用过的时长会自动补进菜单。", "presets");
        new Setting(containerEl).setName("完成时播放提示音")
            .addToggle((t) => t.setValue(p.data.sound).onChange((v) => {
                p.data.sound = v;
                p.saveData(p.data);
            }));
    }
}

module.exports = class CairnPlugin extends Plugin {
    async onload() {
        this.data = Object.assign({}, DEFAULTS, await this.loadData());
        this.addSettingTab(new CairnSettingTab(this.app, this));
        this.wins = new Map(); // 便签窗口 window -> { win, bw, btns, chips, tick, collapsed, height }
        this.decorated = new WeakSet(); // 已加过按钮的 view
        document.body.removeClass("sticky-log", "sticky-collapsed"); // 主窗口永远不是便签
        const onClick = (e) => this.onClick(e);
        this.registerDomEvent(document, "click", onClick, true);
        this.registerEvent(this.app.workspace.on("window-open", (_, win) =>
            this.registerDomEvent(win.document, "click", onClick, true)));
        this.registerEvent(this.app.workspace.on("window-close", (container, win) => {
            this.forgetSticky(container?.id);
            if (!this.wins.delete(win)) return;
            if (!this.wins.size && !this.quitting) this.showMain();
        }));
        // 退出时先关掉便签，免得被 Obsidian 存进布局、下次启动时作为无按钮的普通窗口恢复出来
        this.registerEvent(this.app.workspace.on("quit", () => {
            this.quitting = true;
            this.stickyLeaves(new Set(this.data.stickyWindows)).forEach((l) => l.detach());
        }));
        // 便签窗口里新建/切换的标签页也要补上按钮
        this.registerEvent(this.app.workspace.on("layout-change", () => this.decorateAll()));

        this.addCommand({ id: "open-current-log", name: "以便签打开当前项目日志", callback: () => this.openFromActive() });
        this.addCommand({ id: "toggle-pin", name: "切换当前窗口置顶", callback: () => this.togglePin() });
        this.addCommand({ id: "show-main", name: "显示 Obsidian 主窗口", callback: () => this.showMain() });
        this.addCommand({ id: "timer-toggle", name: "番茄钟：开始 / 暂停 / 继续", callback: () => this.toggleTimer() });
        this.addCommand({ id: "timer-stop", name: "番茄钟：结束", callback: () => this.stopTimer() });
        this.addCommand({ id: "mark-waiting", name: "标记光标所在任务为在跑", callback: () => this.markWaiting() });
        this.addCommand({ id: "next-step", name: "给光标所在任务写下一步", callback: () => this.writeNextStep() });
        this.addCommand({ id: "park-thought", name: "记一条杂念", callback: () => this.parkThought() });

        // 主窗口状态栏也显示倒计时；便签窗口各自另有计时器，因为主窗口隐藏后定时器会被节流
        this.statusEl = this.buildChip(this.addStatusBarItem());
        this.registerInterval(window.setInterval(() => this.tick(), 1000));
        this.registerMarkdownPostProcessor(renderMarks);
        // 光标是否在任务行上，决定「在跑」「下一步」按钮是否点亮
        this.registerEditorExtension([markEditorPlugin, EditorView.updateListener.of((u) => {
            if (u.selectionSet || u.docChanged) this.markCursor(u.state.field(editorInfoField, false), u.state);
        })]);
        this.renderTimer();
        // 只在 Obsidian 启动时清理；插件重载时布局早已就绪，本次运行开着的便签不动
        const startup = !this.app.workspace.layoutReady;
        this.app.workspace.onLayoutReady(() => {
            if (startup) this.closeStaleStickies();
            this.createTray();
        });
        // 图标活在主进程里：⌘R 重载窗口时插件来不及走 onunload，不手动销毁会留下一个失效的图标
        this.registerDomEvent(window, "beforeunload", () => { this.tray?.destroy(); this.tray = null; });
    }

    // 设置项留空时退回默认值，免得清空输入框后整个插件失灵
    opt(key) {
        const v = String(this.data[key] ?? "").trim();
        return v || SETTINGS[key];
    }

    presets() {
        const list = this.opt("presets").split(/[,，\s]+/).map(Number).filter((m) => m > 0 && m <= 600);
        return [...new Set(list.length ? list : SETTINGS.presets.split(", ").map(Number))].sort((a, b) => a - b);
    }

    // 停用插件时清掉便签样式类，避免残留（包括上个版本误加到主窗口上的）
    onunload() {
        for (const doc of [document, ...[...this.wins.keys()].map((w) => w.document)])
            doc.body.removeClass("sticky-log", "sticky-collapsed");
        for (const s of this.wins.values()) {
            s.win.clearInterval(s.tick);
            delete s.win.document.body.dataset.stickyTimer;
            for (const chip of s.chips) chip.remove();
        }
        this.tray?.destroy();
        this.tray = null;
        if (this.wins.size) this.showMain();
    }

    // 拦截属性面板里 log 链接的点击；按住 ⌘ 点击保留默认行为（在标签页打开）
    onClick(e) {
        if (e.button !== 0 || e.metaKey || e.ctrlKey) return;
        const t = e.target;
        if (!t?.closest) return;
        const prop = t.closest(`.metadata-property[data-property-key="${CSS.escape(this.opt("logKey"))}"]`);
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
        const key = this.opt("logKey");
        const raw = file && this.app.metadataCache.getFileCache(file)?.frontmatter?.[key];
        if (!raw) return new Notice(`当前笔记没有 ${key} 属性`);
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
        const win = leaf.view.containerEl.win;
        this.wins.get(win)?.bw?.focus(); // 从菜单栏点进来时 Obsidian 不在前台，要用原生窗口的 focus 才能拉到前面
        win.focus();
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
    }

    async openSticky(linktext, src) {
        const file = await this.resolve(linktext, src);
        const old = this.findLeaf(file);
        if (old) return this.focusLeaf(old);

        const remote = getRemote();
        const before = new Set(remote ? remote.BrowserWindow.getAllWindows().map((w) => w.id) : []);
        const leaf = this.app.workspace.openPopoutLeaf({ size: SIZE });
        await leaf.openFile(file, { active: true, state: VIEW_STATE });
        // 必须在 openFile 之后取窗口：之前 view 还没挂到弹出窗口，拿到的会是主窗口
        const win = leaf.getContainer?.()?.win ?? leaf.view.containerEl.win;
        if (win === window) return new Notice("便签窗口创建失败");
        // 记下窗口 id，强退后 Obsidian 恢复布局时据此认出并关掉它
        const id = leaf.getContainer?.()?.id;
        if (id && !this.data.stickyWindows.includes(id)) {
            this.data.stickyWindows.push(id);
            this.saveData(this.data);
        }
        const s = { win, id, bw: null, btns: new Set(), chips: new Set(), collapsed: false, height: SIZE.height, eatClick: false };
        this.wins.set(win, s);
        win.document.body.addClass("sticky-log");
        s.tick = win.setInterval(() => this.tick(), 1000);
        // 折叠状态下：横条上按下后移动＝拖动窗口，原地松开＝展开
        this.registerDomEvent(win.document, "pointerdown", (e) => this.onBarPointerDown(e, s), true);
        // 吞掉按下/松开之后浏览器补发的 click，免得触发标题重命名等默认行为
        this.registerDomEvent(win.document, "click", (e) => {
            if (!s.eatClick) return;
            s.eatClick = false;
            e.preventDefault();
            e.stopImmediatePropagation();
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

    onBarPointerDown(e, s) {
        const t = e.target;
        if (!s.collapsed || e.button !== 0 || !t?.closest?.(".view-header")) return;
        if (t.closest(".view-actions, .view-header-nav-buttons, .clickable-icon")) return; // 按钮照常可点
        e.preventDefault();
        e.stopImmediatePropagation();
        const doc = s.win.document;
        const [wx, wy] = s.bw ? s.bw.getPosition() : [s.win.screenX, s.win.screenY];
        const sx = e.screenX, sy = e.screenY;
        let dragging = false;
        // 捕获指针：拖得快、光标暂时离开横条时也能持续收到移动事件
        t.setPointerCapture?.(e.pointerId);
        const move = (ev) => {
            const dx = ev.screenX - sx, dy = ev.screenY - sy;
            if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
            dragging = true;
            const x = Math.round(wx + dx), y = Math.round(wy + dy);
            if (s.bw) s.bw.setPosition(x, y);
            else s.win.moveTo(x, y);
        };
        const up = () => {
            doc.removeEventListener("pointermove", move, true);
            doc.removeEventListener("pointerup", up, true);
            doc.removeEventListener("pointercancel", up, true);
            s.eatClick = true;
            setTimeout(() => { s.eatClick = false; }, 300); // 拖到横条外松开时不会有 click
            if (!dragging) this.toggleCollapse(s);
        };
        doc.addEventListener("pointermove", move, true);
        doc.addEventListener("pointerup", up, true);
        doc.addEventListener("pointercancel", up, true);
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

    // 给便签窗口里每个日志标签页的标题栏加按钮；addAction 往左插入，
    // 从右到左依次是：折叠、切换日志、显示主窗口、杂念、下一步、在跑、番茄钟（计时中换成倒计时胶囊）
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
            // 便签是 floating 级置顶，主窗口获得焦点后也不会盖住它
            view.addAction("app-window", "显示 Obsidian 主窗口", () => this.showMain());
            view.addAction("lightbulb", "记一条杂念", () => this.parkThought(view));
            // 这两个只对光标所在的任务起作用，光标不在任务行上时变暗
            view.addAction("footprints", "下一步：写下回来后先做什么", () => this.writeNextStep(view)).addClass("sticky-task-btn");
            view.addAction("hourglass", "标记在跑：交出去等结果", () => this.markWaiting(view)).addClass("sticky-task-btn");
            this.markCursor(view);
            const timerBtn = view.addAction("timer", "番茄钟", (e) => this.timerMenu(e, view));
            timerBtn.addClass("sticky-timer-btn");
            // 计时中由倒计时胶囊顶替番茄钟按钮，点它打开同一个菜单；
            // 放在 .view-actions 里，折叠横条的拖动逻辑会自动放过它
            const actions = timerBtn.parentElement;
            const chip = this.buildChip(actions.createDiv(), view);
            actions.prepend(chip);
            s.chips.add(chip);
        });
        this.renderTimer();
    }

    // 日志里未完成的任务数（- [ ] 和在跑的 - [/]），用元数据缓存统计，不读文件
    openTodos(file) {
        const items = file && this.app.metadataCache.getFileCache(file)?.listItems;
        return items ? items.filter((li) => li.task === " " || li.task === "/").length : null;
    }

    // 所有带 log 的未归档项目，最近改过的在前；dest 是日志文件（还没建时为 null）
    projectLogs() {
        const o = (k) => this.opt(k), key = o("logKey");
        const skip = String(this.data.excludeFolders ?? "").split(/[,，]/).map((s) => normalizePath(s.trim())).filter((s) => s && s !== "/");
        return this.app.vault.getMarkdownFiles()
            .filter((f) => !skip.some((d) => f.path.startsWith(d + "/")))
            .map((f) => ({ f, fm: this.app.metadataCache.getFileCache(f)?.frontmatter }))
            // 属性值可能是列表（type: [project, xxx]），也可能被写成数字等非字符串
            .filter(({ fm }) => fm && [fm[o("projectKey")]].flat().map(String).includes(o("projectValue"))
                && fm[o("archivedKey")] !== true && fm[key])
            .sort((a, b) => b.f.stat.mtime - a.f.stat.mtime)
            .map(({ f, fm }) => {
                const link = linkOf(fm[key]);
                const dest = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(link), f.path);
                const n = this.openTodos(dest);
                // 原生菜单只能显示纯文本，数量以 [n] 前缀标出；日志还没建时不加
                return { f, link, dest, title: n === null ? f.basename : `[${n}] ${f.basename}` };
            });
    }

    // 列出所有未归档项目，选中后在当前便签窗口新开标签页（已打开则切过去）
    pickLog(evt, leaf) {
        const current = leaf.view?.file?.path, items = this.projectLogs();
        if (!items.length) return new Notice(`没有带 ${this.opt("logKey")} 属性的未归档项目`);
        const menu = new Menu();
        for (const { f, link, dest, title } of items)
            menu.addItem((it) => it.setTitle(title).setIcon("folder")
                .setChecked(dest?.path === current)
                .onClick(() => this.openInWindow(link, f.path, leaf)));
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
        await tab.openFile(file, { active: true, state: VIEW_STATE });
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

    // log 指向的文件不存在时，在日志文件夹下按模板新建（文件夹可以多级）
    async createLog(linkpath, src) {
        const folder = normalizePath(this.opt("logFolder"));
        let dir = "";
        for (const part of folder.split("/")) {
            dir = dir ? `${dir}/${part}` : part;
            if (!this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
        }
        const project = src.split("/").pop().replace(/\.md$/, "");
        const date = window.moment().format("YYYY-MM-DD");
        const name = linkpath.split("/").pop();
        const file = await this.app.vault.create(normalizePath(`${folder}/${name}.md`),
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

    // ---- 便签窗口的持久化 ----
    // 便签只属于本次运行：Obsidian 会把弹出窗口存进 workspace.json 并在下次启动时恢复，
    // 恢复出来的窗口没有按钮、不置顶，这里统一关掉

    forgetSticky(id) {
        const i = id ? this.data.stickyWindows.indexOf(id) : -1;
        if (i < 0) return;
        this.data.stickyWindows.splice(i, 1);
        this.saveData(this.data);
    }

    // ids 里登记过的弹出窗口中的标签页；legacy 为真时，全是 logs/ 下日志的弹出窗口也算
    // （0.5.1 之前开的便签没有登记过 id）
    stickyLeaves(ids, legacy = false) {
        const byWin = new Map();
        this.app.workspace.iterateAllLeaves((l) => {
            const c = l.getContainer?.();
            if (!c || c === this.app.workspace.rootSplit?.getContainer?.() || c.win === window) return;
            if (!byWin.has(c)) byWin.set(c, []);
            byWin.get(c).push(l);
        });
        const folder = normalizePath(this.opt("logFolder")) + "/";
        const isLog = (l) => (l.view?.file?.path ?? l.getViewState().state?.file ?? "").startsWith(folder);
        return [...byWin].filter(([c, leaves]) => ids.has(c.id) || (legacy && leaves.every(isLog)))
            .flatMap(([, leaves]) => leaves);
    }

    closeStaleStickies() {
        this.stickyLeaves(new Set(this.data.stickyWindows), true).forEach((l) => l.detach());
        this.data.stickyWindows = [];
        this.saveData(this.data);
    }

    // ---- macOS 菜单栏图标 ----
    // 点图标弹出项目列表，选中即以便签打开；计时中图标右边显示倒计时

    createTray() {
        const remote = getRemote();
        if (!remote?.Tray || this.tray) return;
        try {
            this.tray = new remote.Tray(this.trayIcon());
        } catch {
            return;
        }
        this.tray.setToolTip("Cairn");
        const pop = () => this.tray?.popUpContextMenu(this.trayMenu(remote));
        this.tray.on("click", pop);
        this.tray.on("right-click", pop);
        this.trayTitle = null;
        this.renderTimer();
    }

    // 菜单栏图标必须是模板图（只用透明度），macOS 才会按深浅色菜单栏自动着色。
    // 不能用 nativeImage.setTemplateImage：图片经 remote 传到主进程时会被复制，模板标记会丢，
    // 结果在深色菜单栏里显示成黑色。改为写成文件名以 Template 结尾的 PNG，由系统按文件名识别；
    // 同目录的 @2x 文件会在 Retina 屏上自动选用。图形是 lucide 的 sticky-note，18pt 高
    trayIcon() {
        const fs = require("fs"), path = require("path"), os = require("os");
        const base = path.join(os.tmpdir(), "cairn-trayTemplate");
        for (const [scale, suffix] of [[1, ""], [2, "@2x"]]) {
            const c = document.createElement("canvas"), px = 18 * scale;
            c.width = c.height = px;
            const g = c.getContext("2d");
            g.scale(px / 24, px / 24);
            g.lineWidth = 1.9;
            g.lineJoin = g.lineCap = "round";
            g.stroke(new Path2D("M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"));
            g.stroke(new Path2D("M15 3v4a2 2 0 0 0 2 2h4"));
            fs.writeFileSync(`${base}${suffix}.png`, Buffer.from(c.toDataURL("image/png").split(",")[1], "base64"));
        }
        return `${base}.png`;
    }

    // 每次点开都重建，待办数和「已打开」的勾都是最新的
    trayMenu(remote) {
        const open = new Set();
        this.app.workspace.iterateAllLeaves((l) => {
            if (this.wins.has(l.view?.containerEl?.win) && l.view.file) open.add(l.view.file.path);
        });
        const items = this.projectLogs().map(({ f, link, dest, title }) => ({
            label: title, type: "checkbox", checked: !!dest && open.has(dest.path),
            click: () => this.openSticky(link, f.path),
        }));
        if (!items.length) items.push({ label: "没有带 log 属性的未归档项目", enabled: false });
        return remote.Menu.buildFromTemplate([
            { label: "打开项目日志", enabled: false },
            ...items,
            { type: "separator" },
            { label: "显示 Obsidian 主窗口", click: () => this.showMain() },
        ]);
    }

    // 只在文字变化时调用，避免每秒都跨进程
    setTrayTitle(text) {
        if (!this.tray || this.trayTitle === text) return;
        this.trayTitle = text;
        try { this.tray.setTitle(text ? ` ${text}` : "", { fontType: "monospacedDigit" }); } catch {}
    }

    // ---- 番茄钟 ----
    // timer = { kind: focus|break, total, start, end（运行中）, left（暂停中）, doneAt（已结束）, task（归属的任务）}
    // 所有窗口共用一个计时，重载插件或重启 Obsidian 后接着走

    buildChip(el, view) {
        el.addClass("sticky-timer-chip");
        el.createSpan({ cls: "sticky-timer-icon" });
        el.createSpan({ cls: "sticky-timer-text" });
        el.addEventListener("click", (e) => this.timerMenu(e, view));
        return el;
    }

    timerState() {
        const t = this.data.timer;
        if (!t) return null;
        if (t.doneAt) return "done";
        return t.end ? t.kind : "paused";
    }

    remaining() {
        const t = this.data.timer;
        return t.end ? t.end - Date.now() : t.left;
    }

    tick() {
        const t = this.data.timer;
        if (t && t.end && Date.now() >= t.end) this.finishTimer();
        this.renderTimer();
        this.checkWaits();
    }

    startTimer(minutes, kind = "focus", view) {
        const total = Math.round(minutes * 60000), now = Date.now();
        // 专注开始时就绑定光标所在的任务，计时途中光标移走也不影响归属
        const task = kind === "focus" ? this.cursorTask(view) : null;
        this.data.timer = { kind, total, start: now, end: now + total, task };
        if (kind === "focus") this.data.lastMinutes = minutes;
        this.saveTimer();
    }

    // 快捷键用：空闲→开始上次的专注，运行↔暂停，结束提醒中→关掉
    toggleTimer() {
        const t = this.data.timer;
        if (!t) return this.startTimer(this.data.lastMinutes);
        if (t.doneAt) return this.stopTimer();
        if (t.end) { t.left = t.end - Date.now(); t.end = null; }
        else { t.end = Date.now() + t.left; t.left = null; }
        this.saveTimer();
    }

    addTime(ms) {
        const t = this.data.timer;
        t.total += ms;
        if (t.end) t.end += ms;
        else t.left += ms;
        this.saveTimer();
    }

    stopTimer() {
        if (!this.data.timer) return;
        this.data.timer = null;
        this.saveTimer();
    }

    // early：手动「提前完成」，按实际专注时长记录，不弹通知
    finishTimer(early = false) {
        const t = this.data.timer;
        t.focused = t.total - (early ? Math.max(0, this.remaining()) : 0); // 不含暂停的时间
        t.doneAt = early ? Date.now() : t.end;
        t.end = t.left = null;
        this.saveTimer();
        const focus = t.kind === "focus";
        if (focus) this.recordPomo(t, t.task);
        // Obsidian 关着的时候到点的，重新打开只变色，不再补发提醒
        if (early || Date.now() - t.doneAt > 60000) return;
        this.notify(focus ? "🍅 专注完成" : "☕ 休息结束",
            focus ? `已专注 ${minutesOf(t.focused)} 分钟，起来活动一下吧` : "准备开始下一个番茄");
    }

    // ---- 在跑 / 下一步 / 杂念 ----

    // 文件开在编辑器里就改编辑器（保留光标和撤销），否则直接改文件；fn 返回 null 表示不改
    findEditor(path) {
        let editor = null;
        this.app.workspace.iterateAllLeaves((l) => {
            if (!editor && l.view instanceof MarkdownView && l.view.file?.path === path) editor = l.view.editor;
        });
        return editor;
    }

    async readLines(path) {
        const editor = this.findEditor(path);
        if (editor) return editor.getValue().split("\n");
        const file = this.app.vault.getFileByPath(path);
        return file ? (await this.app.vault.cachedRead(file)).split("\n") : null;
    }

    async editLines(path, fn) {
        const editor = this.findEditor(path);
        if (editor) {
            const before = editor.getValue(), lines = fn(before.split("\n"));
            if (lines) replaceDiff(editor, before, lines.join("\n"));
            return !!lines;
        }
        const file = this.app.vault.getFileByPath(path);
        let ok = false;
        if (file) await this.app.vault.process(file, (data) => {
            const lines = fn(data.split("\n"));
            ok = !!lines;
            return lines ? lines.join("\n") : data;
        });
        return ok;
    }

    // 光标所在行是不是任务，决定便签上「在跑」「下一步」按钮亮还是暗
    markCursor(view, state) {
        if (!(view instanceof MarkdownView) || !this.wins.has(view.containerEl.win)) return;
        const line = state ? state.doc.lineAt(state.selection.main.head).text : view.editor?.getLine(view.editor.getCursor().line);
        view.containerEl.toggleClass("sticky-on-task", TASK_LINE.test(line ?? ""));
    }

    taskOrHint(view) {
        const task = this.cursorTask(view);
        if (!task) new Notice("先把光标放在一条任务上");
        return task;
    }

    // 折叠的横条放不下对话框，先展开
    async expand() {
        const s = this.wins.get(activeWindow);
        if (s?.collapsed) await this.toggleCollapse(s);
    }

    async markWaiting(view) {
        const task = this.taskOrHint(view);
        if (!task) return;
        if (DONE_LINE.test(task.text)) return new Notice("这条任务已经结束了");
        await this.expand();
        const existing = task.text.match(WAIT_RE)?.[1];
        const left = existing ? (waitDue(existing) - Date.now()) / 3600e3 : 0;
        const apply = (token) => this.editLines(task.path, (lines) => {
            const i = locateTask(lines, task);
            if (i < 0) return null;
            lines[i] = setWait(lines[i], token);
            return lines;
        });
        new WaitModal(this.app, {
            task: shortTitle(task.text), existing,
            hours: left > 0 ? Math.max(0.1, +left.toFixed(1)) : this.data.lastWaitHours,
            onSubmit: async (due, hours) => {
                if (hours) { this.data.lastWaitHours = hours; this.saveData(this.data); }
                if (await apply(waitToken(due))) new Notice(`⏳ 已标记在跑，预计 ${whenOf(due, "今天 ")} 完成`);
            },
            onClear: () => apply(null),
        }).open();
    }

    async writeNextStep(view, task = this.taskOrHint(view)) {
        if (!task) return;
        await this.expand();
        const lines = await this.readLines(task.path), i = lines ? locateTask(lines, task) : -1;
        if (i < 0) return new Notice(`没找到任务「${shortTitle(task.text)}」`);
        const j = nextStepLine(lines, i), old = j < 0 ? "" : lines[j].match(NEXT_RE)[1];
        new TextModal(this.app, {
            title: "下一步", task: shortTitle(task.text), value: old,
            placeholder: "回来后第一件事做什么？",
            hint: old ? "清空后保存即删除这条下一步" : "写在任务下面，切回来时一眼就能接上",
            onSubmit: (text) => this.editLines(task.path, (lines) => {
                const i = locateTask(lines, task);
                if (i < 0) return null;
                const j = nextStepLine(lines, i);
                if (j >= 0) {
                    if (text) lines[j] = `${lines[j].match(/^\s*[-*+] /)[0]}👉 ${text}`;
                    else lines.splice(j, 1);
                    return lines;
                }
                if (!text) return null;
                const lead = (l) => l.match(/^\s*/)[0];
                const hasKids = i + 1 < lines.length && lead(lines[i + 1]).length > lead(lines[i]).length;
                lines.splice(i + 1, 0, `${hasKids ? lead(lines[i + 1]) : lead(lines[i]) + "\t"}- 👉 ${text}`);
                return lines;
            }),
        }).open();
    }

    // 专注时冒出来的别的事：记一句就回去，进日志末尾的「待整理」
    async parkThought(view) {
        const t = this.data.timer;
        const path = view?.file?.path || (t?.kind === "focus" && t.task?.path)
            || this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path;
        if (!path) return new Notice("先打开一个日志");
        const heading = this.opt("parkHeading");
        await this.expand();
        new TextModal(this.app, {
            title: "记一条杂念", cta: "记下",
            placeholder: "想到什么写什么，写完回到手头的事",
            hint: `记到「${path.split("/").pop().replace(/\.md$/, "")}」的「${heading.replace(/^#+\s*/, "")}」，休息时再处理`,
            onSubmit: async (text) => {
                if (text && await this.editLines(path, (lines) => appendParked(lines, `- [ ] ${text}`, heading)))
                    new Notice("💡 已记下");
            },
        }).open();
    }

    // 每 30 秒扫一遍有 [/] 任务的文件，在跑到点的只提醒一次
    async checkWaits() {
        if (this.checking || Date.now() - (this.lastCheck ?? 0) < 30000) return;
        this.checking = true;
        this.lastCheck = Date.now();
        try {
            const seen = new Set(this.data.notified), due = [];
            for (const file of this.app.vault.getMarkdownFiles()) {
                if (!this.app.metadataCache.getFileCache(file)?.listItems?.some((li) => li.task === "/")) continue;
                (await this.app.vault.cachedRead(file)).split("\n").forEach((text, line) => {
                    const m = TASK_LINE.test(text) && !DONE_LINE.test(text) && text.match(WAIT_RE);
                    const key = m && `${file.path}|${m[1]}|${taskTitle(text)}`;
                    if (m && waitDue(m[1]) <= Date.now() && !seen.has(key)) due.push({ key, path: file.path, line, text });
                });
            }
            if (!due.length) return;
            this.data.notified = [...this.data.notified, ...due.map((d) => d.key)].slice(-200);
            this.saveData(this.data);
            const names = due.map((d) => shortTitle(d.text));
            this.notify("⏰ 该验收了", names.length > 1 ? `${names[0]} 等 ${names.length} 件` : names[0],
                () => this.revealTask(due[0]));
        } finally {
            this.checking = false;
        }
    }

    // 系统通知 + 提示音；点通知跳到对应任务
    notify(title, body, onClick) {
        const win = this.wins.keys().next().value ?? window;
        try {
            const n = new win.Notification(title, { body, silent: true });
            if (onClick) n.onclick = onClick;
        } catch {}
        if (this.data.sound) this.chime(win);
    }

    async revealTask({ path, line }) {
        const file = this.app.vault.getFileByPath(path);
        if (!file) return;
        if (!this.findLeaf(file)) await this.openSticky(path.replace(/\.md$/, ""), "");
        const leaf = this.findLeaf(file);
        if (!leaf) return;
        this.focusLeaf(leaf);
        leaf.view.editor?.setCursor({ line, ch: 0 });
    }

    // ---- 番茄记录 ----

    // 从标题栏按钮进来时用按钮所在的标签页，从命令进来时用当前活动的编辑器
    cursorTask(view) {
        view = view?.editor ? view : this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file || !view.editor) return null;
        const line = view.editor.getCursor().line, text = view.editor.getLine(line);
        return TASK_LINE.test(text) ? { path: view.file.path, line, text } : null;
    }

    // 把番茄标记写进任务行；任务行在计时期间被改动（打勾、编辑、上下移动）也尽量找回来
    async recordPomo(t, task) {
        if (!task) return;
        t.task = task;
        const file = this.app.vault.getFileByPath(task.path);
        const token = pomoToken(t.start ?? t.doneAt - t.focused, t.doneAt, t.focused);
        let hit = false;
        if (file) await this.app.vault.process(file, (data) => {
            const lines = data.split("\n");
            const i = locateTask(lines, task);
            if (i < 0) return data;
            hit = true;
            lines[i] = insertPomo(lines[i], token);
            return lines.join("\n");
        });
        t.recorded = hit;
        this.saveTimer();
        if (!hit) new Notice(`没找到任务「${taskTitle(task.text)}」，这个番茄没有记录`);
    }

    // 用 WebAudio 合成三连音提示，不依赖音频文件
    chime(win) {
        try {
            const ctx = new win.AudioContext();
            [880, 1108.73, 1318.51].forEach((freq, i) => {
                const at = ctx.currentTime + i * 0.16;
                const osc = ctx.createOscillator(), gain = ctx.createGain();
                osc.frequency.value = freq;
                gain.gain.setValueAtTime(0.0001, at);
                gain.gain.exponentialRampToValueAtTime(0.2, at + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.9);
                osc.connect(gain).connect(ctx.destination);
                osc.start(at);
                osc.stop(at + 1);
            });
            win.setTimeout(() => ctx.close(), 2000);
        } catch {}
    }

    saveTimer() {
        this.saveData(this.data);
        this.renderTimer();
    }

    // 刷新所有倒计时胶囊，并把状态和进度挂到便签窗口 body 上，由 CSS 负责变色和进度条
    renderTimer() {
        const state = this.timerState(), t = this.data.timer;
        let text = "", label = "番茄钟", progress = 0;
        if (t) {
            const focus = t.kind === "focus";
            if (state === "done") {
                text = "+" + clock(Math.floor((Date.now() - t.doneAt) / 1000));
                label = focus ? "专注完成，已超时" : "休息结束，已超时";
                progress = 1;
            } else {
                const left = Math.max(0, this.remaining());
                text = clock(Math.ceil(left / 1000));
                label = state === "paused" ? "已暂停" : focus ? "专注中" : "休息中";
                progress = 1 - left / t.total;
            }
        }
        const icon = { focus: "timer", break: "coffee", paused: "pause", done: "check" }[state];
        this.setTrayTitle(state ? `${{ focus: "🍅", break: "☕", paused: "⏸", done: "✓" }[state]} ${text}` : "");
        const chips = [this.statusEl];
        for (const s of this.wins.values()) {
            const body = s.win.document.body;
            if (state) body.dataset.stickyTimer = state;
            else delete body.dataset.stickyTimer;
            body.style.setProperty("--sticky-timer-progress", progress.toFixed(4));
            for (const chip of s.chips) {
                if (chip.isConnected) chips.push(chip);
                else s.chips.delete(chip);
            }
        }
        for (const chip of chips) {
            if (!chip) continue;
            if (chip.dataset.stickyTimer !== state) {
                if (state) chip.dataset.stickyTimer = state;
                else delete chip.dataset.stickyTimer;
                if (icon) setIcon(chip.firstElementChild, icon);
            }
            chip.lastElementChild.setText(text);
            const task = t?.kind === "focus" && t.task ? `\n${shortTitle(t.task.text)}` : "";
            chip.setAttr("aria-label", `${label}，点击查看操作${task}`);
        }
    }

    timerMenu(evt, view) {
        const t = this.data.timer, state = this.timerState(), menu = new Menu();
        const add = (title, icon, fn) => menu.addItem((it) => it.setTitle(title).setIcon(icon).onClick(fn));
        const hint = (title) => menu.addItem((it) => it.setTitle(title).setIcon("list-checks").setDisabled(true));
        const last = this.data.lastMinutes, here = this.cursorTask(view);
        const start = (m, kind) => this.startTimer(m, kind, view);
        // 第一行告诉用户这个番茄会记到哪个任务上
        if (!t || state === "done") {
            hint(here ? `记录到：${shortTitle(here.text)}` : "光标放在任务行上，番茄会记到该任务");
            menu.addSeparator();
        }
        if (!t) {
            const list = this.presets();
            const presets = list.includes(last) ? list : [...list, last].sort((a, b) => a - b);
            for (const m of presets)
                menu.addItem((it) => it.setTitle(`专注 ${m} 分钟`).setIcon("timer")
                    .setChecked(m === last).onClick(() => start(m)));
            add("休息 5 分钟", "coffee", () => start(5, "break"));
            add("自定义时长…", "pencil", () => this.customTimer(view));
        } else if (state === "done") {
            if (t.kind === "focus") add("休息 5 分钟", "coffee", () => start(5, "break"));
            add(`专注 ${last} 分钟`, "timer", () => start(last));
            add("自定义时长…", "pencil", () => this.customTimer(view));
            if (t.kind === "focus" && t.task) add("写下一步…", "footprints", () => this.writeNextStep(view, t.task));
            add("关闭提醒", "x", () => this.stopTimer());
        } else {
            if (t.kind === "focus") {
                hint(t.task ? `记录到：${shortTitle(t.task.text)}` : "未关联任务，结束后不记录");
                const moved = here && (here.path !== t.task?.path || here.text !== t.task?.text);
                if (moved) add(`改记到：${shortTitle(here.text)}`, "corner-down-right", () => {
                    t.task = here;
                    this.saveTimer();
                });
                menu.addSeparator();
            }
            add(state === "paused" ? "继续" : "暂停", state === "paused" ? "play" : "pause", () => this.toggleTimer());
            add("延长 5 分钟", "plus", () => this.addTime(5 * 60000));
            if (t.kind === "focus") add("提前完成并记录", "check", () => this.finishTimer(true));
            add(t.kind === "focus" ? "放弃本次专注" : "结束休息", "square", () => this.stopTimer());
        }
        menu.addSeparator();
        menu.addItem((it) => it.setTitle("完成时播放提示音").setIcon("bell")
            .setChecked(this.data.sound).onClick(() => {
                this.data.sound = !this.data.sound;
                this.saveData(this.data);
            }));
        menu.showAtMouseEvent(evt);
    }

    async customTimer(view) {
        await this.expand();
        new DurationModal(this.app, this.data.lastMinutes, (m, kind) => this.startTimer(m, kind, view)).open();
    }
};
