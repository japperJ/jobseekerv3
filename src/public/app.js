/* Jobseeker v2 chat client */
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
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  const knowledgeList = document.getElementById("knowledgeList");
  const appList = document.getElementById("appList");

  let busy = false;

  const SIDEBAR_MIN = 240;
  const SIDEBAR_MAX = 520;
  const savedSidebarWidth = Number(localStorage.getItem("jsv2-sidebar-width"));
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
    localStorage.setItem("jsv2-sidebar-width", String(width));
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
    localStorage.setItem("jsv2-sidebar-width", String(next));
  });

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
  function renderResponse(res) {
    switch (res.type) {
      case "chat":
        addBot(res.message);
        break;

      case "analysis": {
        let html = renderMd(res.message || "");
        const score = res.score ?? 0;
        const covered = (res.covered || []).map((s) => `<span class="chip good">${esc(s)}</span>`).join("");
        const missing = (res.missing || []).map((s) => `<span class="chip warn">${esc(s)}</span>`).join("");
        html += `<div class="score-card">
          <div class="score-ring" style="background:${scoreColor(score)}">${score}%</div>
          <div class="score-detail">
            <strong>Match score</strong> — requirements covered vs. the listing.
            ${covered ? `<div class="chips">${covered}</div>` : ""}
            ${missing ? `<div class="chips"><span class="chip">Gaps to confirm:</span>${missing}</div>` : ""}
          </div>
        </div>`;
        addMsg(html, "bot");
        addQuickActions([
          { label: "Yes, I have this", value: "Yes, I have this experience" },
          { label: "No, I don't", value: "No, I don't have this" },
        ]);
        break;
      }

      case "question":
        addBot(res.message || "");
        addQuickActions([
          { label: "✅ Yes, I have this", value: "Yes, I have this experience" },
          { label: "❌ No, I don't", value: "No, I don't have this" },
        ]);
        break;

      case "answerSaved":
        addBot(res.message || "");
        break;

      case "ready": {
        let html = renderMd(res.message || "");
        html += `<div class="quick-actions"><button class="btn btn-primary btn-small" onclick="window.__jsv2Generate()">📄 Generate CV & cover letter PDFs</button></div>`;
        addMsg(html, "bot");
        break;
      }

      case "generated": {
        addBot(res.message || "");
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
        li.innerHTML = `
          <details>
            <summary>
              <span class="file-name">${esc(a.role)}</span><br>
              <span class="file-meta">${esc(a.company)} · ${d} · match ${a.score}%</span>
            </summary>
            <div class="application-content">
              <div><strong>Location:</strong> ${esc(a.location || "Not specified")}</div>
              <p>${esc(a.summary || "No summary available.")}</p>
              <div class="application-downloads">${files}</div>
            </div>
          </details>`;
        appList.appendChild(li);
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
      (data.models || []).forEach((model) => {
        const option = document.createElement("option");
        option.value = model;
        option.textContent = model;
        option.selected = model === data.current;
        modelSelect.appendChild(option);
      });
      modelSelect.disabled = (data.models || []).length === 0;
      if ((data.models || []).length === 0) {
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
