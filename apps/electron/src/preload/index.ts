import { contextBridge, ipcRenderer } from "electron";

function makeSubscription(channel: string) {
  return (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      callback(payload);
    };

    ipcRenderer.on(channel, listener);

    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  };
}

contextBridge.exposeInMainWorld("familyHub", {
  assistant: {
    getSnapshot: () =>
      ipcRenderer.invoke("assistant:getSnapshot") as Promise<unknown>,
    onSnapshot: (callback: (snapshot: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: unknown) => {
        callback(snapshot);
      };

      ipcRenderer.on("assistant:state", listener);

      return () => {
        ipcRenderer.removeListener("assistant:state", listener);
      };
    },
    startListening: () =>
      ipcRenderer.invoke("assistant:startListening") as Promise<unknown>,
    stopListening: () =>
      ipcRenderer.invoke("assistant:stopListening") as Promise<unknown>,
    sendMicFrame: (frame: string) => {
      ipcRenderer.send("assistant:micFrame", frame);
    },
    endLive: () => ipcRenderer.invoke("assistant:endLive") as Promise<boolean>,
    onLive: (callback: (event: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        callback(payload);
      };

      ipcRenderer.on("assistant:live", listener);

      return () => {
        ipcRenderer.removeListener("assistant:live", listener);
      };
    },
    onLiveAudio: (callback: (chunk: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, chunk: unknown) => {
        callback(chunk);
      };

      ipcRenderer.on("assistant:liveAudio", listener);

      return () => {
        ipcRenderer.removeListener("assistant:liveAudio", listener);
      };
    },
  },
  dashboard: {
    getWeather: () =>
      ipcRenderer.invoke("dashboard:getWeather") as Promise<unknown>,
    onWeather: makeSubscription("dashboard:weather"),
    getCalendar: () =>
      ipcRenderer.invoke("dashboard:getCalendar") as Promise<unknown>,
    onCalendar: makeSubscription("dashboard:calendar"),
    getReminders: () =>
      ipcRenderer.invoke("dashboard:getReminders") as Promise<unknown>,
    onReminders: makeSubscription("dashboard:reminders"),
    getNotes: () =>
      ipcRenderer.invoke("dashboard:getNotes") as Promise<unknown>,
    onNotes: makeSubscription("dashboard:notes"),
    getFocusedPanel: () =>
      ipcRenderer.invoke("dashboard:getFocusedPanel") as Promise<unknown>,
    onFocus: makeSubscription("dashboard:focus"),
    getReminderList: () =>
      ipcRenderer.invoke("dashboard:getReminderList") as Promise<unknown>,
    onReminderList: makeSubscription("dashboard:reminderList"),
    createNote: (input: unknown) =>
      ipcRenderer.invoke("dashboard:createNote", input) as Promise<unknown>,
    updateNote: (id: string, patch: unknown) =>
      ipcRenderer.invoke("dashboard:updateNote", id, patch) as Promise<unknown>,
    deleteNote: (id: string) =>
      ipcRenderer.invoke("dashboard:deleteNote", id) as Promise<unknown>,
    connectCalendar: () =>
      ipcRenderer.invoke("dashboard:connectCalendar") as Promise<unknown>,
    connectReminders: () =>
      ipcRenderer.invoke("dashboard:connectReminders") as Promise<unknown>,
  },
  updater: {
    check: () => ipcRenderer.invoke("updater:check") as Promise<unknown>,
    getStatus: () =>
      ipcRenderer.invoke("updater:getStatus") as Promise<unknown>,
    install: () => ipcRenderer.invoke("updater:install") as Promise<unknown>,
    onStatus: makeSubscription("updater:status"),
  },
  ping: () => ipcRenderer.invoke("app:ping") as Promise<string>,
  getVersion: () => ipcRenderer.invoke("app:getVersion") as Promise<string>,
});
