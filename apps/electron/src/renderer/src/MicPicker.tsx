// A low-chrome dropdown in the top-left titlebar band that picks which audio
// input the renderer captures for the "Hey James" wake word. Selection is owned
// by App (which also runs the capture loop and persists the choice); this is a
// presentational <select> styled to match the update badge on the opposite
// corner.
export function MicPicker({
  devices,
  selectedDeviceId,
  onChange,
}: {
  devices: MediaDeviceInfo[];
  onChange: (deviceId: string) => void;
  selectedDeviceId: string;
}): React.JSX.Element {
  // If the saved device has gone away (unplugged), fall back to showing the
  // system-default option rather than leaving the native <select> blank.
  const value = devices.some((device) => device.deviceId === selectedDeviceId)
    ? selectedDeviceId
    : "";

  return (
    <label className="mic-badge" title="Microphone for “Hey James”">
      <svg
        aria-hidden="true"
        className="mic-badge__glyph"
        fill="none"
        height="12"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        viewBox="0 0 24 24"
        width="12"
      >
        <rect height="11" rx="3" width="6" x="9" y="2" />
        <path d="M5 10a7 7 0 0 0 14 0" />
        <line x1="12" x2="12" y1="19" y2="22" />
      </svg>
      <select
        aria-label="Microphone for the wake word"
        className="mic-badge__select"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">System default</option>
        {devices.map((device, index) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label || `Microphone ${index + 1}`}
          </option>
        ))}
      </select>
    </label>
  );
}
