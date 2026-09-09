/* Jobseeker v3 chat client */
(function () {
  "use strict";

  const clientId = (localStorage.getItem("jsv2-client") || crypto.randomUUID());
  localStorage.setItem("jsv2-client", clientId);

  const messagesEl = document.getElementById("messages");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("sendBtn");
  const resetBtn = document.getElementById("resetBtn");
  const modelSelect = document.getElementById("modelSelect");
  const resizeHandle = document.getElementById("resizeHandle");
  const composerResizeHandle = document.getElementById("composerResizeHandle");
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  const knowledgeList = document.getElementById("knowledgeList");
  const promptList = document.getElementById("promptList");
  const appList = document.getElementById("appList");
  const themeToggle = document.getElementById("themeToggle");

  let busy = false;

  const savedTheme = localStorage.getItem("jsv2-theme");
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  let darkTheme = savedTheme ? savedTheme === "dark" : Boolean(prefersDark);
  function applyTheme() {
    document.body.classList.toggle("dark-theme", darkTheme);
    themeToggle.textContent = darkTheme ? "☀ Light" : "☾ Dark";
    themeToggle.title = darkTheme ? "Switch to light theme" : "Switch to dark theme";
  }
  applyTheme();
  themeToggle.addEventListener("click", () => {
    darkTheme = !darkTheme;
    localStorage.setItem("jsv2-theme", darkTheme ? "dark" : "light");
    applyTheme();
  });

  const SIDEBAR_MIN = 240;
  const SIDEBAR_MAX = 1040;
  const savedSidebarWidth = Number(localStorage.getItem("jsv3-sidebar-width"));
  if (Number.isFinite(savedSidebarWidth) && savedSidebarWidth >= SIDEBAR_MIN && savedSidebarWidth <= SIDEBAR_MAX) {
    document.documentElement.style.setProperty("--sidebar-width", `${savedSidebarWidth}px`);
  }

  let resizing = false;
  resizeHandle.addEventListener("pointerdown", (event) => {
    resizing = true;
    resizeHandle.classList.add("active");
    resizeHandle.setPointerCapture(event.pointerId);
    document.body.style.userSelect = "none";
  });
  resizeHandle.addEventListener("pointermove", (event) => {
    if (!resizing) return;
    const width = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, event.clientX));
    document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
  });
  resizeHandle.addEventListener("pointerup", (event) => {
    if (!resizing) return;
    resizing = false;
    resizeHandle.classList.remove("active");
    resizeHandle.releasePointerCapture(event.pointerId);
    document.body.style.userSelect = "";
    const width = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width"), 10);
    localStorage.setItem("jsv3-sidebar-width", String(width));
  });
  resizeHandle.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width"), 10);
    const next = Math.max(
      SIDEBAR_MIN,
      Math.min(SIDEBAR_MAX, current + (event.key === "ArrowRight" ? 16 : -16)),
    );
    document.documentElement.style.setProperty("--sidebar-width", `${next}px`);
    localStorage.setItem("jsv3-sidebar-width", String(next));
  });

 const COMPOSER_MIN = 44;
  const COMPOSER_MAX = 520;
  const savedComposerHeight = Number(localStorage.getItem("jsv2-composer-height"));
  if (Number.isFinite(savedComposerHeight) && savedComposerHeight >= COMPOSER_MIN && savedComposerHeight <= COMPOSER_MAX) {
    inputEl.style.height = `${savedComposerHeight}px`;
  }

  let resizingComposer = false;
  composerResizeHandle.addEventListener("pointerdown", (event) => {
    resizingComposer = true;
    composerResizeHandle.classList.add("active");
    composerResizeHandle.setPointerCapture(event.pointerId);
    document.body.style.userSelect = "none";
  });
  composerResizeHandle.addEventListener("pointermove", (event) => {
    if (!resizingComposer) return;
    const height = Math.max(COMPOSER_MIN, Math.min(COMPOSER_MAX, window.innerHeight - event.clientY));
    inputEl.style.height = `${height}px`;
  });
  composerResizeHandle.addEventListener("pointerup", (event) => {
    if (!resizingComposer) return;
    resizingComposer = false;
    composerResizeHandle.classList.remove("active");
    composerResizeHandle.releasePointerCapture(event.pointerId);
    document.body.style.userSelect = "";
    localStorage.setItem("jsv2-composer-height", String(inputEl.getBoundingClientRect().height));
  });
  composerResizeHandle.addEventListener("keydown", (event) => {
    if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const current = inputEl.getBoundingClientRect().height;
    const next = Math.max(COMPOSER_MIN, Math.min(COMPOSER_MAX, current + (event.key === "ArrowUp" ? 24 : -24)));
    inputEl.style.height = `${next}px`;
    localStorage.setItem("jsv2-composer-height", String(next));
  });

  const appEl = document.getElementById("app");
  const traceToggle = document.getElementById("traceToggle");
  const traceResizeHandle = document.getElementById("traceResizeHandle");
  const traceBody = document.getElementById("traceBody");
  const traceClearBtn = document.getElementById("traceClearBtn");
  const TRACE_MIN = 280;
  const TRACE_MAX = 1240;
  const savedTraceWidth = Number(localStorage.getItem("jsv3-trace-width"));
  if (Number.isFinite(savedTraceWidth) && savedTraceWidth >= TRACE_MIN && savedTraceWidth <= TRACE_MAX) {
    document.documentElement.style.setProperty("--trace-width", `${savedTraceWidth}px`);
  }
  let traceSnapshot = { runs: [] };
  let traceSource = null;
  if (localStorage.getItem("jsv2-trace-open") === "1") appEl.classList.add("trace-open");
  traceToggle.addEventListener("click", () => {
    const open = appEl.classList.toggle("trace-open");
    localStorage.setItem("jsv2-trace-open", open ? "1" : "0");
    if (open) { connectTrace(); renderTrace(); }
  });
  traceClearBtn.addEventListener("click", async () => {
    await fetch("/api/trace/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId }) });
    traceSnapshot = { runs: [] };
    renderTrace();
  });
  function connectTrace() {
    if (traceSource) return;
    traceSource = new EventSource(`/api/trace/stream?clientId=${encodeURIComponent(clientId)}`);
    traceSource.addEventListener("message", (event) => {
      try { traceSnapshot = JSON.parse(event.data).snapshot || { runs: [] }; renderTrace(); } catch { /* ignore malformed events */ }
    });
  }
  function traceSection(title, content, open) {
    const details = document.createElement("details");
    details.className = "trace-section";
    details.open = open;
    details.innerHTML = `<summary>${esc(title)}</summary><pre class="trace-${title === "Prompt sent" ? "prompt" : "response"}">${esc(content)}</pre>`;
    return details;
  }
  function renderTrace() {
    traceBody.innerHTML = "";
    const runs = traceSnapshot.runs || [];
    if (!runs.length) { traceBody.innerHTML = '<div class="trace-empty">No LLM calls yet. Send a message to see the trace.</div>'; return; }
    runs.forEach((run) => {
      const div = document.createElement("div");
      div.className = `trace-run ${esc(run.status)}`;
      const duration = run.durationMs == null ? "" : `${run.durationMs < 1000 ? run.durationMs + "ms" : (run.durationMs / 1000).toFixed(1) + "s"}`;
      div.innerHTML = `<div class="trace-run-header"><span class="trace-run-label">${esc(run.label || "LLM call")}</span><span class="trace-run-status ${esc(run.status)}">${run.status === "running" ? "running…" : run.status}</span><span class="trace-run-meta">${esc([run.model, duration].filter(Boolean).join(" · "))}</span></div>${run.error ? `<div class="trace-error">⚠️ ${esc(run.error)}</div>` : ""}`;
      if (run.prompt) div.appendChild(traceSection("Prompt sent", run.prompt, false));
      if (run.finalText) div.appendChild(traceSection("Response", run.finalText, true));
      traceBody.appendChild(div);
    });
    traceBody.scrollTop = traceBody.scrollHeight;
  }
  traceResizeHandle.addEventListener("pointerdown", (event) => {
    traceResizeHandle.setPointerCapture(event.pointerId);
    traceResizeHandle.classList.add("active");
    traceResizeHandle.onpointermove = (move) => {
      const width = Math.max(TRACE_MIN, Math.min(TRACE_MAX, window.innerWidth - move.clientX));
      document.documentElement.style.setProperty("--trace-width", `${width}px`);
    };
    traceResizeHandle.onpointerup = () => {
      traceResizeHandle.classList.remove("active");
      traceResizeHandle.onpointermove = null;
      localStorage.setItem("jsv3-trace-width", getComputedStyle(document.documentElement).getPropertyValue("--trace-width").trim().replace("px", ""));
    };
  });
  if (appEl.classList.contains("trace-open")) connectTrace();

  // ── Helpers ─────────────────────────────────────────────
  function setStatus(text, cls) {
    statusText.textContent = text;
    statusDot.className = "status-dot" + (cls ? " " + cls : "");
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function renderMd(text) {
    try {
      return window.marked ? marked.parse(esc(text), { breaks: true }) : esc(text);
    } catch {
      return esc(text);
    }
  }

  function addMsg(html, cls) {
    const div = document.createElement("div");
    div.className = "msg " + cls;
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerHTML = html;
    div.appendChild(bubble);
    messagesEl.appendChild(div);
    scrollBottom();
    return div;
  }

  function addBot(text) { addMsg(renderMd(text), "bot"); }
  function addUser(text) { addMsg(esc(text).replace(/\n/g, "<br>"), "user"); }

  function addTyping() {
    const div = document.createElement("div");
    div.className = "msg bot typing-msg";
    div.innerHTML = '<div class="bubble"><span class="typing"><span></span><span></span><span></span></span></div>';
    messagesEl.appendChild(div);
    scrollBottom();
    return div;
  }

  function scrollBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function scoreColor(score) {
    if (score >= 75) return "#12a150";
    if (score >= 50) return "#d97e00";
    return "#d64545";
  }

  // ── Response renderers ──────────────────────────────────
  function verdictBadge(v) {
    const map = {
      yes: ["good", "Yes"],
      partial: ["warn", "Partial"],
      no: ["bad", "No"],
      uncertain: ["warn", "Uncertain"],
      not_relevant: ["muted", "Not relevant"],
    };
    const [cls, label] = map[v] || ["warn", v];
    return `<span class="verdict-badge verdict-${cls}">${label}</span>`;
  }

  function sourceLabel(source) {
    return {
      model: "Model",
      fallback_keyword: "Keyword fallback",
      knowledge_match: "Knowledge match",
      user_override: "Your override",
    }[source] || source;
  }

  function renderMatrixTable(matrix, editable) {
    if (!matrix || !matrix.length) return "";
    const rows = matrix
      .map((row) => {
        const a = row.assessment;
        const override = editable
          ? `<div class="matrix-override">
              <label>Set verdict
                <select class="review-verdict" data-index="${row.index}">
                  ${["yes", "partial", "no", "uncertain", "not_relevant"].map((v) => `<option value="${v}" ${a.verdict === v ? "selected" : ""}>${v.replace("_", " ")}</option>`).join("")}
                </select>
              </label>
              <input class="review-note" data-index="${row.index}" type="text" placeholder="Optional note" value="${esc(a.overrideNote || "")}">
            </div>`
          : "";
        return `<tr>
          <td>${esc(row.requirement.text)}</td>
          <td>${verdictBadge(a.verdict)}</td>
          <td class="muted-cell">${esc(sourceLabel(a.source))} · ${esc(a.confidence)}${override}</td>
          <td class="muted-cell">${esc(a.reason || "")}${a.evidenceQuote ? `<br><em>${esc(a.evidenceQuote)}</em>` : ""}</td>
        </tr>`;
      })
      .join("");
    return `<div class="matrix-wrap"><table class="matrix-table">
      <thead><tr><th>Requirement</th><th>Verdict</th><th>Provenance</th><th>Reason / evidence</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  function renderResponse(res) {
    switch (res.type) {
      case "chat":
        addBot(res.message);
        break;

      case "listingPreview": {
        const p = res.preview || {};
        const qualityClass = { good: "good", fair: "warn", poor: "bad" }[p.quality] || "warn";
        const warnings = (p.warnings || []).map((w) => `<li>${esc(w)}</li>`).join("");
        const g = p.guess || {};
        let html = renderMd(res.message || "");
        html += `<div class="preview-card">
          <div class="preview-quality"><span class="verdict-badge verdict-${qualityClass}">Extraction: ${esc(p.quality || "unknown")}</span> <span class="muted-cell">${esc(p.url || "")}</span></div>
          ${warnings ? `<ul class="preview-warnings">${warnings}</ul>` : ""}
          <div class="preview-fields">
            <label>Company <input type="text" class="preview-company" value="${esc(g.company || "")}" placeholder="unknown"></label>
            <label>Title <input type="text" class="preview-title" value="${esc(g.title || "")}" placeholder="unknown"></label>
            <label>Location <input type="text" class="preview-location" value="${esc(g.location || "")}" placeholder="unknown"></label>
          </div>
          <details class="preview-text-details">
            <summary>Exact extracted text (${(p.text || "").length.toLocaleString()} characters)</summary>
            <textarea class="preview-text" readonly rows="10">${esc(p.text || "")}</textarea>
          </details>
          <div class="quick-actions">
            <button class="btn btn-primary btn-small preview-confirm">✅ Confirm & analyze</button>
            <button class="btn btn-ghost btn-small preview-cancel">✖ Cancel</button>
          </div>
        </div>`;
        const div = document.createElement("div");
        div.className = "msg bot";
        const bubble = document.createElement("div");
        bubble.className = "bubble";
        bubble.innerHTML = html;
        div.appendChild(bubble);
        messagesEl.appendChild(div);
        scrollBottom();

        bubble.querySelector(".preview-confirm")?.addEventListener("click", async () => {
          const company = bubble.querySelector(".preview-company")?.value || "";
          const title = bubble.querySelector(".preview-title")?.value || "";
          const location = bubble.querySelector(".preview-location")?.value || "";
          busy = true;
          setStatus("Thinking…", "busy");
          const typing = addTyping();
          try {
            const r = await fetch("/api/listing/confirm", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ clientId, company, title, location }),
            });
            const data = await r.json();
            typing.remove();
            renderResponse(data);
            setStatus("Ready", "on");
          } catch (err) {
            typing.remove();
            addMsg(`<div style="color:var(--bad)">⚠️ ${esc(err.message)}</div>`, "bot");
          } finally {
            busy = false;
          }
        });
        bubble.querySelector(".preview-cancel")?.addEventListener("click", async () => {
          await fetch("/api/listing/cancel", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientId }),
          });
          addBot("Discarded. Paste a job listing or a URL to start over.");
        });
        break;
      }

      case "analysis": {
        let html = renderMd(res.message || "");
        const coverage = res.coverage || { percentage: res.score ?? 0, coveredCount: (res.covered || []).length, totalCount: (res.covered || []).length + (res.missing || []).length };
        html += `<div class="score-card">
          <div class="score-ring" style="background:${scoreColor(coverage.percentage)}">${coverage.percentage}%</div>
          <div class="score-detail">
            <strong>Profile coverage</strong> — ${coverage.coveredCount}/${coverage.totalCount} listed requirements addressed. Not an ATS pass/fail prediction.
          </div>
        </div>`;
        html += `<p class="review-help">Set each requirement independently below. For example: Terraform = Yes, Kubernetes = No, Stakeholder = Yes.</p>`;
        html += renderMatrixTable(res.matrix, true);
        html += `<div class="quick-actions"><button class="btn btn-primary btn-small analysis-apply">✅ Use these verdicts</button></div>`;
        const analysisMessage = addMsg(html, "bot");
        analysisMessage.querySelector(".analysis-apply")?.addEventListener("click", async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            const overrides = [...analysisMessage.querySelectorAll(".review-verdict")].map((select) => {
              const index = Number(select.dataset.index);
              const note = analysisMessage.querySelector(`.review-note[data-index="${select.dataset.index}"]`)?.value || "";
              return { index, verdict: select.value, note };
            });
            const r = await fetch("/api/analysis/apply-verdicts", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ clientId, overrides }),
            });
            const data = await r.json();
            if (!r.ok) throw new Error(data.error || "Could not apply verdicts");
            renderResponse(data);
          } catch (err) {
            addMsg(`<div style="color:var(--bad)">⚠️ ${esc(err.message)}</div>`, "bot");
            button.disabled = false;
          }
        });
        break;
      }

      case "question":
        addBot(`${res.message || ""}\n\n_Answer this requirement only. The next question will appear after your answer._`);
        addQuickActions([
          { label: "✅ Yes, I have this", value: "Yes, I have this experience" },
          { label: "❌ No, I don't", value: "No, I don't have this" },
        ]);
        break;

      case "answerSaved":
        addBot(res.message || "");
        break;

      case "review": {
        let html = renderMd(res.message || "");
        html += `<p class="review-help">Set each requirement's verdict independently. Choose <strong>Yes</strong> for the two requirements you have and <strong>No</strong> for the one you do not, then approve the selected knowledge items.</p>`;
        html += renderMatrixTable(res.matrix, true);
        const items = res.pendingKnowledge || [];
        if (items.length) {
          const rows = items
            .map(
              (it) => `<label class="pending-item">
                <input type="checkbox" class="pending-checkbox" data-id="${esc(it.id)}" ${it.approved ? "checked" : ""}>
                <span><strong>${esc(it.requirementText)}</strong>${it.evidence ? ` — ${esc(it.evidence)}` : ""}${it.context ? ` <span class="muted-cell">(${esc(it.context)})</span>` : ""}</span>
              </label>`,
            )
            .join("");
          html += `<div class="review-pending"><div class="review-pending-title">Save permanently to knowledge folder:</div>${rows}</div>`;
        }
        html += `<div class="quick-actions">
          <button class="btn btn-primary btn-small review-approve">✅ Approve selected</button>
          <button class="btn btn-ghost btn-small review-skip">Skip — don't save</button>
        </div>`;
        const div = document.createElement("div");
        div.className = "msg bot";
        const bubble = document.createElement("div");
        bubble.className = "bubble";
        bubble.innerHTML = html;
        div.appendChild(bubble);
        messagesEl.appendChild(div);
        scrollBottom();

        bubble.querySelector(".review-approve")?.addEventListener("click", async () => {
          const approvals = [...bubble.querySelectorAll(".pending-checkbox")].map((cb) => ({
            id: cb.dataset.id,
            approved: cb.checked,
          }));
          const overrides = [...bubble.querySelectorAll(".review-verdict")].map((select) => {
            const index = Number(select.dataset.index);
            const note = bubble.querySelector(`.review-note[data-index="${select.dataset.index}"]`)?.value || "";
            return { index, verdict: select.value, note };
          });
          const r = await fetch("/api/review/apply", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientId, approvals, overrides }),
          });
          const data = await r.json();
          renderResponse(data);
        });
        bubble.querySelector(".review-skip")?.addEventListener("click", () => send("skip"));
        break;
      }

      case "ready": {
        let html = renderMd(res.message || "");
        if (res.matrix) html += renderMatrixTable(res.matrix);
        html += `<div class="quick-actions"><button class="btn btn-primary btn-small" onclick="window.__jsv2Generate()">📄 Generate CV & cover letter PDFs</button></div>`;
        addMsg(html, "bot");
        break;
      }

      case "generated": {
        let html = renderMd(res.message || "");
        addMsg(html, "bot");
        const files = res.files || {};
        const items = [
          ["CV (English)", files.cvEn],
          ["CV (Dansk)", files.cvDa],
          ["Cover Letter (English)", files.coverEn],
          ["Ansøgning (Dansk)", files.coverDa],
        ];
        const list = items
          .filter(([, p]) => p)
          .map(([label, p]) => `<div class="download-item"><span>${esc(label)}</span><a href="/api/download/${p}" download>Download ↓</a></div>`)
          .join("");
        addMsg(`<div class="download-list">${list}</div>`, "bot");
        loadApplications();
        break;
      }

      case "error":
        addMsg(`<div style="color:var(--bad)">⚠️ ${esc(res.message)}</div>`, "bot");
        break;

      case "reset":
        clearChat();
        addBot(res.message);
        break;

      default:
        addBot(res.message || "…");
    }
  }

  function addQuickActions(actions) {
    const wrap = document.createElement("div");
    wrap.className = "msg bot";
    wrap.innerHTML =
      '<div class="bubble"><div class="quick-actions">' +
      actions
        .map(
          (a) =>
            `<button class="btn btn-ghost btn-small" data-quick="${esc(a.value)}">${esc(a.label)}</button>`,
        )
        .join("") +
      "</div></div>";
    wrap.querySelectorAll("[data-quick]").forEach((btn) => {
      btn.addEventListener("click", () => send(btn.dataset.quick));
    });
    messagesEl.appendChild(wrap);
    scrollBottom();
  }

  window.__jsv2Generate = function () {
    send("generate");
  };

  function clearChat() {
    messagesEl.innerHTML = "";
  }

  // ── Send flow ───────────────────────────────────────────
  async function send(text) {
    const message = (text ?? inputEl.value).trim();
    if (!message || busy) return;
    inputEl.value = "";
    addUser(message);
    busy = true;
    setStatus("Thinking…", "busy");
    sendBtn.disabled = true;
    const typing = addTyping();
    try {
      const res = await fetch("/api/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, message }),
      });
      const data = await res.json();
      typing.remove();
      renderResponse(data);
      setStatus("Ready", "on");
    } catch (err) {
      typing.remove();
      addMsg(`<div style="color:var(--bad)">⚠️ Network error: ${esc(err.message)}</div>`, "bot");
      setStatus("Offline", "");
    } finally {
      busy = false;
      sendBtn.disabled = false;
      inputEl.focus();
    }
  }

  sendBtn.addEventListener("click", () => send());
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  resetBtn.addEventListener("click", async () => {
    await fetch("/api/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId }),
    });
    clearChat();
    addBot("State cleared. Paste a new job listing to start over.");
  });

  modelSelect.addEventListener("change", async () => {
    const model = modelSelect.value;
    modelSelect.disabled = true;
    try {
      const res = await fetch("/api/model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not change model");
      addBot(`Model changed to **${data.current}**. This will be used for the next request.`);
    } catch (err) {
      addBot(`⚠️ Could not change model: ${err.message}`);
      loadModels();
    } finally {
      modelSelect.disabled = false;
    }
  });

  // ── Sidebar ─────────────────────────────────────────────
  async function loadKnowledge() {
    try {
      const res = await fetch("/api/knowledge");
      const data = await res.json();
      knowledgeList.innerHTML = "";
      (data.entries || []).forEach((e) => {
        const li = document.createElement("li");
        li.className = "expandable-item";
        li.innerHTML = `
          <details>
            <summary><span class="file-name">${esc(e.title)}</span></summary>
            <div class="knowledge-editor">
              <textarea class="knowledge-textarea" data-file="${esc(e.file)}">${esc(e.content)}</textarea>
              <button class="btn btn-primary btn-small knowledge-save" data-file="${esc(e.file)}">Save changes</button>
              <span class="save-status" aria-live="polite"></span>
            </div>
          </details>`;
        knowledgeList.appendChild(li);
      });
    } catch {
      knowledgeList.innerHTML = "<li class='muted'>unavailable</li>";
    }
  }

  knowledgeList.addEventListener("click", async (event) => {
    const button = event.target.closest(".knowledge-save");
    if (!button) return;
    const file = button.dataset.file;
    const item = button.closest(".expandable-item");
    const textarea = item?.querySelector(".knowledge-textarea");
    const status = item?.querySelector(".save-status");
    if (!file || !textarea || !status) return;

    button.disabled = true;
    status.textContent = "Saving…";
    try {
      const res = await fetch(`/api/knowledge/${encodeURIComponent(file)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: textarea.value }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save file");
      status.textContent = "Saved";
      setTimeout(() => { status.textContent = ""; }, 2500);
    } catch (err) {
      status.textContent = `Save failed: ${err.message}`;
    } finally {
      button.disabled = false;
    }
  });

  async function loadPrompts() {
    try {
      const res = await fetch("/api/prompts");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "unavailable");
      promptList.innerHTML = "";
      (data.entries || []).forEach((entry) => {
        const li = document.createElement("li");
        li.className = "expandable-item";
        li.innerHTML = `
          <details>
            <summary>
              <span class="file-name">${esc(entry.title)}</span>
              ${entry.customized ? '<span class="prompt-customized">edited</span>' : ""}
            </summary>
            <div class="knowledge-editor">
              <p class="prompt-description">${esc(entry.description)}</p>
              <p class="prompt-placeholders">Available: ${entry.placeholders.map((p) => `<code>${esc(p)}</code>`).join(" ")}</p>
              <textarea class="knowledge-textarea prompt-textarea" data-prompt="${esc(entry.id)}">${esc(entry.content)}</textarea>
              <button class="btn btn-primary btn-small prompt-save" data-prompt="${esc(entry.id)}">Save prompt</button>
              <button class="btn btn-ghost btn-small prompt-reset" data-prompt="${esc(entry.id)}">Reset default</button>
              <span class="save-status" aria-live="polite"></span>
            </div>
          </details>`;
        promptList.appendChild(li);
      });
    } catch (err) {
      promptList.innerHTML = `<li class="muted">${esc(err.message || "unavailable")}</li>`;
    }
  }

  promptList.addEventListener("click", async (event) => {
    const button = event.target.closest(".prompt-save, .prompt-reset");
    if (!button) return;
    const id = button.dataset.prompt;
    const item = button.closest(".expandable-item");
    const textarea = item?.querySelector(".prompt-textarea");
    const status = item?.querySelector(".save-status");
    if (!id || !textarea || !status) return;
    button.disabled = true;
    status.textContent = button.classList.contains("prompt-reset") ? "Resetting…" : "Saving…";
    try {
      const isReset = button.classList.contains("prompt-reset");
      const res = await fetch(`/api/prompts/${encodeURIComponent(id)}${isReset ? "/reset" : ""}`, {
        method: isReset ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: isReset ? undefined : JSON.stringify({ content: textarea.value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not update prompt");
      if (isReset) textarea.value = data.content;
      status.textContent = isReset ? "Reset" : "Saved";
      setTimeout(() => { status.textContent = ""; }, 2500);
    } catch (err) {
      status.textContent = `Update failed: ${err.message}`;
    } finally {
      button.disabled = false;
    }
  });

  async function loadApplications() {
    try {
      const res = await fetch("/api/applications");
      const data = await res.json();
      appList.innerHTML = "";
      const apps = data.applications || [];
      if (apps.length === 0) {
        appList.innerHTML = "<li class='muted'>No applications yet</li>";
        return;
      }

      apps.slice(0, 12).forEach((a) => {
        const li = document.createElement("li");
        li.className = "expandable-item";
        const d = new Date(a.date).toLocaleDateString();
        const files = [
          ["CV (English)", "CV_English.pdf"],
          ["CV (Dansk)", "CV_Dansk.pdf"],
          ["Cover Letter (English)", "Cover_Letter_English.pdf"],
          ["Ansøgning (Dansk)", "Ansoegning_Dansk.pdf"],
        ]
          .map(([label, filename]) =>
            `<a href="/api/download/applications/${encodeURIComponent(a.folder)}/${filename}" download>${label}</a>`,
          )
          .join("");
        const statusBadge = a.status
          ? `<span class="status-badge ${a.status === "sendable" ? "status-sendable" : "status-draft"}">${a.status === "sendable" ? "✅ Sendable" : "⚠️ Draft"}</span>`
          : "";
        const preflightLink = a.preflightFile
          ? `<a href="/api/download/applications/${encodeURIComponent(a.folder)}/preflight-report.json" download>Preflight report</a>`
          : "";
        li.innerHTML = `
          <details>
            <summary>
              <span class="file-name">${esc(a.role)}</span> ${statusBadge}<br>
              <span class="file-meta">${esc(a.company)} · ${d} · coverage ${a.score}%</span>
            </summary>
            <div class="application-content">
              <div><strong>Location:</strong> ${esc(a.location || "Not specified")}</div>
              <p>${esc(a.summary || "No summary available.")}</p>
              <div class="application-downloads">${files}${preflightLink}</div>
              <button class="delete-application" type="button" data-folder="${esc(a.folder)}">Delete application</button>
            </div>
          </details>`;
        appList.appendChild(li);
      });
      appList.querySelectorAll(".delete-application").forEach((button) => {
        button.addEventListener("click", async () => {
          const folder = button.dataset.folder;
          if (!folder || !confirm("Delete this application and its PDF files?")) return;
          button.disabled = true;
          try {
            const res = await fetch(`/api/applications/${encodeURIComponent(folder)}`, { method: "DELETE" });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Delete failed");
            await loadApplications();
          } catch (err) {
            button.disabled = false;
            alert(err.message);
          }
        });
      });
    } catch {
      appList.innerHTML = "<li class='muted'>unavailable</li>";
    }
  }

  async function loadModels() {
    try {
      const res = await fetch("/api/models");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "unavailable");
      modelSelect.innerHTML = "";
      const groups = Array.isArray(data.providers) && data.providers.length
        ? data.providers
        : [{ id: "", models: data.models || [] }];
      groups.forEach((group) => {
        const parent = group.id ? document.createElement("optgroup") : modelSelect;
        if (group.id) {
          parent.label = group.id;
          modelSelect.appendChild(parent);
        }
        (group.models || []).forEach((model) => {
          const option = document.createElement("option");
          option.value = model;
          option.textContent = group.id ? model.slice(group.id.length + 1) : model;
          option.selected = model === data.current;
          parent.appendChild(option);
        });
      });
      const total = (data.models || []).length;
      modelSelect.disabled = total === 0;
      if (total === 0) {
        modelSelect.innerHTML = "<option>No models available</option>";
      }
    } catch {
      modelSelect.innerHTML = "<option>Models unavailable</option>";
      modelSelect.disabled = true;
    }
  }

  // ── Init ────────────────────────────────────────────────
  async function init() {
    loadKnowledge();
    loadPrompts();
    loadApplications();
    loadModels();
    try {
      const res = await fetch("/api/health");
      const data = await res.json();
      setStatus(data.ok ? "Ready" : "Degraded", data.ok ? "on" : "");
    } catch {
      setStatus("Server unreachable", "");
    }
  }

  init();
})();
