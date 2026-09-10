/* eslint-disable semi */
import * as fs from "node:fs"
import * as path from "node:path"
import * as vscode from "vscode"
import {
  CLAUDE_DIR,
  CLAUDE_STATE,
  CODEX_DIR,
  DAY_MS,
  LimitWindow,
  ProjectUse,
  PromptUse,
  Report,
  Tool,
  WEEK_DAYS,
  WindowUse,
  formatTokens,
  scan,
  sumTotals,
  weeklyDayPercents,
} from "./tracker"

const TOOLS: { id: Tool; label: string; icon: string }[] = [
  { id: "claude", label: "Claude Code", icon: "$(codaude-claude)" },
  { id: "codex", label: "Codex", icon: "$(codaude-codex)" },
]

/**
 * Assigning `webview.html` reloads the document, which throws away scroll position and
 * any expanded prompt lists. A poll every minute mostly produces an identical report, so
 * the html is only swapped when it really changed; the clock is pushed separately as a
 * message and written into the live document.
 */
const painted = new WeakMap<vscode.Webview, string>()

function paint(webview: vscode.Webview) {
  const html = latest ? render(latest) : "<p>Loading…</p>"
  if (painted.get(webview) !== html) {
    painted.set(webview, html)
    webview.html = html
  }
  postStamp(webview)
}

function postStamp(webview: vscode.Webview) {
  webview.postMessage({ type: "scannedAt", text: scannedAt ? `Updated ${stamp(scannedAt)}` : "" })
}

function wire(webview: vscode.Webview, disposables: vscode.Disposable[]) {
  webview.onDidReceiveMessage(
    (msg) => {
      if (msg?.type === "refresh") {
        refresh()
      } else if (msg?.type === "ready") {
        // a freshly loaded document has no clock yet, and a message sent before its
        // listener existed is dropped, so it asks for the value itself
        postStamp(webview)
      }
    },
    null,
    disposables,
  )
}

function pngData(file: string): string {
  try {
    return `data:image/png;base64,${fs.readFileSync(path.join(__dirname, "..", "src", "assets", file)).toString("base64")}`
  } catch {
    return ""
  }
}

const TOOL_IMAGES: Record<Tool, string> = {
  claude: pngData("claude.png"),
  codex: pngData("chatgpt.png"),
}

const VIEW_ID = "codaude.usage"

let statusBar: vscode.StatusBarItem
let view: vscode.WebviewView | undefined
let floating: vscode.WebviewPanel | undefined
let latest: Report | undefined
/** epoch ms of the scan that produced `latest`; shown in the panel header */
let scannedAt = 0

/** How often to re-scan on our own, so the panel never depends solely on file watchers. */
const POLL_MS = 60_000

