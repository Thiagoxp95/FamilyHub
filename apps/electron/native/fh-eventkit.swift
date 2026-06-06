// FamilyHub EventKit helper. Spawned by the Electron main process with one
// argument ("events" or "reminders"); prints a JSON envelope to stdout.
//   events:    {"status":"ok","events":[...]} | {"status":"writeOnly"} | {"status":"denied"}
//   reminders: {"status":"ok","lists":[...]}  | {"status":"denied"}
//
// Runs an NSApplication accessory run loop so macOS can present the EventKit
// permission prompt (a blocked CLI process can't show it).
import AppKit
import EventKit
import Foundation

let store = EKEventStore()

func iso(_ date: Date?) -> String {
  guard let date = date else { return "" }
  return ISO8601DateFormatter().string(from: date)
}

func emitAndExit(_ obj: [String: Any]) -> Never {
  if let data = try? JSONSerialization.data(withJSONObject: obj),
    let str = String(data: data, encoding: .utf8)
  {
    print(str)
  } else {
    print("{\"status\":\"error\"}")
  }
  exit(0)
}

func runEvents() {
  store.requestFullAccessToEvents { _, _ in
    switch EKEventStore.authorizationStatus(for: .event) {
    case .writeOnly:
      emitAndExit(["status": "writeOnly"])
    case .fullAccess:
      let calendar = Calendar.current
      let start = calendar.startOfDay(for: Date())
      let end = calendar.date(byAdding: .day, value: 1, to: start) ?? start
      let predicate = store.predicateForEvents(
        withStart: start, end: end, calendars: nil)
      let events = store.events(matching: predicate)
        .sorted { $0.startDate < $1.startDate }
      let mapped = events.map { event -> [String: Any] in
        [
          "allDay": event.isAllDay,
          "calendar": event.calendar?.title ?? "",
          "end": iso(event.endDate),
          "start": iso(event.startDate),
          "title": event.title ?? "(no title)",
        ]
      }
      emitAndExit(["status": "ok", "events": mapped])
    default:
      emitAndExit(["status": "denied"])
    }
  }
}

func runReminders() {
  store.requestFullAccessToReminders { _, _ in
    guard EKEventStore.authorizationStatus(for: .reminder) == .fullAccess else {
      emitAndExit(["status": "denied"])
    }
    let predicate = store.predicateForIncompleteReminders(
      withDueDateStarting: nil, ending: nil, calendars: nil)
    store.fetchReminders(matching: predicate) { reminders in
      var order: [String] = []
      var lists: [String: [[String: Any]]] = [:]
      for reminder in reminders ?? [] {
        let listName = reminder.calendar?.title ?? "Reminders"
        if lists[listName] == nil {
          order.append(listName)
        }
        var item: [String: Any] = ["title": reminder.title ?? "(untitled)"]
        if let dc = reminder.dueDateComponents,
          let due = Calendar.current.date(from: dc)
        {
          item["due"] = iso(due)
        }
        lists[listName, default: []].append(item)
      }
      let mapped = order.map {
        ["items": lists[$0] ?? [], "name": $0] as [String: Any]
      }
      emitAndExit(["status": "ok", "lists": mapped])
    }
  }
}

let mode = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "events"
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

// Safety net: never hang forever waiting on a prompt.
DispatchQueue.main.asyncAfter(deadline: .now() + 55) {
  emitAndExit(["status": "denied"])
}

DispatchQueue.main.async {
  if mode == "reminders" {
    runReminders()
  } else {
    runEvents()
  }
}

app.run()
