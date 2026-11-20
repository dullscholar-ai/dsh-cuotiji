/**
 * 错题本 · Client 半段。
 *
 * 只做两件事：注册左侧栏的面板入口图标，以及用 main 槽渲染错题本面板。
 * 所有数据都通过同源的 `/api/cuotiji/*` 精确路由读写（HttpOnly Cookie 鉴权），
 * 面板不自己拼业务逻辑，和模型调用的工具落同一份文件。
 *
 * 设计约定：只用 `--dsw-alias-*` 主题 token，不写死颜色；8pt 间距节奏；
 * 正文行长限制在 ~46em；交互态（hover / selected / focus / disabled）齐备；
 * 首屏不出现编辑表单，复核区按需展开。
 * @module @local/dsh-cuotiji/client
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-cuotiji',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useRef, useCallback } = React;

    const API = '/api/cuotiji';

    // ── 样式 ────────────────────────────────────────────────────────────────
    const CSS = `
.cjt-root {
  --cjt-radius: 10px;
  --cjt-measure: 660px;
  /* 本应用的 alias 语义：brand-primary 是「墨色」——浅色主题近黑(15,17,21)，
     深色主题近白(249,250,251)。所以它适合做前景/描边，做底色时必须反配前景。
     bg-layer-1/2 在浅色主题下也是纯白，border-l1 只有 4% 黑，直接引用等于没有分层；
     这里统一用墨色按比例混回底色，两套主题都能看见。 */
  --cjt-accent: var(--dsw-alias-brand-primary, #1c1c1e);
  --cjt-fg: var(--dsw-alias-label-primary, #1c1c1e);
  --cjt-fg-2: var(--dsw-alias-label-secondary, #6b6b74);
  --cjt-bg: var(--dsw-alias-bg-base, #ffffff);
  --cjt-bg-1: var(--dsw-alias-bg-layer-1, #f7f7f8);
  --cjt-bg-1: color-mix(in srgb, var(--cjt-fg) 4%, var(--cjt-bg));
  --cjt-bg-2: var(--dsw-alias-bg-layer-2, #eeeef0);
  --cjt-bg-2: color-mix(in srgb, var(--cjt-fg) 9%, var(--cjt-bg));
  --cjt-line: var(--dsw-alias-border-l1, #e4e4e9);
  --cjt-line: color-mix(in srgb, var(--cjt-fg) 13%, transparent);
  --cjt-line-strong: var(--dsw-alias-border-l2, #c9c9d2);
  --cjt-line-strong: color-mix(in srgb, var(--cjt-fg) 26%, transparent);
  --cjt-danger: var(--dsw-alias-state-error-primary, #d64545);
  --cjt-success: var(--dsw-alias-state-success-primary, #1f9d6b);
  --cjt-warn: var(--dsw-alias-state-warn-primary, #d98324);
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--cjt-bg);
  color: var(--cjt-fg);
  font-family: "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
.cjt-root *, .cjt-root *::before, .cjt-root *::after { box-sizing: border-box; }

/* ── 顶栏 ─────────────────────────────────────────────────────────────── */
.cjt-topbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 52px;
  padding: 0 16px;
  border-bottom: 1px solid var(--cjt-line);
  background: var(--cjt-bg);
}
.cjt-title { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; }
.cjt-title .cjt-glyph { color: var(--cjt-accent); display: grid; place-items: center; }
.cjt-stats {
  display: flex; align-items: center; gap: 6px;
  font-size: 11px; color: var(--cjt-fg-2);
  font-variant-numeric: tabular-nums;
}
.cjt-sep { width: 1px; height: 16px; background: var(--cjt-line); }
.cjt-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }

/* ── 按钮 ─────────────────────────────────────────────────────────────── */
.cjt-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 30px; padding: 0 12px;
  border: 1px solid var(--cjt-line-strong);
  border-radius: 8px;
  background: var(--cjt-bg);
  color: var(--cjt-fg);
  font: inherit; font-size: 13px; line-height: 1;
  cursor: pointer; white-space: nowrap;
  transition: background .16s ease, border-color .16s ease, color .16s ease, box-shadow .16s ease;
}
.cjt-btn:hover:not(:disabled) { background: var(--cjt-bg-2); }
.cjt-btn:active:not(:disabled) { transform: translateY(.5px); }
.cjt-btn:focus-visible { outline: 2px solid var(--cjt-accent); outline-offset: 2px; }
.cjt-btn.cjt-ghost { border-color: transparent; background: transparent; color: var(--cjt-fg); }
.cjt-btn.cjt-ghost:hover:not(:disabled) { background: var(--cjt-bg-2); }
.cjt-btn.cjt-primary {
  background: var(--cjt-accent);
  border-color: var(--cjt-accent);
  /* 前景取底色：浅色主题=白字压近黑，深色主题=近黑字压近白，两套都够对比 */
  color: var(--cjt-bg);
  font-weight: 500;
  box-shadow: 0 1px 2px rgba(16, 24, 40, .10);
}
.cjt-btn.cjt-primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--cjt-accent) 86%, var(--cjt-bg));
  border-color: color-mix(in srgb, var(--cjt-accent) 86%, var(--cjt-bg));
}
.cjt-btn.cjt-danger { color: var(--cjt-danger); }
.cjt-btn.cjt-icon { width: 30px; padding: 0; }
/* 禁用态放在最后：不靠低透明度表达，改成「读得清的次要色 + 弱边框」 */
.cjt-btn:disabled {
  opacity: 1;
  color: var(--cjt-fg-2);
  background: var(--cjt-bg);
  border-color: var(--cjt-line);
  box-shadow: none;
  cursor: not-allowed;
}
.cjt-btn.cjt-ghost:disabled { background: transparent; border-color: transparent; }
.cjt-btn.cjt-primary:disabled {
  background: var(--cjt-bg-2);
  color: var(--cjt-fg-2);
  border-color: transparent;
}
.cjt-spin {
  width: 13px; height: 13px; flex: none; border-radius: 50%;
  border: 2px solid currentColor; border-right-color: transparent;
  animation: cjt-spin .7s linear infinite;
}
@keyframes cjt-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .cjt-root * { transition: none !important; animation: none !important; }
  .cjt-spin { border-right-color: currentColor; opacity: .55; }
}

/* ── 提示条 ───────────────────────────────────────────────────────────── */
.cjt-banner {
  flex: none; display: flex; align-items: center; gap: 8px;
  padding: 7px 16px; font-size: 12px;
  background: var(--cjt-bg-1);
  border-bottom: 1px solid var(--cjt-line);
  color: var(--cjt-fg-2);
}
.cjt-banner .cjt-banner-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cjt-banner.cjt-err { color: var(--cjt-danger); }
.cjt-banner.cjt-ok { color: var(--cjt-success); }
.cjt-banner .cjt-btn { height: 26px; margin-left: auto; }

/* ── 主体三栏 ─────────────────────────────────────────────────────────── */
.cjt-body { flex: 1 1 auto; display: flex; min-height: 0; }

/* 左：分类树 */
.cjt-rail {
  flex: none; width: 232px; display: flex; flex-direction: column; min-height: 0;
  border-right: 1px solid var(--cjt-line);
  background: var(--cjt-bg-1);
}
.cjt-rail-head {
  flex: none; padding: 12px 14px 6px;
  font-size: 11px; font-weight: 600; letter-spacing: .06em;
  color: var(--cjt-fg-2);
}
.cjt-rail-head-split {
  margin-top: 10px; padding-top: 12px;
  border-top: 1px solid var(--cjt-line);
}
.cjt-rail-scroll { flex: 1 1 auto; overflow: auto; padding: 0 8px 16px; }
.cjt-row {
  position: relative; display: flex; align-items: center; gap: 6px;
  height: 30px; padding: 0 8px; border-radius: 7px;
  color: var(--cjt-fg-2); cursor: pointer;
  transition: background .14s ease, color .14s ease;
}
.cjt-row:hover { background: var(--cjt-bg-2); color: var(--cjt-fg); }
.cjt-row:focus-visible { outline: 2px solid var(--cjt-accent); outline-offset: -2px; }
.cjt-row.cjt-on { background: var(--cjt-bg-2); color: var(--cjt-fg); font-weight: 600; }
.cjt-row.cjt-on::before {
  content: ""; position: absolute; left: -8px; top: 7px; bottom: 7px;
  width: 3px; border-radius: 0 3px 3px 0; background: var(--cjt-accent);
}
.cjt-row .cjt-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cjt-row .cjt-count {
  margin-left: auto; flex: none; font-size: 11px; font-weight: 400;
  color: var(--cjt-fg-2); font-variant-numeric: tabular-nums;
}
.cjt-row.cjt-l1 { padding-left: 12px; }
.cjt-row.cjt-l2 { padding-left: 24px; font-size: 12px; }
.cjt-row.cjt-l3 { padding-left: 36px; font-size: 12px; }
.cjt-dot { flex: none; width: 4px; height: 4px; border-radius: 50%; background: var(--cjt-line-strong); }

/* 中：错题列表 */
.cjt-list {
  flex: none; width: 320px; display: flex; flex-direction: column; min-height: 0;
  border-right: 1px solid var(--cjt-line);
}
.cjt-searchwrap { flex: none; padding: 10px 12px; border-bottom: 1px solid var(--cjt-line); }
.cjt-search { position: relative; display: flex; align-items: center; }
.cjt-search .cjt-glyph {
  position: absolute; left: 9px; color: var(--cjt-fg-2); pointer-events: none;
  display: grid; place-items: center;
}
.cjt-search input {
  width: 100%; height: 32px; padding: 0 10px 0 30px;
  border: 1px solid var(--cjt-line-strong); border-radius: 8px;
  background: var(--cjt-bg); color: var(--cjt-fg);
  font: inherit; font-size: 13px;
}
.cjt-search input::placeholder { color: var(--cjt-fg-2); }
.cjt-search input:focus {
  outline: none; border-color: var(--cjt-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--cjt-accent) 16%, transparent);
}
.cjt-filterbar {
  flex: none; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 7px 12px; border-bottom: 1px solid var(--cjt-line);
  font-size: 11px; color: var(--cjt-fg-2);
}
.cjt-date {
  width: 104px; height: 26px; padding: 0 5px;
  border: 1px solid var(--cjt-line-strong); border-radius: 6px;
  background: var(--cjt-bg); color: var(--cjt-fg);
  font: inherit; font-size: 11px;
}
.cjt-date:focus {
  outline: none; border-color: var(--cjt-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--cjt-accent) 16%, transparent);
}
.cjt-linkbtn {
  border: 0; background: transparent; color: var(--cjt-accent);
  font: inherit; font-size: 11px; cursor: pointer;
  display: inline-flex; align-items: center; min-height: 26px;
  padding: 4px 6px; border-radius: 5px;
}
.cjt-linkbtn:hover:not(:disabled) { background: var(--cjt-bg-2); }
.cjt-linkbtn:focus-visible { outline: 2px solid var(--cjt-accent); outline-offset: 1px; }
.cjt-linkbtn:disabled { color: var(--cjt-fg-2); cursor: not-allowed; }
.cjt-items { flex: 1 1 auto; overflow: auto; padding: 8px; }
.cjt-card {
  position: relative; display: flex; flex-direction: column; gap: 5px;
  padding: 10px 12px; margin-bottom: 4px;
  border: 1px solid transparent; border-radius: var(--cjt-radius);
  cursor: pointer;
  transition: background .14s ease, border-color .14s ease;
}
.cjt-card:hover { background: var(--cjt-bg-1); }
.cjt-card:focus-visible { outline: 2px solid var(--cjt-accent); outline-offset: -1px; }
.cjt-card.cjt-on { background: var(--cjt-bg-1); border-color: var(--cjt-accent); }
.cjt-card-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.cjt-check {
  position: relative;
  flex: none; width: 16px; height: 16px;
  border: 1.5px solid var(--cjt-line-strong); border-radius: 4px;
  display: grid; place-items: center; cursor: pointer;
  background: var(--cjt-bg); color: var(--cjt-bg);
  transition: background .14s ease, border-color .14s ease;
}
/* 视觉 16px，命中区扩到 28px，免得非点中不可 */
.cjt-check::after { content: ""; position: absolute; inset: -6px; }
.cjt-check:hover { border-color: var(--cjt-accent); }
.cjt-check:focus-visible { outline: 2px solid var(--cjt-accent); outline-offset: 2px; }
.cjt-check.cjt-on { background: var(--cjt-accent); border-color: var(--cjt-accent); }
.cjt-check svg { opacity: 0; }
.cjt-check.cjt-on svg { opacity: 1; }
.cjt-no {
  flex: none; font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px; font-weight: 600; letter-spacing: .02em; color: var(--cjt-accent);
}
.cjt-meta {
  min-width: 0; font-size: 11px; color: var(--cjt-fg-2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cjt-excerpt {
  font-size: 13px; line-height: 1.55; color: var(--cjt-fg-2);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; word-break: break-word;
}
.cjt-card.cjt-on .cjt-excerpt { color: var(--cjt-fg); }
.cjt-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.cjt-chip {
  display: inline-flex; align-items: center; height: 20px; padding: 0 7px;
  border-radius: 6px; font-size: 11px; line-height: 1;
  background: var(--cjt-bg-2); color: var(--cjt-fg-2);
  max-width: 14em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cjt-chip.cjt-accent { color: var(--cjt-accent); font-weight: 600; }
.cjt-chip.cjt-warn { color: var(--cjt-warn); }

/* 右：题目详情 */
.cjt-detail { flex: 1 1 auto; min-width: 0; overflow: auto; padding: 22px 26px 56px; }
.cjt-detail.cjt-detail-empty { display: flex; align-items: center; justify-content: center; padding: 0; }
.cjt-detail-inner { max-width: 720px; }
.cjt-dhead { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 6px; }
.cjt-dno {
  flex: none; font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 24px; font-weight: 700; line-height: 1.15; color: var(--cjt-accent);
  letter-spacing: -.01em;
}
.cjt-dtitle { display: flex; flex-direction: column; gap: 3px; min-width: 0; padding-top: 2px; }
.cjt-dmeta { font-size: 12px; color: var(--cjt-fg-2); }
.cjt-dactions { display: flex; gap: 6px; margin-left: auto; flex: none; padding-top: 2px; }
.cjt-dtags { display: flex; flex-wrap: wrap; gap: 5px; margin: 10px 0 4px; }

.cjt-section { margin-top: 24px; }
.cjt-section-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.cjt-badge {
  flex: none; width: 18px; height: 18px; border-radius: 50%;
  display: grid; place-items: center;
  font-size: 11px; font-weight: 600; line-height: 1;
  color: var(--cjt-accent); background: var(--cjt-bg-2);
}
.cjt-section-label {
  font-size: 11px; font-weight: 600; letter-spacing: .05em;
  color: var(--cjt-fg-2);
}
.cjt-rule { flex: 1 1 auto; height: 1px; background: var(--cjt-line); }

.cjt-stem {
  max-width: var(--cjt-measure); font-size: 15px; line-height: 1.8;
  color: var(--cjt-fg); word-break: break-word;
}
.cjt-stem .cjt-para { margin: 0 0 8px; }
.cjt-stem .cjt-para:last-child { margin-bottom: 0; }
.cjt-stem strong { font-weight: 600; }
.cjt-subq {
  max-width: var(--cjt-measure); margin-top: 8px; padding-left: 14px;
  border-left: 2px solid var(--cjt-line);
  font-size: 13px; line-height: 1.75; color: var(--cjt-fg);
}
.cjt-table { border-collapse: collapse; margin: 6px 0 10px; font-size: 13px; }
.cjt-table th, .cjt-table td {
  border: 1px solid var(--cjt-line); padding: 5px 10px; text-align: left;
  font-variant-numeric: tabular-nums;
}
.cjt-table th { background: var(--cjt-bg-1); font-weight: 600; color: var(--cjt-fg-2); }

.cjt-steps { display: flex; flex-direction: column; gap: 10px; max-width: var(--cjt-measure); }
.cjt-step { display: flex; gap: 10px; align-items: flex-start; }
.cjt-step-no {
  flex: none; width: 19px; height: 19px; margin-top: 2px; border-radius: 6px;
  display: grid; place-items: center;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px; font-weight: 600; color: var(--cjt-fg-2); background: var(--cjt-bg-2);
}
.cjt-step-text { font-size: 13px; line-height: 1.75; word-break: break-word; }
.cjt-step-text strong { font-weight: 600; }

.cjt-answer {
  max-width: var(--cjt-measure); padding: 12px 14px; border-radius: var(--cjt-radius);
  background: var(--cjt-bg-1); border: 1px solid var(--cjt-line);
  font-size: 14px; line-height: 1.75; word-break: break-word;
}
.cjt-answer .cjt-para { margin: 0 0 6px; }
.cjt-answer .cjt-para:last-child { margin-bottom: 0; }

.cjt-figures { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; max-width: var(--cjt-measure); }
.cjt-figure {
  margin: 0; border: 1px solid var(--cjt-line); border-radius: var(--cjt-radius);
  overflow: hidden; background: var(--cjt-bg-1);
}
.cjt-figure img { display: block; width: 100%; height: auto; }
.cjt-figure figcaption {
  display: flex; align-items: center; gap: 6px; padding: 7px 11px;
  font-size: 11px; color: var(--cjt-fg-2);
  border-top: 1px solid var(--cjt-line); background: var(--cjt-bg);
}

.cjt-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; padding: 40px 32px; text-align: center;
}
.cjt-empty .cjt-empty-glyph {
  width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center;
  background: var(--cjt-bg-2); color: var(--cjt-fg-2);
}
.cjt-empty h3 { margin: 0; font-size: 14px; font-weight: 600; }
.cjt-empty p {
  margin: 0; max-width: 32em; font-size: 13px; line-height: 1.7;
  color: var(--cjt-fg-2);
}
.cjt-skeleton { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; }
.cjt-skeleton i {
  display: block; height: 10px; border-radius: 5px; background: var(--cjt-bg-2);
  animation: cjt-pulse 1.3s ease-in-out infinite;
}
.cjt-skeleton i:nth-child(1) { width: 42%; }
.cjt-skeleton i:nth-child(2) { width: 88%; }
.cjt-skeleton i:nth-child(3) { width: 64%; }
@keyframes cjt-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .5; } }

/* ── 复核编辑区 ───────────────────────────────────────────────────────── */
.cjt-editor {
  margin-top: 24px; padding: 16px;
  border: 1px solid var(--cjt-line); border-radius: 12px;
  background: var(--cjt-bg-1);
}
.cjt-editor-head {
  display: flex; align-items: center; gap: 8px; margin-bottom: 14px;
  font-size: 12px; font-weight: 600; letter-spacing: .04em; color: var(--cjt-fg-2);
}
.cjt-field { display: flex; flex-direction: column; gap: 5px; }
.cjt-field > label { font-size: 11px; color: var(--cjt-fg-2); }
.cjt-input, .cjt-textarea {
  width: 100%; padding: 7px 10px;
  border: 1px solid var(--cjt-line-strong); border-radius: 8px;
  background: var(--cjt-bg); color: var(--cjt-fg);
  font: inherit; font-size: 13px; line-height: 1.6;
}
.cjt-textarea { resize: vertical; min-height: 64px; }
.cjt-input:focus, .cjt-textarea:focus {
  outline: none; border-color: var(--cjt-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--cjt-accent) 16%, transparent);
}
.cjt-grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.cjt-stack { display: flex; flex-direction: column; gap: 10px; }
.cjt-editor-foot { display: flex; align-items: center; gap: 8px; margin-top: 16px; }
.cjt-hint { font-size: 11px; color: var(--cjt-fg-2); }

