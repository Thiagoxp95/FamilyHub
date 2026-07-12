import { app, ipcMain, type WebContents } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import { EnrollmentStore } from "./enrollmentStore";
import { decodePcm16 } from "./enrollmentIpc";
import * as calendarTools from "./calendarTools";
import {
  GeminiLiveSession,
  buildSystemInstruction,
  calendarToolNames,
  computerToolName,
  dashboardToolNames,
  memoryToolNames,
  noteToolNames,
  updaterToolNames,
  weatherToolName,
} from "./liveSession";
import { runComputerTask } from "./computerControl";
import {
  LiveController,
  type LiveControllerSink,
  type LiveStateEvent,
  type ToolRunner,
} from "./liveController";
import {
  WakeWordSidecar,
  resolveSidecarPython,
  resolveSidecarScript,
  type AmbientUtterance,
  type LocalTranscriber,
} from "./localTranscriber";
import { AssistantService } from "./service";
import { MemoryStore, type SearchOptions, type UtteranceSource } from "../ambient/memoryStore";
import { createOllamaClient, type OllamaClient } from "../ambient/ollama";
import { EmbedWorker } from "../ambient/embedWorker";
import { scheduleDigest } from "../ambient/factsDigest";
import { TriggerEngine } from "../ambient/triggerEngine";
import { SuggestionService } from "../ambient/suggestionService";
import type { AssistantSnapshot } from "./types";
import type { AgentEvent, AgentReminder } from "./calendarTools";
import type { DashboardController, DashboardPanel } from "../dashboard/ipc";
import type { UpdaterController, UpdaterStatus } from "../updater";
import type { CalendarEvent, ReminderList } from "../dashboard/eventkit";
import {
  isNoteColor,
  type NoteInput,
  type NotePatch,
} from "../dashboard/notesTypes";

const assistantStateChannel = "assistant:state";
const liveStateChannel = "assistant:live";
const liveAudioChannel = "assistant:liveAudio";