export function activate(context: vscode.ExtensionContext) {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBar.command = "codaude.showDetails"
  statusBar.text = "$(codaude-claude) … $(codaude-codex) …"
  statusBar.show()
  context.subscriptions.push(statusBar)

  context.subscriptions.push(
    // `<viewId>.focus` is contributed automatically; it opens the bottom panel on the view
    vscode.commands.registerCommand("codaude.showDetails", () => vscode.commands.executeCommand(`${VIEW_ID}.focus`)),
    vscode.commands.registerCommand("codaude.openWindow", async () => {
      const win = vscode.window.createWebviewPanel("codaude", "Codaude — Token Usage", vscode.ViewColumn.Active, {
        enableScripts: true,
      })
      paint(win.webview)
      wire(win.webview, context.subscriptions)
      // detach the tab into its own floating window, which closes with its own X
      await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow")
      floating = win
      win.onDidDispose(() => (floating = undefined))
    }),
    // limits and the week anchor live in settings, so a change re-renders
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codaude")) {
        refresh()
      }
    }),
    vscode.window.registerWebviewViewProvider(
      VIEW_ID,
      {
        resolveWebviewView(v) {
          v.webview.options = { enableScripts: true }
          view = v
          v.onDidDispose(() => (view = undefined))
          wire(v.webview, context.subscriptions)
          // the view is torn down when hidden, so repaint AND re-scan whenever it comes
          // back: `latest` may be hours old if nothing wrote to the logs meanwhile
          v.onDidChangeVisibility(() => {
            if (v.visible) {
              // the document was torn down while hidden, so the memo no longer describes
              // anything on screen: drop it or paint() would skip a needed re-assign
              painted.delete(v.webview)
              paint(v.webview)
              refresh()
            }
          })
          paint(v.webview)
          refresh()
        },
      },
      { webviewOptions: { retainContextWhenHidden: false } },
    ),
  )

  // recursive watchers fire onDidChange repeatedly for one write, so coalesce
  let timer: NodeJS.Timeout | undefined
  const refreshSoon = () => {
    clearTimeout(timer)
    timer = setTimeout(refresh, 1500)
  }
  context.subscriptions.push(new vscode.Disposable(() => clearTimeout(timer)))

  // the cached utilization lives in a single file, not in the jsonl logs
  const stateWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.dirname(CLAUDE_STATE)), path.basename(CLAUDE_STATE)),
  )
  // the CLI rewrites this file by writing a temp file and renaming it over the old one,
  // so the event that lands is a create (and sometimes a delete), never a plain change
  stateWatcher.onDidChange(refreshSoon, null, context.subscriptions)
  stateWatcher.onDidCreate(refreshSoon, null, context.subscriptions)
  stateWatcher.onDidDelete(refreshSoon, null, context.subscriptions)
  context.subscriptions.push(stateWatcher)

  for (const dir of [CLAUDE_DIR, CODEX_DIR]) {
    // must be a RelativePattern: a string glob only watches inside the workspace
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dir), "**/*.jsonl"),
    )
    watcher.onDidChange(refreshSoon, null, context.subscriptions)
    watcher.onDidCreate(refreshSoon, null, context.subscriptions)
    watcher.onDidDelete(refreshSoon, null, context.subscriptions)
    context.subscriptions.push(watcher)
  }

  // watchers on paths outside the workspace are best-effort: they can be dropped by the
  // OS under load and never recover. Polling also keeps the relative times ("resets in
  // 2h", "Day 3") honest when neither tool is writing anything.
  const poll = setInterval(refresh, POLL_MS)
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(poll)))

  refresh()
}

/**
 * Scans are serialised: two overlapping scans can finish out of order and leave `latest`
 * holding the older of the two. Chaining also means a manual refresh always runs a scan
 * that starts after the click, so the button really does re-read everything.
 */
let queue: Promise<void> = Promise.resolve()

function refresh(): Promise<void> {
  queue = queue.then(runScan, runScan)
  return queue
}

async function runScan() {
  try {
    latest = await scan()
    scannedAt = Date.now()
  } catch (err) {
    statusBar.text = "$(warning) AI"
    statusBar.tooltip = `Codaude: ${err}`
    return
  }
  const short = (id: Tool) => {
    const five = latest!.limits[id]?.fiveHour
    return five ? `${Math.round(five.percent)}%` : formatTokens(latest!.last5h[id])
  }

  statusBar.text = TOOLS.map((t) => `${t.icon} ${short(t.id)}`).join(" | ")
  statusBar.tooltip = tooltip(latest)

  if (view?.visible) {
    paint(view.webview)
  }
  if (floating) {
    paint(floating.webview)
  }
}

/** The status bar hover is plain markdown, so bars are drawn with block characters. */
function textBar(percent: number, width = 18): string {
  const on = Math.round((Math.min(Math.max(percent, 0), 100) / 100) * width)
  return "█".repeat(on) + "░".repeat(width - on)
}

/** Seven day-slots as one sparkline, scaled to the busiest day of the window. */
function spark(days: number[]): string {
  const steps = "▁▂▃▄▅▆▇█"
  const max = Math.max(...days)
  return days.map((n) => (n > 0 ? steps[Math.ceil((n / max) * (steps.length - 1))] : "·")).join(" ")
}

