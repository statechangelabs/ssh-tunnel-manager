import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("tunnelApi", {
  getStatuses: () => ipcRenderer.invoke("get-statuses"),
  addTunnel: (data: {
    name: string;
    host: string;
    user: string;
    localPort: number;
    remoteHost: string;
    remotePort: number;
    enabled: boolean;
    identityFile?: string;
    sshPort?: number;
  }) => ipcRenderer.invoke("add-tunnel", data),
  updateTunnel: (data: {
    id: string;
    name: string;
    host: string;
    user: string;
    localPort: number;
    remoteHost: string;
    remotePort: number;
    enabled: boolean;
    identityFile?: string;
    sshPort?: number;
  }) => ipcRenderer.invoke("update-tunnel", data),
  toggleTunnel: (id: string) => ipcRenderer.invoke("toggle-tunnel", id),
  removeTunnel: (id: string) => ipcRenderer.invoke("remove-tunnel", id),
});
