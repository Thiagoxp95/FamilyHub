import { useEffect, useState } from "react";

export function weatherEmoji(category: WeatherCategory, isDay: boolean): string {
  if (category === "clear") {
    return isDay ? "☀️" : "🌙";
  }

  if (category === "partly-cloudy") {
    return isDay ? "🌤️" : "🌙";
  }

  if (category === "cloudy") {
    return "☁️";
  }

  if (category === "fog") {
    return "🌫️";
  }

  if (category === "drizzle") {
    return "🌦️";
  }

  if (category === "rain") {
    return "🌧️";
  }

  if (category === "snow") {
    return "❄️";
  }

  if (category === "thunder") {
    return "⛈️";
  }

  return "🌡️";
}

// "YYYY-MM-DD" → short weekday label, with the first entry shown as "Today".
export function forecastDayLabel(date: string, index: number): string {
  if (index === 0) {
    return "Today";
  }

  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return date;
  }

  return parsed.toLocaleDateString("en-CA", { weekday: "short" });
}

// "1970-01-01T05:42" → "5:42 AM"; tolerant of bare-time or full-ISO inputs.
export function formatClock(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value.length <= 5 ? `1970-01-01T${value}` : value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleTimeString("en-CA", {
    hour: "numeric",
    minute: "2-digit",
  });
}

// Shared subscription to the main process's weather feed (initial fetch +
// push updates), used by both the full panel and the compact strip readout.
function useWeather(): WeatherResult | null {
  const [result, setResult] = useState<WeatherResult | null>(null);

  useEffect(() => {
    window.familyHub.dashboard
      .getWeather()
      .then(setResult)
      .catch(() => {
        setResult({ ok: false, error: "Weather unavailable." });
      });

    return window.familyHub.dashboard.onWeather(setResult);
  }, []);

  return result;
}

// Compact one-line readout that lives in the top clock strip: emoji, current
// temperature, condition, and today's range. Tapping it opens the fullscreen
// weather panel. Renders nothing until weather has loaded (the strip simply
// shows the clocks alone).
export function WeatherStrip({
  onExpand,
}: {
  onExpand: () => void;
}): React.JSX.Element | null {
  const result = useWeather();

  if (!result?.ok) {
    return null;
  }

  const weather = result.weather;

  return (
    <button
      aria-label="Expand weather"
      className="weather-strip"
      onClick={onExpand}
      type="button"
    >
      <span className="weather-strip__emoji">
        {weatherEmoji(weather.condition.category, weather.condition.isDay)}
      </span>
      <span className="weather-strip__temp">{weather.temperatureC}°</span>
      <span className="weather-strip__side">
        <span className="weather-strip__desc">{weather.condition.label}</span>
        <span className="weather-strip__range">
          H {weather.highC}° · L {weather.lowC}°
        </span>
      </span>
    </button>
  );
}

export function WeatherPanel({
  variant = "compact",
}: {
  variant?: "compact" | "expanded";
} = {}): React.JSX.Element {
  const result = useWeather();

  if (!result) {
    return (
      <div className="weather weather--pending">
        <p className="quad-placeholder">Loading weather…</p>
      </div>
    );
  }

  if (!result.ok) {
    return (
      <div className="weather weather--pending">
        <p className="quad-placeholder">{result.error}</p>
      </div>
    );
  }

  const weather = result.weather;
  const expanded = variant === "expanded";

  return (
    <div
      className={`weather weather--${weather.condition.category} ${
        weather.condition.isDay ? "is-day" : "is-night"
      } ${expanded ? "weather--expanded" : ""}`}
    >
      <div className="weather-readout">
        <div className="weather-location">
          {weather.city ?? "Local weather"}
        </div>
        <div className="weather-row">
          <span className="weather-emoji-lg">
            {weatherEmoji(
              weather.condition.category,
              weather.condition.isDay,
            )}
          </span>
          <div className="weather-temp">{weather.temperatureC}°</div>
          <div className="weather-side">
            <div className="weather-desc">{weather.condition.label}</div>
            <div className="weather-meta">Feels {weather.apparentC}°</div>
          </div>
        </div>
        <div className="weather-conditions">
          <span>H {weather.highC}°</span>
          <span>L {weather.lowC}°</span>
          {weather.humidity !== null ? <span>{weather.humidity}% hum</span> : null}
          {expanded && weather.windMph !== null ? (
            <span>{weather.windMph} mph wind</span>
          ) : null}
          {expanded && weather.precipitationMm !== null ? (
            <span>{weather.precipitationMm} mm precip</span>
          ) : null}
          {expanded && weather.uvIndex !== null ? (
            <span>UV {weather.uvIndex}</span>
          ) : null}
        </div>
      </div>

      {expanded ? <WeatherForecast days={weather.forecast} /> : null}
    </div>
  );
}

function WeatherForecast({ days }: { days: WeatherDay[] }): React.JSX.Element {
  if (days.length === 0) {
    return <p className="quad-placeholder">Forecast unavailable.</p>;
  }

  return (
    <ol className="weather-forecast">
      {days.map((day, index) => (
        <li className="weather-forecast-day" key={day.date}>
          <span className="weather-forecast-name">
            {forecastDayLabel(day.date, index)}
          </span>
          <span className="weather-forecast-icon">
            {weatherEmoji(day.condition.category, true)}
          </span>
          <span className="weather-forecast-temps">
            <span className="weather-forecast-high">{day.highC}°</span>
            <span className="weather-forecast-low">{day.lowC}°</span>
          </span>
          <span className="weather-forecast-metrics">
            <span className="weather-forecast-precip">
              💧
              {day.precipitationChance !== null
                ? ` ${day.precipitationChance}%`
                : " —"}
              {day.precipitationMm !== null && day.precipitationMm > 0
                ? ` · ${day.precipitationMm} mm`
                : ""}
            </span>
            {day.humidity !== null ? (
              <span className="weather-forecast-hum">{day.humidity}% hum</span>
            ) : null}
            {day.windMph !== null ? (
              <span className="weather-forecast-wind">{day.windMph} mph</span>
            ) : null}
            {day.uvIndex !== null ? (
              <span className="weather-forecast-uv">UV {day.uvIndex}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
