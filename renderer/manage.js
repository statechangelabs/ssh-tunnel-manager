const listView = document.getElementById("list-view");
const formView = document.getElementById("form-view");
const tunnelList = document.getElementById("tunnel-list");
const emptyState = document.getElementById("empty-state");
const addBtn = document.getElementById("add-btn");
const backBtn = document.getElementById("back-btn");
const cancelBtn = document.getElementById("cancel-btn");
const form = document.getElementById("tunnel-form");
const formTitle = document.getElementById("form-title");
const submitBtn = document.getElementById("submit-btn");
const errorEl = document.getElementById("error");

let editingId = null;
let refreshTimer = null;

// ── View Navigation ──

function showList() {
  editingId = null;
  formView.classList.add("hidden");
  listView.classList.remove("hidden");
  loadTunnels();
  startRefresh();
}

function showForm(tunnel) {
  stopRefresh();
  listView.classList.add("hidden");
  formView.classList.remove("hidden");
  errorEl.style.display = "none";

  if (tunnel) {
    editingId = tunnel.id;
    formTitle.textContent = "Edit Tunnel";
    submitBtn.textContent = "Save Changes";
    document.getElementById("name").value = tunnel.name || "";
    document.getElementById("host").value = tunnel.host || "";
    document.getElementById("user").value = tunnel.user || "";
    document.getElementById("localPort").value = tunnel.localPort || "";
    document.getElementById("remoteHost").value = tunnel.remoteHost || "";
    document.getElementById("remotePort").value = tunnel.remotePort || "";
    document.getElementById("identityFile").value = tunnel.identityFile || "";
    document.getElementById("sshPort").value = tunnel.sshPort || 22;
    document.getElementById("enabled").checked = tunnel.enabled;
  } else {
    editingId = null;
    formTitle.textContent = "Add Tunnel";
    submitBtn.textContent = "Add Tunnel";
    form.reset();
    document.getElementById("sshPort").value = "22";
  }
}

// ── Render Tunnel List ──

function renderTunnels(statuses) {
  tunnelList.innerHTML = "";

  if (statuses.length === 0) {
    emptyState.classList.remove("hidden");
    return;
  }
  emptyState.classList.add("hidden");

  for (const s of statuses) {
    const card = document.createElement("div");
    card.className = "tunnel-card";

    const alive = s.alive && s.portOpen;
    card.innerHTML = `
      <span class="tunnel-status ${alive ? "alive" : "dead"}">●</span>
      <div class="tunnel-info">
        <div class="tunnel-name">${esc(s.name)}</div>
        <div class="tunnel-detail">:${s.localPort} → ${esc(s.remoteHost)}:${s.remotePort}</div>
      </div>
      <div class="tunnel-actions">
        <label class="toggle">
          <input type="checkbox" ${s.enabled ? "checked" : ""} data-id="${esc(s.id)}" class="toggle-input">
          <span class="slider"></span>
        </label>
        <button class="icon-btn edit-btn" data-id="${esc(s.id)}" title="Edit">✎</button>
        <button class="icon-btn danger delete-btn" data-id="${esc(s.id)}" title="Delete">✕</button>
      </div>
    `;
    tunnelList.appendChild(card);
  }

  // Attach toggle handlers
  for (const toggle of tunnelList.querySelectorAll(".toggle-input")) {
    toggle.addEventListener("change", async () => {
      try {
        await window.tunnelApi.toggleTunnel(toggle.dataset.id);
        setTimeout(loadTunnels, 1500);
      } catch (err) {
        console.error("Toggle error:", err);
      }
    });
  }

  // Attach edit handlers
  for (const btn of tunnelList.querySelectorAll(".edit-btn")) {
    btn.addEventListener("click", () => {
      const tunnel = statuses.find((s) => s.id === btn.dataset.id);
      if (tunnel) showForm(tunnel);
    });
  }

  // Attach delete handlers
  for (const btn of tunnelList.querySelectorAll(".delete-btn")) {
    btn.addEventListener("click", async () => {
      const tunnel = statuses.find((s) => s.id === btn.dataset.id);
      if (!tunnel) return;
      if (!confirm(`Remove tunnel "${tunnel.name}"?`)) return;
      try {
        await window.tunnelApi.removeTunnel(tunnel.id);
        loadTunnels();
      } catch (err) {
        console.error("Delete error:", err);
      }
    });
  }
}

// ── Data Loading ──

async function loadTunnels() {
  try {
    const statuses = await window.tunnelApi.getStatuses();
    renderTunnels(statuses);
  } catch (err) {
    console.error("Failed to load tunnels:", err);
  }
}

function startRefresh() {
  stopRefresh();
  refreshTimer = setInterval(loadTunnels, 3000);
}

function stopRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// ── Form Submission ──

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorEl.style.display = "none";

  const data = {
    name: document.getElementById("name").value.trim(),
    host: document.getElementById("host").value.trim(),
    user: document.getElementById("user").value.trim() || undefined,
    localPort: parseInt(document.getElementById("localPort").value, 10),
    remoteHost: document.getElementById("remoteHost").value.trim(),
    remotePort: parseInt(document.getElementById("remotePort").value, 10),
    identityFile: document.getElementById("identityFile").value.trim() || undefined,
    sshPort: parseInt(document.getElementById("sshPort").value, 10) || 22,
    enabled: document.getElementById("enabled").checked,
  };

  try {
    if (editingId) {
      await window.tunnelApi.updateTunnel({ id: editingId, ...data });
    } else {
      await window.tunnelApi.addTunnel(data);
    }
    showList();
  } catch (err) {
    errorEl.textContent = err.message || "Failed to save tunnel";
    errorEl.style.display = "block";
  }
});

// ── Button Handlers ──

addBtn.addEventListener("click", () => showForm(null));
backBtn.addEventListener("click", () => showList());
cancelBtn.addEventListener("click", () => showList());

// ── Helpers ──

function esc(str) {
  const el = document.createElement("span");
  el.textContent = str;
  return el.innerHTML;
}

// ── Init ──
showList();