function tooltip(report: Report): vscode.MarkdownString {
  const tip = new vscode.MarkdownString("", true)
  tip.isTrusted = { enabledCommands: ["codaude.showDetails", "codaude.openWindow"] }

  const line = (label: string, win: LimitWindow | undefined, tokens: number) =>
    win
      ? `\`${label.padEnd(12)} ${textBar(win.percent)} ${String(Math.round(win.percent)).padStart(3)}%\`` +
        ` &nbsp; resets in ${until(win.resetsAt)} &nbsp;·&nbsp; ${formatTokens(tokens)}\n\n`
      : `\`${label.padEnd(12)}\` &nbsp; no limit data &nbsp;·&nbsp; ${formatTokens(tokens)}\n\n`

  for (const { id, label, icon } of TOOLS) {
    const use = report.week[id]
    const lim = report.limits[id]
    const weekTokens = use.days.reduce((s, n) => s + n, 0)
    tip.appendMarkdown(
      `${icon} **${label}** &nbsp; \`${mmdd(use.start)} – ${mmdd(use.start + WEEK_DAYS * DAY_MS)}\`` +
        `${stale(lim?.fetchedAt ?? 0)}\n\n`,
    )
    tip.appendMarkdown(line("Session (5h)", lim?.fiveHour, report.last5h[id]))
    tip.appendMarkdown(line("Weekly (7d)", lim?.week, weekTokens))
    tip.appendMarkdown(`\`${spark(use.days)}\` &nbsp; per day, ${mmdd(use.start)} onwards\n\n---\n\n`)
  }

  tip.appendMarkdown(
    "\n[$(window) Open in window](command:codaude.openWindow) &nbsp; " +
      "[$(layout-panel) Open in panel](command:codaude.showDetails)",
  )
  return tip
}

/** one hue per day of the week window, tuned to stay legible on a dark panel */
const DAY_COLORS = ["#ff6b6b", "#ff9f43", "#ffd93d", "#5ed88b", "#4d96ff", "#7d6bf0", "#c07ef0"]
/** circumference = 100, so every stroke-dasharray value is a percentage */
const RING_R = 15.9155

