const form = document.getElementById("tunnel-form");
const errorEl = document.getElementById("error");
const cancelBtn = document.getElementById("cancel-btn");

console.log("tunnelApi available:", !!window.tunnelApi);
if (!window.tunnelApi) {
  errorEl.textContent = "Error: tunnelApi not available (preload script failed to load)";
  errorEl.style.display = "block";
}

cancelBtn.addEventListener("click", () => {
  window.close();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorEl.style.display = "none";

  if (!window.tunnelApi) {
    errorEl.textContent = "Error: tunnelApi not available";
    errorEl.style.display = "block";
    return;
  }

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

  console.log("Submitting tunnel data:", JSON.stringify(data));

  try {
    const result = await window.tunnelApi.addTunnel(data);
    console.log("Add tunnel result:", result);
    window.close();
  } catch (err) {
    console.error("Add tunnel error:", err);
    errorEl.textContent = err.message || "Failed to add tunnel";
    errorEl.style.display = "block";
  }
});
