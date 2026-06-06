import { useEffect, useState } from "react";
import { WeatherScene } from "./WeatherScene";

export function WeatherPanel(): React.JSX.Element {
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

  return (
    <div
      className={`weather weather--${weather.condition.category} ${
        weather.condition.isDay ? "is-day" : "is-night"
      }`}
    >
      <WeatherScene
        category={weather.condition.category}
        isDay={weather.condition.isDay}
      />
      <div className="weather-readout">
        <div className="weather-top">
          <span className="weather-city">{weather.city ?? "Local weather"}</span>
          <span className="weather-cond">{weather.condition.label}</span>
        </div>
        <div className="weather-temp">{weather.temperatureC}°</div>
        <div className="weather-meta">
          <span>H {weather.highC}°</span>
          <span>L {weather.lowC}°</span>
          <span>Feels {weather.apparentC}°</span>
          {weather.humidity !== null ? <span>{weather.humidity}% hum</span> : null}
        </div>
      </div>
    </div>
  );
}