function mmdd(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Panel header clock: "2026-09-10 11:15", in the user's local time. */
function stamp(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Same shape as the CLI's own "Resets in 4h" / "Resets in 5d". */
function until(ts: number): string {
  const h = (ts - Date.now()) / 3_600_000
  if (h <= 0) {
    return "now"
  }
  return h < 24 ? `${Math.round(h)}h` : `${Math.floor(h / 24)}d`
}

function stale(fetchedAt: number): string {
  const min = (Date.now() - fetchedAt) / 60_000
  if (!fetchedAt || min < 30) {
    return ""
  }
  return ` · ${min < 90 ? `${Math.round(min)}m` : `${Math.round(min / 60)}h`} old`
}

/**
 * The ring is the provider's own weekly utilization; the coloured slice of it is
 * split between days by how many tokens each day burned.
 */
function donut(use: WindowUse, week: LimitWindow | undefined): string {
  const total = use.days.reduce((s, n) => s + n, 0)
  const shares = weeklyDayPercents(use, week)

  let offset = 0
  const segs = use.days
    .map((tokens, i) => ({ tokens, i, color: DAY_COLORS[i], start: use.start + i * DAY_MS }))
    .filter((d) => d.tokens > 0)
    .map((d) => {
      const p = shares[d.i] ?? 0
      const seg = `<circle class="seg" cx="21" cy="21" r="${RING_R}"
				stroke-dasharray="${p.toFixed(3)} ${(100 - p).toFixed(3)}"
				stroke-dashoffset="${(-offset).toFixed(3)}"
				stroke="${d.color}"><title>${mmdd(d.start)} — ${formatTokens(d.tokens)} (${p.toFixed(1)}%)</title></circle>`
      offset += p
      return seg
    })
    .join("")

  const mid = week
    ? `<strong>${Math.round(week.percent)}%</strong><span>resets in ${until(week.resetsAt)}</span>`
    : `<strong>${formatTokens(total)}</strong><span>no limit data</span>`

  return `<div class="donut">
		<svg viewBox="0 0 42 42"><circle class="track" cx="21" cy="21" r="${RING_R}"></circle>${segs}</svg>
		<div class="mid">${mid}</div>
	</div>`
}

/** 5-hour limit: the provider's percentage, with our token count alongside. */
function progress(five: LimitWindow | undefined, tokens: number): string {
  const p = five ? Math.min(five.percent, 100) : 0
  return `<div class="prog">
		<div class="prog-head">
			<span>Session (5h)${five ? ` · resets in ${until(five.resetsAt)}` : ""}</span>
			<span>${five ? `${Math.round(five.percent)}%` : formatTokens(tokens)}</span>
		</div>
		<div class="track"><div class="fill" style="width:${p.toFixed(1)}%"></div></div>
		<div class="sub">${formatTokens(tokens)} tokens</div>
	</div>`
}

/** Today's tokens as a slice of the weekly limit, so both bars share one 100%. */
function todayBar(use: WindowUse, week: LimitWindow | undefined): string {
  const total = use.days.reduce((sum, n) => sum + n, 0)
  const i = Math.min(Math.floor((Date.now() - use.start) / DAY_MS), WEEK_DAYS - 1)
  const tokens = use.days[i] ?? 0
  const shares = weeklyDayPercents(use, week)
  const percent = shares[i] ?? 0
  const segments = shares
    .map((share, day) =>
      share > 0
        ? `<span class="day-fill${day < i ? " past" : ""}${day === i ? " today" : ""}${day === i && i === 0 ? " first-today" : ""}" style="width:${share.toFixed(3)}%;--day-color:${DAY_COLORS[day]}" title="${mmdd(use.start + day * DAY_MS)} — ${formatTokens(use.days[day])} tokens (${share.toFixed(1)}% of 7d limit)"></span>`
        : "",
    )
    .join("")
  return `<div class="prog">
		<div class="prog-head">
			<span>Today's usage (based on 7d limit)</span>
			<span>${week && total ? `${percent.toFixed(1)}%` : formatTokens(tokens)}</span>
		</div>
		<div class="track day-track">${segments}</div>
		<div class="sub">${formatTokens(tokens)} tokens · Day ${i + 1}</div>
	</div>`
}

/** Names the donut colours: one chip per day, greyed out when that day burned nothing. */
function dayLegend(use: WindowUse): string {
  const chips = use.days
    .map(
      (
        tokens,
        i,
      ) => `<span class="day-chip${tokens ? "" : " off"}" title="${mmdd(use.start + i * DAY_MS)} — ${formatTokens(tokens)}">
			<i style="background:${DAY_COLORS[i]}"></i>Day ${i + 1}</span>`,
    )
    .join("")
  return `<div class="day-legend">${chips}</div>`
}

/** Per-day share of the weekly limit if it were spread evenly (14%). */
const DAILY_PACE = Math.floor(100 / WEEK_DAYS)

/**
 * "3일차에 50%를 썼으면 오늘 포함 남은 5일 동안 하루 10%씩" — the budget that lands
 * exactly on 100% by the end of the window. Today counts as a day still to spend,
 * and percentages are floored, never rounded up.
 */
function pace(use: WindowUse, week: LimitWindow | undefined): string {
  if (!week) {
    return ""
  }
  const used = Math.floor(week.percent)
  const day = Math.min(Math.floor((Date.now() - use.start) / DAY_MS) + 1, WEEK_DAYS)
  // today is still spendable, so it counts towards the days the rest is split over
  const left = WEEK_DAYS - day + 1
  const remaining = Math.max(100 - used, 0)

  let headline: string
  let note: string
  if (used >= 100) {
    headline = "100% of limit used"
    note = `Resets in ${until(week.resetsAt)}`
  } else if (left === 1) {
    headline = `Final day · ${remaining}% remaining`
    note = `You can use up to ${remaining}% today`
  } else {
    const budget = Math.floor(remaining / left)
    headline = `${budget}% per day for the remaining ${left} days (today included)`
    const diff = budget - DAILY_PACE
    note =
      diff > 0
        ? `${diff}% more per day than the average (${DAILY_PACE}%)`
        : diff < 0
          ? `Save ${-diff}% per day compared with the average (${DAILY_PACE}%)`
          : `Using the average (${DAILY_PACE}%) fits exactly`
  }

  return `<div class="callout${used >= 100 ? " over" : ""}">
    <div class="callout-head"><span>Day ${day} · ${used}% used</span><strong>${headline}</strong></div>
    <div class="callout-note">${note}</div>
  </div>`
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  )
}

function recentPrompts(items: PromptUse[], total: number, five: LimitWindow | undefined): string {
  const rows = items
    .map((item, index) => {
      const tokens = sumTotals(item.usage)
      const share = five && total ? (tokens / total) * five.percent : undefined
      const percent = share === undefined ? "5h limit unavailable" : `${share < 0.1 ? "<0.1" : share.toFixed(1)}%`
      const metric = share === undefined ? percent : `<strong class="prompt-percent">${percent}</strong> of 5h limit`
      const project = item.project ? ` · ${escapeHtml(item.project)}` : ""
      return `<div class="prompt-row"${index >= 5 ? " hidden" : ""} title="${escapeHtml(item.prompt)}">
				<div class="prompt-text">${escapeHtml(item.prompt)}</div>
				<div class="prompt-meta${tokens >= 1_000_000 ? " heavy" : ""}">${metric} · ${formatTokens(tokens)} tokens${project}</div>
			</div>`
    })
    .join("")
  return `<div class="prompt-list">${rows || '<div class="recent-empty">No prompt data</div>'}</div>${items.length > 5 ? '<button class="more" type="button">Show more (+5)</button>' : ""}`
}

function projectCards(items: ProjectUse[]): string {
  const medals = ["🥇", "🥈", "🥉"]
  return (
    items
      .map(
        (item, index) => `<article class="project-card">
				<div class="project-rank"><span>${medals[index] ?? `${index + 1}`}</span><span>#${index + 1}</span></div>
				<div class="project-name" title="${escapeHtml(item.project)}">${escapeHtml(item.project)}</div>
				<strong class="project-total">${formatTokens(item.total)} <small>tokens</small></strong>
				<div class="project-tools">
					<span class="project-claude">Claude ${formatTokens(item.tools.claude)}</span>
					<span class="project-codex">Codex ${formatTokens(item.tools.codex)}</span>
				</div>
			</article>`,
      )
      .join("") || '<div class="recent-empty">No project data</div>'
  )
}

function sectionHeader(icon: string, title: string, description: string): string {
  return `<div class="section-head"><span class="section-icon" aria-hidden="true">${icon}</span><div><h2>${title}</h2><p>${description}</p></div></div>`
}

/** One bar split by how much of the window each tool ate. */
function vsBar(label: string, claude: number, codex: number): string {
  const total = claude + codex
  const cp = total ? (claude / total) * 100 : 50
  const show = (v: number) => (v >= 12 ? `${Math.round(v)}%` : "")
  return `<div class="vs">
		<div class="vs-head"><span>${label}</span>
			<span>${formatTokens(claude)} · ${formatTokens(codex)}</span></div>
		<div class="vs-track${total ? "" : " empty"}">
			<div class="vs-claude" style="width:${cp.toFixed(1)}%"><span>${show(cp)}</span></div>
			<div class="vs-codex" style="width:${(100 - cp).toFixed(1)}%"><span>${show(100 - cp)}</span></div>
		</div>
	</div>`
}

function render(report: Report): string {
  const panels = TOOLS.map(({ id, label }) => {
    const use = report.week[id]
    const lim = report.limits[id]
    const end = use.start + WEEK_DAYS * DAY_MS
    const badge = lim?.week
      ? `${mmdd(use.start)} – ${mmdd(end)}${stale(lim.fetchedAt)}`
      : `${mmdd(use.start)} – ${mmdd(end)} · estimated`
    return `<section class="tool ${id}">
			<h2>${TOOL_IMAGES[id] ? `<img class="tool-icon" src="${TOOL_IMAGES[id]}" alt="" aria-hidden="true">` : ""}${label}</h2>
			<div class="range">${badge}</div>
			${donut(use, lim?.week)}
			${dayLegend(use)}
			${progress(lim?.fiveHour, report.last5h[id])}
			${todayBar(use, lim?.week)}
			${pace(use, lim?.week)}
		</section>`
  }).join("")
  const prompts = TOOLS.map(
    ({ id, label }) => `<section class="prompt-tool ${id}">
		<h3>${label}</h3>
		${recentPrompts(report.recent[id], report.last5h[id], report.limits[id]?.fiveHour)}
	</section>`,
  ).join("")

  const weekTokens = (id: Tool) => report.week[id].days.reduce((s, n) => s + n, 0)

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
	body { font-family: var(--vscode-font-family); font-size: 12px; padding: 14px 16px; }
	h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; opacity: .75; margin: 0 0 6px; }
	.section-head { display: flex; gap: 9px; align-items: flex-start; margin-bottom: 14px; }
	.section-icon { font-size: 17px; line-height: 1.1; color: var(--vscode-textLink-foreground); }
	.section-head h2 { margin: 0; }
	.section-head p { margin: 3px 0 0; opacity: .6; font-size: 11px; }
	.category + .category { margin-top: 24px; }
	.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 22px; }
	.tool { --c: #ffa64d; }
	.tool.codex { --c: #4a9eff; }
	.tool h2 { display: flex; align-items: center; gap: 7px; }
	.tool-icon { width: 18px; height: 18px; object-fit: contain; }
	.tool.codex .tool-icon { width: 14px; height: 14px; padding: 2px; border-radius: 4px; background: #fff; }
	.range { display: inline-block; margin-bottom: 12px; padding: 2px 8px; font-size: 11px;
		border: 1px solid var(--vscode-panel-border); border-radius: 10px; opacity: .8; }

	.donut { position: relative; width: 148px; margin: 0 auto 14px; }
	.donut svg { width: 100%; display: block; transform: rotate(-90deg); }
	.donut circle { fill: none; stroke-width: 4.5; }
	.donut .track { stroke: var(--vscode-panel-border); }
	.mid { position: absolute; inset: 0; display: flex; flex-direction: column;
		align-items: center; justify-content: center; gap: 1px; }
	.mid strong { font-size: 20px; font-weight: 600; }
	.mid span { opacity: .6; font-size: 11px; }

	.prog + .prog { margin-top: 10px; }
	.prog-head, .vs-head { display: flex; justify-content: space-between; opacity: .7; margin-bottom: 4px; }
	.sub { opacity: .5; font-size: 11px; margin-top: 4px; }
	.track { height: 8px; border-radius: 4px; background: var(--vscode-panel-border); overflow: hidden; }
	.fill { height: 100%; background: var(--c); border-radius: 4px; }
	.day-track { display: flex; }
	.day-fill { flex: 0 0 auto; height: 100%; background: var(--day-color); }
	.day-fill.past { background: #808080; opacity: .5; }
	.day-fill.today { border-radius: 0 4px 4px 0; }
	.day-fill.today.first-today { border: 4px solid var(--fill-color); }
	.day-legend { display: flex; flex-wrap: wrap; gap: 4px 8px; margin-bottom: 12px; font-size: 10px; opacity: .8; }
	.day-chip { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
	.day-chip.off { opacity: .35; }
	.day-chip i { width: 7px; height: 7px; border-radius: 2px; }
	.callout { margin-top: 12px; padding: 9px 11px; border-radius: 7px; border: 1px solid var(--vscode-panel-border);
		border-left: 3px solid var(--c); background: color-mix(in srgb, var(--c) 9%, transparent); }
	.callout.over { --c: #ff6b6b; }
	.callout-head { display: flex; flex-direction: column; gap: 2px; }
	.callout-head span { font-size: 10px; opacity: .6; }
	.callout-head strong { font-size: 12px; color: var(--c); }
	.callout-note { margin-top: 4px; font-size: 11px; opacity: .65; }
	.prompt-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 22px; }
	.prompt-tool { --c: #ffa64d; }
	.prompt-tool.codex { --c: #4a9eff; }
	.prompt-tool h3 { font-size: 12px; margin: 0 0 7px; }
	.prompt-tool h3::before { content: ''; display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: var(--c); margin-right: 6px; }
	.prompt-row { padding: 5px 0; border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 60%, transparent); }
	.prompt-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.prompt-meta, .recent-empty { opacity: .55; font-size: 11px; margin-top: 2px; }
	.prompt-percent { color: var(--c); opacity: 1; }
	.prompt-meta.heavy { font-weight: 700; opacity: .9; }
	.hidden { display: none; }
	.more { margin-top: 8px; padding: 3px 8px; color: var(--vscode-textLink-foreground); background: transparent; border: 1px solid var(--vscode-panel-border); border-radius: 4px; cursor: pointer; }
	.project-slider { display: grid; grid-auto-flow: column; grid-auto-columns: calc((100% - 48px) / 5); gap: 12px; overflow-x: auto; padding-bottom: 6px; scroll-snap-type: x mandatory; scrollbar-width: thin; }
	.project-card { min-width: 0; min-height: 135px; padding: 13px; border: 1px solid var(--vscode-panel-border); border-radius: 9px; background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-textLink-foreground)); scroll-snap-align: start; }
	.project-rank { display: flex; align-items: center; gap: 5px; color: var(--vscode-descriptionForeground); font-size: 11px; }
	.project-rank span:first-child { font-size: 20px; line-height: 1; }
	.project-name { margin: 16px 0 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
	.project-total { display: block; font-size: 19px; }
	.project-total small { font-size: 10px; font-weight: 400; opacity: .55; }
	.project-tools { display: flex; flex-direction: column; gap: 3px; margin-top: 9px; font-size: 11px; }
	.project-claude::before, .project-codex::before { content: ''; display: inline-block; width: 6px; height: 6px; margin: 0 5px 1px 0; border-radius: 50%; }
	.project-claude::before { background: #ffa64d; }
	.project-codex::before { background: #4a9eff; }
	@media (max-width: 900px) { .project-slider { grid-auto-columns: minmax(180px, 42%); } }
	@media (max-width: 500px) { .project-slider { grid-auto-columns: 82%; } }

	.vs { margin-top: 14px; }
	.vs-track { display: flex; height: 18px; border-radius: 4px; overflow: hidden;
		background: var(--vscode-panel-border); }
	.vs-track.empty > div { background: transparent; }
	.vs-track div { display: flex; align-items: center; justify-content: center; font-size: 10px; color: #fff; }
	.vs-claude { background: #ffa64d; }
	.vs-codex { background: #4a9eff; }

	hr { border: 0; border-top: 1px solid var(--vscode-panel-border); margin: 22px 0 16px; }

	.topbar { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
	.stamp { font-size: 11px; opacity: .6; font-variant-numeric: tabular-nums; }
	.refresh { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; font-size: 11px;
		color: var(--vscode-foreground); background: transparent; border: 1px solid var(--vscode-panel-border);
		border-radius: 10px; cursor: pointer; }
	.refresh:hover { background: var(--vscode-toolbar-hoverBackground); }
	.refresh i { font-style: normal; line-height: 1; }
	.refresh.busy { opacity: .55; pointer-events: none; }
	.refresh.busy i { animation: spin .7s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
</style></head><body>
<header class="topbar">
	<span class="stamp"></span>
	<button class="refresh" type="button" title="Re-scan every Claude and Codex log from disk"><i>↻</i>Refresh</button>
</header>
<section class="category">
	${sectionHeader("◉", "Usage by AI", "Weekly and 5-hour usage for Claude and Codex")}
	<div class="grid">${panels}</div>
</section>
<section class="category">
	${sectionHeader("☷", "Usage by prompt", "Share of the 5-hour limit used by recent prompts")}
	<div class="prompt-grid">${prompts}</div>
</section>
<section class="category">
	${sectionHeader("▣", "Usage by project", "Token rankings by project folder over the last 7 days")}
	<div class="project-slider">${projectCards(report.projects)}</div>
</section>
<section class="category">
	${sectionHeader("↔", "Claude vs Codex", "Compare the 5-hour and weekly usage shares of both AIs")}
	${vsBar("Last 5 hours", report.last5h.claude, report.last5h.codex)}
	${vsBar("This week", weekTokens("claude"), weekTokens("codex"))}
</section>
<script>
	const api = acquireVsCodeApi();
	const refreshBtn = document.querySelector('.refresh');
	refreshBtn.addEventListener('click', () => {
		refreshBtn.classList.add('busy');
		api.postMessage({ type: 'refresh' });
	});
	// every finished scan sends the clock, whether or not the document was replaced,
	// so it doubles as the signal that the manual refresh is done
	window.addEventListener('message', (event) => {
		if (event.data && event.data.type === 'scannedAt') {
			document.querySelector('.stamp').textContent = event.data.text;
			refreshBtn.classList.remove('busy');
		}
	});
	api.postMessage({ type: 'ready' });
	document.querySelectorAll('.more').forEach((button) => button.addEventListener('click', () => {
		const list = button.previousElementSibling;
		[...list.querySelectorAll('.prompt-row[hidden]')].slice(0, 5).forEach((row) => row.removeAttribute('hidden'));
		if (!list.querySelector('.prompt-row[hidden]')) button.remove();
	}));
</script>
</body></html>`
}

export function deactivate() {}