export function registerAssistantIpc(
  dashboard?: DashboardController,
  updater?: UpdaterController,
): void {
  const geminiApiKey =
    process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? process.env.GOOGLE_API;
  const sidecarPython = resolveSidecarPython();
  const service = new AssistantService();

  // Ambient capture (silent transcription of everything heard, plus session
  // transcripts) into the local memory DB. Opt-out via FAMILYHUB_AMBIENT.
  const ambientEnabled = !["0", "off", "false", "no"].includes(
    (process.env.FAMILYHUB_AMBIENT ?? "1").trim().toLowerCase(),
  );

  // Never blocks startup: a failed store (bad path, disk full, sqlite-vec
  // load failure, etc.) just disables ambient wiring for this run.
  function buildMemory(): { store: MemoryStore; ollama: OllamaClient } | null {
    if (!ambientEnabled) {
      return null;
    }

    try {
      const store = new MemoryStore(join(homedir(), ".familyhub", "memory.sqlite"));
      const ollama = createOllamaClient();
      new EmbedWorker({ store, ollama }).start();
      return { store, ollama };
    } catch (error) {
      service.noteInfo(
        `Ambient memory unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  const memoryBundle = buildMemory();
  const memory = memoryBundle?.store ?? null;
  const ollama = memoryBundle?.ollama ?? null;

  // Nightly facts digest: distills the day's raw utterances into the
  // curated `facts` memory layer. No shutdown hook exists yet in this
  // module to cancel it on quit — the interval is process-lifetime, so the
  // cancel function is intentionally unused here (not a leak: it dies with
  // the process).
  const cancelDigestSchedule = memoryBundle ? scheduleDigest(memoryBundle.store, memoryBundle.ollama) : null;
  void cancelDigestSchedule;

  // Runtime store writes (synchronous node:sqlite) can throw after a healthy
  // startup — disk full, WAL lock, etc. These run inside live-session/sidecar
  // handlers, so a throw here would crash the main process. Swallow, and log
  // only the first failure (mirroring construction-time resilience) to avoid
  // one noteInfo line per utterance while the disk stays full.
  let memoryWriteFailureLogged = false;
  function storeQuietly(text: string, source: UtteranceSource, ts?: number): void {
    if (!memory) {
      return;
    }

    try {
      if (ts === undefined) {
        memory.addUtterance(text, source);
      } else {
        memory.addUtterance(text, source, ts);
      }
    } catch (error) {
      if (!memoryWriteFailureLogged) {
        memoryWriteFailureLogged = true;
        service.noteInfo(
          `Ambient memory write failed (further failures muted): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // The single renderer we stream live state to. Set when the renderer starts
  // listening; the controller pushes mode/transcript/audio events at it.
  let liveSender: WebContents | null = null;

  function sendLive(event: LiveStateEvent): void {
    if (liveSender && !liveSender.isDestroyed()) {
      liveSender.send(liveStateChannel, event);
    }
  }

  const sink: LiveControllerSink = {
    sendLive,
    sendLiveAudio: (chunk) => {
      if (liveSender && !liveSender.isDestroyed()) {
        liveSender.send(liveAudioChannel, chunk);
      }
    },
    noteHeard: memory
      ? (text) => {
          service.noteHeard(text);
          storeQuietly(text, "session_user");
        }
      : (text) => service.noteHeard(text),
    noteAssistantReply: memory
      ? (text) => {
          service.noteAssistantReply(text);
          storeQuietly(text, "session_james");
        }
      : (text) => service.noteAssistantReply(text),
    noteInfo: (message) => service.noteInfo(message),
    emitSnapshot: () => {
      if (liveSender) {
        void emitSnapshot(liveSender, service);
      }
    },
  };

  // Dispatch a Gemini tool call to the Calendar/Reminders/Notes layer, refreshing
  // the affected dashboard card after a write so the change shows immediately.
  const runTool: ToolRunner = async (name, args) => {
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    const optStr = (v: unknown): string | undefined =>
      typeof v === "string" && v.trim() ? v : undefined;
    const minutes = (v: unknown): number[] | undefined =>
      Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : undefined;

    switch (name) {
      case calendarToolNames.listEvents: {
        dashboard?.focusPanel("calendar");
        const daysAhead =
          typeof args.daysAhead === "number" ? args.daysAhead : undefined;
        // Served from the dashboard's in-memory cache (refreshed every 5 min
        // and after every write) so "what's on tomorrow" answers instantly; a
        // fresh AppleScript scan takes ~20s and stalls the live turn. The
        // cache covers 14 days — only a longer horizon needs a live scan.
        const cached =
          dashboard && (daysAhead === undefined || daysAhead <= 13)
            ? await dashboard.getCalendar()
            : null;
        if (cached?.status === "ok") {
          return { ok: true, events: agentEventsFromCache(cached.events, daysAhead) };
        }
        return { ok: true, events: await calendarTools.listEvents(daysAhead) };
      }
      case calendarToolNames.createEvent: {
        dashboard?.focusPanel("calendar");
        // Feed the idempotency pre-check from the cache so a duplicate create
        // is caught without a slow live scan.
        const cached = await dashboard?.getCalendar();
        const existing =
          cached?.status === "ok" ? agentEventsFromCache(cached.events) : undefined;
        const event = await calendarTools.createEvent(
          {
            title: str(args.title),
            start: str(args.start),
            end: optStr(args.end),
            allDay: args.allDay === true,
            calendar: optStr(args.calendar),
            alarmsMinutesBefore: minutes(args.alarmsMinutesBefore),
          },
          existing,
        );
        await dashboard?.refreshCalendar();
        return { ok: true, event };
      }
      case calendarToolNames.updateEvent: {
        dashboard?.focusPanel("calendar");
        await calendarTools.updateEvent({
          id: str(args.id),
          title: optStr(args.title),
          start: optStr(args.start),
          end: optStr(args.end),
          allDay: typeof args.allDay === "boolean" ? args.allDay : undefined,
          alarmsMinutesBefore: minutes(args.alarmsMinutesBefore),
        });
        await dashboard?.refreshCalendar();
        return { ok: true };
      }
      case calendarToolNames.deleteEvent:
        dashboard?.focusPanel("calendar");
        await calendarTools.deleteEvent(str(args.id));
        await dashboard?.refreshCalendar();
        return { ok: true };
      case calendarToolNames.listReminders: {
        dashboard?.focusPanel("reminders");
        if (!dashboard) {
          return missingDashboard();
        }

        const wanted = optStr(args.list);
        if (wanted) {
          dashboard.focusReminderList(wanted);
        }

        // Served from the in-memory cache so it returns instantly; a fresh
        // AppleScript scan can take tens of seconds on lists with many
        // completed items and would blow past the live turn timeout.
        const cached = await dashboard.getReminders();
        if (cached.status !== "ok") {
          return {
            ok: false,
            error:
              cached.status === "denied"
                ? "Reminders access is not granted."
                : "Reminders unavailable.",
          };
        }

        return {
          ok: true,
          reminders: flattenReminders(cached.lists, wanted),
        };
      }
      case calendarToolNames.createReminder: {
        dashboard?.focusPanel("reminders");
        const cached = await dashboard?.getReminders();
        const existing =
          cached?.status === "ok" ? flattenReminders(cached.lists) : undefined;
        const result = await calendarTools.createReminder(
          {
            title: str(args.title),
            due: optStr(args.due),
            list: optStr(args.list),
            notes: optStr(args.notes),
          },
          existing,
        );
        dashboard?.focusReminderList(result.list);
        // Refresh in the background so the tool returns immediately.
        void dashboard?.refreshReminders();
        return { ok: true, list: result.list };
      }
      case calendarToolNames.updateReminder:
        dashboard?.focusPanel("reminders");
        await calendarTools.updateReminder({
          id: str(args.id),
          title: optStr(args.title),
          due: optStr(args.due),
          notes: optStr(args.notes),
        });
        void dashboard?.refreshReminders();
        return { ok: true };
      case calendarToolNames.completeReminder: {
        dashboard?.focusPanel("reminders");
        const completingId = str(args.id);
        // Optimistically strike the item through in the UI before the slow
        // AppleScript mutation (and even slower refresh) lands.
        dashboard?.markReminderCompleting(completingId);
        await calendarTools.completeReminder(completingId);
        void dashboard?.refreshReminders();
        return { ok: true };
      }
      case calendarToolNames.deleteReminder:
        dashboard?.focusPanel("reminders");
        await calendarTools.deleteReminder(str(args.id));
        void dashboard?.refreshReminders();
        return { ok: true };
      case noteToolNames.getNotes:
        dashboard?.focusPanel("notes");
        return dashboard
          ? { ok: true, notes: await dashboard.getNotes() }
          : missingDashboard();
      case noteToolNames.createNote: {
        dashboard?.focusPanel("notes");
        if (!dashboard) {
          return missingDashboard();
        }

        const note = await dashboard.createNote(readNoteInput(args));
        return { ok: true, note };
      }
      case noteToolNames.updateNote: {
        dashboard?.focusPanel("notes");
        if (!dashboard) {
          return missingDashboard();
        }

        const note = await dashboard.updateNote(
          requireString(args.id, "Note id"),
          readNotePatch(args),
        );
        return note ? { ok: true, note } : { ok: false, error: "Note not found." };
      }
      case noteToolNames.deleteNote:
        dashboard?.focusPanel("notes");
        return dashboard
          ? {
              ok: true,
              ...(await dashboard.deleteNote(requireString(args.id, "Note id"))),
            }
          : missingDashboard();
      case dashboardToolNames.showCalendar:
        focusDashboard(dashboard, "calendar");
        return { ok: true };
      case dashboardToolNames.hideCalendar:
        focusDashboard(dashboard, null);
        return { ok: true };
      case weatherToolName: {
        dashboard?.focusPanel("weather");
        if (!dashboard) {
          return missingDashboard();
        }

        const result = await dashboard.getWeather();
        return result.ok
          ? { ok: true, weather: result.weather }
          : { ok: false, error: result.error };
      }
      case dashboardToolNames.showWeather:
        focusDashboard(dashboard, "weather");
        return { ok: true };
      case dashboardToolNames.hideWeather:
        focusDashboard(dashboard, null);
        return { ok: true };
      case dashboardToolNames.showReminders: {
        focusDashboard(dashboard, "reminders");
        const list = optStr(args.list);
        if (list) {
          dashboard?.focusReminderList(list);
        }
        return { ok: true };
      }
      case dashboardToolNames.hideReminders:
        focusDashboard(dashboard, null);
        return { ok: true };
      case dashboardToolNames.showNotes:
        focusDashboard(dashboard, "notes");
        return { ok: true };
      case dashboardToolNames.hideNotes:
        focusDashboard(dashboard, null);
        return { ok: true };
      case computerToolName: {
        const result = await runComputerTask(str(args.task));
        return result.ok
          ? { ok: true, output: result.output ?? "Done." }
          : { ok: false, error: result.error ?? "Computer task failed." };
      }
      case memoryToolNames.search: {
        if (!memory) return { ok: false, error: "Memory is not enabled." };
        const query = str(args.query);
        const daysBack = typeof args.daysBack === "number" ? args.daysBack : undefined;
        const vector = ollama ? await ollama.embed(query) : null;
        const opts: SearchOptions = { topK: 5, layer: "both" };
        if (daysBack !== undefined) {
          opts.sinceTs = Date.now() - daysBack * 86_400_000;
        }
        const hits = memory.search(vector, query, opts);
        return {
          ok: true,
          results: hits.map((hit) => ({
            when: new Date(hit.ts).toISOString(),
            layer: hit.layer,
            source: hit.source,
            text: hit.text,
          })),
        };
      }
      case memoryToolNames.forget: {
        if (!memory) return { ok: false, error: "Memory is not enabled." };
        const result = memory.forget(str(args.query));
        return { ok: true, deleted: result.deleted, texts: result.texts.slice(0, 5) };
      }
      case updaterToolNames.checkForUpdates:
        return callUpdater(updater, (controller) => controller.checkNow());
      case updaterToolNames.downloadUpdate:
        return callUpdater(updater, (controller) => controller.downloadNow());
      // installNow() only relaunches if a download is already complete; verbal
      // confirmation before installing is enforced by the system instruction.
      case updaterToolNames.installUpdate:
        return callUpdater(updater, (controller) => controller.installNow());
      default:
        return { ok: false, error: `Unknown tool: ${name}` };
    }
  };

  // "Can James help right now?" pipeline: TriggerEngine classifies the rolling
  // ambient window after every utterance and hands candidate suggestions to
  // SuggestionService, which shows a one-at-a-time on-screen card (tap or
  // voice to accept/dismiss). Both are only constructed when the memory store
  // is available — with no store, addSuggestion/setSuggestionStatus have
  // nowhere to persist to, so the whole feature stays inert.
  let trigger: TriggerEngine | null = null;
  const suggestions = memoryBundle
    ? new SuggestionService({
        store: memoryBundle.store,
        sendLive,
        runTool,
        onDismissed: () => trigger?.noteDismissed(),
      })
    : null;
  trigger = memoryBundle
    ? new TriggerEngine({
        store: memoryBundle.store,
        ollama: memoryBundle.ollama,
        onSuggestion: (suggestion) => suggestions?.show(suggestion),
      })
    : null;

  const sidecarScript = resolveSidecarScript();
  // Open to anyone: wake word → connect straight to Gemini, which streams the mic
  // continuously and uses its own (server-side) VAD for turn-taking. No speaker
  // gate / voiceprint lock — the fastest, most reliable path.
  const controller =
    geminiApiKey && sidecarPython && sidecarScript
      ? new LiveController({
          createTranscriber: (): LocalTranscriber =>
            new WakeWordSidecar(sidecarPython, sidecarScript),
          createSession: () =>
            new GeminiLiveSession({
              apiKey: geminiApiKey,
              systemInstruction: buildSystemInstruction(),
            }),
          runTool,
          resetDashboardFocus: () => dashboard?.focusPanel(null),
          sink,
          ...(memory
            ? {
                onAmbientUtterance: (u: AmbientUtterance): void => {
                  storeQuietly(u.text, "ambient", Math.round(u.t1 * 1000));
                  suggestions?.handleVoice(u.text);
                  trigger?.handleUtterance(u.text);
                },
              }
            : {}),
        })
      : null;

  // When the listener can't be built, explain which piece is missing rather than
  // a generic "set up the sidecar" — on a fresh machine it's almost always the
  // Gemini key in ~/.familyhub/.env, not the bundled runtime.
  const listenerUnavailableReason = !geminiApiKey
    ? "No Gemini API key — add GOOGLE_API (or GEMINI_API_KEY) to ~/.familyhub/.env, then relaunch."
    : !sidecarPython || !sidecarScript
      ? "Wake sidecar runtime missing from this build."
      : "Local listener unavailable.";

  // ----- IPC handlers -----
  ipcMain.handle("assistant:getSnapshot", async () => service.getSnapshot());

  ipcMain.handle("assistant:startListening", async (event) => {
    liveSender = event.sender;

    if (controller) {
      await controller.start();
    } else {
      service.noteInfo(listenerUnavailableReason);
    }

    const snapshot = await service.startListening();
    event.sender.send(assistantStateChannel, snapshot);
    return snapshot;
  });

  ipcMain.handle("assistant:stopListening", async (event) => {
    await controller?.stop();
    const snapshot = await service.stopListening();
    event.sender.send(assistantStateChannel, snapshot);
    return snapshot;
  });

  // Continuous microphone stream (base64 LINEAR16 @16 kHz). The controller feeds
  // idle frames to the local wake listener; once a session is live every frame
  // streams straight to Gemini, which owns turn-taking and interruption.
  ipcMain.on("assistant:micFrame", (event, frame: unknown) => {
    if (typeof frame === "string") {
      liveSender = event.sender;
      controller?.handleFrame(frame);
    }
  });

  ipcMain.handle("assistant:endLive", async () => {
    await controller?.endLive();
    return true;
  });

  // Tap-to-accept / tap-to-dismiss for the ambient suggestion card.
  ipcMain.handle(
    "assistant:suggestionAction",
    async (_event, id: unknown, action: unknown) => {
      if (!suggestions || typeof id !== "number") {
        return false;
      }

      if (action === "accept") {
        await suggestions.accept(id);
        return true;
      }

      if (action === "dismiss") {
        suggestions.dismiss(id);
        return true;
      }

      return false;
    },
  );

  // ----- Enrollment IPC handlers -----
  const enrollment = new EnrollmentStore(join(app.getPath("userData"), "speaker-profiles"));

  ipcMain.handle("enrollment:listMembers", () => enrollment.listMembers());

  ipcMain.handle("enrollment:addMember", (event, name: string) => {
    enrollment.addMember(name);
    const members = enrollment.listMembers();
    event.sender.send("enrollment:members", members);
    return members;
  });

  ipcMain.handle("enrollment:deleteMember", (event, id: string) => {
    enrollment.deleteMember(id);
    const members = enrollment.listMembers();
    event.sender.send("enrollment:members", members);
    return members;
  });

  ipcMain.handle("enrollment:saveClip", (event, id: string, base64: string) => {
    const result = enrollment.saveClip(id, decodePcm16(base64));
    event.sender.send("enrollment:members", enrollment.listMembers());
    return result;
  });

  ipcMain.handle("enrollment:deleteLastClip", (event, id: string) => {
    const result = enrollment.deleteLastClip(id);
    event.sender.send("enrollment:members", enrollment.listMembers());
    return result;
  });
}

async function emitSnapshot(
  webContents: WebContents,
  service: AssistantService,
): Promise<void> {
  if (webContents.isDestroyed()) {
    return;
  }

  const snapshot: AssistantSnapshot = await service.getSnapshot();
  webContents.send(assistantStateChannel, snapshot);
}

// Run an updater controller method for a voice tool call and normalize the
// result into the assistant's { ok, ... } envelope. A surfaced "error" state
// (e.g. a failed user-initiated check) becomes { ok: false } so the model never
// sees ok:true next to an error message.
async function callUpdater(
  controller: UpdaterController | undefined,
  run: (controller: UpdaterController) => Promise<UpdaterStatus>,
): Promise<Record<string, unknown>> {
  if (!controller) {
    return { ok: false, error: "Updater unavailable." };
  }

  const result = await run(controller);
  return result.state === "error"
    ? { ok: false, error: result.error ?? "Update failed." }
    : { ok: true, ...result };
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }

  return value.trim();
}

function readNoteInput(args: Record<string, unknown>): NoteInput {
  const input: NoteInput = {
    text: requireString(args.text, "Note text"),
  };

  if (typeof args.emoji === "string" && args.emoji.trim()) {
    input.emoji = args.emoji.trim();
  }

  if (isNoteColor(args.color)) {
    input.color = args.color;
  }

  return input;
}

function readNotePatch(args: Record<string, unknown>): NotePatch {
  const patch: NotePatch = {};

  if (typeof args.text === "string") {
    patch.text = args.text;
  }

  if (typeof args.emoji === "string" && args.emoji.trim()) {
    patch.emoji = args.emoji.trim();
  }

  if (isNoteColor(args.color)) {
    patch.color = args.color;
  }

  return patch;
}

function focusDashboard(
  dashboard: DashboardController | undefined,
  panel: DashboardPanel,
): void {
  dashboard?.focusPanel(panel);
}

function missingDashboard(): Record<string, unknown> {
  return { ok: false, error: "Dashboard is unavailable." };
}

// Map the dashboard's cached events into the id-carrying shape the agent uses,
// optionally trimmed to the requested daysAhead window (the cache holds the
// full 14-day horizon).
function agentEventsFromCache(
  events: CalendarEvent[],
  daysAhead?: number,
): AgentEvent[] {
  let horizon = Number.POSITIVE_INFINITY;
  if (daysAhead !== undefined) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    horizon = start.getTime() + (Math.max(0, Math.floor(daysAhead)) + 1) * 86_400_000;
  }

  const agentEvents: AgentEvent[] = [];
  for (const event of events) {
    const at = Date.parse(event.start);
    if (!Number.isFinite(at) || at >= horizon) {
      continue;
    }
    agentEvents.push({
      id: event.id ?? "",
      title: event.title,
      start: event.start,
      end: event.end,
      allDay: event.allDay,
      calendar: event.calendar,
    });
  }
  return agentEvents;
}

// Flatten the cached reminder lists into the id-carrying shape the agent uses,
// optionally narrowed to a single list (matched loosely by name).
function flattenReminders(
  lists: ReminderList[],
  listFilter?: string,
): AgentReminder[] {
  const target = listFilter?.trim().toLowerCase();
  const matches = (name: string): boolean => {
    if (!target) {
      return true;
    }
    const lower = name.trim().toLowerCase();
    return lower === target || lower.includes(target) || target.includes(lower);
  };

  const reminders: AgentReminder[] = [];
  for (const list of lists) {
    if (!matches(list.name)) {
      continue;
    }
    for (const item of list.items) {
      const reminder: AgentReminder = {
        id: item.id ?? "",
        list: list.name,
        title: item.title,
      };
      if (item.due) {
        reminder.due = item.due;
      }
      reminders.push(reminder);
    }
  }
  return reminders;
}