/* ── 拖拽上传覆盖层 ───────────────────────────────────────────────────── */
.cjt-drop {
  position: absolute; inset: 0; z-index: 30;
  display: grid; place-items: center;
  background: var(--dsw-alias-bg-overlay, #fff);
  opacity: .96;
}
.cjt-dropbox {
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  padding: 30px 40px; border-radius: 16px;
  border: 2px dashed var(--cjt-accent);
  color: var(--cjt-fg); font-size: 13px;
}
.cjt-dropbox .cjt-hint { font-size: 12px; }

/* ── 窄窗口适配 ───────────────────────────────────────────────────────── */
@media (max-width: 1080px) {
  .cjt-rail { width: 184px; }
  .cjt-list { width: 280px; }
}
@media (max-width: 860px) {
  .cjt-rail { display: none; }
  .cjt-list { width: 260px; }
}
`;

    // ── 图标（同一套 24px 线性图标，描边 1.7） ──────────────────────────────
    const ICONS = {
      search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14', 'M16.2 16.2 20 20'],
      upload: ['M12 16V4', 'M8 8l4-4 4 4', 'M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3'],
      download: ['M12 4v11', 'M8 11l4 4 4-4', 'M4 19v.5a.5.5 0 0 0 .5.5h15a.5.5 0 0 0 .5-.5V19'],
      refresh: ['M20 12a8 8 0 1 1-2.4-5.7', 'M20 4v4.2h-4.2'],
      sparkle: ['M12 3l1.5 4.2L18 8.7l-4.5 1.5L12 14.4l-1.5-4.2L6 8.7l4.5-1.5z', 'M18 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z'],
      pencil: ['M4 20h4L19 9l-4-4L4 16z', 'M14.5 5.5l4 4'],
      trash: ['M4 7h16', 'M9.5 7V4.5h5V7', 'M6.5 7l1 13h9l1-13', 'M10.5 11v5.5', 'M13.5 11v5.5'],
      book: ['M5 4.5h8.5A3.5 3.5 0 0 1 17 8v12.5H8.5A3.5 3.5 0 0 1 5 17z', 'M8.5 4.5V20.5'],
      image: ['M4 5.5h16v13H4z', 'M4 15.5l4.5-4.5 4 4 3-3 4.5 4.5', 'M8.5 9.2a1.2 1.2 0 1 1 0-.1'],
      warn: ['M12 4.5 20.5 19.5H3.5z', 'M12 10v4', 'M12 16.8v.6'],
      check: ['M5 12.5l4.5 4.5L19 7'],
      external: ['M14 4h6v6', 'M20 4l-9.5 9.5', 'M18 14.5V20H4V6h5.5'],
      inbox: ['M4 13.5 6.5 5h11L20 13.5', 'M4 13.5h4l1 2.5h6l1-2.5h4', 'M4 13.5V19h16v-5.5'],
      layers: ['M12 3.5 3.5 7.5 12 11.5l8.5-4z', 'M3.5 12 12 16l8.5-4', 'M3.5 16.5 12 20.5l8.5-4'],
      close: ['M6 6l12 12', 'M18 6 6 18'],
    };

    function Icon(props) {
      const size = Number(props.size) || 16;
      const paths = ICONS[props.name] ?? [];
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', flex: 'none' },
      }, paths.map((d, index) => h('path', { key: index, d })));
    }

    // ── 工具函数 ────────────────────────────────────────────────────────────

    /** 同源 API 调用，统一把 `{ ok: false, error }` 变成异常。 */
    async function request(pathname, init) {
      const response = await fetch(`${API}${pathname}`, init);
      const text = await response.text();
      let data;
      try {
        data = text === '' ? {} : JSON.parse(text);
      } catch {
        throw new Error(text || `HTTP ${response.status}`);
      }
      if (data.ok === false) throw new Error(data.error || '请求失败');
      return data;
    }

    function safeFileName(name) {
      return String(name ?? 'upload').replace(/[\\/:*?"<>|]/g, '-');
    }

    function fileUrl(relative) {
      return `${API}/file?path=${encodeURIComponent(relative)}`;
    }

    /** 把 `**粗体**`、`` `等宽` `` 拆成节点。 */
    function inlineNodes(text, prefix) {
      const parts = [];
      const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
      let last = 0;
      let match;
      let index = 0;
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) parts.push(text.slice(last, match.index));
        const token = match[0];
        if (token.startsWith('**')) {
          parts.push(h('strong', { key: `${prefix}-b${index++}` }, token.slice(2, -2)));
        } else {
          parts.push(h('code', { key: `${prefix}-c${index++}` }, token.slice(1, -1)));
        }
        last = match.index + token.length;
      }
      if (last < text.length) parts.push(text.slice(last));
      return parts;
    }

    /**
     * 迷你 Markdown 渲染：空行分段、以 `|` 开头结尾的连续行成表格。
     * 题干里的表格是这次「完整保留细节」要求的一部分，直接显示比原样拼接可读得多。
     */
    function richNodes(text, keyPrefix = 'r') {
      const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
      const nodes = [];
      let buffer = [];
      let key = 0;

      const flush = () => {
        if (buffer.length === 0) return;
        const children = [];
        buffer.forEach((line, index) => {
          if (index > 0) children.push(h('br', { key: `${keyPrefix}-br${key}-${index}` }));
          children.push(...inlineNodes(line, `${keyPrefix}-${key}-${index}`));
        });
        nodes.push(h('p', { key: `${keyPrefix}-p${key++}`, className: 'cjt-para' }, children));
        buffer = [];
      };

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed === '') {
          flush();
          continue;
        }
        if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
          flush();
          const rows = [];
          while (i < lines.length) {
            const candidate = lines[i].trim();
            if (!(candidate.startsWith('|') && candidate.endsWith('|'))) break;
            if (!/^\|[\s:|-]+\|$/.test(candidate)) {
              rows.push(candidate.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()));
            }
            i += 1;
          }
          i -= 1;
          if (rows.length > 0) {
            const head = rows[0];
            const body = rows.slice(1);
            nodes.push(h('table', { key: `${keyPrefix}-t${key++}`, className: 'cjt-table' },
              h('thead', null, h('tr', null, head.map((cell, column) => h('th', { key: column }, cell)))),
              body.length === 0
                ? null
                : h('tbody', null, body.map((row, rowIndex) => h('tr', { key: rowIndex },
                  head.map((_, column) => h('td', { key: column }, row[column] ?? '')))))));
          }
          continue;
        }
        buffer.push(line);
      }
      flush();
      return nodes;
    }

    /** 是否含「识别存疑」标记，用于列表上的警示点。 */
    function hasDoubt(question) {
      return /⚠|识别存疑/.test(`${question.stem}${question.answer}`);
    }

    function draftFrom(question) {
      if (question === undefined) return undefined;
      return {
        id: question.id,
        q: question.q,
        subject: question.subject,
        chapter: question.chapter,
        topics: question.topics.join('、'),
        source: question.source,
        stem: question.stem,
        subQuestions: question.subQuestions.join('\n'),
        analysis: question.analysis.join('\n\n'),
        answer: question.answer,
      };
    }

    // ── 子组件（无 hooks，全部走 props） ────────────────────────────────────

    function Rail(props) {
      const { index, topics, filter, onPick } = props;
      const blank = { subject: '', book: '', chapter: '', section: '', topic: '' };
      const active = (next) => ['subject', 'book', 'chapter', 'section', 'topic']
        .every((key) => (filter[key] ?? '') === (next[key] ?? ''));

      const total = index.reduce((sum, item) => sum + item.count, 0);
      const build = (key, label, count, level, next, dot) => h('div', {
        key,
        className: `cjt-row${level === 0 ? '' : ` cjt-l${level}`}${active(next) ? ' cjt-on' : ''}`,
        role: 'button',
        tabIndex: 0,
        'aria-pressed': active(next),
        onClick: () => onPick(next),
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onPick(next);
          }
        },
      },
      dot === true ? h('span', { className: 'cjt-dot' }) : null,
      h('span', { className: 'cjt-label' }, label),
      h('span', { className: 'cjt-count' }, String(count)));

      const rows = [build('all', '全部错题', total, 0, { ...blank }, false)];
      for (const subject of index) {
        rows.push(build(`s:${subject.subject}`, subject.subject, subject.count, 0,
          { ...blank, subject: subject.subject }, false));
        for (const book of subject.books) {
          rows.push(build(`b:${subject.subject}/${book.book}`, book.book, book.count, 1,
            { ...blank, subject: subject.subject, book: book.book }, false));
          for (const chapter of book.chapters) {
            rows.push(build(`c:${subject.subject}/${book.book}/${chapter.chapter}`, chapter.chapter, chapter.count, 2,
              { ...blank, subject: subject.subject, book: book.book, chapter: chapter.chapter }, false));
            for (const section of chapter.sections) {
              rows.push(build(
                `t:${subject.subject}/${book.book}/${chapter.chapter}/${section.section}`,
                section.section,
                section.count,
                3,
                { ...blank, subject: subject.subject, book: book.book, chapter: chapter.chapter, section: section.section },
                true,
              ));
            }
          }
        }
      }

      const topicRows = topics.length === 0
        ? []
        : [
          h('div', { className: 'cjt-rail-head cjt-rail-head-split', key: 'topic-head' }, '知识点标签'),
          ...topics.slice(0, 40).map((item) => h('div', {
            key: `k:${item.topic}`,
            className: `cjt-row cjt-l1${active({ ...blank, topic: item.topic }) ? ' cjt-on' : ''}`,
            role: 'button',
            tabIndex: 0,
            'aria-pressed': active({ ...blank, topic: item.topic }),
            onClick: () => onPick({ ...blank, topic: item.topic }),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onPick({ ...blank, topic: item.topic });
              }
            },
          },
          h('span', { className: 'cjt-dot' }),
          h('span', { className: 'cjt-label' }, item.topic),
          h('span', { className: 'cjt-count' }, String(item.count)))),
        ];

      const body = index.length === 0 && topics.length === 0
        ? h('div', { className: 'cjt-empty', style: { padding: '24px 14px' } },
          h('p', null, '识别入库后，这里会按「学科 / 册 / 章 / 节」自动成形。'))
        : rows;

      return h('div', { className: 'cjt-rail' },
        h('div', { className: 'cjt-rail-head' }, '教材归类'),
        h('div', { className: 'cjt-rail-scroll' }, body, topicRows));
    }

    function QuestionCard(props) {
      const { question, active, checked, onSelect, onToggle } = props;
      const meta = [question.subject, question.chapter].filter((part) => part !== '').join(' · ');
      const where = [question.book, question.chapter, question.section, question.source]
        .filter((part) => part !== '').join(' · ');
      const excerpt = question.stem.replace(/\s+/g, ' ').trim();
      return h('div', {
        className: `cjt-card${active ? ' cjt-on' : ''}`,
        title: where,
        role: 'button',
        tabIndex: 0,
        'aria-current': active,
        onClick: onSelect,
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect();
          }
        },
      },
      h('div', { className: 'cjt-card-top' },
        h('span', {
          className: `cjt-check${checked ? ' cjt-on' : ''}`,
          role: 'checkbox',
          'aria-checked': checked === true,
          'aria-label': `选择第 ${question.q === '' ? question.id : question.q} 题以便批量导出或删除`,
          tabIndex: 0,
          onClick: (event) => {
            event.stopPropagation();
            onToggle();
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              event.stopPropagation();
              onToggle();
            }
          },
        }, h(Icon, { name: 'check', size: 11 })),
        h('span', { className: 'cjt-no' }, question.q === '' ? '—' : question.q),
        h('span', { className: 'cjt-meta' }, meta),
        hasDoubt(question)
          ? h('span', { style: { marginLeft: 'auto', color: 'var(--cjt-warn)', display: 'inline-flex' }, title: '含识别存疑' },
            h(Icon, { name: 'warn', size: 13 }))
          : null),
      h('div', { className: 'cjt-excerpt' }, excerpt === '' ? '（空题干）' : excerpt),
      question.topics.length === 0
        ? null
        : h('div', { className: 'cjt-tags' },
          question.topics.slice(0, 3).map((topic) => h('span', { className: 'cjt-chip', key: topic }, topic)),
          question.topics.length > 3
            ? h('span', { className: 'cjt-chip' }, `+${question.topics.length - 3}`)
            : null));
    }

    function Section(props) {
      return h('section', { className: 'cjt-section' },
        h('div', { className: 'cjt-section-head' },
          h('span', { className: 'cjt-badge' }, props.index),
          h('span', { className: 'cjt-section-label' }, props.label),
          h('span', { className: 'cjt-rule' })),
        props.children);
    }

    function Editor(props) {
      const { draft, busy, onChange, onSave, onCancel, relPath } = props;
      if (draft === undefined) return null;
      const field = (label, key, options = {}) => h('div', { className: 'cjt-field' },
        h('label', { htmlFor: `cjt-${key}` }, label),
        options.textarea === true
          ? h('textarea', {
            id: `cjt-${key}`,
            className: 'cjt-textarea',
            rows: options.rows ?? 4,
            value: draft[key],
            onChange: (event) => onChange(key, event.target.value),
          })
          : h('input', {
            id: `cjt-${key}`,
            className: 'cjt-input',
            value: draft[key],
            onChange: (event) => onChange(key, event.target.value),
          }));

      return h('div', { className: 'cjt-editor' },
        h('div', { className: 'cjt-editor-head' },
          h(Icon, { name: 'pencil', size: 14 }), '复核与修改',
          h('button', {
            className: 'cjt-btn cjt-primary',
            type: 'button',
            style: { marginLeft: 'auto', height: '26px' },
            disabled: busy !== '',
            onClick: onSave,
          }, busy === 'save' ? '保存中…' : h(Icon, { name: 'check', size: 14 }), busy === 'save' ? '' : '保存修改')),
        h('div', { className: 'cjt-grid2' },
          field('题号', 'q'),
          field('出处', 'source'),
          field('学科', 'subject'),
          field('章节', 'chapter')),
        h('div', { className: 'cjt-stack', style: { marginTop: '10px' } },
          field('知识点（用「、」或逗号分隔）', 'topics'),
          field('题干（逐字保留；支持 **粗体**、| 表格 |、$公式$）', 'stem', { textarea: true, rows: 7 }),
          field('小问（每行一个）', 'subQuestions', { textarea: true, rows: 2 }),
          field('解题过程（空行分段）', 'analysis', { textarea: true, rows: 6 }),
          field('答案', 'answer', { textarea: true, rows: 3 })),
        h('div', { className: 'cjt-editor-foot' },
          h('button', {
            className: 'cjt-btn cjt-primary',
            type: 'button',
            disabled: busy !== '',
            onClick: onSave,
          }, busy === 'save' ? h('span', { className: 'cjt-spin' }) : h(Icon, { name: 'check', size: 14 }),
          busy === 'save' ? '保存中…' : '保存修改'),
          h('button', { className: 'cjt-btn', type: 'button', disabled: busy !== '', onClick: onCancel }, '收起'),
          h('span', { className: 'cjt-hint', title: relPath }, '改动会直接写回工作区文件')));
    }

    function Detail(props) {
      const { question, draft, editing, busy, paneRef, onEdit, onCancel, onChange, onSave, onRemove } = props;
      if (question === undefined) {
        return h('div', { className: 'cjt-detail cjt-detail-empty' },
          h('div', { className: 'cjt-empty' },
            h('div', { className: 'cjt-empty-glyph' }, h(Icon, { name: 'book', size: 22 })),
            h('h3', null, '选一道错题'),
            h('p', null, '左边列出的是按知识点归集后的错题，点一条即可看到完整题干、解题过程与原卷原件。')));
      }
      const meta = [question.subject, question.book, question.chapter, question.section, question.source]
        .filter((part) => part !== '').join(' · ');
      return h('div', { className: 'cjt-detail', ref: paneRef },
        h('div', { className: 'cjt-detail-inner' },
          h('div', { className: 'cjt-dhead' },
            h('span', { className: 'cjt-dno' }, question.q === '' ? '—' : question.q),
            h('div', { className: 'cjt-dtitle' }, h('span', { className: 'cjt-dmeta' }, meta)),
            h('div', { className: 'cjt-dactions' },
              h('button', {
                className: 'cjt-btn cjt-ghost cjt-icon',
                type: 'button',
                title: editing ? '收起编辑' : '编辑这道题',
                'aria-label': editing ? '收起编辑' : '编辑这道题',
                onClick: editing ? onCancel : onEdit,
              }, h(Icon, { name: editing ? 'close' : 'pencil', size: 15 })),
              h('button', {
                className: 'cjt-btn cjt-ghost cjt-icon cjt-danger',
                type: 'button',
                title: '删除这道题',
                'aria-label': '删除这道题',
                disabled: busy !== '',
                onClick: onRemove,
              }, busy === 'delete' ? h('span', { className: 'cjt-spin' }) : h(Icon, { name: 'trash', size: 15 })))),

          /* 编辑表单必须紧跟标题：否则会被下方整页原卷图顶到滚动区最底部，
             点「编辑」后看不到任何反馈，看起来就像按钮失效。 */
          editing
            ? h(Editor, {
              draft,
              busy,
              relPath: question.relPath,
              onChange: (key, value) => onChange({ ...draft, [key]: value }),
              onSave,
              onCancel,
            })
            : null,

          question.topics.length === 0
            ? null
            : h('div', { className: 'cjt-dtags' },
              question.topics.map((topic) => h('span', { className: 'cjt-chip cjt-accent', key: topic }, topic))),

          h(Section, { index: '1', label: '原题' },
            h('div', { className: 'cjt-stem' }, richNodes(question.stem, 'stem')),
            question.subQuestions.map((item, index) => h('div', { className: 'cjt-subq', key: index },
              richNodes(item, `sub${index}`)))),

          h(Section, { index: '2', label: '解题过程' },
            question.analysis.length === 0
              ? h('div', { className: 'cjt-hint' }, '（尚未补解题思路）')
              : h('div', { className: 'cjt-steps' },
                question.analysis.map((step, index) => h('div', { className: 'cjt-step', key: index },
                  h('span', { className: 'cjt-step-no' }, String(index + 1)),
                  h('div', { className: 'cjt-step-text' }, richNodes(step, `step${index}`)))))),

          h(Section, { index: '3', label: '答案' },
            h('div', { className: 'cjt-answer' },
              question.answer === ''
                ? h('span', { className: 'cjt-hint' }, '（尚未补答案）')
                : richNodes(question.answer, 'answer'))),

          question.figures.length === 0
            ? null
            : h(Section, { index: '4', label: '原卷原件' },
              h('div', { className: 'cjt-figures' },
                question.figures.map((figure) => h('figure', { className: 'cjt-figure', key: figure.path },
                  h('a', { href: fileUrl(figure.path), target: '_blank', rel: 'noreferrer' },
                    h('img', { src: fileUrl(figure.path), alt: figure.caption || '原卷图' })),
                  h('figcaption', null,
                    h(Icon, { name: 'image', size: 13 }),
                    h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      figure.caption || figure.path),
                    h('span', { style: { marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '4px' } },
                      h(Icon, { name: 'external', size: 12 }), '打开原图')))))),

          h('div', { style: { marginTop: '18px' } },
            h('button', { className: 'cjt-btn', type: 'button', onClick: onEdit },
              h(Icon, { name: 'pencil', size: 14 }), editing ? '编辑中（可在上方修改）' : '复核 / 修改这道题'),
            h('span', { className: 'cjt-hint', style: { marginLeft: '10px' } }, question.relPath))));
    }

    // ── 面板 ────────────────────────────────────────────────────────────────

    function Panel() {
      const [state, setState] = useState(undefined);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [busy, setBusy] = useState('');
      const [query, setQuery] = useState('');
      const [filter, setFilter] = useState({ subject: '', book: '', chapter: '', section: '', topic: '' });
      const [selectedId, setSelectedId] = useState('');
      const [editing, setEditing] = useState(false);
      const [draft, setDraft] = useState(undefined);
      const [dragging, setDragging] = useState(false);
      const [picked, setPicked] = useState([]);
      // 批量删除是破坏性操作：第一次点只是展开确认条，再点「确认删除」才真正删。
      const [confirming, setConfirming] = useState(false);
      const [from, setFrom] = useState('');
      const [to, setTo] = useState('');
      const fileInput = useRef(null);
      const paneRef = useRef(null);
      // 同步锁：setBusy 是异步的，快速连点「导出 PDF」时按钮还没禁用，
      // 第二次点击会再触发一次导出，产生一堆重复的 PDF。用 ref 立即拦住重入。
      const exportingRef = useRef(false);

      const load = useCallback(async () => {
        setBusy('load');
        setError('');
        try {
          const data = await request('/state');
          setState(data);
          setSelectedId((current) => (data.questions.some((item) => item.id === current) ? current : ''));
          setPicked((current) => current.filter((id) => data.questions.some((item) => item.id === id)));
        } catch (failure) {
          setError(String(failure.message ?? failure));
        } finally {
          setBusy('');
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      const questions = state?.questions ?? [];

      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return questions.filter((item) => {
          if (filter.subject !== '' && item.subject !== filter.subject) return false;
          if (filter.book !== '' && item.book !== filter.book) return false;
          if (filter.chapter !== '') {
            const chapter = item.chapter === '' ? '（未分类）' : item.chapter;
            if (chapter !== filter.chapter) return false;
          }
          if (filter.section !== '' && item.section !== filter.section) return false;
          if (filter.topic !== '' && !item.topics.includes(filter.topic)) return false;
          if (from !== '' || to !== '') {
            const stamp = Date.parse(item.createdAt);
            if (!Number.isNaN(stamp)) {
              if (from !== '') {
                const start = Date.parse(`${from}T00:00:00`);
                if (!Number.isNaN(start) && stamp < start) return false;
              }
              if (to !== '') {
                const end = Date.parse(`${to}T23:59:59.999`);
                if (!Number.isNaN(end) && stamp > end) return false;
              }
            }
          }
          if (needle !== '') {
            const haystack = [
              item.stem, item.answer, item.source, item.chapter, item.section, item.book, item.subject,
              ...item.topics, ...item.subQuestions, ...item.analysis,
            ].join('\n').toLowerCase();
            if (!haystack.includes(needle)) return false;
          }
          return true;
        });
      }, [questions, filter, query, from, to]);

      const selected = filtered.find((item) => item.id === selectedId) ?? filtered[0];

      useEffect(() => {
        setDraft(draftFrom(selected));
        setEditing(false);
      }, [selected?.id, selected?.updatedAt]);

      // 点「编辑」后把右栏滚回顶部，让刚展开的表单立刻出现在视野里。
      useEffect(() => {
        if (editing && paneRef.current) paneRef.current.scrollTop = 0;
      }, [editing]);

      const pickFilter = useCallback((next) => {
        setFilter(next);
        setSelectedId('');
      }, []);

      /** 勾选/取消一道题（用于批量导出、批量删除）。 */
      const togglePicked = useCallback((id) => {
        // 选择变了，之前弹出的删除确认条就不再对应当前这批题，先收起来。
        setConfirming(false);
        setPicked((current) => (current.includes(id)
          ? current.filter((item) => item !== id)
          : [...current, id]));
      }, []);

      /** 把当前筛选结果全部加入选择。 */
      const pickAllFiltered = useCallback(() => {
        setConfirming(false);
        setPicked((current) => {
          const merged = new Set(current);
          for (const item of filtered) merged.add(item.id);
          return [...merged];
        });
      }, [filtered]);

      const clearPicked = useCallback(() => {
        setConfirming(false);
        setPicked([]);
      }, []);

      const upload = useCallback(async (files) => {
        const list = [...files];
        if (list.length === 0) return;
        setBusy('upload');
        setNotice('');
        setError('');
        try {
          let last;
          for (const file of list) {
            last = await request(
              `/upload?name=${encodeURIComponent(safeFileName(file.name))}&recognize=1`,
              { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' } },
            );
          }
          setNotice(`${list.length} 个文件已存进收件箱。${last?.note ?? ''}`);
          await load();
        } catch (failure) {
          setError(String(failure.message ?? failure));
        } finally {
          setBusy('');
        }
      }, [load]);

      const recognize = useCallback(async () => {
        setBusy('recognize');
        setNotice('');
        setError('');
        try {
          const data = await request('/recognize', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          const ocr = Array.isArray(data.ocr) ? data.ocr : [];
          const done = ocr.filter((item) => item.ok === true);
          const failedOcr = ocr.filter((item) => item.ok !== true);
          const ocrNote = ocr.length === 0
            ? ''
            : done.length === ocr.length
              ? `，本地 OCR 已识别 ${done.reduce((sum, item) => sum + item.lines, 0)} 段文字`
              : failedOcr.length === ocr.length
                ? '，本地 OCR 未成功（将直接读原图）'
                : `，本地 OCR ${done.length}/${ocr.length} 份成功`;
          setNotice(`${data.note ?? `已交给模型识别 ${data.count ?? 0} 份原卷`}${ocrNote}。`);
        } catch (failure) {
          setError(String(failure.message ?? failure));
        } finally {
          setBusy('');
        }
      }, []);

      const save = useCallback(async () => {
        if (draft === undefined) return;
        setBusy('save');
        setNotice('');
        setError('');
        try {
          await request('/save', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              ...draft,
              topics: draft.topics.split(/[、,，\s]+/).filter((item) => item !== ''),
              subQuestions: draft.subQuestions.split('\n').filter((line) => line.trim() !== ''),
              analysis: draft.analysis.split(/\n\s*\n/).filter((line) => line.trim() !== ''),
            }),
          });
          setNotice('已写回工作区文件。');
          setEditing(false);
          await load();
        } catch (failure) {
          setError(String(failure.message ?? failure));
        } finally {
          setBusy('');
        }
      }, [draft, load]);

      const remove = useCallback(async () => {
        if (selected === undefined) return;
        setBusy('delete');
        setError('');
        setNotice('');
        try {
          await request('/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: selected.id }),
          });
          setSelectedId('');
          setEditing(false);
          setNotice('已删除。');
          await load();
        } catch (failure) {
          setError(String(failure.message ?? failure));
        } finally {
          setBusy('');
        }
      }, [selected, load]);

      /** 批量删除已勾选的题（连同各自的配图目录）。 */
      const removeMany = useCallback(async () => {
        if (picked.length === 0) return;
        const ids = [...picked];
        setBusy('deleteMany');
        setError('');
        setNotice('');
        try {
          const data = await request('/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ids }),
          });
          const deleted = Number(data.deleted ?? 0);
          setPicked([]);
          setSelectedId('');
          setEditing(false);
          setConfirming(false);
          setNotice(deleted === ids.length
            ? `已删除 ${deleted} 道错题。`
            : `已删除 ${deleted} 道；${ids.length - deleted} 道未找到（可能已被删除）。`);
          await load();
        } catch (failure) {
          setError(String(failure.message ?? failure));
        } finally {
          setBusy('');
        }
      }, [picked, load]);

      const runExport = useCallback(async (split) => {
        // 只导手动勾选的题：未勾选任何题时导出数量为 0，不做任何事。
        if (picked.length === 0) return;
        // 同步重入锁：一旦有导出在跑，后续点击直接忽略，杜绝重复导出。
        if (exportingRef.current) return;
        exportingRef.current = true;
        setBusy(split ? 'split' : 'export');
        setNotice('');
        setError('');
        const target = { ids: picked };
        try {
          const data = await request('/export', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              ...target,
              split,
              format: 'pdf',
              // 不把「已选 N 道 / 关键词 / 日期」等导出记录写进文档页眉：
              // 文档交付后这些筛选痕迹没有意义，反而干扰阅读。
            }),
          });
          const paths = data.outputs.map((output) => output.path);
          const pdfs = data.outputs.filter((output) => output.format === 'pdf');
          const warnings = Array.isArray(data.warnings) ? data.warnings : [];
          const head = pdfs.length === 0
            ? `已导出 ${data.count} 道题：${paths.join('  ·  ')}`
            : pdfs.length === 1
              ? `已导出 ${data.count} 道题，PDF：${pdfs[0].path}`
              : `已导出 ${data.count} 道题，${pdfs.length} 份 PDF 在：${pdfs[0].path.replace(/[\\/][^\\/]+$/, '')}`;
          setNotice(warnings.length === 0 ? head : `${head}　⚠ ${warnings.join('；')}`);
          // 导出后清空勾选：下一次导出只导本次新选的题，不带上历史勾选。
          setPicked([]);
        } catch (failure) {
          setError(String(failure.message ?? failure));
        } finally {
          setBusy('');
          exportingRef.current = false;
        }
      }, [filter, query, picked, from, to]);

      const inboxCount = state?.inbox?.length ?? 0;
      // 导出数量只认手动勾选：未勾选任何题时为 0，按钮禁用。
      const exportCount = picked.length;
      const canExport = busy === '' && exportCount > 0;
      const total = state?.total ?? 0;
      const topicCount = (state?.topics ?? []).length;
      const sectionCount = (state?.index ?? []).reduce(
        (sum, subject) => sum + subject.books.reduce(
          (inner, book) => inner + book.chapters.reduce((deep, chapter) => deep + chapter.sections.length, 0),
          0,
        ),
        0,
      );

      const banner = error !== '' || notice !== ''
        ? h('div', { className: `cjt-banner${error !== '' ? ' cjt-err' : ' cjt-ok'}` },
          h(Icon, { name: error !== '' ? 'warn' : 'check', size: 14 }),
          h('span', { className: 'cjt-banner-text', title: error || notice }, error || notice),
          h('button', {
            className: 'cjt-btn cjt-ghost cjt-icon',
            type: 'button',
            'aria-label': '关闭提示',
            onClick: () => {
              setError('');
              setNotice('');
            },
          }, h(Icon, { name: 'close', size: 14 })))
        : null;

      const body = h('div', { className: 'cjt-body' },
        h(Rail, { index: state?.index ?? [], topics: state?.topics ?? [], filter, onPick: pickFilter }),
        h('div', { className: 'cjt-list' },
          h('div', { className: 'cjt-searchwrap' },
            h('div', { className: 'cjt-search' },
              h('span', { className: 'cjt-glyph' }, h(Icon, { name: 'search', size: 15 })),
              h('input', {
                type: 'search',
                placeholder: '搜索题干、知识点、出处…',
                value: query,
                'aria-label': '搜索错题',
                onChange: (event) => setQuery(event.target.value),
              }))),
          h('div', { className: 'cjt-filterbar' },
            h('span', null, '入库'),
            h('input', {
              className: 'cjt-date',
              type: 'date',
              value: from,
              'aria-label': '入库起始日期',
              onChange: (event) => setFrom(event.target.value),
            }),
            h('span', null, '至'),
            h('input', {
              className: 'cjt-date',
              type: 'date',
              value: to,
              'aria-label': '入库结束日期',
              onChange: (event) => setTo(event.target.value),
            }),
            h('span', { style: { marginLeft: 'auto' } }),
            h('button', {
              className: 'cjt-linkbtn',
              type: 'button',
              disabled: filtered.length === 0,
              onClick: pickAllFiltered,
            }, `全选 ${filtered.length}`),
            picked.length > 0
              ? h('button', { className: 'cjt-linkbtn', type: 'button', onClick: clearPicked }, `清空 ${picked.length}`)
              : null),
          h('div', { className: 'cjt-items' },
            busy === 'load' && state === undefined
              ? [0, 1, 2].map((key) => h('div', { className: 'cjt-skeleton', key }, h('i'), h('i'), h('i')))
              : filtered.length === 0
                ? h('div', { className: 'cjt-empty', style: { height: 'auto', padding: '40px 20px' } },
                  h('div', { className: 'cjt-empty-glyph' }, h(Icon, { name: 'book', size: 20 })),
                  h('h3', null, total === 0 ? '还没有错题' : '没有匹配的题目'),
                  h('p', null, total === 0
                    ? '把试卷截图、PDF 或 Markdown 拖进这个面板，模型会逐题识别入库。'
                    : '换个关键词，或点左侧「全部错题」重新开始。'))
                : filtered.map((item) => h(QuestionCard, {
                  key: item.id,
                  question: item,
                  active: selected?.id === item.id,
                  checked: picked.includes(item.id),
                  onSelect: () => setSelectedId(item.id),
                  onToggle: () => togglePicked(item.id),
                })))),
        h(Detail, {
          question: selected,
          draft,
          editing,
          busy,
          paneRef,
          onEdit: () => {
            setEditing(true);
            if (paneRef.current) paneRef.current.scrollTop = 0;
          },
          onCancel: () => {
            setEditing(false);
            setDraft(draftFrom(selected));
          },
          onChange: setDraft,
          onSave: save,
          onRemove: remove,
        }));

      return h('div', {
        className: 'cjt-root',
        onDragOver: (event) => {
          event.preventDefault();
          setDragging(true);
        },
        onDragLeave: (event) => {
          if (event.currentTarget.contains(event.relatedTarget)) return;
          setDragging(false);
        },
        onDrop: (event) => {
          event.preventDefault();
          setDragging(false);
          upload(event.dataTransfer?.files ?? []);
        },
      },
      h('style', null, CSS),

      h('div', { className: 'cjt-topbar' },
        h('div', { className: 'cjt-title' },
          h('span', { className: 'cjt-glyph' }, h(Icon, { name: 'book', size: 17 })),
          '错题本'),
        h('span', { className: 'cjt-sep' }),
        h('div', { className: 'cjt-stats' },
          h('span', null, `${total} 道`),
          h('span', { style: { opacity: .5 } }, '/'),
          h('span', { title: '已覆盖的教材节数' }, `覆盖 ${sectionCount} 节`),
          h('span', { style: { opacity: .5 } }, '/'),
          h('span', { title: '知识点标签数' }, `${topicCount} 个标签`)),
        h('div', { className: 'cjt-actions' },
          h('button', {
            className: 'cjt-btn cjt-ghost cjt-icon',
            type: 'button',
            title: '刷新',
            'aria-label': '刷新',
            disabled: busy !== '',
            onClick: load,
          }, busy === 'load' ? h('span', { className: 'cjt-spin' }) : h(Icon, { name: 'refresh', size: 15 })),
          h('button', {
            className: 'cjt-btn',
            type: 'button',
            disabled: busy === 'upload',
            onClick: () => fileInput.current?.click(),
          }, busy === 'upload' ? h('span', { className: 'cjt-spin' }) : h(Icon, { name: 'upload', size: 15 }),
          busy === 'upload' ? '上传中…' : '上传原卷'),
          h('input', {
            ref: fileInput,
            type: 'file',
            multiple: true,
            accept: 'image/*,.pdf,.md,.markdown,.txt',
            style: { display: 'none' },
            onChange: (event) => {
              upload(event.target.files ?? []);
              event.target.value = '';
            },
          }),
          h('button', {
            className: 'cjt-btn cjt-danger',
            type: 'button',
            disabled: busy !== '' || picked.length === 0,
            title: '删除左栏中已勾选的题（连同配图，不可恢复）',
            onClick: () => setConfirming(true),
          }, h(Icon, { name: 'trash', size: 15 }), `删除选中（${picked.length}）`),
          h('button', {
            className: 'cjt-btn',
            type: 'button',
            disabled: !canExport,
            onClick: () => runExport(true),
          }, busy === 'split' ? h('span', { className: 'cjt-spin' }) : h(Icon, { name: 'layers', size: 15 }),
          busy === 'split' ? '分册排版中…' : '按知识点分册'),
          h('button', {
            className: 'cjt-btn cjt-primary',
            type: 'button',
            disabled: !canExport,
            title: '先勾选要导出的题，未勾选时导出数量为 0',
            onClick: () => runExport(false),
          }, busy === 'export' ? h('span', { className: 'cjt-spin' }) : h(Icon, { name: 'download', size: 15 }),
          busy === 'export'
            ? 'PDF 排版中…'
            : `导出 PDF（${exportCount}）`))),

      banner,

      // 批量删除确认条：勾选的题会连同配图一起永久删除，必须再点一次「确认删除」。
      confirming && picked.length > 0
        ? h('div', { className: 'cjt-banner cjt-err' },
          h(Icon, { name: 'warn', size: 14 }),
          h('span', { className: 'cjt-banner-text' },
            `将永久删除勾选的 ${picked.length} 道错题及其配图，无法恢复。`),
          h('button', {
            className: 'cjt-btn cjt-danger',
            type: 'button',
            disabled: busy !== '',
            onClick: removeMany,
          }, busy === 'deleteMany' ? h('span', { className: 'cjt-spin' }) : h(Icon, { name: 'trash', size: 14 }),
          busy === 'deleteMany' ? '删除中…' : '确认删除'),
          h('button', {
            className: 'cjt-btn',
            type: 'button',
            disabled: busy !== '',
            onClick: () => setConfirming(false),
          }, '取消'))
        : null,

      inboxCount === 0
        ? null
        : h('div', { className: 'cjt-banner' },
          h(Icon, { name: 'inbox', size: 14 }),
          h('span', { className: 'cjt-banner-text' },
            `收件箱还有 ${inboxCount} 个原件没识别：${state.inbox.slice(0, 2).map((file) => file.name).join('、')}${inboxCount > 2 ? ' 等' : ''}`),
          h('button', {
            className: 'cjt-btn',
            type: 'button',
            disabled: busy !== '',
            onClick: recognize,
          }, busy === 'recognize' ? h('span', { className: 'cjt-spin' }) : h(Icon, { name: 'sparkle', size: 14 }),
          busy === 'recognize' ? '本地 OCR 中…' : '交给模型识别')),

      body,

      dragging
        ? h('div', { className: 'cjt-drop' },
          h('div', { className: 'cjt-dropbox' },
            h(Icon, { name: 'upload', size: 26 }),
            h('strong', null, '松开即可上传'),
            h('span', { className: 'cjt-hint' }, '图片、PDF、Markdown 都行；上传后自动交给模型识别')))
        : null);
    }

    // ── 注册 ────────────────────────────────────────────────────────────────

    function CuotijiIcon(props) {
      const size = Number(props?.size) || 18;
      const active = props?.active === true;
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        'aria-hidden': true,
        style: { display: 'block' },
      },
      h('path', {
        d: 'M6 3.5h9.5A2.5 2.5 0 0 1 18 6v12a2.5 2.5 0 0 1-2.5 2.5H6z',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: active ? 1.9 : 1.6,
        strokeLinejoin: 'round',
        opacity: active ? 1 : 0.86,
      }),
      h('path', { d: 'M6 3.5h2.2v17H6z', fill: 'currentColor', opacity: 0.16 }),
      h('path', {
        d: 'M9.6 8.2h5.6M9.6 12h5.6M9.6 15.8h3.4',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeLinecap: 'round',
        opacity: 0.55,
      }),
      h('path', {
        d: 'M10.1 6.6l3.4 2.4M13.5 6.6l-3.4 2.4',
        stroke: 'var(--dsw-alias-state-error-primary, #d64545)',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
      }),
      h('path', {
        d: 'M14.2 16.2l1.5 1.5 2.6-2.9',
        fill: 'none',
        stroke: 'var(--dsw-alias-state-success-primary, #1f9d6b)',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'cuotiji',
          order: 20,
          label: '错题本',
        }, CuotijiIcon));

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'cuotiji',
        }, Panel));
      },
    };
  },
});
