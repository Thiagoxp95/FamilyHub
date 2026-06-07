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
    deleteSpeaker: (speakerId: string) =>
      ipcRenderer.invoke("assistant:deleteSpeaker", speakerId) as Promise<boolean>,
    enrollSpeaker: (name: string) =>
      ipcRenderer.invoke("assistant:enrollSpeaker", name) as Promise<unknown>,
    saveEnrollmentClip: (speakerId: string, audioBase64: string) =>
      ipcRenderer.invoke(
        "assistant:saveEnrollmentClip",
        speakerId,
        audioBase64,
      ) as Promise<{ sampleCount: number }>,
    finalizeEnrollment: (speakerId: string) =>
      ipcRenderer.invoke("assistant:finalizeEnrollment", speakerId) as Promise<void>,
    getSnapshot: () =>
      ipcRenderer.invoke("assistant:getSnapshot") as Promise<unknown>,
    lockSessionSpeaker: (speakerId: string, speakerLabel: string) =>
      ipcRenderer.invoke(
        "assistant:lockSessionSpeaker",
        speakerId,
        speakerLabel,
      ) as Promise<unknown>,
    onSnapshot: (callback: (snapshot: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: unknown) => {
        callback(snapshot);
      };

      ipcRenderer.on("assistant:state", listener);

      return () => {
        ipcRenderer.removeListener("assistant:state", listener);
      };
    },
    setSpeakerAllowed: (speakerId: string, allowed: boolean) =>
      ipcRenderer.invoke(
        "assistant:setSpeakerAllowed",
        speakerId,
        allowed,
      ) as Promise<unknown>,
    startListening: () =>
      ipcRenderer.invoke("assistant:startListening") as Promise<unknown>,
    stopListening: () =>
      ipcRenderer.invoke("assistant:stopListening") as Promise<unknown>,
    submitTranscript: (transcript: string, speakerLabel: string) =>
      ipcRenderer.invoke(
        "assistant:submitTranscript",
        transcript,
        speakerLabel,
      ) as Promise<unknown>,
    submitAudioChunk: (audio: Uint8Array, sampleRateHertz: number) =>
      ipcRenderer.invoke(
        "assistant:submitAudioChunk",
        audio,
        sampleRateHertz,
      ) as Promise<unknown>,
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
    connectCalendar: () =>
      ipcRenderer.invoke("dashboard:connectCalendar") as Promise<unknown>,
    connectReminders: () =>
      ipcRenderer.invoke("dashboard:connectReminders") as Promise<unknown>,
  },
  ping: () => ipcRenderer.invoke("app:ping") as Promise<string>,
});
